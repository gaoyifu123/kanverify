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
import { candidateProblems, checkVerbatim, loadPrompt, normalizeForMatch } from './extract.js';
import { confirm, hasUnconfirmedChanges, publicationBlockers } from './ledger.js';
import { DEFAULT_TEXT_DIR, VERDICTS, checkCandidatesFile, checkPack, checkVote, sha256Of, sourceUnits, voteProblems, writeJsonAtomic } from './pack.js';
import { renderCandidatePage, renderVerdictPage } from './desk-view.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
export const DEFAULT_LOG_PATH = resolve(ROOT, 'data/desk/actions.jsonl');
export const DEFAULT_CANDIDATES_DIR = resolve(ROOT, 'data/candidates');
const JUDGE_PROMPT_PATH = resolve(ROOT, 'team/run/judge-prompt.md');
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

/** The log with undone entries taken out: last effective action per queue and item. */
export function actionState(entries) {
  const undone = new Set(entries.filter((e) => e.action === 'undo' && e.undoes).map((e) => e.undoes));
  const effective = entries.filter((e) => e.action !== 'undo' && !undone.has(e.id));
  const last = new Map();
  for (const e of effective) last.set(`${e.queue}|${e.item}`, e);
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

/** The verdict part of a workspace state without row ids, to compare two states. */
function verdictKey(state) {
  const strip = (r, ...keys) => (r ? Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k))) : null);
  return JSON.stringify({
    verdict: strip(state.verdict, 'id'),
    evidence: state.evidence.map((e) => strip(e, 'id', 'verdict_id')),
    jury: state.jury.map((j) => strip(j, 'id')),
  });
}

function restoreVerdictState(db, claimId, state) {
  db.prepare('DELETE FROM verdicts WHERE claim_id = ?').run(claimId);
  db.prepare('DELETE FROM jury_votes WHERE claim_id = ?').run(claimId);
  if (state.verdict) {
    const v = state.verdict;
    const verdictId = Number(db.prepare(
      `INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, open_question_fr, open_question_en, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(claimId, v.verdict, v.summary_fr, v.summary_en, v.open_question_fr, v.open_question_en, v.decided_by).lastInsertRowid);
    const add = db.prepare('INSERT INTO verdict_evidence (verdict_id, source_id, excerpt, excerpt_fr, excerpt_en, locator) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of state.evidence) add.run(verdictId, e.source_id, e.excerpt, e.excerpt_fr, e.excerpt_en, e.locator);
  }
  const vote = db.prepare(
    `INSERT INTO jury_votes (claim_id, round, provider, model, prompt_version, verdict, reasoning, open_question, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const j of state.jury) vote.run(claimId, j.round, j.provider, j.model, j.prompt_version, j.verdict, j.reasoning, j.open_question, j.evidence_json);
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
  now = () => new Date(), confirmWindowMs = CONFIRM_WINDOW_MS, judgePromptPath = JUDGE_PROMPT_PATH,
}) {
  const opts = { evidenceDir, textDir };
  const undoStack = [];
  let pending = null;
  let abandoned = null;
  let toast = null;
  const pendingActive = () => (pending && now().getTime() - pending.startedAt <= confirmWindowMs + COMMIT_GRACE_MS ? pending : null);
  const unitsCache = new Map();
  const fileCache = new Map();
  const promptVersion = loadPrompt(judgePromptPath).version;

  const log = (fields) => appendAction(logPath, fields, now());
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

  function packFiles() {
    const out = [];
    for (const dir of packDirs) {
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir).sort()) if (f.endsWith('.pack.json')) out.push(join(dir, f));
    }
    return out;
  }

  function loadPack(path) {
    const bytes = readFileSync(path);
    const pack = JSON.parse(bytes.toString('utf8'));
    const packSha256 = sha256Of(bytes);
    const checked = checkPack(db, pack, opts);
    const stem = basename(path).slice(0, -'.pack.json'.length);
    const dir = dirname(path);
    const voteNames = readdirSync(dir).filter((f) => f.startsWith(`${stem}.vote-`) && f.endsWith('.json')).sort();
    const voteBytes = [];
    const votes = voteNames.map((f, i) => {
      const b = readFileSync(join(dir, f));
      voteBytes.push(f, b.toString('base64'));
      let vote;
      try {
        vote = JSON.parse(b.toString('utf8'));
      } catch {
        return { n: i + 1, file: f, vote: {}, valid: false, problems: ['not valid JSON'] };
      }
      const problems = checkVote(vote, pack, checked, { packSha256, promptVersion });
      if (`${stem}.vote-${vote?.provider}-${vote?.channel}.json` !== f) problems.push('file name does not match provider and channel');
      return { n: i + 1, file: f, vote, valid: problems.length === 0, problems };
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
    return { path, pack, packSha256, checked, votes, votesSha256: sha256Of(Buffer.from(JSON.stringify(voteBytes))) };
  }

  function claimOfPack(pack) {
    if (Number.isInteger(pack.claim?.claim_id)) return db.prepare('SELECT id FROM claims WHERE id = ?').get(pack.claim.claim_id)?.id ?? null;
    const rows = db.prepare('SELECT id FROM claims WHERE source_id = ? AND quote_original = ?').all(pack.claim?.origin?.source_id ?? -1, pack.claim?.quote_original ?? '');
    return rows.length === 1 ? rows[0].id : null;
  }

  /**
   * Records the valid votes in jury_votes. Rounds are appended, never deleted: if the latest round
   * already holds exactly these votes nothing is written, otherwise they become round max + 1.
   */
  function syncJury(claimId, votes) {
    const rowOf = ({ vote }) => ({
      provider: vote.provider, model: vote.model, prompt_version: vote.promptVersion, verdict: vote.verdict, reasoning: vote.reasoning,
      open_question: vote.open_question_en ?? vote.open_question_fr ?? null, evidence_json: JSON.stringify(vote.evidence ?? []),
    });
    const sig = (r) => JSON.stringify([r.provider, r.model, r.prompt_version, r.verdict, r.reasoning, r.open_question, r.evidence_json]);
    const rows = db.prepare('SELECT * FROM jury_votes WHERE claim_id = ?').all(claimId);
    const round = rows.reduce((m, r) => Math.max(m, r.round), 0);
    const latest = rows.filter((r) => r.round === round).map(sig).sort();
    const wanted = votes.map(rowOf);
    if (wanted.length === 0) return;
    if (round > 0 && JSON.stringify(latest) === JSON.stringify(wanted.map(sig).sort())) return;
    const add = db.prepare(
      `INSERT INTO jury_votes (claim_id, round, provider, model, prompt_version, verdict, reasoning, open_question, evidence_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of wanted) add.run(claimId, round + 1, r.provider, r.model, r.prompt_version, r.verdict, r.reasoning, r.open_question, r.evidence_json);
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
    return voteProblems(asVote, claim, p.checked.docs, p.checked.texts, localDate(now()));
  }

  /** Writes vote n into the workspace: verdict (decided_by jury), its evidence, and the valid votes. */
  function applyVote(p, claimId, n) {
    const v = p.votes.find((x) => x.n === n);
    if (!v?.valid) throw new DeskError(`vote ${n} does not pass the program's checks and cannot be adopted`);
    const vote = v.vote;
    syncJury(claimId, p.votes.filter((x) => x.valid));
    const existing = db.prepare('SELECT id FROM verdicts WHERE claim_id = ?').get(claimId);
    const fields = [vote.verdict, vote.summary_fr ?? null, vote.summary_en ?? null, vote.open_question_fr ?? null, vote.open_question_en ?? null];
    let verdictId;
    if (existing) {
      db.prepare(`UPDATE verdicts SET verdict = ?, summary_fr = ?, summary_en = ?, open_question_fr = ?, open_question_en = ?, decided_by = 'jury' WHERE id = ?`).run(...fields, existing.id);
      verdictId = existing.id;
      db.prepare('DELETE FROM verdict_evidence WHERE verdict_id = ?').run(verdictId);
    } else {
      verdictId = Number(db.prepare(
        `INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, open_question_fr, open_question_en, decided_by) VALUES (?, ?, ?, ?, ?, ?, 'jury')`
      ).run(claimId, ...fields).lastInsertRowid);
    }
    const add = db.prepare('INSERT INTO verdict_evidence (verdict_id, source_id, excerpt, excerpt_fr, excerpt_en, locator) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of evidenceOfVote(vote, p.pack, sourceLang)) add.run(verdictId, e.source_id, e.excerpt, e.excerpt_fr, e.excerpt_en, e.locator);
  }

  /** One verdict item: the pack, the votes, the workspace, and what C would publish. */
  function verdictView(p, claimId) {
    const ws = workspaceOf(db, claimId);
    const valid = p.votes.filter((v) => v.valid);
    const tally = new Map();
    for (const v of valid) tally.set(v.vote.verdict, (tally.get(v.vote.verdict) ?? 0) + 1);
    const unanimous = valid.length >= 2 && tally.size === 1;
    const adopted = ws.verdict ? valid.find((v) => voteMatchesVerdict(v.vote, ws.verdict))?.n ?? null : null;
    const preselect = !ws.verdict && unanimous ? valid[0].n : null;
    const mismatch = PACK_CLAIM_FIELDS.filter((f) => (p.pack.claim?.[f] ?? null) !== (ws.claim[f] ?? null));
    const { last, effective } = actionState(readActions(logPath));
    const published = db.prepare('SELECT count(*) AS n FROM publications WHERE claim_id = ?').get(claimId).n;

    const after = preview(db, () => {
      if (preselect) applyVote(p, claimId, preselect);
      const snap = db.prepare('SELECT snapshot FROM publishable WHERE claim_id = ?').get(claimId)?.snapshot ?? null;
      return { blockers: publicationBlockers(db, claimId), snapshot: snap, state: workspaceOf(db, claimId) };
    });
    const current = db.prepare("SELECT snapshot FROM current_publications WHERE claim_id = ? AND status = 'published'").get(claimId)?.snapshot ?? null;
    const unconfirmed = hasUnconfirmedChanges(db, claimId);
    const ruleProblems = verdictRuleProblems(p, ws.claim, after.state);
    const stops = [];
    if (p.checked.problems.length > 0) stops.push('the evidence pack does not pass its checks; send it back (reason 1)');
    if (mismatch.length > 0) stops.push(`the pack's claim differs from the workspace claim (${mismatch.join(', ')}); the votes judged the pack's version`);
    if (valid.length < 2) stops.push(`only ${valid.length} vote(s) pass the program's checks; at least two different models must vote`);
    if (!ws.verdict && !preselect && valid.length >= 2) stops.push(`the votes are split: adopt one with 1–${p.votes.length} (nothing is pre-selected on a split)`);
    if (after.blockers.length > 0 && !after.blockers.includes('there is no such claim')) stops.push(...after.blockers);
    if (ruleProblems.length > 0) stops.push(`the verdict breaks the rules every judge's vote must meet: ${ruleProblems.join('; ')}`);
    if (current && after.snapshot === current) stops.push('nothing has changed since the last confirmation');
    if (pendingActive() && pending.claimId !== claimId) stops.push('another confirmation is in its 5-second window; wait for it');
    const origin = effective.filter((e) => e.claim_id === claimId && ACCEPTED.has(e.action)).at(-1)?.action ?? null;
    const group = p.checked.problems.length > 0 || mismatch.length > 0 || valid.length < 2 || after.blockers.length > 0 || ruleProblems.length > 0 ? 2 : unanimous ? 0 : 1;
    return {
      id: `c${claimId}`, claimId, p, ws, after, valid, tally, unanimous, adopted, preselect, mismatch, stops, group,
      canConfirm: stops.length === 0, published, unconfirmed,
      changed: unconfirmed && current ? snapshotDiff(current, after.snapshot) : [],
      entered: origin === 'auto_accept' ? 'auto' : origin ? 'candidate' : null,
      lastAction: last.get(`verdict|c${claimId}`) ?? null,
      bilingual: bilingualGaps(after.state, sourceLang),
    };
  }

  function verdictQueue() {
    const items = [];
    const unlinked = [];
    for (const path of packFiles()) {
      let p;
      try {
        p = loadPack(path);
      } catch (error) {
        unlinked.push({ path, why: `cannot read: ${error.message}` });
        continue;
      }
      const claimId = claimOfPack(p.pack);
      if (!claimId) { unlinked.push({ path, why: 'no single workspace claim matches this pack' }); continue; }
      if (pendingActive()?.claimId === claimId) continue;
      let view;
      try {
        view = verdictView(p, claimId);
      } catch (error) {
        unlinked.push({ path, why: `cannot be shown: ${error.message}` });
        continue;
      }
      const la = view.lastAction;
      if (la?.action === 'send_back' && la.pack_sha256 === p.packSha256 && la.votes_sha256 === p.votesSha256) continue;
      const current = db.prepare("SELECT snapshot FROM current_publications WHERE claim_id = ? AND status = 'published'").get(claimId)?.snapshot ?? null;
      if (current && view.after.snapshot === current) continue;
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

  function verdictAction({ item, action, seconds, reason, note, vote, fields }) {
    seconds = cleanSeconds(seconds);
    const view = findVerdict(item);
    const { claimId, p } = view;
    const base = { queue: 'verdict', item, claim_id: claimId, pack_sha256: p.packSha256, votes_sha256: p.votesSha256 };
    if (action === 'adopt') {
      const n = Number(vote);
      return inTransaction(db, () => {
        const before = workspaceOf(db, claimId);
        applyVote(p, claimId, n);
        const entry = log({ ...base, action: 'adopt_vote', note: `vote ${n}`, seconds, before, after: workspaceOf(db, claimId) });
        undoStack.push(entry);
        return `Adopted vote ${n} for item #${claimId}. Z to undo`;
      });
    }
    if (action === 'edit') {
      const next = {};
      for (const f of ['verdict', 'summary_fr', 'summary_en', 'open_question_fr', 'open_question_en']) {
        const v = fields?.[f];
        next[f] = typeof v === 'string' && v.trim() !== '' ? v : null;
      }
      if (!VERDICTS.includes(next.verdict)) throw new DeskError('choose one of the six verdicts');
      return inTransaction(db, () => {
        const before = workspaceOf(db, claimId);
        if (!before.verdict && view.preselect) applyVote(p, claimId, view.preselect);
        const cur = db.prepare('SELECT * FROM verdicts WHERE claim_id = ?').get(claimId);
        const values = [next.verdict, next.summary_fr, next.summary_en, next.open_question_fr, next.open_question_en];
        const edited = cur ? ['verdict', 'summary_fr', 'summary_en', 'open_question_fr', 'open_question_en'].filter((f) => (cur[f] ?? null) !== next[f]) : ['verdict'];
        // decided_by: text-only edits keep the jury's; a changed verdict is the founder's (decision 6).
        const decidedBy = !cur || cur.verdict !== next.verdict ? 'human' : cur.decided_by;
        if (cur) db.prepare('UPDATE verdicts SET verdict = ?, summary_fr = ?, summary_en = ?, open_question_fr = ?, open_question_en = ?, decided_by = ? WHERE id = ?').run(...values, decidedBy, cur.id);
        else db.prepare('INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, open_question_fr, open_question_en, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(claimId, ...values, decidedBy);
        // One ruler (principle 3): the founder's verdict meets the rules a judge's vote must meet.
        const problems = verdictRuleProblems(p, before.claim, workspaceOf(db, claimId));
        if (problems.length > 0) throw new DeskError(`not saved: a judge's vote with this verdict would be refused: ${problems.join('; ')}`);
        syncJury(claimId, p.votes.filter((x) => x.valid));
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
        id: randomUUID(), claimId, item, adoptVote: view.preselect, snapshot: view.after.snapshot, seconds,
        startedAt: now().getTime(), packSha256: p.packSha256, votesSha256: p.votesSha256, packPath: p.path,
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
      // The whole record goes to the log first; then the claim and everything hanging from it is deleted.
      const entry = log({ ...fields, action: 'reject_claim', removed });
      db.prepare('DELETE FROM claims WHERE id = ?').run(claimId);
      undoStack.push(entry);
      return `Rejected item #${claimId}: deleted from the workspace, saved in the desk log. Z puts it back`;
    });
  }

  /** Writes the pending confirmation, if its window is over and nothing changed meanwhile. */
  function commit(id) {
    if (!pending || pending.id !== id) throw new DeskError('there is no such pending confirmation; nothing was written');
    const p0 = pending;
    const elapsed = now().getTime() - p0.startedAt;
    if (elapsed < confirmWindowMs) throw new DeskError(`the ${Math.round(confirmWindowMs / 1000)}-second window is not over; nothing was written`);
    pending = null;
    if (elapsed > confirmWindowMs + COMMIT_GRACE_MS) throw new DeskError(`item #${p0.claimId}: the confirmation was abandoned (the page was closed, reloaded or asleep); nothing was written`);
    const publicationId = inTransaction(db, () => {
      if (p0.adoptVote) {
        const p = loadPack(p0.packPath);
        if (p.packSha256 !== p0.packSha256 || p.votesSha256 !== p0.votesSha256) throw new DeskError('the pack or its votes changed during the window; nothing was written');
        applyVote(p, p0.claimId, p0.adoptVote);
      }
      const snap = db.prepare('SELECT snapshot FROM publishable WHERE claim_id = ?').get(p0.claimId)?.snapshot ?? null;
      if (snap !== p0.snapshot) throw new DeskError('the claim changed during the window, so what would be published is not what you saw; nothing was written');
      const pubId = confirm(db, p0.claimId, 'founder', { reviewSeconds: p0.seconds });
      log({ queue: 'verdict', item: p0.item, action: 'confirm', claim_id: p0.claimId, publication_id: pubId, pack_sha256: p0.packSha256, votes_sha256: p0.votesSha256 });
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
        restoreVerdictState(db, claimId, r);
        item = `c${claimId}`;
        toastText = `Undone: the item is back in the workspace as #${claimId}.`;
      } else if (top.action === 'adopt_vote' || top.action === 'edit_verdict') {
        if (verdictKey(workspaceOf(db, top.claim_id)) !== verdictKey(top.after)) throw new DeskError(`the verdict of item #${top.claim_id} has changed since; edit it in the workspace`);
        restoreVerdictState(db, top.claim_id, top.before);
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

  function verdictPage(wanted) {
    const vq = verdictQueue();
    const q = candidateQueue();
    const chosen = vq.items.find((x) => x.id === wanted) ?? vq.items[0] ?? null;
    const subject = chosen ? db.prepare('SELECT * FROM subjects WHERE id = ?').get(chosen.ws.claim.subject_id) : null;
    const origin = chosen ? sourceRow(chosen.ws.claim.source_id) : null;
    const sources = new Map();
    if (chosen) for (const s of [...(chosen.p.pack.sources ?? []), ...(chosen.p.pack.considered_not_used ?? [])]) {
      const row = sourceRow(s.source_id);
      if (row) sources.set(row.id, row);
    }
    return renderVerdictPage({
      today: today(), counts: { candidates: q.items.length, verdicts: vq.items.length }, toast: toast?.queue === 'verdict' ? toast.text : null, pending: pendingInfo(),
      view: chosen, subject, origin, sources, originUnits: chosen && chosen.entered === 'auto' && origin ? unitsOf(origin) : null,
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
  if (path === '/verdicts') return send(res, 200, 'text/html; charset=utf-8', desk.verdictPage(url.searchParams.get('item')));
  if (Object.hasOwn(ASSETS, path)) {
    const [file, type] = ASSETS[path];
    return send(res, 200, type, readFileSync(file));
  }
  const m = /^\/original\/(\d+)$/.exec(path);
  if (m) {
    const source = desk.sourceRow(Number(m[1]));
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
    return send(res, 200, type, bytes);
  }
  return send(res, 404, 'text/plain; charset=utf-8', 'Not found.');
}

function handlePost(desk, path, body, res) {
  desk.beginWrite();
  const pageOf = (queue, item) => `/${queue === 'verdict' ? 'verdicts' : 'candidates'}${item ? `?item=${encodeURIComponent(item)}` : ''}`;
  if (path === '/api/action') {
    const queue = body.queue === 'verdict' ? 'verdict' : body.queue === 'candidate' ? 'candidate' : null;
    if (!queue) throw new DeskError('unknown queue');
    const args = { item: String(body.item ?? ''), action: String(body.action ?? ''), seconds: body.seconds ?? null, reason: body.reason, note: typeof body.note === 'string' ? body.note : null, fields: body.fields && typeof body.fields === 'object' ? body.fields : null, vote: body.vote };
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
