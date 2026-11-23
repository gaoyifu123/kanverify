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

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_EVIDENCE_DIR, evidencePath } from './archive.js';
import { openDatabase } from './db.js';
import { candidateProblems, checkVerbatim, htmlToParagraphs, normalizeForMatch } from './extract.js';
import { isLegifranceSource, legifranceToUnits } from './legifrance.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TEXT_DIR = resolve(here, '../data/candidates');

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
function filled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}
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

// ---------------------------------------------------------------- evidence pack

const CLAIM_FIELDS = [
  'quote_original', 'lang', 'quote_fr', 'quote_en', 'type', 'domain', 'verifiability', 'deadline',
  'deadline_basis', 'criteria_fr', 'criteria_en', 'speaker_role_fr', 'speaker_role_en',
];
const SOURCE_FIELDS = ['kind', 'title', 'publisher', 'published_on', 'url', 'lang'];

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

/**
 * The program's checks on an evidence pack. Returns
 * { problems, tokens, docs, texts } where docs and texts are what voteProblems needs: each cited
 * source's metadata from the database, and per source the pack's excerpts as the only text a
 * vote may quote from.
 */
export function checkPack(db, pack, opts = {}) {
  const problems = [];
  if (pack?.kind !== PACK_KIND) problems.push(`kind is not ${PACK_KIND}`);
  if (pack?.format !== 1) problems.push('format is not 1');
  if (!filled(pack?.made_by?.role) || !filled(pack?.made_by?.model)) problems.push('made_by must name the role and the model that cut the pack');
  const claim = pack?.claim;
  if (!claim || typeof claim !== 'object') return { problems: [...problems, 'claim is missing'], tokens: null, docs: [], texts: new Map() };
  if (!filled(claim.key)) problems.push('claim.key is empty');
  if (!filled(claim.speaker)) problems.push('claim.speaker is empty');

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

  // Sources: listed once, as the database has them, each with at least one excerpt.
  const listed = new Map();
  const docs = [];
  const texts = new Map();
  const sourceTexts = new Map();
  for (const s of Array.isArray(pack.sources) ? pack.sources : []) {
    const row = sourceRow(db, s?.source_id);
    if (!row) { problems.push(`source ${JSON.stringify(s?.source_id ?? null)} is not in the database`); continue; }
    if (listed.has(row.id)) { problems.push(`source ${row.id} is listed twice`); continue; }
    listed.set(row.id, row);
    for (const f of SOURCE_FIELDS) if ((s[f] ?? null) !== (row[f] ?? null)) problems.push(`source ${row.id}: ${f} differs from the database`);
    if (['platform', 'statement'].includes(row.kind)) problems.push(`source ${row.id} is a ${row.kind}, never evidence (list it under considered_not_used)`);
    if (row.kind === 'renunciation' && claim.type !== 'promise') problems.push(`source ${row.id} is a renunciation, evidence only for a promise`);
    docs.push({ meta: { source_id: row.id, kind: row.kind, title: row.title, publisher: row.publisher, published_on: row.published_on, url: row.url, media_type: row.media_type } });
  }
  const textOf = (row) => {
    if (!sourceTexts.has(row.id)) sourceTexts.set(row.id, sourceUnits(row, opts));
    return sourceTexts.get(row.id);
  };

  const excerpts = Array.isArray(pack.excerpts) ? pack.excerpts : [];
  if (excerpts.length < 1 || excerpts.length > MAX_EXCERPTS) problems.push(`a pack has 1 to ${MAX_EXCERPTS} excerpts, this one has ${excerpts.length}`);
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
  });
  for (const id of listed.keys()) if (!texts.has(id)) problems.push(`source ${id} is listed but has no excerpt`);

  // What was looked at and left out, for spot checks (decision 0010). Text, if given, is verbatim.
  if (!Array.isArray(pack.considered_not_used)) problems.push('considered_not_used must be a list (empty if nothing was left out)');
  (Array.isArray(pack.considered_not_used) ? pack.considered_not_used : []).forEach((e, i) => {
    const at = `considered_not_used ${i + 1}`;
    const row = sourceRow(db, e?.source_id);
    if (!row) { problems.push(`${at}: source ${JSON.stringify(e?.source_id ?? null)} is not in the database`); return; }
    if (!filled(e.why)) problems.push(`${at}: why is empty`);
    if (e.text === null || e.text === undefined) return;
    if (!filled(e.text)) { problems.push(`${at}: text is empty`); return; }
    const st = textOf(row);
    if (st.error) { problems.push(`${at}: ${st.error}`); return; }
    problems.push(...placeExcerpt(e.text, e.locator, e.pdf_page, st, row.id, { strictLocator: false }).problems.map((p) => `${at}: ${p}`));
  });
  if (pack.gaps !== null && pack.gaps !== undefined && typeof pack.gaps !== 'string') problems.push('gaps must be text or null');

  const tokens = estimateTokens(JSON.stringify(judgeView(pack)));
  if (tokens > MAX_PACK_TOKENS) problems.push(`the judges' view is about ${tokens} tokens, over ${MAX_PACK_TOKENS}`);
  return { problems, tokens, docs, texts };
}

// ---------------------------------------------------------------- votes

/**
 * The program's checks on one vote (team/run/judge.md): fixed verdicts, the evidence rule of
 * publication_checks, an open question for to_evaluate, summaries in both languages, deadlines,
 * and every excerpt found verbatim in its document. `texts` maps source_id to units, or to null
 * when no text is available to compare with (then the excerpt is reported as unchecked).
 * withinUnit: each quote must lie inside one unit (one excerpt of a pack), never run across two.
 *
 * Deadlines (team/run/judge-prompt.md, step 2): the deadline day is still inside the deadline.
 * On or before it, only came_true, pending, unverifiable on a vague or hedged claim, and
 * not_came_true on a renounced promise; after it, never pending.
 */
export function voteProblems(vote, claim, docs, texts, today, { withinUnit = false } = {}) {
  const problems = [];
  const byId = new Map(docs.map((d) => [d.meta.source_id, d]));
  if (!VERDICTS.includes(vote?.verdict)) return ['verdict is not one of the six'];
  const { verdict } = vote;
  const evidence = Array.isArray(vote.evidence) ? vote.evidence : [];
  if (!filled(vote.reasoning)) problems.push('reasoning is empty');
  if (['vague', 'hedged'].includes(claim.verifiability) && verdict !== 'unverifiable') problems.push('vague or hedged claim, verdict must be unverifiable');
  if (verdict !== 'pending' && !(filled(vote.summary_fr) && filled(vote.summary_en))) problems.push('summary missing in French or English');
  if (verdict === 'to_evaluate' && !(filled(vote.open_question_fr) && filled(vote.open_question_en))) problems.push('to_evaluate without an open question in both languages');
  const renounced = verdict === 'not_came_true' && claim.type === 'promise'
    && evidence.some((e) => byId.get(e?.source_id)?.meta.kind === 'renunciation');
  // Before the deadline only came_true may be given early (verdict standard section 5, as
  // amended); partly_came_true waits like not_came_true, which only a renounced promise skips.
  // unverifiable on a measurable claim is only "the condition did not arise by the deadline".
  const notOver = claim.deadline && today <= claim.deadline;
  const waits = (['to_evaluate', 'partly_came_true', 'not_came_true'].includes(verdict) && !renounced)
    || (verdict === 'unverifiable' && claim.verifiability === 'measurable');
  if (notOver && waits) problems.push(`deadline ${claim.deadline} not over (not reached until the day after it), but verdict is ${verdict}`);
  if (claim.deadline && today > claim.deadline && verdict === 'pending') problems.push(`deadline ${claim.deadline} passed, but verdict is pending`);
  for (const e of evidence) {
    const doc = byId.get(e?.source_id);
    if (!doc) { problems.push(`evidence cites source_id ${e?.source_id}, which was not given`); continue; }
    if (['platform', 'statement'].includes(doc.meta.kind)) problems.push(`source ${doc.meta.source_id} is a ${doc.meta.kind}, never evidence`);
    if (doc.meta.kind === 'renunciation' && !(verdict === 'not_came_true' && claim.type === 'promise')) problems.push(`source ${doc.meta.source_id} is a renunciation, evidence only for not_came_true on a promise`);
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
  const needsEvidence = ['came_true', 'partly_came_true', 'not_came_true'].includes(verdict) || (verdict === 'unverifiable' && claim.verifiability === 'measurable');
  if (needsEvidence && !renounced) {
    const kinds = evidence.map((e) => byId.get(e?.source_id)).filter(Boolean);
    const official = kinds.some((d) => OFFICIAL_KINDS.includes(d.meta.kind));
    const publishers = new Set(kinds.filter((d) => INDEPENDENT_KINDS.includes(d.meta.kind)).map((d) => d.meta.publisher.trim().toLowerCase()));
    if (!official && publishers.size < 2) problems.push('outcome verdict without one official document or two independent publishers');
  }
  return problems;
}

/** The judge's answer fields of a vote, as the judge prompt asks for them. */
export function answerOf(json) {
  const j = json ?? {};
  return {
    verdict: j.verdict ?? null,
    evidence: Array.isArray(j.evidence) ? j.evidence.map((e) => ({ source_id: e?.source_id ?? null, excerpt: e?.excerpt ?? null, locator: e?.locator ?? null, pdf_page: e?.pdf_page ?? null })) : [],
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

async function main(argv) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const [what, file] = positionals;
  if (!['candidates', 'pack'].includes(what) || !file || !existsSync(file)) {
    console.error('Usage: node src/pack.js candidates <candidates file>   (rewrites the program-owned fields)\n       node src/pack.js pack <evidence pack file>');
    process.exitCode = 2;
    return;
  }
  const db = openDatabase();
  try {
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
