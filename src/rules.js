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
 * A renunciation counts as evidence only for "not_came_true" on a promise, and only when it
 * was published on or after the day the promise was made (it cannot give up what was not yet
 * said). Mirrors publication_checks in db/schema.sql.
 * @param {{kind: string, published_on: string|null}} source
 * @param {{type: string, said_on: string}} claim
 */
export function renunciationCounts(source, claim, verdict) {
  return source?.kind === 'renunciation'
    && verdict === 'not_came_true'
    && claim.type === 'promise'
    && typeof source.published_on === 'string'
    && typeof claim.said_on === 'string'
    && source.published_on >= claim.said_on;
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
 * day itself is still inside the deadline. On or before it: only came_true, pending,
 * unverifiable on a vague or hedged claim, and not_came_true on a renounced promise. After
 * it: never pending. Returns the problem, or null.
 * @param {{deadline: string|null, verifiability: string}} claim
 * @param {string} verdict
 * @param {string} today YYYY-MM-DD, local date
 * @param {boolean} renounced the verdict rests on a renunciation that counts
 */
export function deadlineProblem(claim, verdict, today, renounced) {
  if (!claim.deadline) return null;
  const notOver = today <= claim.deadline;
  const waits = (['to_evaluate', 'partly_came_true', 'not_came_true'].includes(verdict) && !renounced)
    || (verdict === 'unverifiable' && claim.verifiability === 'measurable');
  if (notOver && waits) return `deadline ${claim.deadline} not over (not reached until the day after it), but verdict is ${verdict}`;
  if (!notOver && verdict === 'pending') return `deadline ${claim.deadline} passed, but verdict is pending`;
  return null;
}
