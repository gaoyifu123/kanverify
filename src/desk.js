// The local review desk (design/review-desk.md, including "总协调的决定"). Two queues:
//   A  flagged candidates: accept into the workspace claims table, or reject, skip, undo;
//   B  verdicts: read an evidence pack and its vote files, adopt a vote or edit the summary,
//      then confirm into the ledger after a 5-second undo window; or send back, reject the claim.
// Plus `auto-import`: unflagged candidates that pass the verbatim check go straight into claims.
//
// Everything the database has no place for (reject, skip, send back, removed claims, auto
// imports) is appended to data/desk/actions.jsonl, one JSON object a line, never rewritten.
//
// Security (design §10): the server listens on 127.0.0.1 only; every request must carry
// Host 127.0.0.1:<port>; every write must also carry Origin http://127.0.0.1:<port> exactly
// and the startup token in the X-Desk-Token header, with a JSON body. No CORS headers are
// ever sent. The token is printed once in the terminal and never put in a page.
//
// No model is called here (principle 8). Nothing leaves this machine.

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_EVIDENCE_DIR, evidencePath } from './archive.js';
import { openDatabase } from './db.js';
import { candidateProblems, checkVerbatim, normalizeForMatch } from './extract.js';
import { confirm, hasUnconfirmedChanges, publicationBlockers } from './ledger.js';
import { readRounds, roundsFileName, voteContext } from './jury.js';
import { publisherKey, sameSessionProblem, sessionsRecorded } from './rules.js';
import { DEFAULT_TEXT_DIR, PACK_PROMPT_PATH, VERDICTS, checkCandidatesFile, checkPack, checkVote, sha256Of, sourceUnits, voteProblems, writeJsonAtomic } from './pack.js';
import { renderCandidatePage, renderVerdictPage } from './desk-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
export const DEFAULT_LOG_PATH = resolve(ROOT, 'data/desk/actions.jsonl');
export const DEFAULT_CANDIDATES_DIR = resolve(ROOT, 'data/candidates');
const JUDGE_PROMPT_PATH = resolve(ROOT, 'team/run/judge-prompt.md');
const PRINCIPLES_PATH = resolve(ROOT, 'PRINCIPLES.md');
const ASSETS = {
  '/assets/kanverify.css': [resolve(ROOT, 'design/mockups/kanverify.css'), 'text/css; charset=utf-8'],
  '/assets/desk.css': [resolve(here, 'desk-assets/desk.css'), 'text/css; charset=utf-8'],
  '/assets/desk-client.js': [resolve(here, 'desk-assets/desk-client.js'), 'text/javascript; charset=utf-8'],
};
export const DEFAULT_PORT = 4818;
export const CONFIRM_WINDOW_MS = 5_000;
// A pending confirmation is written only if the page that started it asks within this long after
// the 5-second window. A page closed or reloaded never asks, so nothing is written (design §5.3).
export const COMMIT_GRACE_MS = 2_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_SECONDS = 24 * 3600;

// ---------------------------------------------------------------- small helpers

function filled(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
// Characters that show nothing: whitespace, the zero-width and joiner family, soft hyphen, BOM, and
// U+180E, U+2800, U+115F, U+3164 (decision 9, item 6), which neither JavaScript's trim nor the schema knows.
const BLANK_RE = /[\s\u00AD\u115F\u180E\u200B-\u200F\u2060\u2800\u3164\uFEFF]/gu;
/** True when the text has something a reader can see. */
export function deskFilled(v) {
  return typeof v === 'string' && v.replace(BLANK_RE, '').length > 0;
}
/** Local time with its UTC offset, e.g. 2026-11-22T10:31:07+01:00. */
export function localIso(d = new Date()) {
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(off / 60)}:${pad(off % 60)}`;
}
function localDate(d) {
  return localIso(d).slice(0, 10);
}
function cleanSeconds(s) {
  if (s === null || s === undefined) return null;
  if (typeof s !== 'number' || !Number.isFinite(s) || s < 0) throw new DeskError('seconds must be a non-negative number');
  return Math.min(Math.round(s), MAX_SECONDS);
}
// Figures in an excerpt (decision 0012 A3): digits of any script, a per cent or per mille sign, or a
// number written in words in French or English. "One", "un" and "une" are left out: they are mostly
// articles. Fable re-check F: numbers in words were not caught before.
const NUMBER_WORDS = [
  'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundreds?', 'thousands?', 'millions?', 'billions?', 'trillions?', 'dozens?', 'half', 'percent', 'per cent',
  'deux', 'trois', 'quatre', 'cinq', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize',
  'vingts?', 'trente', 'quarante', 'cinquante', 'soixante', 'cents?', 'mille', 'milliers?', 'milliards?', 'douzaines?',
  'moitié', 'pour cent', 'pourcentage',
];
const FIGURE_RE = new RegExp(String.raw`[\p{Nd}%‰]|(?<!\p{L})(?:${NUMBER_WORDS.join('|')})(?!\p{L})`, 'iu');
/** True when the text holds a figure: digits, %, or a number in words (French or English). */
export function hasFigures(text) {
  return typeof text === 'string' && FIGURE_RE.test(text);
}
/** A refusal the founder should read; the message is shown as is, and nothing was written. */
export class DeskError extends Error {}

/** Runs fn in a transaction; nothing is kept if it throws. Nested calls use savepoints. */
function inTransaction(db, fn) {
  const name = `desk_${randomBytes(4).toString('hex')}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    db.exec(`RELEASE ${name}`);
    return result;
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
    throw error;
  }
}
/** Runs fn and always undoes what it wrote: a look at what a change would do. */
function preview(db, fn) {
  const name = `preview_${randomBytes(4).toString('hex')}`;
  db.exec(`SAVEPOINT ${name}`);
  try {
    return fn();
  } finally {
    db.exec(`ROLLBACK TO ${name}`);
    db.exec(`RELEASE ${name}`);
  }
}

// ---------------------------------------------------------------- the action log

const ENTRY_DEFAULTS = {
  reason: null, note: null, claim_id: null, publication_id: null, fixes: null, edited: null, seconds: null, undoes: null, removed: null,
};

/** Every entry of the log, in order. A line that is not JSON (an interrupted write) is skipped. */
export function readActions(path) {
  if (!existsSync(path)) return [];
  const out = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // Only the last line can be cut short; it held nothing that was committed.
    }
  }
  return out;
}

export function appendAction(path, fields, now = new Date()) {
  mkdirSync(dirname(path), { recursive: true });
  const entry = { id: randomUUID(), at: localIso(now), by: 'founder', ...ENTRY_DEFAULTS, ...fields };
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
  return entry;
}

// Lines that record what happened around an item, not a decision on it: they never count as its last action
// (Fable re-check F: an old PDF link must not bring a sent-back item back).
const NOT_DECISIONS = new Set(['opened_original', 'round_ingested', 'tick_publisher']);

/** The log with undone entries taken out: last effective decision per queue and item. */
export function actionState(entries) {
  const undone = new Set(entries.filter((e) => e.action === 'undo' && e.undoes).map((e) => e.undoes));
  const effective = entries.filter((e) => e.action !== 'undo' && !undone.has(e.id));
  const last = new Map();
  for (const e of effective) if (!NOT_DECISIONS.has(e.action)) last.set(`${e.queue}|${e.item}`, e);
  return { undone, effective, last };
}

const ACCEPTED = new Set(['auto_accept', 'accept', 'accept_with_fixes']);
const CANDIDATE_DONE = new Set([...ACCEPTED, 'reject']);

// ---------------------------------------------------------------- candidates

const EDITABLE_FIELDS = [
  'quote_original', 'unit', 'locator', 'quote_fr', 'quote_en', 'type', 'domain', 'verifiability', 'deadline', 'deadline_basis',
  'criteria_fr', 'criteria_en', 'speaker_role_fr', 'speaker_role_en',
];

/** Should a reviewed candidate go to a person (queue A)? A consistency note alone does not. */
export function reviewFlagged(entry) {
  if (!entry) return true;
  return ['duplicate', 'possible_duplicate'].includes(entry.status)
    || (entry.flags ?? []).some((f) => f?.kind !== 'consistency_note')
    || (entry.proposed_fixes ?? []).length > 0
    || entry.needs_founder === true;
}

/** The human label of a candidate, as in the review file (s<source>-<index>). Shown, never used as a key. */
export function candidateItemId(sourceId, index) {
  return `s${sourceId}-${index}`;
}

/**
 * The key every desk decision is filed under: the candidates file's name and the SHA-256 of the
 * quote. Unlike the index it does not move when a file is regenerated or reordered. Two candidates
 * with the very same quote in one file share a key (and are the same claim).
 */
export function candidateKey(sourceFile, quote) {
  return `${sourceFile}#${sha256Of(Buffer.from(String(quote ?? ''), 'utf8'))}`;
}

function claimRowOf(subjectId, source, c) {
  return {
    subject_id: subjectId, speaker_role_fr: c.speaker_role_fr ?? null, speaker_role_en: c.speaker_role_en ?? null,
    type: c.type, domain: c.domain, quote_original: c.quote_original, lang: c.lang, quote_fr: c.quote_fr ?? null,
    quote_en: c.quote_en ?? null, said_on: source.published_on, source_id: source.id, source_locator: c.locator,
    verifiability: c.verifiability, deadline: c.deadline ?? null, deadline_basis: c.deadline_basis ?? null,
    criteria_fr: c.criteria_fr ?? null, criteria_en: c.criteria_en ?? null,
  };
}
const CLAIM_COLUMNS = Object.keys(claimRowOf(0, { id: 0, published_on: null }, {}));

function insertClaim(db, row) {
  const cols = CLAIM_COLUMNS;
  const result = db.prepare(`INSERT INTO claims (${cols.join(', ')}) VALUES (${cols.map((c) => `:${c}`).join(', ')})`).run(row);
  return Number(result.lastInsertRowid);
}

function claimInWorkspace(db, sourceId, c) {
  return db.prepare('SELECT id FROM claims WHERE source_id = ? AND quote_original = ? AND source_locator = ?')
    .get(sourceId, c.quote_original ?? '', c.locator ?? '')?.id ?? null;
}

/**
 * Problems that stop a candidate (as it stands, or after a fix or edit) from becoming a claims
 * row: verbatim check against the archived source, the page, the candidate rules, said_on.
 */
function acceptProblems(c, source, units) {
  const problems = [];
  if (!source.published_on) problems.push(`source ${source.id} has no publication date, so said_on cannot be filled in; fix the source first`);
  if (units.error) return [...problems, units.error];
  const found = checkVerbatim(c.quote_original, units.units);
  if (!found.verbatim) problems.push('the program cannot find this quote word for word in the archived original');
  else if (found.verbatim_unit !== c.unit) problems.push(`the quote is on ${unitName(units.kind)} ${found.verbatim_unit}, but the candidate says ${c.unit}`);
  problems.push(...candidateProblems(c, { unitCount: units.units.length + units.missing.length }));
  return problems;
}
function unitName(kind) {
  return kind === 'pdf_page' ? 'page' : kind === 'law' ? 'article unit' : 'paragraph';
}

/** Applies the review's proposed fixes. Throws when a fix no longer matches the candidate. */
function withFixes(c, fixes) {
  const out = { ...c };
  for (const f of fixes) {
    if (!EDITABLE_FIELDS.includes(f.field)) throw new DeskError(`a proposed fix changes ${f.field}, which the desk cannot change`);
    if ((out[f.field] ?? null) !== (f.from ?? null)) throw new DeskError(`the proposed fix for ${f.field} expects ${JSON.stringify(f.from)}, but the candidate has ${JSON.stringify(out[f.field] ?? null)}`);
    out[f.field] = f.to;
  }
  return out;
}

function withEdits(c, fields) {
  const out = { ...c };
  const edited = [];
  for (const f of EDITABLE_FIELDS) {
    if (!fields || !Object.hasOwn(fields, f)) continue;
    let v = fields[f];
    if (typeof v === 'string') v = v.trim() === '' ? null : v;
    if (f === 'unit') v = v === null ? null : Number(v);
    if (v !== null && f !== 'unit' && typeof v !== 'string') throw new DeskError(`${f} must be text`);
    if ((out[f] ?? null) !== v) edited.push(f);
    out[f] = v;
  }
  return { candidate: out, edited };
}

// ---------------------------------------------------------------- verdict queue helpers

const PACK_CLAIM_FIELDS = [
  'quote_original', 'lang', 'quote_fr', 'quote_en', 'type', 'domain', 'verifiability', 'deadline', 'deadline_basis',
  'criteria_fr', 'criteria_en', 'speaker_role_fr', 'speaker_role_en',
];

/** Everything the workspace holds about one claim: what reject_claim saves and undo restores. */
export function workspaceOf(db, claimId) {
  const claim = db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId) ?? null;
  const verdict = db.prepare('SELECT * FROM verdicts WHERE claim_id = ?').get(claimId) ?? null;
  const evidence = verdict ? db.prepare('SELECT * FROM verdict_evidence WHERE verdict_id = ? ORDER BY id').all(verdict.id).map((r) => ({ ...r })) : [];
  const jury = db.prepare('SELECT * FROM jury_votes WHERE claim_id = ? ORDER BY id').all(claimId).map((r) => ({ ...r }));
  return { claim: claim && { ...claim }, verdict: verdict && { ...verdict }, evidence, jury };
}

/** The verdict and its evidence without row ids, to compare two states. Votes are not part of it: they only grow. */
function verdictKey(state) {
  const strip = (r, ...keys) => (r ? Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))) : null);
  return JSON.stringify({
    verdict: strip(state.verdict, 'id'),
    evidence: state.evidence.map((e) => strip(e, 'id', 'verdict_id')),
  });
}

/** Puts a claim's verdict and evidence back as they were in `state`. Never touches jury_votes (decision 9). */
function restoreVerdict(db, claimId, state) {
  db.prepare('DELETE FROM verdicts WHERE claim_id = ?').run(claimId);
  if (state.verdict) {
    const v = state.verdict;
    const verdictId = Number(db.prepare(
      `INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, open_question_fr, open_question_en, based_on_round, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(claimId, v.verdict, v.summary_fr, v.summary_en, v.open_question_fr, v.open_question_en, v.based_on_round ?? null, v.decided_by).lastInsertRowid);
    const add = db.prepare('INSERT INTO verdict_evidence (verdict_id, source_id, excerpt, excerpt_fr, excerpt_en, locator) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of state.evidence) add.run(verdictId, e.source_id, e.excerpt, e.excerpt_fr, e.excerpt_en, e.locator);
  }
}

/** Identifies a claim in the log together with its id, which a deleted, never-published claim can hand on. */
export function claimQuoteSha(claim) {
  return sha256Of(Buffer.from(`${claim.source_id}\n${claim.quote_original}`, 'utf8'));
}

/** The pack excerpts a vote cites, as verdict_evidence rows: text and locator from the pack. */
export function evidenceOfVote(vote, pack, sourceLang) {
  const excerpts = pack.excerpts ?? [];
  const used = new Map();
  const loose = [];
  for (const e of vote.evidence ?? []) {
    const needle = normalizeForMatch(e?.excerpt ?? '');
    const i = excerpts.findIndex((x) => x.source_id === e?.source_id && needle.length > 0 && normalizeForMatch(x.text ?? '').includes(needle));
    if (i >= 0) used.set(i, true);
    else loose.push(e);
  }
  const rows = [...used.keys()].sort((a, b) => a - b).map((i) => {
    const x = excerpts[i];
    const lang = sourceLang(x.source_id);
    // Translations, when the translation step has added them to the pack; never into the source's own language.
    return { n: i + 1, source_id: x.source_id, excerpt: x.text, locator: x.locator, excerpt_fr: lang === 'fr' ? null : x.text_fr ?? null, excerpt_en: lang === 'en' ? null : x.text_en ?? null };
  });
  for (const e of loose) rows.push({ n: null, source_id: e.source_id, excerpt: e.excerpt, locator: e.locator, excerpt_fr: null, excerpt_en: null });
  return rows;
}

const sameText = (a, b) => (a ?? null) === (b ?? null);
function voteMatchesVerdict(vote, verdict) {
  return verdict && vote.verdict === verdict.verdict && sameText(vote.summary_fr, verdict.summary_fr) && sameText(vote.summary_en, verdict.summary_en)
    && sameText(vote.open_question_fr, verdict.open_question_fr) && sameText(vote.open_question_en, verdict.open_question_en);
}

/** Bilingual gaps, said precisely (design §5.4): which text is missing which language. */
export function bilingualGaps(state, sourceLangOf) {
  const gaps = [];
  const blank = (v) => !filled(v);
  const c = state.claim;
  if (!c) return gaps;
  if (c.lang !== 'fr' && blank(c.quote_fr)) gaps.push('quote: French translation missing');
  if (c.lang !== 'en' && blank(c.quote_en)) gaps.push('quote: English translation missing');
  state.evidence.forEach((e, i) => {
    const lang = sourceLangOf(e.source_id);
    if (lang !== 'fr' && blank(e.excerpt_fr)) gaps.push(`evidence excerpt ${i + 1}: French translation missing`);
    if (lang !== 'en' && blank(e.excerpt_en)) gaps.push(`evidence excerpt ${i + 1}: English translation missing`);
  });
  const pair = (label, fr, en) => { if (blank(fr) !== blank(en)) gaps.push(`${label}: ${blank(fr) ? 'French' : 'English'} version missing`); };
  pair('speaker role', c.speaker_role_fr, c.speaker_role_en);
  pair('criteria', c.criteria_fr, c.criteria_en);
  if (state.verdict) {
    pair('summary', state.verdict.summary_fr, state.verdict.summary_en);
    pair('what is missing', state.verdict.open_question_fr, state.verdict.open_question_en);
  }
  return gaps;
}

/** Which top-level snapshot fields differ (for "has unconfirmed changes"). */
function snapshotDiff(a, b) {
  const out = [];
  const A = JSON.parse(a);
  const B = b ? JSON.parse(b) : {};
  for (const part of ['claim', 'subject', 'origin', 'verdict']) {
    for (const k of new Set([...Object.keys(A[part] ?? {}), ...Object.keys(B[part] ?? {})])) {
      if (JSON.stringify(A[part]?.[k]) !== JSON.stringify(B[part]?.[k])) out.push(`${part}.${k}`);
    }
  }
  for (const part of ['evidence', 'jury']) if (JSON.stringify(A[part]) !== JSON.stringify(B[part])) out.push(part);
  return out;
}

// ---------------------------------------------------------------- the desk

/**
 * The desk's state and actions, without HTTP. One founder, one process.
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {string} [o.reviewPath] review-*.json with the flags; its inputs are the candidate files
 * @param {string[]} [o.packDirs] directories holding <name>.pack.json and its vote files
 */
export function createDesk({
  db, logPath = DEFAULT_LOG_PATH, reviewPath = null, packDirs = [], evidenceDir = DEFAULT_EVIDENCE_DIR, textDir = DEFAULT_TEXT_DIR,
  now = () => new Date(), confirmWindowMs = CONFIRM_WINDOW_MS,
}) {
  const opts = { evidenceDir, textDir };
  const undoStack = [];
  let pending = null;
  let abandoned = null;
  let toast = null;
  const pendingActive = () => (pending && now().getTime() - pending.startedAt <= confirmWindowMs + COMMIT_GRACE_MS ? pending : null);
  const unitsCache = new Map();
  const fileCache = new Map();

  const log = (fields) => {
    if (fields.claim_id !== null && fields.claim_id !== undefined && !fields.quote_sha256) {
      const c = db.prepare('SELECT source_id, quote_original FROM claims WHERE id = ?').get(fields.claim_id);
      if (c) fields = { ...fields, quote_sha256: claimQuoteSha(c) };
    }
    return appendAction(logPath, fields, now());
  };
  const sourceRow = (id) => db.prepare('SELECT * FROM sources WHERE id = ?').get(id) ?? null;
  const sourceLang = (id) => sourceRow(id)?.lang ?? null;
  function unitsOf(source) {
    const key = `${source.id}|${source.sha256}`;
    if (!unitsCache.has(key)) unitsCache.set(key, sourceUnits(source, opts));
    return unitsCache.get(key);
  }

  // ------------------------------------------------ queue A

  function review() {
    if (!reviewPath || !existsSync(reviewPath)) return null;
    return JSON.parse(readFileSync(reviewPath, 'utf8'));
  }

  function candidateFile(path) {
    const st = statSync(path);
    const subjects = db.prepare('SELECT count(*) AS n, max(id) AS m FROM subjects').get();
    const key = `${st.mtimeMs}|${st.size}|${subjects.n}|${subjects.m}`;
    const hit = fileCache.get(path);
    if (hit?.key === key) return hit.value;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    const { problems, record } = checkCandidatesFile(db, raw, opts);
    const value = { path, name: basename(path), raw, record, problems, source: sourceRow(raw?.source?.id) };
    fileCache.set(path, { key, value });
    return value;
  }

  /** Every flagged candidate not yet decided, in queue order (skipped ones last). */
  function candidateQueue() {
    const r = review();
    if (!r) return { items: [], files: [], reviewMissing: true };
    const { last } = actionState(readActions(logPath));
    const byId = new Map((r.candidates ?? []).map((e) => [e.id, e]));
    const byKey = new Map((r.candidates ?? []).map((e) => [candidateKey(e.source_file, e.quote_original), e]));
    const files = [];
    const items = [];
    for (const name of r.inputs ?? []) {
      const path = join(dirname(reviewPath), name);
      if (!existsSync(path)) { files.push({ name, problems: [`candidate file ${name} is missing`] }); continue; }
      const f = candidateFile(path);
      files.push({ name, problems: f.problems, source: f.source, subjectId: f.raw.subject_id ?? null });
      if (!f.source) continue;
      for (const c of f.record.candidates ?? []) {
        const id = candidateKey(name, c.quote_original);
        const label = candidateItemId(f.source.id, c.index);
        const entry = byKey.get(id) ?? null;
        const reviewMismatch = !entry;
        const checked = Array.isArray(c.problems);
        const needsPerson = reviewFlagged(entry) || reviewMismatch || f.problems.length > 0 || !checked || !c.verbatim || c.problems.length > 0;
        // Clean candidates of a file without a speaker wait for auto-import, not for the desk.
        const cleanButFileBlocked = !reviewFlagged(entry) && !reviewMismatch && checked && c.verbatim && c.problems.length === 0;
        if (!needsPerson || cleanButFileBlocked) continue;
        const lastAction = last.get(`candidate|${id}`);
        if (lastAction && CANDIDATE_DONE.has(lastAction.action)) continue;
        if (claimInWorkspace(db, f.source.id, c)) continue;
        items.push({ id, label, file: f, candidate: c, entry, reviewMismatch, skippedAt: lastAction?.action === 'skip' ? lastAction.at : null });
      }
    }
    items.sort((a, b) => (a.skippedAt ? 1 : 0) - (b.skippedAt ? 1 : 0) || (a.skippedAt ?? '').localeCompare(b.skippedAt ?? '')
      || a.file.source.id - b.file.source.id || a.candidate.index - b.candidate.index);
    return { items, files, byId };
  }

  /** One candidate with what the founder may do with it. */
  function candidateView(item) {
    const { file, candidate: c, entry } = item;
    const source = file.source;
    const units = unitsOf(source);
    const fileBlocked = file.problems.length > 0;
    const problems = fileBlocked ? [] : acceptProblems(c, source, units);
    const fixes = entry?.proposed_fixes ?? [];
    let fixProblems = [];
    if (fixes.length > 0 && !fileBlocked) {
      try {
        fixProblems = acceptProblems(withFixes(c, fixes), source, units);
      } catch (error) {
        fixProblems = [error.message];
      }
    }
    const sourceError = units.error ?? null;
    return {
      ...item, source, units, problems, fixProblems, fixes,
      canAccept: !fileBlocked && !sourceError && problems.length === 0,
      canFix: !fileBlocked && !sourceError && fixes.length > 0 && fixProblems.length === 0,
      canEdit: !fileBlocked && !sourceError && !!source.published_on,
      canReject: !sourceError,
    };
  }

  function findCandidate(id) {
    const q = candidateQueue();
    const item = q.items.find((x) => x.id === id);
    if (!item) throw new DeskError('this candidate is not in the queue (already decided, or not flagged)');
    return candidateView(item);
  }

  function acceptCandidate(view, c, action, extra, seconds) {
    const problems = acceptProblems(c, view.source, view.units);
    if (problems.length > 0) throw new DeskError(`not accepted: ${problems.join('; ')}`);
    if (claimInWorkspace(db, view.source.id, c)) throw new DeskError('this quote is already in the workspace');
    const row = claimRowOf(view.file.raw.subject_id, view.source, c);
    return inTransaction(db, () => {
      const claimId = insertClaim(db, row);
      const entry = log({ queue: 'candidate', item: view.id, label: view.label, action, claim_id: claimId, seconds, source_file: view.file.name, row, ...extra });
      undoStack.push(entry);
      return { claimId, entry };
    });
  }

  function candidateAction({ item, action, seconds, reason, note, fields }) {
    const view = findCandidate(item);
    seconds = cleanSeconds(seconds);
    if (action === 'accept') {
      if (!view.canAccept) throw new DeskError(`cannot accept: ${[...view.file.problems, ...view.problems].join('; ') || 'blocked'}`);
      const { claimId } = acceptCandidate(view, view.candidate, 'accept', {}, seconds);
      return `Accepted ${view.label} → workspace item #${claimId}. Z to undo`;
    }
    if (action === 'accept_with_fixes') {
      if (!view.canFix) throw new DeskError(`cannot apply the fixes: ${view.fixProblems.join('; ') || 'no proposed fix'}`);
      const fixed = withFixes(view.candidate, view.fixes);
      const { claimId } = acceptCandidate(view, fixed, 'accept_with_fixes', { fixes: view.fixes.map((f) => f.field) }, seconds);
      return `Accepted ${view.label} with fixes (${view.fixes.map((f) => f.field).join(", ")}) → workspace item #${claimId}. Z to undo`;
    }
    if (action === 'accept_edited') {
      if (!view.canEdit) throw new DeskError(`cannot edit: ${view.file.problems.join('; ') || view.units.error || `source ${view.source.id} has no publication date`}`);
      const { candidate, edited } = withEdits(view.candidate, fields);
      const { claimId } = acceptCandidate(view, candidate, 'accept', { edited }, seconds);
      return `Accepted ${view.label} after editing ${edited.join(', ') || 'nothing'} → workspace item #${claimId}. Z to undo`;
    }
    if (action === 'reject') {
      if (!view.canReject) throw new DeskError('the source text cannot be read; only skip is possible');
      reason = checkReason(reason, note, { needsNote: [4] });
      const entry = log({ queue: 'candidate', item, label: view.label, action: 'reject', reason, note: note || null, seconds, source_file: view.file.name });
      undoStack.push(entry);
      return `Rejected ${view.label}. Z to undo`;
    }
    if (action === 'skip') {
      const entry = log({ queue: 'candidate', item, label: view.label, action: 'skip', seconds, source_file: view.file.name });
      undoStack.push(entry);
      return `Skipped ${view.label}; it moves to the end. Z to undo`;
    }
    throw new DeskError(`unknown candidate action ${action}`);
  }

  // ------------------------------------------------ queue B
  //
  // Coordinator decision 9 (design/review-desk.md), on record format 10, as amended by the step-back of
  // 2026-11-23: the desk never infers a round from the files on disk. The jury step closes a round
  // explicitly (src/jury.js closeRound, <name>.rounds.jsonl); the desk reads only the newest closed round
  // of each pack and the vote files it lists, and ignores any other vote file. The first time the desk
  // sees a closed round whose files are intact it writes its valid votes to jury_votes once, under the
  // claim's next round number, each row carrying the pack's sha256; the `round_ingested` log line keeps
  // which closed round that was (`round_id`). Every verdict records its round in
  // verdicts.based_on_round; a verdict from an older round is stale and the item comes back to queue B,
  // published or not. A closed round whose pack or vote files changed afterwards is shown with a stop.
  //
  // Vague and hedged claims (decision 0012 A5) skip pack and jury: their only verdict is
  // "unverifiable"; the founder writes the summary and confirms directly.

  // Pack index: path -> { key, value }. A pack is read and checked again only when one of its files
  // (pack, votes, judge input), the judge prompt or the sources table changed.
  const packIndex = new Map();
  function statKey(path) {
    try {
      const st = statSync(path);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'missing';
    }
  }
  function packFiles() {
    const out = [];
    for (const dir of packDirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith('.pack.json')) continue;
        out.push({ path: join(dir, f), dir, stem: f.slice(0, -'.pack.json'.length) });
      }
    }
    return out;
  }
  // The newest closed round of a pack, read again only when its rounds file changed.
  const roundsCache = new Map();
  function newestClosed(packPath) {
    const path = roundsFileName(packPath);
    const key = statKey(path);
    const hit = roundsCache.get(path);
    if (hit?.key === key) return hit.value;
    const value = readRounds(packPath).reduce((a, r) => (!a || r.round > a.round ? r : a), null);
    roundsCache.set(path, { key, value });
    return value;
  }
  function packEntry(f, globalKey) {
    const closed = newestClosed(f.path);
    const key = [
      globalKey, statKey(f.path), statKey(join(f.dir, `${f.stem}.judge-input.md`)), closed?.id ?? 'no round',
      ...(closed?.votes ?? []).map((v) => `${v.file}=${statKey(join(f.dir, v.file))}`),
    ].join('|');
    const hit = packIndex.get(f.path);
    if (hit?.key === key) return hit.value;
    let value;
    try {
      value = { ...loadPack(f, closed), key };
    } catch (error) {
      value = { path: f.path, error: error.message };
    }
    packIndex.set(f.path, { key, value });
    return value;
  }

  /** A jury_votes row as the desk writes it from a vote. */
  const voteRow = (vote) => ({
    provider: vote.provider, model: vote.model, prompt_version: vote.promptVersion, verdict: vote.verdict, reasoning: vote.reasoning,
    open_question: vote.open_question_en ?? vote.open_question_fr ?? null, evidence_json: JSON.stringify(vote.evidence ?? []),
  });
  /** What identifies a round's votes: the counted votes, in a fixed order. */
  const roundSig = (rows) => JSON.stringify(rows.map((r) => [r.provider, r.model, r.prompt_version, r.verdict, r.reasoning, r.open_question, r.evidence_json]).map((x) => JSON.stringify(x)).sort());

  /**
   * A pack and the votes of its newest closed round (none without one). A vote file of the round that is
   * missing, or whose sha256 differs from the round's, is not read as a vote: the round cannot be
   * confirmed (`roundProblems`), and the item says so.
   */
  function loadPack({ path, dir, stem }, closed) {
    const bytes = readFileSync(path);
    const pack = JSON.parse(bytes.toString('utf8'));
    const packSha256 = sha256Of(bytes);
    const checked = checkPack(db, pack, opts);
    // The same context tallyPack uses: current prompt and system text, and the date from the judge input.
    const ctx = voteContext(path, packSha256);
    const roundProblems = [];
    if (closed && closed.pack_sha256 !== packSha256) {
      roundProblems.push(`the evidence pack changed after round ${closed.round} was closed, so its votes are about another version of it`);
    }
    const votes = (closed?.votes ?? []).map(({ file: f, sha256 }, i) => {
      const at = join(dir, f);
      if (!existsSync(at)) {
        roundProblems.push(`vote file ${f} was removed after round ${closed.round} was closed`);
        return { n: i + 1, file: f, vote: {}, valid: false, problems: ['this vote file was removed after the round was closed'] };
      }
      const b = readFileSync(at);
      if (sha256Of(b) !== sha256) {
        roundProblems.push(`vote file ${f} changed after round ${closed.round} was closed`);
        return { n: i + 1, file: f, vote: {}, valid: false, problems: ['this vote file changed after the round was closed; the vote of the round is no longer on disk'] };
      }
      let vote;
      try {
        vote = JSON.parse(b.toString('utf8'));
      } catch {
        return { n: i + 1, file: f, vote: {}, valid: false, problems: ['not valid JSON'] };
      }
      const problems = ctx.problem ? [ctx.problem] : checkVote(vote, pack, checked, ctx);
      if (`${stem}.vote-${vote?.provider}-${vote?.channel}.json` !== f) problems.push('file name does not match provider and channel');
      // Decision 0012 A2: a vote from the session that cut the pack is not independent; a pack with no program-stamped session counts no vote.
      const session = sameSessionProblem(pack, vote);
      if (session) problems.push(session);
      const unrecorded = vote?.provider === 'anthropic' && vote?.channel === 'subscription' && !sessionsRecorded(pack, vote);
      return { n: i + 1, file: f, vote, valid: problems.length === 0, problems, sessionUnrecorded: unrecorded };
    });
    // One vote per model. Two files from the same provider and model (case and spaces aside) are not
    // independent votes, and file order must not pick one: neither is counted.
    const byModel = new Map();
    for (const v of votes) {
      const key = `${String(v.vote?.provider ?? '').trim().toLowerCase()}|${String(v.vote?.model ?? '').trim().toLowerCase()}`;
      byModel.set(key, [...(byModel.get(key) ?? []), v]);
    }
    for (const group of byModel.values()) {
      if (group.length < 2) continue;
      for (const v of group) {
        v.valid = false;
        v.problems = [...v.problems, `same provider and model as vote ${group.filter((x) => x !== v).map((x) => x.n).join(', ')}; neither is counted`];
      }
    }
    const validSig = roundSig(votes.filter((v) => v.valid).map((v) => voteRow(v.vote)));
    return { path, pack, packSha256, checked, votes, closed, roundProblems, validSig, mtime: statSync(path).mtimeMs };
  }

  /** The rounds of a claim as recorded in jury_votes: round -> { pack_sha256, sig }. */
  function roundsOf(claimId) {
    const byRound = new Map();
    for (const r of db.prepare('SELECT * FROM jury_votes WHERE claim_id = ? ORDER BY round, id').all(claimId)) {
      byRound.set(r.round, [...(byRound.get(r.round) ?? []), r]);
    }
    return [...byRound.entries()].map(([round, rows]) => ({ round, pack_sha256: rows[0].pack_sha256, sig: roundSig(rows) }));
  }

  /**
   * Writes a closed round seen for the first time: its valid votes into jury_votes under the claim's next
   * round number, with the pack's sha256 (never deleted), and a log line naming the closed round.
   */
  function ingestRound(claim, p, known) {
    const round = Math.max(0, ...known.map((r) => r.round)) + 1;
    return inTransaction(db, () => {
      const add = db.prepare(
        `INSERT INTO jury_votes (claim_id, round, provider, model, prompt_version, verdict, reasoning, open_question, evidence_json, pack_sha256)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const { vote } of p.votes.filter((v) => v.valid)) {
        const r = voteRow(vote);
        add.run(claim.id, round, r.provider, r.model, r.prompt_version, r.verdict, r.reasoning, r.open_question, r.evidence_json, p.packSha256);
      }
      log({
        by: 'program', queue: 'verdict', item: `c${claim.id}`, action: 'round_ingested', claim_id: claim.id, quote_sha256: claimQuoteSha(claim), round,
        round_id: p.closed.id, closed_round: p.closed.round, pack_sha256: p.packSha256, pack_file: basename(p.path),
        votes: p.votes.map((v) => ({ file: v.file, valid: v.valid })),
      });
      return round;
    });
  }

  const isDirect = (claim) => ['vague', 'hedged'].includes(claim.verifiability);

  /** Closed round id -> the claim round it was written as, from the desk log's round_ingested lines. */
  function ingestedRounds(entries) {
    const out = new Map();
    for (const e of entries) if (e.action === 'round_ingested' && typeof e.round_id === 'string') out.set(e.round_id, e.round);
    return out;
  }

  /**
   * Reads the pack index, links packs to claims, writes closed rounds not seen before, and returns per
   * claim its pack with the newest closed round, the claim round that closed round was written as
   * (null while there is none, or none of its votes counts), and the closed round's id. Loose vote files
   * play no part. Vague and hedged claims are returned without a pack.
   */
  function scan(entries = readActions(logPath), world = worldKey()) {
    const globalKey = `${world}|${statKey(JUDGE_PROMPT_PATH)}|${statKey(PACK_PROMPT_PATH)}|${statKey(PRINCIPLES_PATH)}`;
    const allClaims = db.prepare('SELECT id, source_id, quote_original, verifiability FROM claims').all();
    const claimsByQuote = new Map();
    for (const c of allClaims) {
      const k = `${c.source_id}
${c.quote_original}`;
      claimsByQuote.set(k, [...(claimsByQuote.get(k) ?? []), c]);
    }
    const unlinked = [];
    const byClaim = new Map();
    for (const f of packFiles()) {
      const p = packEntry(f, globalKey);
      if (p.error) { unlinked.push({ path: f.path, why: `cannot read: ${p.error}` }); continue; }
      let claim = null;
      if (Number.isInteger(p.pack.claim?.claim_id)) claim = allClaims.find((c) => c.id === p.pack.claim.claim_id) ?? null;
      else {
        const found = claimsByQuote.get(`${p.pack.claim?.origin?.source_id}
${p.pack.claim?.quote_original}`) ?? [];
        if (found.length === 1) claim = found[0];
      }
      if (!claim) { unlinked.push({ path: f.path, why: 'no single workspace claim matches this pack' }); continue; }
      if (isDirect(claim)) { unlinked.push({ path: f.path, why: `item #${claim.id} is vague or hedged: it is confirmed at the desk without pack or jury` }); continue; }
      byClaim.set(claim.id, { claim, packs: [...(byClaim.get(claim.id)?.packs ?? []), p] });
    }
    const ingested = ingestedRounds(entries);
    const out = new Map();
    for (const [claimId, { claim, packs }] of byClaim) {
      const closedPacks = packs.filter((x) => x.closed);
      if (closedPacks.length === 0) {
        // No closed round yet: the item is shown with its newest pack and no votes (its stops say why).
        out.set(claimId, { claim, p: [...packs].sort((a, b) => b.mtime - a.mtime)[0], round: null, roundId: null });
        continue;
      }
      // The newest closed round over the claim's packs (one pack per claim is the normal case).
      const p = closedPacks.sort((a, b) => String(b.closed.closed_at).localeCompare(String(a.closed.closed_at)) || b.closed.round - a.closed.round)[0];
      const known = roundsOf(claimId);
      const top = known.reduce((a, r) => (r.round > (a?.round ?? 0) ? r : a), null);
      const logged = ingested.get(p.closed.id);
      let round = null;
      if (logged !== undefined && known.some((r) => r.round === logged && r.pack_sha256 === p.closed.pack_sha256)) round = logged;
      // Without the log line (log lost): the newest round in the database with the same pack and votes is this one.
      else if (top && top.pack_sha256 === p.packSha256 && top.sig === p.validSig) round = top.round;
      // Written once, and only while every file of the round is as it was closed and some vote counts.
      else if (p.roundProblems.length === 0 && p.votes.some((v) => v.valid)) round = ingestRound(claim, p, known);
      out.set(claimId, { claim, p, round, roundId: p.closed.id });
    }
    // Vague and hedged claims: every one is an item, pack or not.
    for (const c of allClaims) if (isDirect(c)) out.set(c.id, { claim: c, p: null, round: null, roundId: null, direct: true });
    return { byClaim: out, unlinked };
  }

  /** Writes vote n of a round into the workspace: verdict (decided_by jury, based on that round) and its evidence. */
  function applyVote(p, claimId, n, round) {
    const v = p.votes.find((x) => x.n === n);
    if (!v?.valid) throw new DeskError(`vote ${n} does not pass the program's checks and cannot be adopted`);
    const vote = v.vote;
    const existing = db.prepare('SELECT id FROM verdicts WHERE claim_id = ?').get(claimId);
    const fields = [vote.verdict, vote.summary_fr ?? null, vote.summary_en ?? null, vote.open_question_fr ?? null, vote.open_question_en ?? null, round];
    let verdictId;
    if (existing) {
      db.prepare(`UPDATE verdicts SET verdict = ?, summary_fr = ?, summary_en = ?, open_question_fr = ?, open_question_en = ?, based_on_round = ?, decided_by = 'jury' WHERE id = ?`).run(...fields, existing.id);
      verdictId = existing.id;
      db.prepare('DELETE FROM verdict_evidence WHERE verdict_id = ?').run(verdictId);
    } else {
      verdictId = Number(db.prepare(
        `INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, open_question_fr, open_question_en, based_on_round, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'jury')`
      ).run(claimId, ...fields).lastInsertRowid);
    }
    const add = db.prepare('INSERT INTO verdict_evidence (verdict_id, source_id, excerpt, excerpt_fr, excerpt_en, locator) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of evidenceOfVote(vote, p.pack, sourceLang)) add.run(verdictId, e.source_id, e.excerpt, e.excerpt_fr, e.excerpt_en, e.locator);
  }

  /** The judges' rules (pack.js voteProblems) applied to a workspace verdict, whoever wrote it (principle 3). */
  function verdictRuleProblems(p, claim, state) {
    if (!state.verdict) return [];
    const v = state.verdict;
    const asVote = {
      verdict: v.verdict, summary_fr: v.summary_fr, summary_en: v.summary_en, open_question_fr: v.open_question_fr,
      open_question_en: v.open_question_en, reasoning: `decided by ${v.decided_by}`,
      evidence: state.evidence.map((e) => ({ source_id: e.source_id, excerpt: e.excerpt, locator: e.locator })),
    };
    const problems = voteProblems(asVote, claim, p?.checked.docs ?? [], p?.checked.texts ?? new Map(), localDate(now()), { withinUnit: true });
    // Text made only of characters that look blank (decision 9, item 6) counts as missing.
    for (const f of ['summary_fr', 'summary_en', 'open_question_fr', 'open_question_en']) {
      if (typeof v[f] === 'string' && !deskFilled(v[f])) problems.push(`${f} looks blank`);
    }
    return problems;
  }

  /** The preview, publication checks and judges' rules for the workspace as it would be after `prepare`. */
  function publishPreview(claimId, prepare) {
    const today = localDate(now());
    return preview(db, () => {
      prepare?.();
      const snap = db.prepare('SELECT snapshot FROM publishable WHERE claim_id = ?').get(claimId)?.snapshot ?? null;
      return { blockers: publicationBlockers(db, claimId, { today }), snapshot: snap, state: workspaceOf(db, claimId) };
    });
  }

  /**
   * One verdict item: the newest round's pack and votes, the workspace, and what C would publish.
   * This is the costly part (a preview in a rolled-back savepoint, the publication checks, the judges'
   * rules); verdictView keeps it per claim until something it depends on changes.
   */
  function viewCore({ claim, p, round, direct }, ws) {
    const claimId = claim.id;
    const published = db.prepare('SELECT count(*) AS n FROM publications WHERE claim_id = ?').get(claimId).n;
    const current = db.prepare("SELECT snapshot FROM current_publications WHERE claim_id = ? AND status = 'published'").get(claimId)?.snapshot ?? null;
    const unconfirmed = hasUnconfirmedChanges(db, claimId);
    if (direct) {
      // Decision 0012 A5: no pack, no jury. The founder writes the summary; the verdict can only be "unverifiable".
      const after = publishPreview(claimId);
      const ruleProblems = verdictRuleProblems(null, ws.claim, after.state);
      const stops = [];
      if (!ws.verdict) stops.push('write the summary in French and English (E); a vague or hedged item is confirmed as “Unverifiable”, without pack or jury');
      if (after.blockers.length > 0 && !after.blockers.includes('there is no such claim')) stops.push(...after.blockers);
      if (ruleProblems.length > 0) stops.push(`the verdict breaks the rules every judge's vote must meet: ${ruleProblems.join('; ')}`);
      if (current && after.snapshot === current) stops.push('nothing has changed since the last confirmation');
      return {
        id: `c${claimId}`, claimId, direct: true, p: null, round: null, stale: false, ws, after, valid: [], tally: new Map(), unanimous: false,
        adopted: null, preselect: null, mismatch: [], stops, group: stops.length ? 2 : 0, published, unconfirmed, current, recheck: null,
        changed: unconfirmed && current ? snapshotDiff(current, after.snapshot) : [], bilingual: bilingualGaps(after.state, sourceLang),
      };
    }
    const stale = !!ws.verdict && ws.verdict.based_on_round !== round;
    const currentVerdict = stale ? null : ws.verdict;
    const valid = p.votes.filter((v) => v.valid);
    const tally = new Map();
    for (const v of valid) tally.set(v.vote.verdict, (tally.get(v.vote.verdict) ?? 0) + 1);
    const unanimous = valid.length >= 2 && tally.size === 1 && round !== null;
    const adopted = currentVerdict ? valid.find((v) => voteMatchesVerdict(v.vote, currentVerdict))?.n ?? null : null;
    const preselect = !currentVerdict && unanimous ? valid[0].n : null;
    const mismatch = PACK_CLAIM_FIELDS.filter((f) => (p.pack.claim?.[f] ?? null) !== (ws.claim[f] ?? null));
    const after = publishPreview(claimId, preselect ? () => applyVote(p, claimId, preselect, round) : null);
    const ruleProblems = verdictRuleProblems(p, ws.claim, after.state);
    const stops = [];
    if (!p.closed) stops.push('no jury round has been closed for this pack yet: when the judges have voted, run node src/jury.js tally on the pack; until then no vote is shown');
    if (p.roundProblems.length > 0) stops.push(`round ${p.closed.round} of the jury cannot be confirmed: ${p.roundProblems.join('; ')}. Run the jury again and close a new round (node src/jury.js tally)`);
    if (p.checked.problems.length > 0) stops.push('the evidence pack does not pass its checks; send it back (reason 1)');
    if (mismatch.length > 0) stops.push(`the pack's claim differs from the workspace claim (${mismatch.join(', ')}); the votes judged the pack's version`);
    if (valid.length < 2) stops.push(`only ${valid.length} vote(s) pass the program's checks; at least two different models must vote`);
    if (!currentVerdict && !preselect && valid.length >= 2) {
      stops.push(stale
        ? `new votes since your last decision: adopt one with 1–${p.votes.length}, or edit (nothing is pre-selected on a split)`
        : `the votes are split: adopt one with 1–${p.votes.length} (nothing is pre-selected on a split)`);
    }
    if (after.blockers.length > 0 && !after.blockers.includes('there is no such claim')) stops.push(...after.blockers);
    if (ruleProblems.length > 0) stops.push(`the verdict breaks the rules every judge's vote must meet: ${ruleProblems.join('; ')}`);
    if (current && after.snapshot === current) stops.push('nothing has changed since the last confirmation');
    const group = !p.closed || p.roundProblems.length > 0 || p.checked.problems.length > 0 || mismatch.length > 0 || valid.length < 2 || after.blockers.length > 0 || ruleProblems.length > 0 ? 2 : unanimous ? 0 : 1;
    return {
      id: `c${claimId}`, claimId, direct: false, p, round, verdictRound: ws.verdict?.based_on_round ?? null, stale, ws, after, valid, tally, unanimous,
      adopted, preselect, mismatch, stops, group, published, unconfirmed, current,
      recheck: stale ? (published > 0 ? 'Re-check of a published item: new votes since it was published' : 'New votes since your last decision') : null,
      changed: unconfirmed && current ? snapshotDiff(current, after.snapshot) : [],
      bilingual: bilingualGaps(after.state, sourceLang),
    };
  }

  // Originals opened in an item view (decision 0012 A3): `${claimId}|${round}|${sourceId}`, this desk run only.
  const opened = new Set();
  // Page nonces: a link to an original carries the nonce of the page it is on, so only that page can mark it opened.
  const viewNonces = new Map();
  function newViewNonce(claimId, round) {
    const nonce = randomBytes(16).toString('hex');
    viewNonces.set(nonce, { claimId, round });
    while (viewNonces.size > 200) viewNonces.delete(viewNonces.keys().next().value);
    return nonce;
  }
  /** Called when an original is served for a link from an item page. */
  function markOpened(nonce, sourceId) {
    const v = viewNonces.get(nonce);
    if (!v) return;
    const key = `${v.claimId}|${v.round}|${sourceId}`;
    if (opened.has(key)) return;
    opened.add(key);
    log({ queue: 'verdict', item: `c${v.claimId}`, action: 'opened_original', claim_id: v.claimId, round: v.round, source_id: sourceId });
  }

  /** PDF sources whose excerpts, as they would be published, contain figures (decision 0012 A3). */
  function pdfsWithFigures(state) {
    const ids = new Set();
    for (const e of state.evidence) if (hasFigures(e.excerpt) && sourceRow(e.source_id)?.media_type === 'application/pdf') ids.add(e.source_id);
    return [...ids];
  }
  /** `official` publishers used as evidence that the founder has not ticked yet (decision 0012 A4). */
  function untickedOfficials(state, ticked) {
    const out = new Map();
    for (const e of state.evidence) {
      const s = sourceRow(e.source_id);
      if (s?.kind !== 'official') continue;
      const key = publisherKey(s.publisher);
      if (!ticked.has(key) && !out.has(key)) out.set(key, { key, publisher: s.publisher, sourceId: s.id });
    }
    return [...out.values()];
  }

  // claim id -> { key, value }. The key holds everything viewCore reads: the round and its files, the
  // claim's workspace rows (verdict round included), its ledger rows, people and sources, and today's
  // date (the deadline rules depend on it).
  const viewCache = new Map();
  function verdictView(entry, actions, world) {
    const claimId = entry.claim.id;
    const ws = workspaceOf(db, claimId);
    const pubs = db.prepare('SELECT count(*) AS n, max(id) AS m FROM publications WHERE claim_id = ?').get(claimId);
    const key = JSON.stringify([entry.p?.path ?? null, entry.p?.key ?? null, entry.round, ws, pubs.n, pubs.m, world, localDate(now())]);
    let core = viewCache.get(claimId)?.key === key ? viewCache.get(claimId).value : null;
    if (!core) {
      core = viewCore(entry, ws);
      viewCache.set(claimId, { key, value: core });
    }
    const stops = [...core.stops];
    const figures = pdfsWithFigures(core.after.state);
    const toOpen = figures.filter((id) => !opened.has(`${claimId}|${core.round}|${id}`));
    if (toOpen.length > 0) stops.push(`the evidence quotes figures from a PDF: open the original first (O) — source ${toOpen.join(', source ')}; the transcription is checked by one model only`);
    const officials = untickedOfficials(core.after.state, actions.ticked);
    for (const o of officials) stops.push(`first use of the official publisher “${o.publisher}”: check that it is an official body and tick it (T)`);
    if (pendingActive() && pending.claimId !== claimId) stops.push('another confirmation is in its 5-second window; wait for it');
    const origin = actions.originOf.get(claimId) ?? null;
    return {
      ...core, roundId: entry.roundId ?? null, stops, canConfirm: stops.length === 0, figures, toOpen, officials,
      entered: origin === 'auto_accept' ? 'auto' : origin ? 'candidate' : null,
      lastAction: actions.last.get(`verdict|c${claimId}`) ?? null,
    };
  }
  /**
   * The people and sources tables, by content: a corrected name or title changes it (Fable re-check D),
   * so no cached pack check or view outlives the rows it was built from.
   */
  function worldKey() {
    const rows = [db.prepare('SELECT * FROM subjects ORDER BY id').all(), db.prepare('SELECT * FROM sources ORDER BY id').all()];
    return sha256Of(Buffer.from(JSON.stringify(rows), 'utf8'));
  }
  /** The claim's workspace rows that a send-back waits on (votes aside: a new round changes the round id). */
  function workspaceSha(claimId) {
    const { claim, verdict, evidence } = workspaceOf(db, claimId);
    return sha256Of(Buffer.from(JSON.stringify([claim, verdict, evidence]), 'utf8'));
  }
  function deskActions(entries = readActions(logPath)) {
    const actions = actionState(entries);
    actions.originOf = new Map();
    actions.ticked = new Set();
    for (const e of actions.effective) {
      if (ACCEPTED.has(e.action) && e.claim_id !== null && e.claim_id !== undefined) actions.originOf.set(e.claim_id, e.action);
      if (e.action === 'tick_publisher' && typeof e.publisher_key === 'string') actions.ticked.add(e.publisher_key);
    }
    return actions;
  }

  function verdictQueue() {
    const entries = readActions(logPath);
    const world = worldKey();
    const { byClaim, unlinked } = scan(entries, world);
    const actions = deskActions(entries);
    const items = [];
    for (const entry of byClaim.values()) {
      if (pendingActive()?.claimId === entry.claim.id) continue;
      const la = actions.last.get(`verdict|c${entry.claim.id}`);
      // Sent back: away until something it was sent back for changes: the claim, its verdict or evidence
      // (Fable re-check C: a fixed translation brings it back), or for a judged item the pack or the
      // closed round. A stray vote file outside the closed round changes nothing.
      if (la?.action === 'send_back' && la.ws_sha256 === workspaceSha(entry.claim.id)
        && (entry.direct ? la.direct === true : la.pack_sha256 === entry.p.packSha256 && la.round_id === entry.roundId)) continue;
      let view;
      try {
        view = verdictView(entry, actions, world);
      } catch (error) {
        unlinked.push({ path: entry.p?.path ?? `item #${entry.claim.id}`, why: `cannot be shown: ${error.message}` });
        continue;
      }
      // Done: the verdict is from the newest round and the ledger already says exactly this.
      if (!view.stale && view.current && view.after.snapshot === view.current) continue;
      items.push({ ...view, skippedAt: la?.action === 'skip' ? la.at : null });
    }
    items.sort((a, b) => (a.skippedAt ? 1 : 0) - (b.skippedAt ? 1 : 0) || (a.skippedAt ?? '').localeCompare(b.skippedAt ?? '')
      || a.group - b.group || a.claimId - b.claimId);
    return { items, unlinked };
  }

  function findVerdict(id) {
    const item = verdictQueue().items.find((x) => x.id === id);
    if (!item) throw new DeskError(`${id} is not in the verdict queue`);
    return item;
  }

  function verdictAction({ item, action, seconds, reason, note, vote, fields, round, source }) {
    seconds = cleanSeconds(seconds);
    const view = findVerdict(item);
    const { claimId, p } = view;
    // Adopt, edit and confirm act on the round the page showed; newer votes mean the page is out of date.
    const shown = round === undefined || round === null || round === '' ? null : Number(round);
    if (['adopt', 'edit', 'confirm'].includes(action) && shown !== view.round) {
      throw new DeskError(`new votes arrived (round ${view.round}) since this page was shown (round ${shown ?? 'none'}); look again`);
    }
    const base = {
      queue: 'verdict', item, claim_id: claimId, quote_sha256: claimQuoteSha(view.ws.claim), round: view.round,
      pack_sha256: p?.packSha256 ?? null, round_id: view.roundId ?? null, ws_sha256: workspaceSha(claimId), ...(view.direct && { direct: true }),
    };
    if (action === 'adopt') {
      if (view.direct) throw new DeskError('a vague or hedged item has no votes');
      const n = Number(vote);
      return inTransaction(db, () => {
        const before = workspaceOf(db, claimId);
        applyVote(p, claimId, n, view.round);
        const entry = log({ ...base, action: 'adopt_vote', note: `vote ${n}`, seconds, before, after: workspaceOf(db, claimId) });
        undoStack.push(entry);
        return `Adopted vote ${n} of round ${view.round} for item #${claimId}. Z to undo`;
      });
    }
    if (action === 'edit') {
      const next = {};
      for (const f of ['verdict', 'summary_fr', 'summary_en', 'open_question_fr', 'open_question_en']) {
        const v = fields?.[f];
        next[f] = deskFilled(v) ? v : null;
      }
      if (view.direct) Object.assign(next, { verdict: 'unverifiable', open_question_fr: null, open_question_en: null });
      if (!VERDICTS.includes(next.verdict)) throw new DeskError('choose one of the six verdicts');
      return inTransaction(db, () => {
        const before = workspaceOf(db, claimId);
        // A verdict from an older round is not a base to edit from: start from the pre-selected vote, or from nothing.
        if ((!before.verdict || view.stale) && view.preselect) applyVote(p, claimId, view.preselect, view.round);
        const cur = db.prepare('SELECT * FROM verdicts WHERE claim_id = ?').get(claimId);
        const baseRow = (view.stale && !view.preselect) || view.direct ? null : cur;
        const values = [next.verdict, next.summary_fr, next.summary_en, next.open_question_fr, next.open_question_en, view.round];
        const edited = baseRow ? ['verdict', 'summary_fr', 'summary_en', 'open_question_fr', 'open_question_en'].filter((f) => (baseRow[f] ?? null) !== next[f]) : ['verdict'];
        // decided_by: text-only edits keep the jury's; a changed verdict, or one with no jury at all, is the founder's (decision 6).
        const decidedBy = !baseRow || baseRow.verdict !== next.verdict ? 'human' : baseRow.decided_by;
        if (cur) {
          db.prepare('UPDATE verdicts SET verdict = ?, summary_fr = ?, summary_en = ?, open_question_fr = ?, open_question_en = ?, based_on_round = ?, decided_by = ? WHERE id = ?').run(...values, decidedBy, cur.id);
          // A stale verdict's evidence belongs to the old round; a decision without a vote has none.
          if (!baseRow) db.prepare('DELETE FROM verdict_evidence WHERE verdict_id = ?').run(cur.id);
        } else {
          db.prepare('INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, open_question_fr, open_question_en, based_on_round, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(claimId, ...values, decidedBy);
        }
        // One ruler (principle 3): the founder's verdict meets the rules a judge's vote must meet.
        const problems = verdictRuleProblems(p, before.claim, workspaceOf(db, claimId));
        if (problems.length > 0) throw new DeskError(`not saved: a judge's vote with this verdict would be refused: ${problems.join('; ')}`);
        const entry = log({ ...base, action: 'edit_verdict', edited, seconds, before, after: workspaceOf(db, claimId) });
        undoStack.push(entry);
        return `Saved the verdict of item #${claimId} (decided by ${decidedBy}). Z to undo`;
      });
    }
    if (action === 'send_back') {
      reason = checkReason(reason, note, { needsNote: [1, 2, 3, 4] });
      const entry = log({ ...base, action: 'send_back', reason, note, seconds });
      undoStack.push(entry);
      return `Sent item #${claimId} back; it returns when its pack or votes change. Z to undo`;
    }
    if (action === 'wrong_kind') {
      // Decision 0012 A4: one key sends the pack back because a source carries the wrong kind.
      if (view.direct) throw new DeskError('a vague or hedged item has no evidence');
      const id = Number(source);
      if (!(p.pack.sources ?? []).some((s) => s.source_id === id)) throw new DeskError('choose one of the sources of this pack');
      const row = sourceRow(id);
      const entry = log({
        ...base, action: 'send_back', reason: 1, seconds, wrong_kind_source: id,
        note: `wrong kind: source ${id} ("${row?.title ?? ''}", ${row?.publisher ?? ''}) is labelled ${row?.kind ?? '?'}`,
      });
      undoStack.push(entry);
      return `Sent item #${claimId} back: source ${id} has the wrong kind. Z to undo`;
    }
    if (action === 'tick_publisher') {
      const next = view.officials[0];
      if (!next) throw new DeskError('no official publisher here waits for a tick');
      const entry = log({ ...base, action: 'tick_publisher', publisher_key: next.key, publisher: next.publisher, source_id: next.sourceId, seconds });
      undoStack.push(entry);
      return `Ticked “${next.publisher}” as an official body; it will not be asked again. Z to undo`;
    }
    if (action === 'reject_claim') {
      reason = checkReason(reason, note, { needsNote: [3, 4] });
      return rejectClaim(claimId, { ...base, reason, note: note || null, seconds });
    }
    if (action === 'skip') {
      const entry = log({ ...base, action: 'skip', seconds });
      undoStack.push(entry);
      return `Skipped item #${claimId}; it moves to the end. Z to undo`;
    }
    if (action === 'confirm') {
      if (!view.canConfirm) throw new DeskError(`cannot confirm: ${view.stops.join('; ')}`);
      if (pendingActive()) throw new DeskError('another confirmation is in its 5-second window; wait for it');
      pending = {
        id: randomUUID(), claimId, item, round: view.round, direct: view.direct, adoptVote: view.preselect, snapshot: view.after.snapshot, seconds,
        startedAt: now().getTime(), packSha256: p?.packSha256 ?? null, roundId: view.roundId ?? null, quoteSha256: claimQuoteSha(view.ws.claim),
      };
      return `Item #${claimId} will be written to the ledger in ${Math.round(confirmWindowMs / 1000)} s. Z to cancel (nothing will be written)`;
    }
    throw new DeskError(`unknown verdict action ${action}`);
  }

  function rejectClaim(claimId, fields) {
    const published = db.prepare('SELECT count(*) AS n FROM publications WHERE claim_id = ?').get(claimId).n;
    if (published > 0) throw new DeskError('Published items can only be withdrawn; withdrawal is not done at the desk');
    return inTransaction(db, () => {
      const removed = workspaceOf(db, claimId);
      // Delete and log in one step: if either fails, neither is kept. The log keeps the whole item, rounds included.
      db.prepare('DELETE FROM claims WHERE id = ?').run(claimId);
      const entry = log({ ...fields, action: 'reject_claim', removed });
      undoStack.push(entry);
      return `Rejected item #${claimId}: deleted from the workspace, saved in the desk log. Z puts it back`;
    });
  }

  /** Writes the pending confirmation, if its window is over, the newest round is still the one shown, and nothing changed. */
  function commit(id) {
    if (!pending || pending.id !== id) throw new DeskError('there is no such pending confirmation; nothing was written');
    const p0 = pending;
    const elapsed = now().getTime() - p0.startedAt;
    if (elapsed < confirmWindowMs) throw new DeskError(`the ${Math.round(confirmWindowMs / 1000)}-second window is not over; nothing was written`);
    pending = null;
    if (elapsed > confirmWindowMs + COMMIT_GRACE_MS) throw new DeskError(`item #${p0.claimId}: the confirmation was abandoned (the page was closed, reloaded or asleep); nothing was written`);
    // Always, not only for a pre-selected vote: newer votes since the page was shown stop the commit.
    const entry = scan().byClaim.get(p0.claimId);
    if (!entry || (!p0.direct && (entry.round !== p0.round || entry.roundId !== p0.roundId || entry.p.packSha256 !== p0.packSha256))) {
      throw new DeskError(`item #${p0.claimId}: new votes arrived during the window (round ${entry?.round ?? '?'}, the page showed round ${p0.round}); nothing was written`);
    }
    if (!p0.direct && entry.p.roundProblems.length > 0) {
      throw new DeskError(`item #${p0.claimId}: the files of the jury round changed during the window (${entry.p.roundProblems.join('; ')}); nothing was written`);
    }
    const publicationId = inTransaction(db, () => {
      if (p0.adoptVote) applyVote(entry.p, p0.claimId, p0.adoptVote, p0.round);
      const snap = db.prepare('SELECT snapshot FROM publishable WHERE claim_id = ?').get(p0.claimId)?.snapshot ?? null;
      if (snap !== p0.snapshot) throw new DeskError('the item changed during the window, so what would be published is not what you saw; nothing was written');
      // No date passed: confirm() applies the deadline rule on this machine's date (only tests pass one).
      const pubId = confirm(db, p0.claimId, 'founder', { reviewSeconds: p0.seconds });
      log({
        queue: 'verdict', item: p0.item, action: 'confirm', claim_id: p0.claimId, quote_sha256: p0.quoteSha256, round: p0.round,
        adopted_vote: p0.adoptVote, publication_id: pubId, pack_sha256: p0.packSha256, round_id: p0.roundId,
      });
      return pubId;
    });
    undoStack.push({ action: 'confirm', claim_id: p0.claimId, publication_id: publicationId });
    return { publicationId, claimId: p0.claimId, seconds: p0.seconds };
  }

  // ------------------------------------------------ undo

  function undo() {
    if (pending) {
      const { claimId, item } = pending;
      pending = null;
      abandoned = null;
      return { toast: `Cancelled: item #${claimId} was not written to the ledger.`, queue: 'verdict', item };
    }
    const top = undoStack.at(-1);
    if (!top) throw new DeskError('nothing to undo since the desk was started');
    if (top.action === 'confirm') throw new DeskError(`Written to the ledger (item #${top.claim_id}, entry #${top.publication_id}); it can only be withdrawn in the workspace`);
    const done = inTransaction(db, () => {
      let toastText;
      let item = top.item;
      let claimId = top.claim_id;
      if (ACCEPTED.has(top.action)) {
        const row = db.prepare('SELECT * FROM claims WHERE id = ?').get(top.claim_id);
        const untouched = row && CLAIM_COLUMNS.every((c) => (row[c] ?? null) === (top.row[c] ?? null));
        const follows = db.prepare('SELECT (SELECT count(*) FROM verdicts WHERE claim_id = ?) + (SELECT count(*) FROM jury_votes WHERE claim_id = ?) + (SELECT count(*) FROM publications WHERE claim_id = ?) AS n').get(top.claim_id, top.claim_id, top.claim_id).n;
        if (!untouched || follows > 0) throw new DeskError(`This item has later changes; edit it in the workspace (item #${top.claim_id})`);
        db.prepare('DELETE FROM claims WHERE id = ?').run(top.claim_id);
        toastText = `Undone: ${top.label ?? top.item} is back in the queue (workspace item #${top.claim_id} deleted).`;
      } else if (top.action === 'reject_claim') {
        const r = top.removed;
        const { id: _id, ...claim } = r.claim;
        claimId = insertClaim(db, Object.fromEntries(CLAIM_COLUMNS.map((c) => [c, claim[c] ?? null])));
        restoreVerdict(db, claimId, r);
        // The item comes back with its own rounds, under the same numbers and pack hashes.
        const vote = db.prepare(
          `INSERT INTO jury_votes (claim_id, round, provider, model, prompt_version, verdict, reasoning, open_question, evidence_json, pack_sha256)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const j of r.jury) vote.run(claimId, j.round, j.provider, j.model, j.prompt_version, j.verdict, j.reasoning, j.open_question, j.evidence_json, j.pack_sha256);
        item = `c${claimId}`;
        toastText = `Undone: the item is back in the workspace as #${claimId}.`;
      } else if (top.action === 'adopt_vote' || top.action === 'edit_verdict') {
        // Only the verdict (with the round it was based on) and its evidence go back; votes and rounds are never removed.
        if (verdictKey(workspaceOf(db, top.claim_id)) !== verdictKey(top.after)) throw new DeskError(`the verdict of item #${top.claim_id} has changed since; edit it in the workspace`);
        restoreVerdict(db, top.claim_id, top.before);
        toastText = `Undone: the verdict of item #${top.claim_id} is as it was.`;
      } else {
        toastText = `Undone: ${top.action.replace('_', ' ')} of ${top.label ?? top.item}.`;
      }
      log({ queue: top.queue, item: top.item, action: 'undo', undoes: top.id, claim_id: claimId });
      return { toast: toastText, queue: top.queue, item };
    });
    undoStack.pop();
    return done;
  }

  // ------------------------------------------------ today

  function today() {
    const day = localDate(now());
    const { effective } = actionState(readActions(logPath));
    const todays = effective.filter((e) => typeof e.at === 'string' && e.at.slice(0, 10) === day);
    const count = (...actions) => todays.filter((e) => actions.includes(e.action)).length;
    const pubs = db.prepare("SELECT confirmed_at, review_seconds FROM publications WHERE status = 'published'").all()
      .filter((r) => localDate(new Date(r.confirmed_at)) === day);
    const candSecs = todays.filter((e) => e.queue === 'candidate' && e.by === 'founder' && Number.isFinite(e.seconds)).map((e) => e.seconds);
    const verdSecs = [
      ...todays.filter((e) => e.queue === 'verdict' && e.action !== 'confirm' && Number.isFinite(e.seconds)).map((e) => e.seconds),
      ...pubs.filter((r) => r.review_seconds !== null).map((r) => r.review_seconds),
    ];
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    const avg = (a) => (a.length ? Math.round(sum(a) / a.length) : null);
    return {
      autoAccepted: count('auto_accept'), accepted: count('accept', 'accept_with_fixes'), rejected: count('reject'),
      confirmed: pubs.length, rejectedClaims: count('reject_claim'), sentBack: count('send_back'),
      minutes: Math.round((sum(candSecs) + sum(verdSecs)) / 60), candidateAvg: avg(candSecs), verdictAvg: avg(verdSecs),
    };
  }

  // ------------------------------------------------ pages

  /** What a page says about a confirmation in its window. The page never gets the pending id: only the page that pressed C can commit. */
  function pendingInfo() {
    if (pendingActive()) return { claimId: pending.claimId, state: 'active' };
    if (pending) return { claimId: pending.claimId, state: 'abandoned' };
    if (abandoned) return { claimId: abandoned.claimId, state: 'abandoned' };
    return null;
  }
  /**
   * A full page load that does not come from the view that pressed C ends that confirmation's window
   * at once: the view was reloaded or left, and design §5.3 says nothing is written then. The safe
   * direction, so it may happen on a GET; it writes nothing anywhere.
   */
  function pageLoaded(viewId) {
    if (pendingActive() && viewId !== pending.id) {
      abandoned = { claimId: pending.claimId };
      pending = null;
    }
  }

  /** Called before every write: clears the last toast and drops a confirmation whose page never came back. */
  function beginWrite() {
    toast = null;
    abandoned = null;
    if (pending && !pendingActive()) {
      abandoned = { claimId: pending.claimId };
      pending = null;
    }
  }

  function candidatePage(wanted) {
    const q = candidateQueue();
    const vq = verdictQueue();
    const chosen = q.items.find((x) => x.id === wanted) ?? q.items[0] ?? null;
    const view = chosen ? candidateView(chosen) : null;
    const sameSource = view ? q.items.filter((x) => x.file.source.id === view.source.id) : [];
    return renderCandidatePage({
      today: today(), counts: { candidates: q.items.length, verdicts: vq.items.length }, toast: toast?.queue === 'candidate' ? toast.text : null, pending: pendingInfo(),
      view, files: q.files, reviewMissing: !!q.reviewMissing, byId: q.byId ?? new Map(),
      position: view ? { n: sameSource.indexOf(chosen) + 1, of: sameSource.length } : null,
      onlySkipped: q.items.length > 0 && q.items.every((x) => x.skippedAt),
    });
  }

  /** @param {{ nonce?: boolean }} [o] false for a page another site loaded: it cannot read the page, so it gets no link nonce (Fable re-check F) */
  function verdictPage(wanted, { nonce = true } = {}) {
    const vq = verdictQueue();
    const q = candidateQueue();
    const chosen = vq.items.find((x) => x.id === wanted) ?? vq.items[0] ?? null;
    const subject = chosen ? db.prepare('SELECT * FROM subjects WHERE id = ?').get(chosen.ws.claim.subject_id) : null;
    const origin = chosen ? sourceRow(chosen.ws.claim.source_id) : null;
    const sources = new Map();
    if (chosen?.p) for (const s of [...(chosen.p.pack.sources ?? []), ...(chosen.p.pack.considered_not_used ?? [])]) {
      const row = sourceRow(s.source_id);
      if (row) sources.set(row.id, row);
    }
    return renderVerdictPage({
      today: today(), counts: { candidates: q.items.length, verdicts: vq.items.length }, toast: toast?.queue === 'verdict' ? toast.text : null, pending: pendingInfo(),
      view: chosen, subject, origin, sources, originUnits: chosen && (chosen.entered === 'auto' || chosen.direct) && origin ? unitsOf(origin) : null,
      viewNonce: chosen && nonce ? newViewNonce(chosen.claimId, chosen.round) : null,
      position: chosen ? { n: vq.items.indexOf(chosen) + 1, of: vq.items.length } : null, unlinked: vq.unlinked,
      onlySkipped: vq.items.length > 0 && vq.items.every((x) => x.skippedAt),
    });
  }

  return {
    candidateQueue, candidateView: (id) => findCandidate(id), verdictQueue, verdictView: (id) => findVerdict(id),
    candidateAction, verdictAction, commit, undo, today, candidatePage, verdictPage,
    setToast: (text, queue) => { toast = text ? { text, queue } : null; },
    pageLoaded,
    beginWrite,
    markOpened,
    get pending() { return pending; },
    sourceRow,
  };
}

function checkReason(reason, note, { needsNote }) {
  const r = Number(reason);
  if (![1, 2, 3, 4].includes(r)) throw new DeskError('choose a reason, 1 to 4');
  if (needsNote.includes(r) && !filled(note)) throw new DeskError(`reason ${r} needs a sentence`);
  return r;
}

// ---------------------------------------------------------------- auto-import

/**
 * Inserts every candidate of one file that the review did not flag and that passes the
 * verbatim check and the candidate rules, logging each as auto_accept (by: program).
 * The file's subject_id is used; `subject` fills it in (and is written into the file) when absent.
 */
export function autoImport(db, candidatesPath, { subject = null, reviewPath, logPath = DEFAULT_LOG_PATH, evidenceDir = DEFAULT_EVIDENCE_DIR, textDir = DEFAULT_TEXT_DIR, now = () => new Date() } = {}) {
  const opts = { evidenceDir, textDir };
  const raw = JSON.parse(readFileSync(candidatesPath, 'utf8'));
  if (subject !== null && raw.subject_id !== undefined && raw.subject_id !== null && raw.subject_id !== subject) {
    throw new Error(`the file says subject ${raw.subject_id}, but --subject ${subject} was given; refusing`);
  }
  const subjectId = raw.subject_id ?? subject;
  if (!Number.isInteger(subjectId)) throw new Error('no speaker: the file has no subject_id; give --subject <subjects.id>');
  if (!reviewPath || !existsSync(reviewPath)) throw new Error('no review file: unflagged means "reviewed and not flagged", so a review is needed');
  const review = JSON.parse(readFileSync(reviewPath, 'utf8'));
  const name = basename(candidatesPath);
  if (!(review.inputs ?? []).includes(name)) throw new Error(`${name} is not among the inputs of ${basename(reviewPath)}; it has not been reviewed`);
  const { problems, record } = checkCandidatesFile(db, { ...raw, subject_id: subjectId }, opts);
  if (problems.length > 0) throw new Error(`the candidates file does not pass its checks: ${problems.join('; ')}`);
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(raw.source.id);
  if (!source.published_on) throw new Error(`source ${source.id} has no publication date, so said_on cannot be filled in`);
  if (raw.subject_id === undefined || raw.subject_id === null) writeJsonAtomic(candidatesPath, { ...raw, subject_id: subjectId });

  const byKey = new Map((review.candidates ?? []).map((e) => [candidateKey(e.source_file, e.quote_original), e]));
  const { last } = actionState(readActions(logPath));
  const result = { imported: [], flagged: [], failed: [], already: [] };
  for (const c of record.candidates) {
    const id = candidateKey(name, c.quote_original);
    const label = candidateItemId(source.id, c.index);
    const entry = byKey.get(id);
    if (!entry || reviewFlagged(entry)) { result.flagged.push(label); continue; }
    if (!c.verbatim || c.problems.length > 0) { result.failed.push(label); continue; }
    const done = last.get(`candidate|${id}`);
    if ((done && CANDIDATE_DONE.has(done.action)) || claimInWorkspace(db, source.id, c)) { result.already.push(label); continue; }
    const row = claimRowOf(subjectId, source, c);
    inTransaction(db, () => {
      const claimId = insertClaim(db, row);
      appendAction(logPath, { by: 'program', queue: 'candidate', item: id, label, action: 'auto_accept', claim_id: claimId, source_file: name, row }, now());
      result.imported.push({ id: label, key: id, claimId });
    });
  }
  return result;
}

// ---------------------------------------------------------------- HTTP

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

function send(res, status, type, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.end(body);
}
function sendJson(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

function tokenMatches(given, token) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new DeskError('request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1']);

/**
 * The request handler. `origin()` gives http://127.0.0.1:<port> once the server listens.
 * Exported for tests; use startDeskServer to run it.
 */
export function deskHandler(desk, { token, origin, evidenceDir = DEFAULT_EVIDENCE_DIR }) {
  return async (req, res) => {
    securityHeaders(res);
    try {
      const local = origin();
      if (!LOOPBACK.has(req.socket.remoteAddress)) return send(res, 403, 'text/plain; charset=utf-8', 'Refused: not from this machine.');
      if (req.headers.host !== local.slice('http://'.length)) return send(res, 421, 'text/plain; charset=utf-8', 'Refused: wrong Host.');
      const url = new URL(req.url, local);
      if (req.method === 'GET' || req.method === 'HEAD') return handleGet(desk, url, res, evidenceDir, req);
      if (req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed.');
      // Writes: exact Origin, the token, JSON only. No CORS headers are ever sent.
      if (req.headers.origin !== local) return sendJson(res, 403, { ok: false, error: 'Refused: wrong or missing Origin.' });
      if (!tokenMatches(req.headers['x-desk-token'], token)) return sendJson(res, 403, { ok: false, error: 'Refused: missing or wrong desk token. Open the address printed in the terminal.' });
      if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return sendJson(res, 415, { ok: false, error: 'Refused: JSON only.' });
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof DeskError ? error.message : 'Body is not JSON.' });
      }
      return handlePost(desk, url.pathname, body ?? {}, res);
    } catch (error) {
      return sendJson(res, error instanceof DeskError ? 409 : 500, { ok: false, error: `${error.message} — nothing was written.` });
    }
  };
}

function handleGet(desk, url, res, evidenceDir, req) {
  const path = url.pathname;
  // Only pages the desk's own tabs load count; another site's image or link request does not end a window.
  if (['/', '/candidates', '/verdicts'].includes(path) && req.headers['sec-fetch-site'] !== 'cross-site') {
    desk.pageLoaded(typeof req.headers['x-desk-view'] === 'string' ? req.headers['x-desk-view'] : null);
  }
  if (path === '/' || path === '/candidates') return send(res, 200, 'text/html; charset=utf-8', desk.candidatePage(url.searchParams.get('item')));
  if (path === '/verdicts') {
    return send(res, 200, 'text/html; charset=utf-8', desk.verdictPage(url.searchParams.get('item'), { nonce: req.headers['sec-fetch-site'] !== 'cross-site' }));
  }
  if (Object.hasOwn(ASSETS, path)) {
    const [file, type] = ASSETS[path];
    return send(res, 200, type, readFileSync(file));
  }
  const m = /^\/original\/(\d+)$/.exec(path);
  if (m) {
    const source = desk.sourceRow(Number(m[1]));
    // A link from an item page carries that page's nonce: serving it counts as "opened in this item view" (decision 0012 A3).
    const view = url.searchParams.get('view');
    if (!source) return send(res, 404, 'text/plain; charset=utf-8', 'No such source.');
    const file = evidencePath(evidenceDir, source.sha256);
    if (!existsSync(file)) return send(res, 404, 'text/plain; charset=utf-8', `The archived file of source ${source.id} is missing.`);
    const bytes = readFileSync(file);
    if (sha256Of(bytes) !== source.sha256) return send(res, 409, 'text/plain; charset=utf-8', `The archived file of source ${source.id} does not match its hash.`);
    const pdf = source.media_type === 'application/pdf';
    // An archived page is someone else's content: no script, an opaque origin, so it can never reach the desk.
    // A PDF is downloaded, not shown, so no browser PDF viewer runs on the desk's origin.
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'none'");
    if (pdf) res.setHeader('Content-Disposition', `attachment; filename="source-${source.id}.pdf"`);
    const type = pdf ? 'application/pdf' : ['text/html', 'application/xhtml+xml'].includes(source.media_type) ? 'text/html; charset=utf-8'
      : source.media_type === 'application/json' ? 'application/json' : 'text/plain; charset=utf-8';
    send(res, 200, type, bytes);
    // Marked only once the file was served with its hash checked (Fable re-check E).
    if (view && req.headers['sec-fetch-site'] !== 'cross-site') desk.markOpened(view, source.id);
    return undefined;
  }
  return send(res, 404, 'text/plain; charset=utf-8', 'Not found.');
}

function handlePost(desk, path, body, res) {
  desk.beginWrite();
  const pageOf = (queue, item) => `/${queue === 'verdict' ? 'verdicts' : 'candidates'}${item ? `?item=${encodeURIComponent(item)}` : ''}`;
  if (path === '/api/action') {
    const queue = body.queue === 'verdict' ? 'verdict' : body.queue === 'candidate' ? 'candidate' : null;
    if (!queue) throw new DeskError('unknown queue');
    const args = { item: String(body.item ?? ''), action: String(body.action ?? ''), seconds: body.seconds ?? null, reason: body.reason, note: typeof body.note === 'string' ? body.note : null, fields: body.fields && typeof body.fields === 'object' ? body.fields : null, vote: body.vote, round: body.round, source: body.source };
    const text = queue === 'candidate' ? desk.candidateAction(args) : desk.verdictAction(args);
    // After C the page that pressed it shows its own countdown; a stored toast would go stale.
    desk.setToast(args.action === 'confirm' ? null : text, queue);
    // Adopting or editing stays on the same item; everything else moves on.
    const stay = ['adopt', 'edit'].includes(args.action);
    // Only the page that pressed C learns the pending id; it commits after the window, or nothing is written.
    const pend = args.action === 'confirm' && desk.pending ? { id: desk.pending.id, ms: CONFIRM_WINDOW_MS, claimId: desk.pending.claimId } : null;
    return sendJson(res, 200, { ok: true, toast: text, next: pageOf(queue, stay ? args.item : null), pending: pend });
  }
  if (path === '/api/undo') {
    const r = desk.undo();
    desk.setToast(r.toast, r.queue);
    return sendJson(res, 200, { ok: true, toast: r.toast, next: pageOf(r.queue, r.item) });
  }
  if (path === '/api/commit') {
    try {
      const r = desk.commit(String(body.id ?? ''));
      const text = `Item #${r.claimId} written to the ledger, entry #${r.publicationId}${r.seconds !== null ? ` (${r.seconds} s)` : ''}. From now on it can only be withdrawn, and the withdrawal is public.`;
      desk.setToast(text, 'verdict');
      return sendJson(res, 200, { ok: true, toast: text, next: '/verdicts' });
    } catch (error) {
      const text = `Not written to the ledger: ${error.message}`;
      desk.setToast(text, 'verdict');
      return sendJson(res, 409, { ok: false, error: text, next: '/verdicts' });
    }
  }
  return sendJson(res, 404, { ok: false, error: 'Not found.' });
}

/**
 * Starts the desk on 127.0.0.1. Tries `port`, then a random free port if it is taken.
 * @returns {Promise<{ server: import('node:http').Server, url: string, origin: string, token: string }>}
 */
export function startDeskServer(desk, { port = DEFAULT_PORT, token = randomBytes(32).toString('hex'), evidenceDir = DEFAULT_EVIDENCE_DIR } = {}) {
  let origin = null;
  const server = createServer(deskHandler(desk, { token, origin: () => origin, evidenceDir }));
  const listen = (p) => new Promise((ok, fail) => {
    const onError = (e) => { server.off('listening', onListen); fail(e); };
    const onListen = () => { server.off('error', onError); ok(); };
    server.once('error', onError);
    server.once('listening', onListen);
    server.listen(p, '127.0.0.1');
  });
  return listen(port).catch((e) => {
    if (e.code !== 'EADDRINUSE' || port === 0) throw e;
    return listen(0);
  }).then(() => {
    origin = `http://127.0.0.1:${server.address().port}`;
    return { server, origin, token, url: `${origin}/#token=${token}` };
  });
}

// ---------------------------------------------------------------- CLI

function latest(dir, re) {
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((f) => re.test(f)).sort();
  return names.length ? join(dir, names.at(-1)) : null;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: {
      subject: { type: 'string' }, review: { type: 'string' }, packs: { type: 'string', multiple: true }, port: { type: 'string' },
      db: { type: 'string' }, log: { type: 'string' },
    },
  });
  const reviewPath = values.review ? resolve(values.review) : latest(DEFAULT_CANDIDATES_DIR, /^review-.*\.json$/);
  // --db and --log point the desk at another database and log (e.g. a copy for testing); default data/.
  const db = values.db ? openDatabase(resolve(values.db)) : openDatabase();
  const logPath = values.log ? resolve(values.log) : DEFAULT_LOG_PATH;
  if (positionals[0] === 'auto-import') {
    try {
      const file = positionals[1];
      if (!file || !existsSync(file)) {
        console.error('Usage: node src/desk.js auto-import <candidates file> [--subject <subjects.id>] [--review <review file>] [--db <database>] [--log <actions.jsonl>]\n       node src/desk.js [--db <database>] [--log <actions.jsonl>] [--review <file>] [--packs <dir>]... [--port <n>]');
        process.exitCode = 2;
        return;
      }
      const subject = values.subject === undefined ? null : Number(values.subject);
      if (subject !== null && !Number.isInteger(subject)) throw new Error('--subject must be a subjects.id (an integer)');
      const r = autoImport(db, resolve(file), { subject, reviewPath, logPath });
      console.log(`Imported ${r.imported.length} into the workspace; ${r.flagged.length} flagged (desk queue A); ${r.failed.length} failed a check (desk queue A); ${r.already.length} already decided.`);
    } finally {
      db.close();
    }
    return;
  }
  const packDirs = values.packs?.map((d) => resolve(d))
    ?? (existsSync(DEFAULT_CANDIDATES_DIR) ? readdirSync(DEFAULT_CANDIDATES_DIR).filter((f) => /^packs-/.test(f)).map((f) => join(DEFAULT_CANDIDATES_DIR, f)) : []);
  const desk = createDesk({ db, reviewPath, packDirs, logPath });
  // Read and check every pack once before the address is printed, so the first page is as fast as the rest
  // (about 12 s for 500 packs on this machine; afterwards only changed files are read again).
  console.log('Reading the evidence packs and votes…');
  const started = Date.now();
  const { items } = desk.verdictQueue();
  desk.candidateQueue();
  console.log(`${items.length} verdict(s) waiting; ready in ${((Date.now() - started) / 1000).toFixed(1)} s.`);
  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  const { url } = await startDeskServer(desk, { port });
  console.log('KANVERIFY review desk, on this machine only. Open this address (the part after # is a one-time token; it is never sent to the server in the URL; do not share it):');
  console.log(`  ${url}`);
  console.log(`Database: ${values.db ? resolve(values.db) : 'data/kanverify.db'}; log: ${logPath}; review file: ${reviewPath ?? '(none found)'}; pack folders: ${packDirs.length}. Ctrl+C stops the desk.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
