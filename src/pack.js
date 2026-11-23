// File formats of the two-layer pipeline (docs/decisions/0010-subscription-vs-api.md) and the
// program's checks on them. Layer 1 (Claude Code agents under the subscription) reads documents
// and writes plain files; this module only checks those files against the archived originals.
// It calls no model and writes nothing to the database.
//
//   candidates file   the shape src/extract.js writes (kind kanverify-extraction-candidates),
//                     plus subject_id at file level: the subjects.id of the speaker, filled in
//                     by the extraction role (design/review-desk.md, coordinator decision 1);
//                     the program recomputes verbatim, verbatim_unit, duplicate_of and problems,
//                     whatever the file says about them.
//   evidence pack     one claim, its criteria, 1..N verbatim excerpts {source_id, locator, text}
//                     from archived sources, and the excerpts looked at but not used.
//   vote file         one judge's verdict on one pack, bound to the pack by its SHA-256.
//
// The text an excerpt is compared with: a web page's visible text (htmlToParagraphs), a
// Légifrance file (legifranceToUnits), plain text by paragraph, or for a PDF the saved
// transcription data/candidates/source-<id>-text.json, made once per file and tied to its hash.
// There is no PDF text-layer reader (principle 5: no PDF parser; the transcription exists).

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { DEFAULT_EVIDENCE_DIR, evidencePath } from './archive.js';
import { openDatabase } from './db.js';
import { candidateProblems, checkVerbatim, htmlToParagraphs, loadPrompt, normalizeForMatch } from './extract.js';
import { isLegifranceSource, legifranceToUnits } from './legifrance.js';
import {
  REVERSAL_TYPES, deadlineProblem, filled, futureEvidence, renunciationAdmitted, renunciationProblems, renunciationRefusal,
  twoIndependent,
} from './rules.js';
import { loadStandard, rulesAppliedProblems } from './standard.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEXT_DIR = resolve(here, '../data/candidates');
/** The rules a pack is cut under (team/run/pack-prompt.md); checkPack accepts only its current version. */
export const PACK_PROMPT_PATH = resolve(here, '../team/run/pack-prompt.md');
export function packPromptVersion(path = PACK_PROMPT_PATH) {
  return loadPrompt(path).version;
}

export const VERDICTS = Object.freeze(['unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true']);
// Same three classes as sources.kind and publication_checks in db/schema.sql.
export const OFFICIAL_KINDS = Object.freeze(['law', 'gazette', 'statistic', 'budget', 'parliament', 'court', 'audit', 'official']);
export const INDEPENDENT_KINDS = Object.freeze(['media', 'dataset_study']);
export const EVIDENCE_KINDS = Object.freeze([...OFFICIAL_KINDS, ...INDEPENDENT_KINDS, 'renunciation']);
const ORIGIN_KINDS = ['platform', 'statement'];

export const PACK_KIND = 'kanverify-evidence-pack';
export const VOTE_KIND = 'kanverify-vote';
export const CHANNELS = Object.freeze(['subscription', 'api']);
// The judges' view of a pack (claim, sources, excerpts) stays near 5k tokens (decision 0010).
export const MAX_PACK_TOKENS = 5_000;
export const MAX_EXCERPTS = 12;
export const MAX_EXCERPT_CHARS = 1_500;

// ---------------------------------------------------------------- small helpers

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function sha256Of(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
/** Rough token count, about 3.5 characters a token for French and English text. An estimate only. */
export function estimateTokens(text) {
  return Math.ceil(String(text).length / 3.5);
}
function localDateOf(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** "Article 10", "art. 10", "ART 10" -> "art 10"; other labels compared lowercased, spaces collapsed. */
export function articleKey(text) {
  return String(text ?? '').trim().toLowerCase().replace(/^(?:article|art\.?)\s*/, 'art ').replace(/\s+/g, ' ');
}
export function writeJsonAtomic(path, value) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w' });
  renameSync(temp, path);
}

// ---------------------------------------------------------------- source text

/**
 * The text of an archived source, in units, for the verbatim checks.
 * @returns {{ kind: 'pdf_page'|'paragraph'|'law', basis: string, units: {unit:number,text:string,label?:string}[], missing: number[] } | { error: string }}
 */
export function sourceUnits(source, { evidenceDir = DEFAULT_EVIDENCE_DIR, textDir = DEFAULT_TEXT_DIR } = {}) {
  const path = evidencePath(evidenceDir, source.sha256);
  if (!existsSync(path)) return { error: `the archived file of source ${source.id} is missing` };
  const bytes = readFileSync(path);
  if (sha256Of(bytes) !== source.sha256) return { error: `the archived file of source ${source.id} does not match its hash` };
  if (source.media_type === 'application/pdf') {
    const textPath = join(textDir, `source-${source.id}-text.json`);
    if (!existsSync(textPath)) return { error: `source ${source.id} is a PDF without a saved transcription (${textPath})` };
    const saved = JSON.parse(readFileSync(textPath, 'utf8'));
    if (saved.sha256 !== source.sha256) return { error: `the transcription of source ${source.id} belongs to another file (hash differs)` };
    const units = (Array.isArray(saved.units) ? saved.units : []).filter((u) => Number.isInteger(u?.unit) && typeof u.text === 'string');
    const basis = `transcription (${saved.method ?? 'unknown method'}${saved.model ? `, ${saved.model}` : ''})`;
    return { kind: 'pdf_page', basis, units, missing: Array.isArray(saved.missing_units) ? saved.missing_units : [] };
  }
  if (source.media_type === 'text/html' || source.media_type === 'application/xhtml+xml') {
    return { kind: 'paragraph', basis: 'html', units: htmlToParagraphs(bytes.toString('utf8')).map((text, i) => ({ unit: i + 1, text })), missing: [] };
  }
  if (source.media_type === 'text/plain') {
    const units = bytes.toString('utf8').split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((text, i) => ({ unit: i + 1, text }));
    return { kind: 'paragraph', basis: 'text', units, missing: [] };
  }
  if (isLegifranceSource(source)) {
    try {
      return { kind: 'law', basis: 'legifrance', units: legifranceToUnits(JSON.parse(bytes.toString('utf8'))), missing: [] };
    } catch {
      return { error: `the Légifrance file of source ${source.id} is not valid JSON` };
    }
  }
  return { error: `source ${source.id} has media type ${source.media_type}, which is not handled` };
}

function sourceRow(db, id) {
  return Number.isInteger(id) ? db.prepare('SELECT * FROM sources WHERE id = ?').get(id) ?? null : null;
}

/**
 * Where an excerpt is in its source, and what is wrong with its locator.
 * Returns { problems, unit, label } (unit is where the match starts).
 */
function placeExcerpt(text, locator, pdfPage, st, sourceId, { strictLocator = true } = {}) {
  const problems = [];
  const where = `source ${sourceId}`;
  const found = checkVerbatim(text, st.units);
  if (!found.verbatim) {
    const missingNote = st.missing.length > 0 ? ` (pages not transcribed: ${st.missing.slice(0, 12).join(', ')}${st.missing.length > 12 ? '…' : ''})` : '';
    problems.push(`excerpt not found verbatim in ${where}${missingNote}`);
    return { problems, unit: null, label: null };
  }
  const label = st.units.find((u) => u.unit === found.verbatim_unit)?.label ?? null;
  if (!strictLocator) return { problems, unit: found.verbatim_unit, label };
  if (st.kind === 'pdf_page') {
    if (pdfPage !== found.verbatim_unit) problems.push(`pdf_page ${JSON.stringify(pdfPage ?? null)} but the excerpt starts on PDF page ${found.verbatim_unit} of ${where}`);
    // The printed page cannot be checked; its wording can (Fable review 6 A10).
    if (!/^p\. \S+$/.test(String(locator ?? '').trim())) problems.push(`locator ${JSON.stringify(locator ?? null)} for a PDF must be "p. N", the page number printed on the page`);
  } else if (pdfPage !== null && pdfPage !== undefined) {
    problems.push(`pdf_page given for ${where}, which is not a PDF`);
  }
  if (st.kind === 'law' && articleKey(locator) !== articleKey(label)) {
    problems.push(`locator ${JSON.stringify(locator ?? null)} does not match where the excerpt is in ${where} (${label})`);
  }
  if (st.kind === 'paragraph' && String(locator ?? '').trim() !== `§${found.verbatim_unit}`) {
    problems.push(`locator ${JSON.stringify(locator ?? null)} but the excerpt starts in §${found.verbatim_unit} of ${where}`);
  }
  return { problems, unit: found.verbatim_unit, label };
}

// ---------------------------------------------------------------- candidates file

/**
 * Checks a candidates file written by a layer-1 agent (or by src/extract.js) against its source.
 * The fields the program owns (verbatim, verbatim_unit, duplicate_of, problems) are recomputed.
 * @returns {{ problems: string[], record: object }} file-level problems and the checked record.
 */
export function checkCandidatesFile(db, record, opts = {}) {
  const problems = [];
  if (record?.kind !== 'kanverify-extraction-candidates') problems.push('kind is not kanverify-extraction-candidates');
  for (const field of ['provider', 'model', 'prompt_version']) if (!filled(record?.[field])) problems.push(`${field} is empty`);
  // The speaker: without it no candidate can become a claims row (claims.subject_id is required).
  if (!Number.isInteger(record?.subject_id)) problems.push('subject_id is missing: the subjects.id of the speaker');
  else if (!db.prepare('SELECT 1 FROM subjects WHERE id = ?').get(record.subject_id)) problems.push(`subject ${record.subject_id} is not in the database`);
  const source = sourceRow(db, record?.source?.id);
  if (!source) return { problems: [...problems, `source ${JSON.stringify(record?.source?.id ?? null)} is not in the database`], record };
  if (!ORIGIN_KINDS.includes(source.kind)) problems.push(`source ${source.id} is a ${source.kind}, not the speaker's own words`);
  if (record.source.sha256 !== source.sha256) problems.push(`source ${source.id}: the file's sha256 differs from the archive`);
  const st = sourceUnits(source, opts);
  if (st.error) return { problems: [...problems, st.error], record };
  const unitCount = st.units.length + st.missing.length;
  const seen = new Map();
  const candidates = (Array.isArray(record.candidates) ? record.candidates : []).map((raw, i) => {
    const { verbatim: _v, verbatim_unit: _u, duplicate_of: _d, problems: _p, ...c } = raw ?? {};
    const check = checkVerbatim(c.quote_original, st.units);
    const key = normalizeForMatch(c.quote_original ?? '');
    const duplicateOf = seen.get(key) ?? null;
    if (duplicateOf === null) seen.set(key, i + 1);
    const own = candidateProblems({ ...c }, { unitCount });
    if (check.verbatim && check.verbatim_unit !== c.unit) own.push(`quote found on unit ${check.verbatim_unit}, not ${c.unit}`);
    return { ...c, index: i + 1, verbatim: check.verbatim, verbatim_unit: check.verbatim_unit, duplicate_of: duplicateOf, problems: own };
  });
  if (candidates.length === 0) problems.push('no candidates');
  const checked = {
    ...record,
    candidates,
    counts: {
      candidates: candidates.length,
      verbatim_ok: candidates.filter((c) => c.verbatim).length,
      verbatim_failed: candidates.filter((c) => !c.verbatim).length,
      with_problems: candidates.filter((c) => c.problems.length > 0).length,
      duplicates: candidates.filter((c) => c.duplicate_of !== null).length,
    },
    checked_by_program: { at: new Date().toISOString(), text_basis: st.basis },
  };
  return { problems, record: checked };
}

// ---------------------------------------------------------------- where an excerpt starts and ends

const INVISIBLE_CHAR = /[\u00AD\u200B-\u200D\u2060\uFEFF]/;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032`\u00B4]/;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u2033]/;
const DASH = /[-\u2010-\u2015\u2212]/;
const SPACE = /\s/u;
// A hyphen joining two letters ("non-raccordables") is inside a word (Fable review 6 re-check, R3).
const HYPHEN = /[-‐‑]/;
const LETTER = /\p{L}/u;

/**
 * normalizeForMatch(text), and for every character of the result the index in text.normalize('NFKC')
 * it comes from, so a match can be placed in the text a reader sees. Null when the step-by-step
 * version does not give exactly normalizeForMatch's result (then the boundaries are not checked).
 */
function normalizedWithMap(text) {
  const src = String(text ?? '').normalize('NFKC');
  const skip = (c) => INVISIBLE_CHAR.test(c) || SPACE.test(c);
  let norm = '';
  const map = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (skip(c)) continue;
    if (SINGLE_QUOTES.test(c)) { norm += "'"; map.push(i); continue; }
    if (DOUBLE_QUOTES.test(c)) { norm += '"'; map.push(i); continue; }
    if (c === '\u2026') { norm += '...'; map.push(i, i, i); continue; }
    if (DASH.test(c)) {
      // As in normalizeForMatch: a dash directly before a digit (blanks aside) is a sign and stays.
      let j = i + 1;
      while (j < src.length && skip(src[j])) j++;
      if (/\d/.test(src[j] ?? '')) { norm += '-'; map.push(i); }
      continue;
    }
    norm += c;
    map.push(i);
  }
  return norm === normalizeForMatch(text) ? { src, norm, map } : null;
}

/**
 * Where a verbatim excerpt lies in a source's units: its range in the compared text (for order and
 * overlap), the units it spans, and the characters around it in the unit text (for its boundaries).
 * Null when it is not found or cannot be placed.
 */
export function locateSpan(text, units) {
  const needle = normalizeForMatch(text ?? '');
  if (!needle) return null;
  const parts = [];
  let hay = '';
  for (const u of units) {
    const m = normalizedWithMap(u.text);
    if (!m) return null;
    parts.push({ unit: u.unit, start: hay.length, ...m });
    hay += m.norm;
  }
  const at = hay.indexOf(needle);
  if (at < 0) return null;
  const end = at + needle.length;
  const partOf = (pos) => parts.findIndex((p) => p.start <= pos && pos < p.start + p.norm.length);
  const a = partOf(at);
  const b = partOf(end - 1);
  const sp = parts[a];
  const ep = parts[b];
  const startOffset = sp.map[at - sp.start];
  const endOffset = ep.map[end - 1 - ep.start] + 1;
  return {
    at, end, startUnit: sp.unit, endUnit: ep.unit, units: parts.slice(a, b + 1).map((p) => p.unit),
    before: sp.src.slice(0, startOffset), head: sp.src.slice(startOffset, startOffset + 8),
    upToEnd: ep.src.slice(0, endOffset), after: ep.src.slice(endOffset),
  };
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const DIGIT_CHAR = /\p{N}/u;
// A space inside a figure, "1 200 000" (NFKC has made no-break and thin spaces plain ones): a digit, one
// space, then a group of exactly three digits.
const GROUP_BEFORE = /\d[^\S\n]$/u;
const GROUP_AFTER = /^[^\S\n]\d{3}(?!\d)/u;
const GROUP_HEAD = /^\d{3}(?!\d)/;
const SIGN_END = /[+\-\u2010-\u2015\u2212]$/;
const SENTENCE_END = /[.!?\u2026]["'\u201D\u2019\u00BB)\]]*$/u;

/**
 * Fable review 6 A5. refuse: the excerpt starts or ends inside a word or a number ("2,4 millions" cut from
 * "42,4 millions", "200 000" from "1 200 000", "raccordables" from "non-raccordables": a hyphen between
 * letters is inside the word, re-check R3), or starts right after a sign ("0,3 %" cut from "-0,3 %"). flag: it does not start or end
 * at a sentence or unit boundary (a negation or an attribution may be cut off); the desk shows these.
 */
export function boundaryProblems(span) {
  const refuse = [];
  const flag = [];
  const { before, head, upToEnd, after } = span;
  const first = head[0] ?? '';
  const second = head[1] ?? '';
  const prev = before.at(-1) ?? '';
  const prev2 = before.at(-2) ?? '';
  const last = upToEnd.at(-1) ?? '';
  const penult = upToEnd.at(-2) ?? '';
  const next = after[0] ?? '';
  const next2 = after[1] ?? '';
  const startsNumber = DIGIT_CHAR.test(first) || (/[.,]/.test(first) && DIGIT_CHAR.test(second));
  if ((WORD_CHAR.test(prev) && WORD_CHAR.test(first))
    || (LETTER.test(prev2) && HYPHEN.test(prev) && LETTER.test(first))
    || (DIGIT_CHAR.test(first) && /[.,]/.test(prev) && DIGIT_CHAR.test(prev2))
    || (/[.,]/.test(first) && DIGIT_CHAR.test(prev) && DIGIT_CHAR.test(second))
    || (GROUP_HEAD.test(head) && GROUP_BEFORE.test(before))) {
    refuse.push('starts inside a word or a number');
  } else if (startsNumber && SIGN_END.test(before.trimEnd())) {
    refuse.push('starts right after a sign (- + −): the sign belongs to the figure');
  }
  if ((WORD_CHAR.test(last) && WORD_CHAR.test(next))
    || (LETTER.test(last) && HYPHEN.test(next) && LETTER.test(next2))
    || (DIGIT_CHAR.test(last) && /[.,]/.test(next) && DIGIT_CHAR.test(next2))
    || (/[.,]/.test(last) && DIGIT_CHAR.test(penult) && DIGIT_CHAR.test(next))
    || (/\d$/.test(upToEnd) && GROUP_AFTER.test(after))) {
    refuse.push('ends inside a word or a number');
  }
  // A line start or a list bullet counts as a boundary.
  if (before.trim() !== '' && !SENTENCE_END.test(before.trimEnd()) && !/(?:\n|[•▪◦])\s*$/u.test(before)) {
    flag.push('does not start at a sentence or unit boundary');
  }
  if (after.trim() !== '' && !SENTENCE_END.test(upToEnd.trimEnd()) && !/^[^\S\n]*\n/.test(after)) {
    flag.push('does not end at a sentence or unit boundary');
  }
  return { refuse, flag };
}

// ---------------------------------------------------------------- the speaker's name

const fold = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The speaker's full name and surname (last word, 3 letters or more), case and accents aside. */
function nameTerms(name) {
  const full = fold(name).trim().replace(/\s+/g, ' ');
  const last = full.split(' ').at(-1);
  return [...new Set([full, ...(last && last.length >= 3 ? [last] : [])])].filter(Boolean)
    .map((t) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(t)}(?![\\p{L}\\p{N}])`, 'u'));
}

// Verbatim text and the program-written parts may name the speaker; everything else a cutter writes may not.
const NAME_FREE_SKIP_TOP = new Set(['kind', 'claim', 'header', 'sources']);
const NAME_FREE_SKIP_ITEM = new Set(['text', 'text_fr', 'text_en', 'locator']);

/** Paths of the free-text fields of a pack that name the speaker (Fable review 6 A10). */
export function speakerNamed(pack, name) {
  if (!filled(name)) return [];
  const terms = nameTerms(name);
  const hits = [];
  const walk = (value, path, inItem) => {
    if (typeof value === 'string') {
      if (terms.some((re) => re.test(fold(value)))) hits.push(path);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path} ${i + 1}`, true));
      return;
    }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (!path && NAME_FREE_SKIP_TOP.has(k)) continue;
        if (inItem && NAME_FREE_SKIP_ITEM.has(k)) continue;
        walk(v, path ? `${path}.${k}` : k, inItem);
      }
    }
  };
  walk(pack, '', false);
  return hits;
}

// ---------------------------------------------------------------- evidence pack

const CLAIM_FIELDS = [
  'quote_original', 'lang', 'quote_fr', 'quote_en', 'type', 'domain', 'verifiability', 'deadline',
  'deadline_basis', 'criteria_fr', 'criteria_en', 'speaker_role_fr', 'speaker_role_en',
];
const SOURCE_FIELDS = ['kind', 'title', 'publisher', 'published_on', 'url', 'lang'];

/**
 * The start of a pack, written by the program (Fable review 6 A2, A4): the claim copied from the record,
 * the given sources in a fixed order (ascending id, so neither the dispatcher nor the cutter orders them),
 * a session id the program stamps, and the current pack prompt version. The cutter fills in the rest;
 * checkPack compares the finished pack with this header.
 */
export function startPack(db, claimId, sourceIds, { now = () => new Date(), promptVersion = packPromptVersion() } = {}) {
  const c = db.prepare('SELECT c.*, s.name AS speaker FROM claims c JOIN subjects s ON s.id = c.subject_id WHERE c.id = ?').get(claimId);
  if (!c) throw new Error(`claim ${claimId} is not in the database`);
  if (['vague', 'hedged'].includes(c.verifiability)) throw new Error(`claim ${claimId} is ${c.verifiability}: it gets no evidence pack (decision 0012 item 5)`);
  if (!Array.isArray(sourceIds) || sourceIds.length === 0) throw new Error('give at least one source id');
  if (new Set(sourceIds).size !== sourceIds.length) throw new Error('a source id is given twice');
  for (const id of sourceIds) if (!sourceRow(db, id)) throw new Error(`source ${JSON.stringify(id)} is not in the database`);
  const origin = sourceRow(db, c.source_id);
  const claim = {
    claim_id: c.id, key: `c${c.id}`, speaker: c.speaker, said_on: c.said_on,
    origin: { source_id: origin.id, title: origin.title, published_on: origin.published_on, locator: c.source_locator },
    ...Object.fromEntries(CLAIM_FIELDS.map((f) => [f, c[f] ?? null])),
  };
  return {
    kind: PACK_KIND, format: 1,
    header: {
      written_by: 'node src/pack.js start', started_at: now().toISOString(), prompt_version: promptVersion,
      session: `pack-${randomUUID()}`, given_sources: [...sourceIds].sort((a, b) => a - b), claim: structuredClone(claim),
    },
    made_by: { role: 'evidence', channel: null, provider: null, via: null, model: null },
    before_reading: { met: null, not_met: null },
    claim, sources: [], excerpts: [], read: [], considered_not_used: [], transcription_doubts: [], gaps: null,
  };
}

/** "all", or unit numbers and ranges ("1-5, 9") -> a set of unit numbers; null when not well formed. */
export function parseUnitList(spec) {
  if (spec === 'all') return 'all';
  if (typeof spec !== 'string') return null;
  const out = new Set();
  for (const part of spec.split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (b < a || b - a > 100_000) return null;
    for (let u = a; u <= b; u++) out.add(u);
  }
  return out.size > 0 ? out : null;
}

/**
 * What every judge sees of a pack: the claim, the sources' metadata, the excerpts. Nothing else.
 * The speaker's name is left out, only their role is given, so no judge brings in what it knows
 * of the person (principle 3; Fable review 1, finding 18). The quote or the title may still name them.
 */
export function judgeView(pack) {
  const c = pack.claim ?? {};
  return {
    claim: {
      speaker_role: c.speaker_role_en, made_in: c.origin?.title ?? null, made_on: c.origin?.published_on ?? null,
      quote_original: c.quote_original, quote_lang: c.lang, quote_en: c.quote_en, type: c.type, verifiability: c.verifiability,
      deadline: c.deadline, deadline_basis: c.deadline_basis, criteria_en: c.criteria_en, criteria_fr: c.criteria_fr,
    },
    sources: (pack.sources ?? []).map((s) => ({
      source_id: s.source_id, kind: s.kind, title: s.title, publisher: s.publisher, published_on: s.published_on, url: s.url,
    })),
    excerpts: (pack.excerpts ?? []).map((e, i) => ({
      n: i + 1, source_id: e.source_id, locator: e.locator, pdf_page: e.pdf_page ?? null, text: e.text,
    })),
  };
}

const sortedNums = (set) => [...set].sort((a, b) => a - b);

/**
 * The program's checks on an evidence pack (team/run/pack-prompt.md). Returns
 * { problems, flags, coverage, tokens, docs, texts }: docs and texts are what voteProblems needs (each
 * cited source's metadata from the database, and per source the pack's excerpts as the only text a vote
 * may quote from); flags are excerpt boundaries the desk shows (not refusals); coverage is per given
 * source: units excerpted, declared read and not excerpted, not read, not transcribed.
 */
export function checkPack(db, pack, opts = {}) {
  const problems = [];
  const flags = [];
  const coverage = [];
  if (pack?.kind !== PACK_KIND) problems.push(`kind is not ${PACK_KIND}`);
  if (pack?.format !== 1) problems.push('format is not 1');
  if (!filled(pack?.made_by?.role) || !filled(pack?.made_by?.model)) problems.push('made_by must name the role and the model that cut the pack');
  const claim = pack?.claim;
  if (!claim || typeof claim !== 'object') return { problems: [...problems, 'claim is missing'], flags, coverage, tokens: null, docs: [], texts: new Map() };
  if (!filled(claim.key)) problems.push('claim.key is empty');
  if (!filled(claim.speaker)) problems.push('claim.speaker is empty');

  // The header the program wrote (startPack): current prompt, its session, the claim unchanged, the given sources.
  const header = pack.header;
  let given = [];
  if (!header || typeof header !== 'object') {
    problems.push('header is missing: a pack is started by the program (node src/pack.js start <claim_id> <source_id...>)');
  } else {
    const current = packPromptVersion();
    if (header.prompt_version !== current) problems.push(`header.prompt_version ${JSON.stringify(header.prompt_version ?? null)} is not the current pack prompt ${current}; start the pack again`);
    if (!filled(header.session)) problems.push('header.session is empty: the session is stamped by the program when the pack is started');
    if (!isDeepStrictEqual(header.claim, claim)) {
      const keys = [...new Set([...Object.keys(header.claim ?? {}), ...Object.keys(claim)])].filter((k) => !isDeepStrictEqual(header.claim?.[k], claim[k]));
      problems.push(`claim differs from the claim the program wrote at the start (${keys.join(', ') || 'the whole claim'}); it is copied from the record and stays unchanged`);
    }
    const ids = header.given_sources;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(Number.isInteger) || new Set(ids).size !== ids.length) {
      problems.push('header.given_sources must list the given source ids, each once');
    } else given = ids;
  }
  const isGiven = (id) => given.includes(id);

  // The claim: its quote is in its origin, and it would pass the candidate rules.
  const origin = sourceRow(db, claim.origin?.source_id);
  if (!origin) problems.push(`claim origin ${JSON.stringify(claim.origin?.source_id ?? null)} is not in the database`);
  else {
    if (!ORIGIN_KINDS.includes(origin.kind)) problems.push(`claim origin ${origin.id} is a ${origin.kind}, not the speaker's own words`);
    for (const f of ['title', 'published_on']) if ((claim.origin[f] ?? null) !== (origin[f] ?? null)) problems.push(`claim origin: ${f} differs from the database`);
    const st = sourceUnits(origin, opts);
    if (st.error) problems.push(st.error);
    else {
      const found = checkVerbatim(claim.quote_original, st.units);
      if (!found.verbatim) problems.push(`claim quote not found verbatim in its origin, source ${origin.id}`);
      const c = Object.fromEntries(CLAIM_FIELDS.map((f) => [f, Object.hasOwn(claim, f) ? claim[f] : null]));
      problems.push(...candidateProblems({ ...c, unit: found.verbatim_unit ?? 1, locator: claim.origin.locator }, {}).map((p) => `claim: ${p}`));
    }
  }

  const sourceTexts = new Map();
  const textOf = (row) => {
    if (!sourceTexts.has(row.id)) sourceTexts.set(row.id, sourceUnits(row, opts));
    return sourceTexts.get(row.id);
  };
  // Every given source: in the database, its text readable, nothing left untranscribed (A7: stop first).
  const givenRows = new Map();
  for (const id of given) {
    const row = sourceRow(db, id);
    if (!row) { problems.push(`given source ${id} is not in the database`); continue; }
    givenRows.set(id, row);
    const st = textOf(row);
    if (st.error) problems.push(`given source ${id}: ${st.error}`);
    else if (st.missing.length > 0) problems.push(`source ${id} has units not transcribed (${st.missing.join(', ')}): get them transcribed before cutting the pack`);
  }

  // Sources: given, listed once in the given order, as the database has them, each with at least one excerpt.
  const listed = new Map();
  const docs = [];
  const texts = new Map();
  let lastGivenAt = -1;
  for (const s of Array.isArray(pack.sources) ? pack.sources : []) {
    const row = sourceRow(db, s?.source_id);
    if (!row) { problems.push(`source ${JSON.stringify(s?.source_id ?? null)} is not in the database`); continue; }
    if (listed.has(row.id)) { problems.push(`source ${row.id} is listed twice`); continue; }
    if (!isGiven(row.id)) problems.push(`source ${row.id} was not given (header.given_sources)`);
    else if (given.indexOf(row.id) < lastGivenAt) problems.push(`sources are not in the given order (ascending source id): source ${row.id} comes too late`);
    else lastGivenAt = given.indexOf(row.id);
    listed.set(row.id, row);
    for (const f of SOURCE_FIELDS) if ((s[f] ?? null) !== (row[f] ?? null)) problems.push(`source ${row.id}: ${f} differs from the database`);
    if (['platform', 'statement'].includes(row.kind)) problems.push(`source ${row.id} is a ${row.kind}, never evidence (list it under considered_not_used)`);
    if (row.kind === 'renunciation' && !REVERSAL_TYPES.includes(claim.type)) problems.push(`source ${row.id} is a reversal by the speaker, which counts only on a ${REVERSAL_TYPES.join(' or ')} (RN-1 row 1; list it under considered_not_used)`);
    docs.push({ meta: { source_id: row.id, kind: row.kind, title: row.title, publisher: row.publisher, published_on: row.published_on, url: row.url, media_type: row.media_type, sha256: row.sha256 } });
  }
  const sourceOrder = [...listed.keys()];

  const excerpts = Array.isArray(pack.excerpts) ? pack.excerpts : [];
  if (excerpts.length < 1 || excerpts.length > MAX_EXCERPTS) problems.push(`a pack has 1 to ${MAX_EXCERPTS} excerpts, this one has ${excerpts.length}`);
  const spans = [];
  excerpts.forEach((e, i) => {
    const at = `excerpt ${i + 1}`;
    const row = listed.get(e?.source_id);
    if (!row) { problems.push(`${at}: source ${JSON.stringify(e?.source_id ?? null)} is not listed in sources`); return; }
    if (!filled(e.text)) { problems.push(`${at}: text is empty`); return; }
    if (e.text.length > MAX_EXCERPT_CHARS) problems.push(`${at}: ${e.text.length} characters, over ${MAX_EXCERPT_CHARS}`);
    if (!filled(e.locator)) problems.push(`${at}: locator is empty`);
    const st = textOf(row);
    if (st.error) { problems.push(`${at}: ${st.error}`); return; }
    const placed = placeExcerpt(e.text, e.locator, e.pdf_page, st, row.id);
    problems.push(...placed.problems.map((p) => `${at}: ${p}`));
    const units = texts.get(row.id) ?? [];
    units.push({ unit: units.length + 1, text: e.text, ...(placed.label && { label: placed.label }) });
    texts.set(row.id, units);
    if (placed.unit === null) return;
    const span = locateSpan(e.text, st.units);
    if (!span) { flags.push({ excerpt: i + 1, flag: 'its boundaries could not be checked' }); return; }
    const b = boundaryProblems(span);
    for (const r of b.refuse) problems.push(`${at}: ${r} in source ${row.id} (…${span.before.slice(-12)}[${e.text.slice(0, 12)}…${e.text.slice(-12)}]${span.after.slice(0, 12)}…); cut it at whole words, whole numbers and whole sentences`);
    for (const f of b.flag) flags.push({ excerpt: i + 1, flag: f });
    spans.push({ n: i + 1, source_id: row.id, order: sourceOrder.indexOf(row.id), ...span });
  });
  for (const id of listed.keys()) if (!texts.has(id)) problems.push(`source ${id} is listed but has no excerpt`);
  // A6: a fixed order (the order of sources, then the place in the document), no repeats, no overlaps.
  for (let k = 1; k < spans.length; k++) {
    const p = spans[k - 1];
    const q = spans[k];
    if (q.order < p.order || (q.order === p.order && q.at < p.at)) {
      problems.push(`excerpt ${q.n} comes before excerpt ${p.n} in the fixed order (the order of sources, then the place in the document)`);
    }
  }
  for (const p of spans) {
    for (const q of spans) {
      if (q.n > p.n && q.source_id === p.source_id && p.at < q.end && q.at < p.end) problems.push(`excerpt ${q.n} repeats or overlaps excerpt ${p.n}`);
    }
  }

  // What was looked at and left out, for spot checks (decision 0010). Text, if given, is verbatim.
  const notUsed = new Set();
  if (!Array.isArray(pack.considered_not_used)) problems.push('considered_not_used must be a list (empty if nothing was left out)');
  (Array.isArray(pack.considered_not_used) ? pack.considered_not_used : []).forEach((e, i) => {
    const at = `considered_not_used ${i + 1}`;
    const row = sourceRow(db, e?.source_id);
    if (!row) { problems.push(`${at}: source ${JSON.stringify(e?.source_id ?? null)} is not in the database`); return; }
    if (!isGiven(row.id)) problems.push(`${at}: source ${row.id} was not given (header.given_sources)`);
    notUsed.add(row.id);
    if (!filled(e.why)) problems.push(`${at}: why is empty`);
    if (e.text === null || e.text === undefined) return;
    if (!filled(e.text)) { problems.push(`${at}: text is empty`); return; }
    const st = textOf(row);
    if (st.error) { problems.push(`${at}: ${st.error}`); return; }
    problems.push(...placeExcerpt(e.text, e.locator, e.pdf_page, st, row.id, { strictLocator: false }).problems.map((p) => `${at}: ${p}`));
  });
  if (pack.gaps !== null && pack.gaps !== undefined && typeof pack.gaps !== 'string') problems.push('gaps must be text or null');

  // read (declared by the cutter): each given source once, "all" or the units read, why when not all.
  const reads = new Map();
  if (!Array.isArray(pack.read)) problems.push('read must be a list: one entry per given source');
  (Array.isArray(pack.read) ? pack.read : []).forEach((r, i) => {
    const at = `read ${i + 1}`;
    const row = givenRows.get(r?.source_id);
    if (!row) { problems.push(`${at}: source ${JSON.stringify(r?.source_id ?? null)} was not given`); return; }
    if (reads.has(row.id)) { problems.push(`${at}: source ${row.id} is in read twice`); return; }
    const st = textOf(row);
    if (st.error) return;
    const all = new Set([...st.units.map((u) => u.unit), ...st.missing]);
    const units = parseUnitList(r.units);
    if (!units) { problems.push(`${at}: units must be "all" or unit numbers and ranges such as "1-5, 9"`); return; }
    if (units === 'all') { reads.set(row.id, new Set(st.units.map((u) => u.unit))); return; }
    const outside = sortedNums(units).filter((u) => !all.has(u) || st.missing.includes(u));
    if (outside.length > 0) problems.push(`${at}: source ${row.id} has no transcribed unit ${outside.join(', ')}`);
    const set = new Set(sortedNums(units).filter((u) => all.has(u) && !st.missing.includes(u)));
    if (set.size < st.units.length && !filled(r.not_read_why)) problems.push(`${at}: not every unit of source ${row.id} was read, so not_read_why must say why`);
    reads.set(row.id, set);
  });
  for (const id of givenRows.keys()) {
    if (!reads.has(id) && Array.isArray(pack.read)) problems.push(`source ${id} was given but is not in read`);
    if (!listed.has(id) && !notUsed.has(id)) problems.push(`source ${id} was given but is neither in sources nor in considered_not_used`);
  }
  // RN-1 row 3 and pack rule 4 (Fable review 6 re-check, R1): on a claim of a type RN-1 applies to, every given
  // reversal by the speaker (kind renunciation) is dated, not dated before the claim was made, and excerpted
  // (in sources), so a judge never meets one it cannot place.
  if (REVERSAL_TYPES.includes(claim.type)) {
    const said = claim.said_on ?? claim.origin?.published_on ?? null;
    for (const [id, row] of givenRows) {
      if (row.kind !== 'renunciation') continue;
      if (typeof row.published_on !== 'string') problems.push(`given source ${id} is a reversal by the speaker (kind renunciation) with no date: record its date before the pack is cut (RN-1 row 3)`);
      else if (typeof said === 'string' && row.published_on < said) problems.push(`given source ${id} is a reversal by the speaker (kind renunciation) dated ${row.published_on}, before the claim was made (${said}): its date or kind needs correcting (RN-1 row 3)`);
      if (!listed.has(id)) problems.push(`given source ${id} is a reversal by the speaker (kind renunciation): it is always excerpted, never left out (pack rule 4)`);
    }
  }
  for (const s of spans) {
    const read = reads.get(s.source_id);
    const unread = read ? s.units.filter((u) => !read.has(u)) : [];
    if (unread.length > 0) problems.push(`excerpt ${s.n}: unit ${unread.join(', ')} of source ${s.source_id} is not declared read`);
  }

  // Rule 2's two lists (A9), and transcription doubts (A7: a doubt stops the pack). Neither reaches the judges.
  if (!filled(pack.before_reading?.met) || !filled(pack.before_reading?.not_met)) {
    problems.push('before_reading must give both lists of rule 2: what would show the criteria met, and not met or only partly met');
  }
  if (!Array.isArray(pack.transcription_doubts)) problems.push('transcription_doubts must be a list (empty if none)');
  else {
    pack.transcription_doubts.forEach((d, i) => problems.push(`transcription doubt ${i + 1} (source ${JSON.stringify(d?.source_id ?? null)}${d?.pdf_page ? `, PDF page ${d.pdf_page}` : ''}): stop; the transcription is checked and fixed before the pack is cut`));
  }
  // A10: the name appears only in claim.speaker (and in verbatim text); judges see the role only.
  for (const path of speakerNamed(pack, claim.speaker)) problems.push(`the speaker's name appears in ${path}; write "the speaker"`);

  // Coverage per given source, from read (declared) and the excerpts (checked).
  for (const [id, row] of givenRows) {
    const st = textOf(row);
    if (st.error) continue;
    const excerpted = new Set(spans.filter((s) => s.source_id === id).flatMap((s) => s.units));
    const read = reads.get(id) ?? new Set();
    coverage.push({
      source_id: id, cited: listed.has(id), units: st.units.length + st.missing.length,
      excerpted: sortedNums(excerpted),
      read_not_excerpted: sortedNums(read).filter((u) => !excerpted.has(u)).length,
      not_read: st.units.map((u) => u.unit).filter((u) => !read.has(u) && !excerpted.has(u)),
      not_transcribed: [...st.missing],
    });
  }

  const tokens = estimateTokens(JSON.stringify(judgeView(pack)));
  if (tokens > MAX_PACK_TOKENS) problems.push(`the judges' view is about ${tokens} tokens, over ${MAX_PACK_TOKENS}`);
  return { problems, flags, coverage, tokens, docs, texts };
}

// ---------------------------------------------------------------- votes

/**
 * The program's checks on one vote (team/run/judge.md): fixed verdicts, the evidence rule of
 * publication_checks, an open question for to_evaluate, summaries in both languages, deadlines,
 * rules_applied, and every excerpt found verbatim in its document. `texts` maps source_id to units,
 * or to null when no text is available to compare with (then the excerpt is reported as unchecked).
 * withinUnit: each quote must lie inside one unit (one excerpt of a pack), never run across two.
 *
 * The rules are docs/methodology/verdict-standard.md (0.7) and are named by id in the messages. Deadlines
 * (DL-1, DL-3, DL-4, EA-1): deadlineProblem, shared with confirm(). Renunciation (RN-1, the truth table):
 * a renunciation is cited only in row 5 (renunciationRefusal names the row otherwise); and because a vote
 * sees every document of the pack, once a given renunciation is in its window and dated on or before
 * `today` only came_true (row 4) or not_came_true citing it (row 5) is possible (renunciationProblems).
 * That check is stricter than the ledger, which sees only the cited evidence.
 * rules_applied: a list of distinct ids of the current standard (src/standard.js); VG-1 on a vague or
 * hedged claim, RN-1 when a renunciation decided the verdict.
 * @param {{ withinUnit?: boolean, standard?: { version: string, rules: Map<string, object> } }} [options]
 */
export function voteProblems(vote, claim, docs, texts, today, { withinUnit = false, standard = loadStandard() } = {}) {
  const problems = [];
  const byId = new Map(docs.map((d) => [d.meta.source_id, d]));
  if (!VERDICTS.includes(vote?.verdict)) return ['verdict is not one of the six'];
  const { verdict } = vote;
  const evidence = Array.isArray(vote.evidence) ? vote.evidence : [];
  if (!filled(vote.reasoning)) problems.push('reasoning is empty');
  const vague = ['vague', 'hedged'].includes(claim.verifiability);
  if (vague && verdict !== 'unverifiable') problems.push('vague or hedged claim, verdict must be unverifiable (VG-1)');
  if (verdict !== 'pending' && !(filled(vote.summary_fr) && filled(vote.summary_en))) problems.push('summary missing in French or English');
  if (verdict === 'to_evaluate' && !(filled(vote.open_question_fr) && filled(vote.open_question_en))) problems.push('to_evaluate without an open question in both languages (DL-4)');
  problems.push(...rulesAppliedProblems(vote.rules_applied, standard));
  if (vague && Array.isArray(vote.rules_applied) && !vote.rules_applied.includes('VG-1')) problems.push('rules_applied must name VG-1 on a vague or hedged claim');
  // The deadline and renunciation rules are shared with confirm() (src/rules.js). A pack's claim carries
  // the day it was said as its origin's publication date.
  const said = {
    type: claim.type, verifiability: claim.verifiability, deadline: claim.deadline ?? null,
    said_on: claim.said_on ?? claim.origin?.published_on ?? null,
  };
  const cited = evidence.map((e) => byId.get(e?.source_id)?.meta).filter(Boolean);
  const admitted = cited.filter((m) => renunciationAdmitted(m, said, verdict));
  const late = deadlineProblem(claim, verdict, today, admitted.some((m) => m.published_on <= today));
  if (late) problems.push(late);
  problems.push(...renunciationProblems(said, docs.map((d) => d.meta), cited, verdict, vote.rules_applied, today));
  const future = futureEvidence(cited, today);
  if (future) problems.push(future);
  for (const e of evidence) {
    const doc = byId.get(e?.source_id);
    if (!doc) { problems.push(`evidence cites source_id ${e?.source_id}, which was not given`); continue; }
    if (['platform', 'statement'].includes(doc.meta.kind)) problems.push(`source ${doc.meta.source_id} is a ${doc.meta.kind}, never evidence (EV-2)`);
    const refused = renunciationRefusal(doc.meta, said, verdict);
    if (refused) problems.push(refused);
    if (!filled(e.excerpt)) { problems.push(`empty excerpt for source ${doc.meta.source_id}`); continue; }
    const units = texts.get(doc.meta.source_id);
    const found = !units ? null
      : withinUnit ? units.map((u) => checkVerbatim(e.excerpt, [u])).find((f) => f.verbatim) ?? { verbatim: false, verbatim_unit: null }
        : checkVerbatim(e.excerpt, units);
    e.verbatim = found ? found.verbatim : null;
    if (e.verbatim === false) problems.push(`excerpt not found verbatim in source ${doc.meta.source_id}`);
    // Law text: the locator must name the article the excerpt starts in.
    const label = found?.verbatim ? units.find((u) => u.unit === found.verbatim_unit)?.label : undefined;
    if (label && articleKey(e.locator) !== articleKey(label)) {
      problems.push(`locator ${JSON.stringify(e.locator ?? null)} does not match where the excerpt is in source ${doc.meta.source_id} (${label})`);
    }
  }
  // EV-1, or RN-1 row 5 for not_came_true.
  const needsEvidence = ['came_true', 'partly_came_true', 'not_came_true'].includes(verdict) || (verdict === 'unverifiable' && claim.verifiability === 'measurable');
  if (needsEvidence && admitted.length === 0) {
    const kinds = evidence.map((e) => byId.get(e?.source_id)).filter(Boolean);
    const official = kinds.some((d) => OFFICIAL_KINDS.includes(d.meta.kind));
    if (!official && !twoIndependent(kinds.map((d) => d.meta))) problems.push('outcome verdict without one official document or two independent publishers (different publishers and different files) (EV-1)');
  }
  return problems;
}

/** The judge's answer fields of a vote, as the judge prompt asks for them. */
export function answerOf(json) {
  const j = json ?? {};
  return {
    verdict: j.verdict ?? null,
    evidence: Array.isArray(j.evidence) ? j.evidence.map((e) => ({ source_id: e?.source_id ?? null, excerpt: e?.excerpt ?? null, locator: e?.locator ?? null, pdf_page: e?.pdf_page ?? null })) : [],
    rules_applied: Array.isArray(j.rules_applied) ? [...j.rules_applied] : null,
    reasoning: j.reasoning ?? null,
    open_question_fr: j.open_question_fr ?? null,
    open_question_en: j.open_question_en ?? null,
    summary_fr: j.summary_fr ?? null,
    summary_en: j.summary_en ?? null,
  };
}

/**
 * Checks a vote file against the pack it answers. A vote may quote only from the pack's excerpts
 * (which are themselves verbatim in the archived originals), so a judge cannot cite from memory.
 * Each quote must lie inside one excerpt: joining the end of one excerpt to the start of the next
 * is not a passage of the document (Fable review 1, finding 9).
 *
 * The deadline is checked against `today`: the date printed in the judge input the judge read
 * (its "made" date, see src/jury.js judgeInputHeader), never a date the judge typed. Without it
 * (callers that have no judge input) the vote's created_at is used, as before judge-0.5.
 * systemSha256, when given, must equal the vote's system_sha256: the hash of the exact system
 * text (principles + judge prompt) the judge received.
 * Summaries in both languages are required for every verdict, pending included (the prompt asks
 * for them; this is stricter than publication, which needs none for pending).
 * @param checked the result of checkPack for that pack
 */
export function checkVote(vote, pack, checked, { packSha256, promptVersion, systemSha256, today } = {}) {
  const problems = [];
  if (vote?.kind !== VOTE_KIND) problems.push(`kind is not ${VOTE_KIND}`);
  if (vote?.format !== 1) problems.push('format is not 1');
  if (vote?.pack_sha256 !== packSha256) problems.push('pack_sha256 does not match the pack (the vote is about another version of it)');
  if (vote?.claim !== pack.claim?.key) problems.push(`claim ${JSON.stringify(vote?.claim ?? null)} is not the pack's claim ${pack.claim?.key}`);
  for (const f of ['provider', 'model']) if (!filled(vote?.[f])) problems.push(`${f} is empty`);
  if (!CHANNELS.includes(vote?.channel)) problems.push(`channel must be one of ${CHANNELS.join(', ')}`);
  if (vote?.promptVersion !== promptVersion) problems.push(`promptVersion ${JSON.stringify(vote?.promptVersion ?? null)} is not the current judge prompt ${promptVersion}`);
  if (systemSha256 !== undefined && vote?.system_sha256 !== systemSha256) {
    problems.push('system_sha256 does not match the current system text (principles + judge prompt) the judge input was made with');
  }
  let date = today;
  if (date === undefined) {
    const created = typeof vote?.created_at === 'string' ? new Date(vote.created_at) : null;
    if (!created || Number.isNaN(created.getTime())) return [...problems, 'created_at is not a date and time'];
    date = localDateOf(vote.created_at);
  } else if (typeof date !== 'string' || !DATE_RE.test(date)) {
    return [...problems, 'the date of the judge input is not known'];
  }
  if (checked.problems.length > 0) problems.push('the pack itself does not pass its checks');
  // voteProblems asks for summaries for every verdict but pending; a judge owes them for pending too.
  if (vote?.verdict === 'pending' && !(filled(vote.summary_fr) && filled(vote.summary_en))) {
    problems.push('summary missing in French or English (required for every verdict, pending included)');
  }
  problems.push(...voteProblems(vote, pack.claim, checked.docs, checked.texts, date, { withinUnit: true }));
  return problems;
}

// ---------------------------------------------------------------- CLI

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The units of a source as the program numbers them (Fable review 6 A4): what a cutter reads, and the
 * numbers excerpts, locators, read and coverage use. One line per unit: its number, the locator to
 * write, its text; then the units not transcribed.
 */
export function unitsListing(source, st) {
  if (st.error) return [st.error];
  const where = (u) => (st.kind === 'pdf_page' ? `pdf_page ${u.unit}, locator "p. N" as printed on the page`
    : st.kind === 'law' ? `locator "${u.label ?? '?'}"` : `locator "§${u.unit}"`);
  return [
    `source ${source.id} · ${source.kind} · ${source.title} · ${st.units.length + st.missing.length} units · text: ${st.basis}`,
    ...st.units.map((u) => `[unit ${u.unit}] ${where(u)}\n${u.text}\n`),
    `not transcribed: ${st.missing.length > 0 ? st.missing.join(', ') : 'none'}`,
  ];
}

/** data/candidates/packs-YYYYMMDD/c<id>.pack.json, the folder the desk reads. */
function defaultPackPath(claimId, now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return join(DEFAULT_TEXT_DIR, `packs-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`, `c${claimId}.pack.json`);
}

const USAGE = [
  'Usage: node src/pack.js start <claim_id> <source_id...> [--out <pack file>]   (writes the start of a pack)',
  '       node src/pack.js units <source_id>                                     (prints the units of a source)',
  '       node src/pack.js pack <evidence pack file>                             (checks a pack)',
  '       node src/pack.js candidates <candidates file>                          (rewrites the program-owned fields)',
].join('\n');

async function main(argv) {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { out: { type: 'string' } } });
  const [what, ...rest] = positionals;
  const ints = rest.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
  const usable = (what === 'start' && rest.length >= 2 && ints.every(Number.isInteger))
    || (what === 'units' && rest.length === 1 && Number.isInteger(ints[0]))
    || (['candidates', 'pack'].includes(what) && rest.length === 1 && existsSync(rest[0]));
  if (!usable) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const db = openDatabase();
  try {
    if (what === 'start') {
      const [claimId, ...sourceIds] = ints;
      const pack = startPack(db, claimId, sourceIds);
      const out = resolve(values.out ?? defaultPackPath(claimId));
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(pack, null, 2)}\n`, { flag: 'wx' }); // never over an existing pack
      console.log(`pack started: ${out}\nsession ${pack.header.session} · ${pack.header.prompt_version} · given sources ${pack.header.given_sources.join(', ')}`);
      return;
    }
    if (what === 'units') {
      const row = sourceRow(db, ints[0]);
      if (!row) { console.error(`source ${ints[0]} is not in the database`); process.exitCode = 1; return; }
      const st = sourceUnits(row);
      for (const line of unitsListing(row, st)) console.log(line);
      process.exitCode = st.error ? 1 : 0;
      return;
    }
    const file = rest[0];
    if (what === 'candidates') {
      const { problems, record } = checkCandidatesFile(db, readJson(file));
      if (problems.length === 0) writeJsonAtomic(file, record);
      for (const p of problems) console.log(`file: ${p}`);
      if (record.counts) console.log(`${record.counts.candidates} candidates, ${record.counts.verbatim_ok} verbatim, ${record.counts.with_problems} with problems, ${record.counts.duplicates} duplicates`);
      process.exitCode = problems.length === 0 ? 0 : 1;
      return;
    }
    const checked = checkPack(db, readJson(file));
    for (const p of checked.problems) console.log(p);
    for (const f of checked.flags) console.log(`flag (shown at the desk): excerpt ${f.excerpt} ${f.flag}`);
    for (const c of checked.coverage) {
      console.log(`coverage, source ${c.source_id}${c.cited ? '' : ' (not used)'}: ${c.excerpted.length} of ${c.units} units excerpted, ${c.read_not_excerpted} declared read and not excerpted, ${c.not_read.length} not read, ${c.not_transcribed.length} not transcribed`);
    }
    console.log(`${checked.problems.length === 0 ? 'pack OK' : 'pack REFUSED'}; judges' view about ${checked.tokens} tokens (cap ${MAX_PACK_TOKENS})`);
    process.exitCode = checked.problems.length === 0 ? 0 : 1;
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
