// Confirming and withdrawing: the only two ways anything becomes public.
//
// What may be published is publication_checks in db/schema.sql plus two rules the database
// cannot hold: the deadline rule, which depends on the date (src/rules.js, shared with the
// jury's vote checks), and the rules check, which reads the verdict standard of the verdict's
// version (src/standard.js; Fable review 8, finding 2). confirm() is the one way into the
// ledger and applies all three.
// These functions explain a refusal in terms a reviewer can act on.

import { deadlineProblem, futureEvidence, localToday, renunciationAdmitted } from './rules.js';
import { loadStandard, rulesAppliedProblems } from './standard.js';

// In the order a reviewer would fix them. Those in NEEDS_VERDICT only make sense once a
// verdict exists; translations come last because they are done after the content.
const CHECK_MESSAGES = [
  ['has_subject', 'the claim points at a subject that does not exist'],
  ['origin_is_own_words', "the claim's origin is missing or is not the speaker's own published words"],
  ['has_verdict', 'the claim has no verdict yet'],
  ['verdict_fits_verifiability', 'a vague or hedged claim can only be "unverifiable"'],
  ['summary_stated', 'every verdict except "pending" needs a summary explaining it'],
  ['outcome_has_evidence', 'a verdict that asserts an outcome ("came_true", "partly_came_true", "not_came_true", or "unverifiable" on a measurable claim) needs one official document, or two independent sources from different publishers, as evidence (EV-1); "not_came_true" on a measurable promise may instead rest on the speaker\'s own renunciation dated between the day the promise was made and its deadline (RN-1 row 5)'],
  ['evidence_is_primary', 'a statement, a platform, a missing source, or a renunciation outside RN-1 row 5 (cited only under "not_came_true" on a measurable promise, dated on or after the day it was made and on or before its deadline) is used as evidence; evidence must be an official document or independent reporting (EV-2)'],
  ['rules_recorded', 'the rules the verdict was judged by are not recorded as a list of distinct rule ids such as "DL-2" (decision 0014)'],
  ['bilingual', 'a published text is missing its French or English version: the quote and each evidence excerpt need a translation into French and into English, except into their own language (where there must be none); speaker role, criteria, summary and open question must be in both languages or in neither'],
];
const NEEDS_VERDICT = new Set(['verdict_fits_verifiability', 'summary_stated', 'outcome_has_evidence', 'evidence_is_primary', 'rules_recorded']);

/**
 * The deadline rule for a claim's working verdict on a given local date, or null; also refuses a cited
 * source of any kind dated after that date. The same functions the jury's vote checks use (src/rules.js).
 */
function deadlineBlocker(db, claimId, today) {
  const claim = db.prepare('SELECT type, verifiability, deadline, said_on FROM claims WHERE id = ?').get(claimId);
  const verdict = db.prepare('SELECT id, verdict FROM verdicts WHERE claim_id = ?').get(claimId);
  if (!claim || !verdict) return null;
  const sources = db
    .prepare('SELECT s.id, s.kind, s.published_on FROM verdict_evidence e JOIN sources s ON s.id = e.source_id WHERE e.verdict_id = ?')
    .all(verdict.id);
  // RN-1 row 5: a cited renunciation of the promise, in its window and not dated after today, lets
  // not_came_true come before the deadline. The ledger sees only the cited evidence, never the pack file.
  const renounced = sources.some((s) => renunciationAdmitted(s, claim, verdict.verdict) && s.published_on <= today);
  const problems = [futureEvidence(sources, today), deadlineProblem(claim, verdict.verdict, today, renounced)].filter(Boolean);
  return problems.length > 0 ? problems.join('; ') : null;
}

/**
 * The rules a verdict was judged by (decision 0014). Its version is the current verdict standard: a verdict judged under
 * an earlier one is looked at again first, as the desk asks (Fable review 8 re-check, R4); every id is a rule of it (a
 * made-up id in the append-only ledger would stop the site build for good, finding 2). Named rules the program can tell
 * decided the verdict: RN-1 when a reversal is cited (finding 5); EA-1 for "came_true" confirmed on or before the
 * deadline, which is provisional (re-check R3). Null when fine.
 */
function rulesBlocker(db, claimId, today) {
  const v = db.prepare('SELECT id, verdict, rules_version, rules_applied FROM verdicts WHERE claim_id = ?').get(claimId);
  if (!v) return null;
  const current = loadStandard();
  if (v.rules_version !== current.version) {
    return `the verdict was judged under verdict standard ${JSON.stringify(v.rules_version)}, the current one is ${current.version}: check the rules applied and save them under the current standard`;
  }
  const standard = current;
  let ids = null;
  try {
    ids = JSON.parse(v.rules_applied);
  } catch {
    // reported below: not a list of ids
  }
  const problems = rulesAppliedProblems(ids, standard);
  const reversal = db.prepare("SELECT 1 FROM verdict_evidence e JOIN sources s ON s.id = e.source_id WHERE e.verdict_id = ? AND s.kind = 'renunciation'").get(v.id);
  if (reversal && Array.isArray(ids) && !ids.includes('RN-1')) problems.push('a reversal by the speaker is cited, so RN-1 decided the verdict: rules_applied must name RN-1');
  const deadline = db.prepare('SELECT deadline FROM claims WHERE id = ?').get(claimId)?.deadline;
  if (v.verdict === 'came_true' && deadline && today <= deadline && Array.isArray(ids) && !ids.includes('EA-1')) {
    problems.push(`"came_true" on or before the deadline ${deadline} is the early, provisional verdict: rules_applied must name EA-1`);
  }
  return problems.length > 0 ? problems.join('; ') : null;
}

function checkToday(today) {
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('today must be a local date, YYYY-MM-DD');
  return today;
}

/**
 * Why a claim cannot be confirmed right now. Empty when it can.
 * @param {{ today?: string }} [options] local date for the deadline rule (default: today here)
 * @returns {string[]}
 */
export function publicationBlockers(db, claimId, { today = localToday() } = {}) {
  checkToday(today);
  const checks = db.prepare('SELECT * FROM publication_checks WHERE claim_id = ?').get(claimId);
  if (!checks) return ['there is no such claim'];
  const blockers = CHECK_MESSAGES.filter(([name]) => !checks[name] && (checks.has_verdict || !NEEDS_VERDICT.has(name))).map(
    ([, message]) => message
  );
  const late = deadlineBlocker(db, claimId, today);
  if (late) blockers.push(late);
  const rules = rulesBlocker(db, claimId, today);
  if (rules) blockers.push(rules);
  return blockers;
}

function currentlyPublished(db, claimId) {
  return db
    .prepare("SELECT snapshot FROM current_publications WHERE claim_id = ? AND status = 'published'")
    .get(claimId);
}

/**
 * Stores what is publishable right now as a new ledger entry. Refuses what
 * publication_checks refuses, and a verdict the deadline rule does not allow on `today`.
 * @param {{ reviewSeconds?: number, today?: string }} [options] how long the human review
 *   took; the local date for the deadline rule (default: today on this machine)
 * @returns {number} id of the new ledger entry
 */
export function confirm(db, claimId, confirmedBy, { reviewSeconds = null, today = localToday() } = {}) {
  checkToday(today);
  if (reviewSeconds !== null) {
    if (!Number.isFinite(reviewSeconds) || reviewSeconds < 0) {
      throw new Error('reviewSeconds must be a non-negative number of seconds');
    }
    reviewSeconds = Math.round(reviewSeconds);
  }
  const now = db.prepare('SELECT snapshot FROM publishable WHERE claim_id = ?').get(claimId);
  if (!now) {
    throw new Error(`Claim ${claimId} cannot be confirmed: ${publicationBlockers(db, claimId, { today }).join('; ')}`);
  }
  const late = deadlineBlocker(db, claimId, today);
  if (late) throw new Error(`Claim ${claimId} cannot be confirmed: ${late}`);
  const rules = rulesBlocker(db, claimId, today);
  if (rules) throw new Error(`Claim ${claimId} cannot be confirmed: ${rules}`);
  const current = currentlyPublished(db, claimId);
  if (current && current.snapshot === now.snapshot) {
    throw new Error(`Claim ${claimId}: nothing has changed since the last confirmation`);
  }
  const result = db
    .prepare(
      `INSERT INTO publications (claim_id, status, snapshot, confirmed_by, review_seconds)
       SELECT claim_id, 'published', snapshot, ?, ? FROM publishable WHERE claim_id = ?`
    )
    .run(confirmedBy, reviewSeconds, claimId);
  // Exactly one entry, or nothing happened: never report a stale id as success.
  if (result.changes !== 1) throw new Error(`Claim ${claimId}: the ledger entry was not written (${result.changes} rows)`);
  return Number(result.lastInsertRowid);
}

/**
 * Withdraws what is currently public for a claim. The entry keeps what was withdrawn and
 * why; the reason is published, so it is given in French and in English.
 * @param {{ noteFr: string, noteEn: string }} note
 * @returns {number} id of the new ledger entry
 */
export function withdraw(db, claimId, confirmedBy, { noteFr = null, noteEn = null } = {}) {
  const result = db
    .prepare(
      `INSERT INTO publications (claim_id, status, snapshot, note_fr, note_en, confirmed_by)
       SELECT claim_id, 'withdrawn', snapshot, ?, ?, ? FROM current_publications
       WHERE claim_id = ? AND status = 'published'`
    )
    .run(noteFr, noteEn, confirmedBy, claimId);
  if (result.changes === 0) {
    throw new Error(`Claim ${claimId} has nothing currently published to withdraw`);
  }
  return Number(result.lastInsertRowid);
}

/**
 * True when something is public for this claim and the workspace no longer matches it —
 * either because it was edited, or because it has stopped being publishable. A new
 * confirmation is needed before the public record changes. False when nothing is
 * currently public (never published, or withdrawn).
 */
export function hasUnconfirmedChanges(db, claimId) {
  const current = currentlyPublished(db, claimId);
  if (!current) return false;
  const now = db.prepare('SELECT snapshot FROM publishable WHERE claim_id = ?').get(claimId);
  return !now || now.snapshot !== current.snapshot;
}
