// Rules shared by the ledger (src/ledger.js, the one way into the public record) and the
// jury's vote checks (src/pack.js), so the two can never drift apart. No I/O here.
//
// Why a module of its own (principle 5): ledger.js must stay free of pack.js's archive and
// extraction imports, and a copy of these rules in each file is how they drifted before
// (Fable review 3, findings 1 and 3).

/**
 * The project's blank characters: the same list as "Not blank" in db/schema.sql.
 * If the list changes, change both.
 */
export const BLANK_CODE_POINTS = Object.freeze([
  32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199,
  8200, 8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279,
]);
const BLANK_CLASS = BLANK_CODE_POINTS.map((c) => `\\u{${c.toString(16)}}`).join('');
const ALL_BLANK = new RegExp(`^[${BLANK_CLASS}]*$`, 'u');
// Characters that take no space (zero-width, joiners, soft hyphen, byte order mark) are
// removed; every other blank character counts as a space.
const INVISIBLE = /[\u{ad}\u{200b}\u{200c}\u{200d}\u{2060}\u{feff}]/gu;
const SPACES = new RegExp(`[${BLANK_CLASS}]+`, 'gu');

/** True when the value is a string with something in it besides blank characters. */
export function filled(value) {
  return typeof value === 'string' && !ALL_BLANK.test(value);
}

/**
 * The one normalisation of a publisher name, used to tell "two different publishers" apart,
 * here and in SQL (openDatabase registers it as kv_publisher_key): Unicode NFKC, case-folded,
 * invisible characters removed, runs of blank characters collapsed to one space, trimmed.
 */
export function publisherKey(name) {
  if (typeof name !== 'string') return null;
  return name
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase() // upper then lower folds case more fully than lower alone (ß, final sigma)
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .replace(SPACES, ' ')
    .trim();
}

/** Today's date on this machine, YYYY-MM-DD (deadlines are calendar dates, not instants). */
export function localToday(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * RN-1's switch (verdict-standard.md 0.7 section 5; decision 0015 S1; predictions off, founder 2026-11-23): the
 * claim types a public reversal by the speaker applies to. The same list is written once more, in
 * db/schema.sql (outcome_has_evidence and evidence_is_primary, "c.type IN (...)"); test/ledger.test.js
 * checks that the two agree. A type taken off the list falls under RN-1 row 1 (a lead only).
 */
export const REVERSAL_TYPES = Object.freeze(['promise']);

/**
 * RN-1 (docs/methodology/verdict-standard.md 0.7, the truth table), rows 4 and 5 without the date of
 * judging: a public reversal by the speaker (source kind `renunciation`) of a measurable claim of a
 * listed type, dated on or after the day the claim was made and on or before its deadline. Outside this
 * window it negates nothing, for any verdict: a type not on the list (row 1), a vague or hedged claim
 * (row 2), undated or dated before the claim (row 3), dated after the deadline (row 7). The claim needs
 * type, verifiability, said_on and deadline.
 */
export function renunciationInWindow(source, claim) {
  return source?.kind === 'renunciation'
    && REVERSAL_TYPES.includes(claim?.type)
    && claim.verifiability === 'measurable'
    && typeof source.published_on === 'string'
    && typeof claim.said_on === 'string'
    && typeof claim.deadline === 'string'
    && source.published_on >= claim.said_on
    && source.published_on <= claim.deadline;
}

/**
 * Whether a renunciation may stand among a verdict's evidence: RN-1 row 5 only, under "not_came_true",
 * in the window (renunciationInWindow). There it is enough evidence on its own. Mirrors
 * evidence_is_primary and outcome_has_evidence in db/schema.sql. That it is not dated after the date of
 * judging is futureEvidence, as for every source.
 */
export function renunciationAdmitted(source, claim, verdict) {
  return verdict === 'not_came_true' && renunciationInWindow(source, claim);
}

/**
 * Why a cited renunciation is refused, naming the row of the RN-1 table; null when it is admitted or
 * the source is not a renunciation.
 */
export function renunciationRefusal(source, claim, verdict) {
  if (source?.kind !== 'renunciation' || renunciationAdmitted(source, claim, verdict)) return null;
  const what = `source ${source.id ?? source.source_id} is a public reversal by the speaker (kind renunciation)`;
  if (!REVERSAL_TYPES.includes(claim?.type)) return `${what}: on a ${claim?.type ?? 'claim'} it is a lead, never evidence (RN-1 row 1)`;
  if (claim.verifiability !== 'measurable') return `${what}: a ${claim.verifiability} claim is "unverifiable" and cites none (VG-1, RN-1 row 2)`;
  if (typeof source.published_on !== 'string') return `${what} with no date, so it is no evidence (RN-1 row 3)`;
  if (source.published_on < claim.said_on) return `${what} dated ${source.published_on}, before the claim was made (${claim.said_on}), so it is no evidence (RN-1 row 3)`;
  if (typeof claim.deadline === 'string' && source.published_on > claim.deadline) {
    return `${what} dated ${source.published_on}, after the deadline ${claim.deadline}: it changes nothing, the state at the deadline counts (RN-1 row 7, DL-2); do not cite it`;
  }
  return `${what}: it is cited only under not_came_true (RN-1 row 5); under came_true it is mentioned in the summary only (row 4)`;
}

/**
 * RN-1 rows 4 and 5 for the vote checks, which see every document the pack gives (the ledger sees only
 * the cited evidence, so it cannot apply this; the desk does, with the pack). Once a given renunciation
 * is in the window and dated on or before `today`, the only verdicts are "came_true" (criteria fully met
 * before it, row 4) and "not_came_true" citing such a renunciation (row 5), and rules_applied names RN-1.
 * Returns the problems.
 * @param {{kind: string, published_on: string|null, id?: number, source_id?: number}[]} given every document of the pack
 * @param {{id?: number, source_id?: number}[]} cited the documents the verdict cites
 * @param {string[]|null} rulesApplied the vote's rules_applied
 */
export function renunciationProblems(claim, given, cited, verdict, rulesApplied, today) {
  const idOf = (s) => s.id ?? s.source_id;
  const live = given.filter((s) => renunciationInWindow(s, claim) && typeof today === 'string' && s.published_on <= today);
  if (live.length === 0) return [];
  const named = live.map((s) => `source ${idOf(s)} (${s.published_on})`).join(', ');
  const problems = [];
  if (verdict !== 'came_true' && verdict !== 'not_came_true') {
    problems.push(`${named} ${live.length === 1 ? 'is a public reversal' : 'are public reversals'} by the speaker dated between the day the claim was made and its deadline: the verdict is not_came_true citing it, or came_true if the criteria were fully met before it (RN-1 rows 4, 5), not ${verdict}; if the document is not an explicit, precise reversal of this claim (a postponement, a changed figure, a softer wording: a separate claim), its kind needs correcting and the pack goes back (RN-1 rows 8, 9)`);
  } else if (verdict === 'not_came_true') {
    // The earliest reversal in the window counts (RN-1, truth table): it is the one cited (Fable review 8, finding 5).
    const earliest = [...live].sort((a, b) => a.published_on.localeCompare(b.published_on) || idOf(a) - idOf(b))[0];
    if (!cited.some((c) => idOf(c) === idOf(earliest))) {
      problems.push(`not_came_true on a claim the speaker reversed: cite the earliest reversal, source ${idOf(earliest)} (${earliest.published_on}), among the evidence (RN-1 row 5)`);
    }
  }
  if (!Array.isArray(rulesApplied) || !rulesApplied.includes('RN-1')) {
    problems.push(`rules_applied must name RN-1: the speaker reversed the claim (${named}), so RN-1 decided the verdict`);
  }
  return problems;
}

/**
 * A cited source of any kind dated after `today` is refused: a document cannot be cited before it exists
 * (Fable review 7 and its re-check: a law dated 2030 must not stand behind came_true today). Returns the
 * problem, or null. Used by confirm() and the vote checks.
 * @param {{kind: string, published_on: string|null, id?: number, source_id?: number}[]} sources the verdict's evidence sources
 */
export function futureEvidence(sources, today) {
  const late = sources.filter((s) => typeof s?.published_on === 'string' && s.published_on > today);
  if (late.length === 0) return null;
  const what = (s) => (s.kind === 'renunciation' ? 'the renunciation' : `the ${s.kind} document`);
  return late.map((s) => `${what(s)} (source ${s.id ?? s.source_id}) is dated ${s.published_on}, after ${today}; it cannot be cited before it is published`).join('; ');
}

export const INDEPENDENT_KINDS = Object.freeze(['media', 'dataset_study']);

/**
 * Two independent sources: two of kind media or dataset_study whose publishers differ
 * (publisherKey) and whose archived files differ (sha256). Mirrors publication_checks.
 * @param {{kind: string, publisher: string, sha256?: string}[]} sources
 */
export function twoIndependent(sources) {
  const list = sources.filter((s) => INDEPENDENT_KINDS.includes(s?.kind));
  return list.some((a) => list.some((b) => publisherKey(a.publisher) !== publisherKey(b.publisher) && a.sha256 !== b.sha256));
}

/**
 * The deadline rule (verdict-standard.md 0.7: DL-1, DL-3, DL-4, EA-1, RN-1 row 5). The deadline day itself
 * is still inside the deadline (DL-1). On or before it: came_true (EA-1), pending, unverifiable on a vague
 * or hedged claim (VG-1), and not_came_true when a renunciation of row 5 is cited (RN-1); nothing else
 * (DL-3). After it: never pending (DL-4). Returns the problem, or null.
 * @param {{deadline: string|null, verifiability: string, type?: string}} claim
 * @param {string} verdict
 * @param {string} today YYYY-MM-DD, local date
 * @param {boolean} renounced a cited renunciation is admitted (renunciationAdmitted) and dated on or before today
 */
export function deadlineProblem(claim, verdict, today, renounced) {
  if (!claim.deadline) return null;
  const before = today <= claim.deadline;
  const waits = ['to_evaluate', 'partly_came_true', 'not_came_true'].includes(verdict)
    || (verdict === 'unverifiable' && claim.verifiability === 'measurable');
  if (before && waits && !(verdict === 'not_came_true' && renounced)) {
    const how = verdict === 'not_came_true' && REVERSAL_TYPES.includes(claim.type)
      ? '; before the deadline, not_came_true needs a public reversal by the speaker, dated on or before today, cited among the evidence (RN-1 row 5)' : '';
    return `deadline ${claim.deadline} not over (not reached until the day after it), but verdict is ${verdict} (DL-3)${how}`;
  }
  if (!before && verdict === 'pending') return `deadline ${claim.deadline} passed, but verdict is pending (DL-4)`;
  return null;
}

/**
 * Session integrity (decision 0012 A2; Fable review 6 A2): the session that cut a pack is stamped by the
 * program when the pack is started (`node src/pack.js start`, pack.header.session), never typed by the
 * agent. A pack without one is refused for every vote. A vote whose made_by.session is that same
 * session (case and surrounding blanks aside, Fable re-check F) is refused, whoever made it. A vote
 * that names no session is not refused here (sessionsRecorded tells the desk to say so).
 * Returns the problem, or null.
 */
export function sameSessionProblem(pack, vote) {
  const cut = pack?.header?.session;
  if (!filled(cut)) return 'the evidence pack has no session stamped by the program (node src/pack.js start); cut it again';
  const voted = vote?.made_by?.session;
  if (!filled(voted)) return null;
  return cut.trim().toLowerCase() === voted.trim().toLowerCase()
    ? 'this vote was made in the session that cut the pack; a judge must be a fresh session (decision 0012 A2)'
    : null;
}

/** True when both the pack and the vote name their session, so sameSessionProblem could check them. */
export function sessionsRecorded(pack, vote) {
  return filled(pack?.header?.session) && filled(vote?.made_by?.session);
}
