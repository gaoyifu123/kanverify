// Confirming and withdrawing: the only two ways anything becomes public.
//
// What may be published is publication_checks in db/schema.sql plus one rule that depends
// on the date and so is not in the database: the deadline rule (src/rules.js, shared with
// the jury's vote checks). confirm() is the one way into the ledger and applies both.
// These functions explain a refusal in terms a reviewer can act on.

import { deadlineProblem, localToday, renunciationEndsWait } from './rules.js';

// In the order a reviewer would fix them. Those in NEEDS_VERDICT only make sense once a
// verdict exists; translations come last because they are done after the content.
const CHECK_MESSAGES = [
  ['has_subject', 'the claim points at a subject that does not exist'],
  ['origin_is_own_words', "the claim's origin is missing or is not the speaker's own published words"],
  ['has_verdict', 'the claim has no verdict yet'],
  ['verdict_fits_verifiability', 'a vague or hedged claim can only be "unverifiable"'],
  ['summary_stated', 'every verdict except "pending" needs a summary explaining it'],
  ['outcome_has_evidence', 'a verdict that asserts an outcome ("came_true", "partly_came_true", "not_came_true", or "unverifiable" on a measurable claim) needs one official document, or two independent sources from different publishers, as evidence ("not_came_true" on a promise may instead rest on the speaker\'s own renunciation)'],
  ['evidence_is_primary', 'a statement, a platform, a renunciation (evidence only for "not_came_true" on a promise), or a missing source is used as evidence; evidence must be an official document or independent reporting'],
  ['bilingual', 'a published text is missing its French or English version: the quote and each evidence excerpt need a translation into French and into English, except into their own language (where there must be none); speaker role, criteria, summary and open question must be in both languages or in neither'],
];
const NEEDS_VERDICT = new Set(['verdict_fits_verifiability', 'summary_stated', 'outcome_has_evidence', 'evidence_is_primary']);

/**
 * The deadline rule for a claim's working verdict on a given local date, or null.
 * The same function the jury's vote checks use (src/rules.js).
 */
function deadlineBlocker(db, claimId, today) {
  const claim = db.prepare('SELECT type, verifiability, deadline, said_on FROM claims WHERE id = ?').get(claimId);
  const verdict = db.prepare('SELECT id, verdict FROM verdicts WHERE claim_id = ?').get(claimId);
  if (!claim || !verdict) return null;
  const sources = db
    .prepare('SELECT s.kind, s.published_on FROM verdict_evidence e JOIN sources s ON s.id = e.source_id WHERE e.verdict_id = ?')
    .all(verdict.id);
  // A renunciation ends the wait whatever the verdict (founder, 2026-11-23). Here it can only be found
  // among the verdict's evidence, where publication_checks admits it under not_came_true alone.
  const renounced = sources.some((s) => renunciationEndsWait(s, claim, today));
  return deadlineProblem(claim, verdict.verdict, today, renounced);
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
