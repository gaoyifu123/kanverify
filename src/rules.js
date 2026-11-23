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
 * The verdicts under which a renunciation may be cited at all (record format 11): on a promise, under
 * "not_came_true", "partly_came_true", "came_true", "to_evaluate", and "unverifiable" when the promise
 * is measurable (its condition never arose; Fable review 7). Never under "pending", and never on a
 * vague or hedged promise, which stays "unverifiable" on its wording alone (decision 0013).
 */
export const RENUNCIATION_VERDICTS = Object.freeze(['not_came_true', 'partly_came_true', 'came_true', 'to_evaluate', 'unverifiable']);

/** Whether this verdict on this claim may cite a renunciation at all (RENUNCIATION_VERDICTS). */
export function renunciationFits(claim, verdict) {
  return claim?.type === 'promise'
    && RENUNCIATION_VERDICTS.includes(verdict)
    && (verdict !== 'unverifiable' || claim.verifiability === 'measurable');
}

/**
 * Whether a renunciation may stand among a verdict's evidence: renunciationFits, and published on or
 * after the day the promise was made (it cannot give up what was not yet said). Mirrors
 * evidence_is_primary in db/schema.sql, except "never the only evidence" (renunciationAlone), which
 * needs the other rows. The claim needs type, said_on and verifiability.
 */
export function renunciationAdmitted(source, claim, verdict) {
  return source?.kind === 'renunciation'
    && renunciationFits(claim, verdict)
    && typeof source.published_on === 'string'
    && typeof claim.said_on === 'string'
    && source.published_on >= claim.said_on;
}

/**
 * A renunciation counts as evidence of an outcome only for "not_came_true", where it may be the only
 * evidence. Mirrors outcome_has_evidence in db/schema.sql.
 */
export function renunciationCounts(source, claim, verdict) {
  return verdict === 'not_came_true' && renunciationAdmitted(source, claim, verdict);
}

/**
 * True when a renunciation would be the only evidence of a verdict that is not "not_came_true":
 * there it is never sole (record format 11). Mirrors evidence_is_primary.
 * @param {{kind: string}[]} sources the verdict's evidence sources
 */
export function renunciationAlone(sources, verdict) {
  return verdict !== 'not_came_true'
    && sources.some((s) => s?.kind === 'renunciation')
    && !sources.some((s) => s && s.kind !== 'renunciation');
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

/**
 * A public renunciation ends the wait on a promise (founder, 2026-11-23): from its date the claim is
 * judged as if its deadline had passed, on what was actually done. Whether a renunciation does that
 * does not depend on the verdict, unlike renunciationCounts (the renunciation as the only evidence,
 * which stays limited to "not_came_true"). It must be of kind renunciation, about a promise, published
 * on or after the day the promise was made, and not after `today`. The ledger sees one only among the
 * verdict's evidence (record format 11), so the vote checks look there too.
 * @param {{kind: string, published_on: string|null}} source
 * @param {{type: string, said_on: string}} claim
 * @param {string} today YYYY-MM-DD, local date
 */
export function renunciationEndsWait(source, claim, today) {
  return source?.kind === 'renunciation'
    && claim?.type === 'promise'
    && typeof source.published_on === 'string'
    && typeof claim.said_on === 'string'
    && typeof today === 'string'
    && source.published_on >= claim.said_on
    && source.published_on <= today;
}

/**
 * Why no renunciation ended the wait, for the "not over" message, so a stop names the real cause.
 * Looks at every renunciation given. Null where citing one would itself be refused (a prediction, a
 * verdict that may not cite one), so a hint never recommends a move the rules refuse.
 * @param {{type: string, said_on: string, verifiability?: string}} claim
 * @param {{kind: string, published_on: string|null, id?: number, source_id?: number}[]} sources the verdict's evidence sources
 */
export function waitHint(claim, verdict, sources, today) {
  if (!renunciationFits(claim, verdict)) return null;
  const ren = sources.filter((s) => s?.kind === 'renunciation');
  if (ren.length === 0) return 'only a public renunciation cited among the evidence ends the wait before the deadline';
  if (ren.some((s) => renunciationEndsWait(s, claim, today))) return null;
  return ren.map((s) => {
    const id = s.id ?? s.source_id;
    if (typeof s.published_on !== 'string' || typeof claim.said_on !== 'string' || s.published_on < claim.said_on) {
      return `the renunciation (source ${id}) is undated or dated before the promise was made, so it does not end the wait`;
    }
    return `the renunciation (source ${id}) is dated ${s.published_on}, after ${today}, so it does not end the wait yet`;
  }).join('; ');
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
 * The deadline rule (verdict-standard.md section 3 and section 5 as amended). The deadline
 * day itself is still inside the deadline. On or before it: only came_true, pending, and
 * unverifiable on a vague or hedged claim. After it: never pending. A renounced promise is
 * judged as if its deadline had passed (renunciationEndsWait). Returns the problem, or null.
 * @param {{deadline: string|null, verifiability: string}} claim
 * @param {string} verdict
 * @param {string} today YYYY-MM-DD, local date
 * @param {boolean} renounced a renunciation has ended the wait (renunciationEndsWait), whatever the verdict
 * @param {string|null} [hint] why no renunciation ended it (waitHint), added to the "not over" message
 */
export function deadlineProblem(claim, verdict, today, renounced, hint = null) {
  if (!claim.deadline) return null;
  const notOver = !renounced && today <= claim.deadline;
  const waits = ['to_evaluate', 'partly_came_true', 'not_came_true'].includes(verdict)
    || (verdict === 'unverifiable' && claim.verifiability === 'measurable');
  if (notOver && waits) {
    return `deadline ${claim.deadline} not over (not reached until the day after it), but verdict is ${verdict}${hint ? `; ${hint}` : ''}`;
  }
  if (!notOver && verdict === 'pending') {
    return renounced ? 'the promise was publicly renounced, which ends the wait, but verdict is pending'
      : `deadline ${claim.deadline} passed, but verdict is pending`;
  }
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
