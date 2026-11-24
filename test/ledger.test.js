// The ledger: what may become public, and that the public record cannot be altered.
// These tests include the attacks found in the three independent reviews.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  confirm as confirmOn, withdraw, hasUnconfirmedChanges, publicationBlockers as blockersOn,
} from '../src/ledger.js';
import { REVERSAL_TYPES, publisherKey, renunciationAdmitted } from '../src/rules.js';
import {
  freshDb, addSource, addClaim, addVerdict, addEvidence, addVote, readyClaim, OUTCOMES, VERDICTS, RULES_VERSION,
  ledger, publicRecord, publishableSnapshot,
} from './helpers.js';

// The deadline rule (record format 10) is tested on its own below, with explicit dates. The
// other tests are about other rules, so they confirm on a date the deadline allows: before
// the default deadline (2027-05-13) for pending and came_true, after it for the rest.
const BEFORE = '2026-11-23';
const AFTER = '2027-06-01';
function allowedDate(db, claimId) {
  const v = db.prepare('SELECT verdict FROM verdicts WHERE claim_id = ?').get(claimId)?.verdict;
  return v === 'pending' || v === 'came_true' ? BEFORE : AFTER;
}
const confirm = (db, claimId, by, opts = {}) => confirmOn(db, claimId, by, { today: allowedDate(db, claimId), ...opts });
const publicationBlockers = (db, claimId, opts = {}) => blockersOn(db, claimId, { today: allowedDate(db, claimId), ...opts });

const SOURCE_KEYS = ['kind', 'url', 'title', 'publisher', 'published_on', 'retrieved_on', 'sha256', 'media_type', 'lang'];

const REASON = { noteFr: 'Raison.', noteEn: 'Reason.' };
const PRIMARY_MSG = 'a statement, a platform, a missing source, or a renunciation outside RN-1 row 5 (cited only under "not_came_true" on a measurable promise, dated on or after the day it was made and on or before its deadline) is used as evidence; evidence must be an official document or independent reporting (EV-2)';

function timestamp(offsetSeconds) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ---- What may become public (principles 1 and 2) --------------------------------------

test('confirming stores the complete content as one snapshot', () => {
  const db = freshDb();
  const { claim, law, platform } = readyClaim(db);
  addVote(db, claim, 'model-1', 'came_true', {
    evidence_json: JSON.stringify([{ source_id: law, excerpt: 'Article 1', locator: 'art. 1' }]),
  });
  addVote(db, claim, 'model-2', 'to_evaluate', { open_question: 'Is the decree in force?' });
  confirm(db, claim, 'founder', { reviewSeconds: 42 });

  const [entry] = ledger(db, claim);
  assert.equal(entry.status, 'published');
  assert.equal(entry.confirmed_by, 'founder');
  assert.equal(entry.review_seconds, 42);

  const s = entry.snapshot;
  assert.deepEqual(Object.keys(s), ['format', 'claim', 'subject', 'origin', 'verdict', 'evidence', 'jury']);
  // The snapshot's shape, counted on its own (format 13, Fable review 10 finding 2).
  assert.equal(s.format, 1);
  assert.deepEqual(s.claim, {
    id: claim, type: 'promise', domain: 'economy',
    speaker_role_fr: 'Candidat à la présidence, 2022', speaker_role_en: 'Candidate for president, 2022',
    quote_original: 'Nous ferons X avant 2027.', lang: 'fr',
    quote_fr: null, quote_en: 'We will do X before 2027.',
    said_on: '2022-03-17', source_locator: 'p. 4', verifiability: 'measurable',
    deadline: '2027-05-13', deadline_basis: 'stated',
    criteria_fr: 'X est en vigueur selon le Journal officiel.',
    criteria_en: 'X is in force according to the official gazette.',
  });
  assert.deepEqual(s.subject, { id: 1, wikidata_id: null, name: 'Test Subject', kind: 'person', country: 'FR' });
  assert.deepEqual(Object.keys(s.origin), ['id', ...SOURCE_KEYS]);
  // The ids let the site group items by the document they were said in (format 9).
  assert.equal(s.origin.id, platform);
  assert.equal(s.origin.kind, 'platform');
  assert.equal(s.origin.sha256, 'a'.repeat(64));
  assert.deepEqual(s.verdict, {
    verdict: 'came_true', summary_fr: 'Résumé du résultat.', summary_en: 'Summary of the outcome.',
    open_question_fr: null, open_question_en: null,
    decided_by: 'human', based_on_round: null, rules_version: RULES_VERSION, rules_applied: ['EA-1', 'OC-1', 'EV-1'],
  });
  assert.deepEqual(Object.keys(s.evidence[0]), ['source_id', 'excerpt', 'excerpt_fr', 'excerpt_en', 'locator', ...SOURCE_KEYS]);
  assert.deepEqual(s.evidence.map((e) => e.source_id), [law]);
  assert.deepEqual(
    s.evidence.map((e) => [e.kind, e.excerpt, e.excerpt_fr, e.excerpt_en, e.locator, e.url, e.sha256]),
    [['law', 'Article 1 : X entre en vigueur le 1er janvier 2025.', null,
      'Article 1: X enters into force on 1 January 2025.', 'art. 1', 'https://example.org/law', 'b'.repeat(64)]]
  );
  // Who voted what is frozen with the confirmation; the votes' working notes stay in the workspace.
  assert.deepEqual(s.jury, [
    { round: 1, provider: 'provider-a', model: 'model-1', prompt_version: 'judge-0.1', verdict: 'came_true' },
    { round: 1, provider: 'provider-a', model: 'model-2', prompt_version: 'judge-0.1', verdict: 'to_evaluate' },
  ]);
});

test('the time a review took is recorded in whole seconds', () => {
  const db = freshDb();
  const { claim, verdict } = readyClaim(db);
  assert.throws(() => confirm(db, claim, 'founder', { reviewSeconds: -1 }), /non-negative/);
  assert.throws(() => confirm(db, claim, 'founder', { reviewSeconds: Number.NaN }), /non-negative/);
  confirm(db, claim, 'founder', { reviewSeconds: 12.7 });
  db.prepare("UPDATE verdicts SET summary_fr = 'Précisé.', summary_en = 'Clarified.' WHERE id = ?").run(verdict);
  confirm(db, claim, 'founder');
  assert.deepEqual(ledger(db, claim).map((e) => e.review_seconds), [13, null]);
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO publications (claim_id, status, snapshot, confirmed_by, review_seconds) SELECT claim_id, 'published', snapshot, 'founder', -5 FROM publishable WHERE claim_id = ?"
        )
        .run(claim),
    /CHECK/
  );
});

test('a verdict that asserts an outcome cannot be confirmed without evidence', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  for (const outcome of OUTCOMES) {
    const claim = addClaim(db, platform);
    addVerdict(db, claim, outcome);
    assert.throws(() => confirm(db, claim, 'founder'), /needs one official document/, outcome);
    assert.equal(publicRecord(db, claim), null);
  }
});

test('a statement is a lead, never evidence — alone or beside a real document', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const statement = addSource(db, 'statement');
  const law = addSource(db, 'law');
  for (const lead of [statement, platform]) {
    const claim = addClaim(db, platform);
    const verdict = addVerdict(db, claim, 'not_came_true');
    addEvidence(db, verdict, lead);
    assert.throws(() => confirm(db, claim, 'founder'), /needs one official document/);
    addEvidence(db, verdict, law);
    assert.deepEqual(publicationBlockers(db, claim), [
      PRIMARY_MSG,
    ]);
    assert.throws(() => confirm(db, claim, 'founder'), /evidence must be an official document/);
  }
});

test('"unverifiable" on a measurable claim needs evidence; on a vague or hedged claim it does not', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const measurable = addClaim(db, platform);
  const verdict = addVerdict(db, measurable, 'unverifiable');
  // "Its condition never arose" is a statement about the world: principle 2 applies.
  assert.throws(() => confirm(db, measurable, 'founder'), /needs one official document/);
  addEvidence(db, verdict, addSource(db, 'statistic'));
  confirm(db, measurable, 'founder');
  for (const verifiability of ['vague', 'hedged']) {
    const claim = addClaim(db, platform, { verifiability, criteria_fr: null, criteria_en: null });
    addVerdict(db, claim, 'unverifiable');
    confirm(db, claim, 'founder');
  }
});

// ---- Record format 10 (Fable review 3) ------------------------------------------------

test('confirm() applies the deadline rule, on the local date it is given', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const law = addSource(db, 'law', { sha256: 'b'.repeat(64) });
  const QUESTION = { open_question_fr: 'Le chiffre manque.', open_question_en: 'The figure is missing.' };
  const make = (verdict, verifiability = 'measurable') => {
    const claim = addClaim(db, platform, verifiability === 'measurable' ? {} : { verifiability, criteria_fr: null, criteria_en: null });
    addEvidence(db, addVerdict(db, claim, verdict, verdict === 'to_evaluate' ? QUESTION : {}), law);
    return claim;
  };
  // The deadline day (2027-05-13) is still inside the deadline.
  for (const today of ['2026-11-23', '2027-05-13']) {
    for (const verdict of ['to_evaluate', 'partly_came_true', 'not_came_true', 'unverifiable']) {
      const claim = make(verdict);
      assert.throws(() => confirmOn(db, claim, 'founder', { today }), /not over/, `${verdict} ${today}`);
      assert.match(blockersOn(db, claim, { today }).join(), /not over/);
      confirmOn(db, claim, 'founder', { today: '2027-05-14' });
    }
    confirmOn(db, make('came_true'), 'founder', { today }); // may be given early
    confirmOn(db, make('pending'), 'founder', { today });
    confirmOn(db, make('unverifiable', 'vague'), 'founder', { today }); // vague: no deadline involved
  }
  const late = make('pending');
  assert.throws(() => confirmOn(db, late, 'founder', { today: '2027-05-14' }), /passed, but verdict is pending/);
  assert.deepEqual(blockersOn(db, late, { today: '2027-05-14' }), ['deadline 2027-05-13 passed, but verdict is pending (DL-4)']);
  for (const bad of ['23/11/2026', '2026-11-23T10:00:00Z', 20261123]) {
    assert.throws(() => confirmOn(db, late, 'founder', { today: bad }), /local date/, String(bad));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM publications WHERE claim_id = ?').get(late).n, 0);
});

// ---- Record format 12: RN-1, one test per row of the truth table (verdict-standard.md 0.6 section 5) ----
// The claim: said 2022-03-17, due 2027-05-13 (helpers.addClaim). The ledger sees only the cited evidence.

function rnSetup() {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  let n = 0;
  const ren = (published_on) => addSource(db, 'renunciation', { published_on, url: `https://example.org/ren/${++n}`, sha256: (n).toString(16).padStart(64, 'd') });
  const law = addSource(db, 'law', { url: 'https://example.org/law/rn', sha256: 'b'.repeat(64) });
  const QUESTION = { open_question_fr: 'Le chiffre manque.', open_question_en: 'The figure is missing.' };
  const make = (verdict, rows, over = {}, rules = null) => {
    const claim = addClaim(db, platform, over);
    const v = addVerdict(db, claim, verdict, {
      ...(verdict === 'to_evaluate' ? QUESTION : {}), ...(rules && { rules_applied: JSON.stringify(rules) }),
    });
    for (const r of rows) addEvidence(db, v, r);
    return claim;
  };
  return { db, platform, ren, law, make };
}
const VAGUE = { verifiability: 'vague', criteria_fr: null, criteria_en: null };

test('RN-1 row 1: on a prediction a reversal is a lead, never evidence (the switch is off for predictions)', () => {
  const { db, ren, law, make } = rnSetup();
  const r = ren('2025-06-01');
  const alone = make('not_came_true', [r], { type: 'prediction' });
  const b = blockersOn(db, alone, { today: AFTER });
  assert.ok(b.includes(PRIMARY_MSG));
  assert.ok(b.some((x) => /needs one official document/.test(x)));
  const beside = make('not_came_true', [law, r], { type: 'prediction' });
  assert.deepEqual(blockersOn(db, beside, { today: AFTER }), [PRIMARY_MSG]);
  // Before the deadline a prediction cannot be "not_came_true" at all: no reversal ends its wait.
  assert.match(blockersOn(db, make('not_came_true', [law], { type: 'prediction' }), { today: BEFORE }).join(), /not over .*\(DL-3\)$/);
});

test('RN-1 switch: the ledger and src/rules.js admit a reversal on the same claim types', () => {
  const { db, ren, make } = rnSetup();
  for (const type of ['promise', 'prediction']) {
    const claim = make('not_came_true', [ren('2025-06-01')], { type });
    const ledgerSays = blockersOn(db, claim, { today: AFTER }).length === 0;
    const rulesSay = renunciationAdmitted({ kind: 'renunciation', published_on: '2025-06-01' }, { type, verifiability: 'measurable', said_on: '2022-03-17', deadline: '2027-05-13' }, 'not_came_true');
    assert.equal(ledgerSays, rulesSay, type);
    assert.equal(rulesSay, REVERSAL_TYPES.includes(type), type);
  }
});

test('RN-1 row 2: a vague or hedged promise stays unverifiable and cites no reversal', () => {
  const { db, ren, make } = rnSetup();
  for (const verifiability of ['vague', 'hedged']) {
    const over = { ...VAGUE, verifiability };
    const r = ren('2025-06-01');
    assert.ok(blockersOn(db, make('unverifiable', [r], over), { today: BEFORE }).includes(PRIMARY_MSG), verifiability);
    assert.ok(blockersOn(db, make('not_came_true', [r], over), { today: AFTER }).includes('a vague or hedged claim can only be "unverifiable"'), verifiability);
    confirmOn(db, make('unverifiable', [], over), 'founder', { today: BEFORE });
  }
});

test('RN-1 row 3: an undated reversal, or one dated before the promise, is no evidence', () => {
  const { db, ren, make } = rnSetup();
  for (const published_on of [null, '2022-03-16']) {
    const claim = make('not_came_true', [ren(published_on)]);
    const b = blockersOn(db, claim, { today: AFTER });
    assert.ok(b.includes(PRIMARY_MSG), String(published_on));
    assert.ok(b.some((x) => /needs one official document/.test(x)), String(published_on));
    assert.throws(() => confirmOn(db, claim, 'founder', { today: BEFORE }), /not over.*RN-1 row 5/, String(published_on));
  }
});

test('RN-1 row 4: criteria fully met before the reversal is came_true, on its evidence, without citing the reversal', () => {
  const { db, ren, law, make } = rnSetup();
  const r = ren('2025-06-01');
  assert.ok(blockersOn(db, make('came_true', [law, r]), { today: BEFORE }).includes(PRIMARY_MSG));
  confirmOn(db, make('came_true', [law], {}, ['EA-1', 'RN-1', 'EV-1']), 'founder', { today: BEFORE });
});

test('RN-1 row 5: a reversal between the promise and its deadline makes not_came_true, alone, before or after the deadline', () => {
  const { db, ren, law, make } = rnSetup();
  // Window bounds: the day the promise was made and the deadline day are inside.
  for (const published_on of ['2022-03-17', '2025-06-01', '2027-05-13']) {
    for (const today of [published_on, '2027-05-13', AFTER]) {
      const claim = make('not_came_true', [ren(published_on)], {}, ['RN-1']);
      assert.deepEqual(blockersOn(db, claim, { today }), [], `${published_on} ${today}`);
    }
    confirmOn(db, make('not_came_true', [ren(published_on)], {}, ['RN-1']), 'founder', { today: published_on });
  }
  // Beside the evidence of what was done (delivered later, or in part): still not_came_true.
  confirmOn(db, make('not_came_true', [law, ren('2025-06-01')], {}, ['RN-1']), 'founder', { today: AFTER });
  // No other verdict may cite it, alone or beside other evidence.
  for (const verdict of ['partly_came_true', 'to_evaluate', 'unverifiable', 'pending']) {
    const claim = make(verdict, [law, ren('2025-06-01')]);
    assert.ok(blockersOn(db, claim, { today: AFTER }).includes(PRIMARY_MSG), verdict);
    assert.throws(() => confirmOn(db, claim, 'founder', { today: AFTER }), /cannot be confirmed/, verdict);
  }
  // Without a reversal, not_came_true waits for the deadline (DL-3), and the stop says what would end it.
  assert.throws(() => confirmOn(db, make('not_came_true', [law]), 'founder', { today: BEFORE }),
    /deadline 2027-05-13 not over \(not reached until the day after it\), but verdict is not_came_true \(DL-3\); before the deadline, not_came_true needs a public reversal by the speaker/);
});

test('RN-1 row 6: a reversal dated after today cannot be cited yet', () => {
  const { db, ren, make } = rnSetup();
  const r = ren('2026-12-01');
  const claim = make('not_came_true', [r], {}, ['RN-1']);
  const b = blockersOn(db, claim, { today: BEFORE });
  assert.ok(b.some((x) => x.includes(`the renunciation (source ${r}) is dated 2026-12-01, after ${BEFORE}; it cannot be cited before it is published`)), b.join(' | '));
  assert.ok(b.some((x) => /not over/.test(x)), b.join(' | '));
  assert.throws(() => confirmOn(db, claim, 'founder', { today: BEFORE }), /cannot be cited before it is published/);
  confirmOn(db, claim, 'founder', { today: '2026-12-01' });
});

test('RN-1 row 7: a reversal after the deadline changes nothing and is no evidence (N2 closed)', () => {
  const { db, ren, law, make } = rnSetup();
  const late = make('not_came_true', [ren('2027-05-14')]);
  const b = blockersOn(db, late, { today: AFTER });
  assert.ok(b.includes(PRIMARY_MSG));
  assert.ok(b.some((x) => /needs one official document/.test(x)));
  // The state at the deadline decides, on its own evidence.
  confirmOn(db, make('not_came_true', [law]), 'founder', { today: AFTER });
});

test('format 12: every verdict records its rules as distinct rule ids, in the snapshot', () => {
  const { db, law, make } = rnSetup();
  const claim = make('came_true', [law], {}, ['EA-1', 'EV-1']);
  confirmOn(db, claim, 'founder', { today: BEFORE });
  const s = publicRecord(db, claim).snapshot;
  assert.equal(s.verdict.rules_version, RULES_VERSION);
  assert.deepEqual(s.verdict.rules_applied, ['EA-1', 'EV-1']);
  // Required and a non-empty list on every verdict row.
  const other = addClaim(db, addSource(db, 'platform', { url: 'https://example.org/p2' }));
  const insert = (version, rules) => db.prepare("INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, decided_by, rules_version, rules_applied) VALUES (?, 'came_true', 'r', 's', 'human', ?, ?)").run(other, version, rules);
  for (const [version, rules] of [[null, '["EV-1"]'], ['0.6', null], ['0.6', '[]'], ['0.6', '{"a":1}'], ['0.6', 'EV-1'], ['v0.6', '["EV-1"]'], ['0.6.1', '["EV-1"]'], ['', '["EV-1"]']]) {
    assert.throws(() => insert(version, rules), /constraint/, `${version} ${rules}`);
  }
  // The form of each id is a publication check.
  const RULES_MSG = 'the rules the verdict was judged by are not recorded as a list of distinct rule ids such as "DL-2" (decision 0014)';
  for (const rules of [['ev-1'], ['EV-01'], ['EV-'], ['EV-1', 'EV-1'], ['EV-1x'], [1], ['EV-1\u0000x'], ['E-1']]) {
    const c = make('came_true', [law], {}, rules);
    assert.equal(blockersOn(db, c, { today: BEFORE })[0], RULES_MSG, JSON.stringify(rules));
  }
  // Changing the rules is a change of the public record.
  db.prepare("UPDATE verdicts SET rules_applied = '[\"OC-1\",\"EV-1\"]' WHERE claim_id = ?").run(claim);
  assert.equal(hasUnconfirmedChanges(db, claim), true);
});

test('VG-3: a prediction never has an inferred deadline', () => {
  const { db, platform } = rnSetup();
  assert.throws(() => addClaim(db, platform, { type: 'prediction', deadline_basis: 'inferred' }), /constraint/);
  addClaim(db, platform, { type: 'prediction', deadline_basis: 'stated' });
  addClaim(db, platform, { type: 'prediction', ...VAGUE, deadline: null, deadline_basis: null });
  addClaim(db, platform, { type: 'promise', deadline_basis: 'inferred' });
});

test('a renunciation is never where a claim was made', () => {
  const db = freshDb();
  const fromRenunciation = addClaim(db, addSource(db, 'renunciation'));
  addVerdict(db, fromRenunciation, 'pending');
  assert.throws(() => confirm(db, fromRenunciation, 'founder'), /not the speaker's own published words/);
});

test('format 11: the snapshot says which jury round the verdict rests on', () => {
  const db = freshDb();
  const { claim, verdict } = readyClaim(db);
  addVote(db, claim, 'model-1', 'pending', { round: 1 });
  addVote(db, claim, 'model-1', 'came_true', { round: 2 });
  db.prepare('UPDATE verdicts SET based_on_round = 2 WHERE id = ?').run(verdict);
  confirm(db, claim, 'founder');
  const s = publicRecord(db, claim).snapshot;
  assert.equal(s.verdict.based_on_round, 2);
  assert.deepEqual(s.jury.map((j) => [j.round, j.verdict]), [[1, 'pending'], [2, 'came_true']]);
  // Changing the round is a change of the public record: it needs a new confirmation.
  db.prepare('UPDATE verdicts SET based_on_round = 1 WHERE id = ?').run(verdict);
  assert.equal(hasUnconfirmedChanges(db, claim), true);
});

test('two independent sources: different publishers by one normalisation, and different files', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  let n = 0;
  const media = (publisher, sha256 = (++n).toString(16).padStart(64, '0')) =>
    addSource(db, 'media', { publisher, sha256, url: `https://example.org/m/${++n}` });
  const withTwo = (a, b) => {
    const claim = addClaim(db, platform);
    const v = addVerdict(db, claim, 'came_true');
    addEvidence(db, v, a);
    addEvidence(db, v, b);
    return claim;
  };
  // The same publisher written differently (full width, case, invisible characters, spaces).
  for (const [base, twin] of [['Le Monde', '\uff2c\uff25\u3000\uff2d\uff2f\uff2e\uff24\uff25'], ['Lemonde', 'le\u200bmonde'],
    ['Le Monde', ' LE \u00a0 MONDE\ufeff'], ['Straße', 'STRASSE']]) {
    const claim = withTwo(media(base), media(twin));
    assert.throws(() => confirm(db, claim, 'founder'), /needs one official document/, JSON.stringify(twin));
  }
  // One archived file under two publisher names is one source.
  const same = withTwo(media('Le Quotidien', 'e'.repeat(64)), media('The Daily', 'e'.repeat(64)));
  assert.throws(() => confirm(db, same, 'founder'), /needs one official document/);
  confirm(db, withTwo(media('Le Quotidien'), media('The Daily')), 'founder');
});

test('confirm() reports success only when exactly one ledger entry was written', () => {
  const db = freshDb();
  const { claim } = readyClaim(db);
  // A connection on which the insert writes nothing (as if the claim stopped being publishable
  // between the check and the insert): confirm must not return a stale id.
  const silent = new Proxy(db, {
    get(target, key) {
      if (key !== 'prepare') return Reflect.get(target, key).bind?.(target) ?? Reflect.get(target, key);
      return (sql) => (/INSERT INTO publications/.test(sql) ? { run: () => ({ changes: 0, lastInsertRowid: 7 }) } : target.prepare(sql));
    },
  });
  assert.throws(() => confirm(silent, claim, 'founder'), /not written \(0 rows\)/);
});

test('a connection without the publisher normalisation cannot publish anything', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanverify-nofn-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'test.db');
  const db = freshDb(file);
  const { claim } = readyClaim(db);
  db.close();
  const plain = new DatabaseSync(file);
  assert.throws(
    () => plain.exec(`INSERT INTO publications (claim_id, status, snapshot, confirmed_by) SELECT claim_id, 'published', snapshot, 'x' FROM publishable WHERE claim_id = ${claim}`),
    /no such function: kv_publisher_key/
  );
  assert.equal(plain.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
  plain.close();
});

test('one official document is enough; independent reporting needs two different publishers', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  let files = 0;
  const media = (publisher, kind = 'media') =>
    addSource(db, kind, {
      publisher,
      url: `https://example.org/${encodeURIComponent(publisher)}/${kind}/${++files}`,
      sha256: files.toString(16).padStart(64, '0'),
    });
  const fresh = () => {
    const claim = addClaim(db, platform);
    return { claim, verdict: addVerdict(db, claim, 'not_came_true') };
  };

  // Any document issued by a public institution, including kinds without their own label.
  for (const kind of ['law', 'gazette', 'statistic', 'budget', 'parliament', 'court', 'audit', 'official']) {
    const { claim, verdict } = fresh();
    addEvidence(db, verdict, addSource(db, kind));
    confirm(db, claim, 'founder');
  }

  // One outlet is not enough, however many of its articles are cited.
  const one = fresh();
  addEvidence(db, one.verdict, media('Le Quotidien'));
  assert.throws(() => confirm(db, one.claim, 'founder'), /needs one official document/);
  addEvidence(db, one.verdict, media('Le Quotidien'));
  addEvidence(db, one.verdict, media('  le quotidien '));
  assert.throws(() => confirm(db, one.claim, 'founder'), /needs one official document/);

  // Two different publishers are enough; a study with open data counts as one of them.
  addEvidence(db, one.verdict, media('The Daily'));
  confirm(db, one.claim, 'founder');
  const mixed = fresh();
  addEvidence(db, mixed.verdict, media('Le Quotidien'));
  addEvidence(db, mixed.verdict, media('Open Data Lab', 'dataset_study'));
  confirm(db, mixed.claim, 'founder');

  // A study alone is not enough, and two outlets do not make a statement admissible.
  const alone = fresh();
  addEvidence(db, alone.verdict, media('Open Data Lab', 'dataset_study'));
  assert.throws(() => confirm(db, alone.claim, 'founder'), /needs one official document/);
  const tainted = fresh();
  addEvidence(db, tainted.verdict, media('Le Quotidien'));
  addEvidence(db, tainted.verdict, media('The Daily'));
  addEvidence(db, tainted.verdict, addSource(db, 'statement'));
  assert.throws(() => confirm(db, tainted.claim, 'founder'), /evidence must be an official document/);
});

test("a claim whose origin is not the speaker's own words cannot be confirmed", () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'audit'));
  addVerdict(db, claim, 'pending');
  assert.throws(() => confirm(db, claim, 'founder'), /not the speaker's own published words/);
});

test('a claim without a verdict cannot be confirmed, and the reason is given', () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  assert.deepEqual(publicationBlockers(db, claim), ['the claim has no verdict yet']);
  assert.throws(() => confirm(db, claim, 'founder'), /no verdict yet/);
  assert.deepEqual(publicationBlockers(db, 999), ['there is no such claim']);
  assert.throws(() => confirm(db, 999, 'founder'), /no such claim/);
});

test('"pending" and "to_evaluate" can be confirmed without evidence', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const waiting = addClaim(db, platform);
  addVerdict(db, waiting, 'pending');
  confirm(db, waiting, 'founder');
  const stuck = addClaim(db, platform);
  addVerdict(db, stuck, 'to_evaluate', {
    open_question_fr: "L'office statistique publie le chiffre en mars 2027.",
    open_question_en: 'The statistics office publishes the figure in March 2027.',
  });
  confirm(db, stuck, 'founder');
  const { verdict } = publicRecord(db, stuck).snapshot;
  assert.equal(verdict.open_question_fr, "L'office statistique publie le chiffre en mars 2027.");
  assert.equal(verdict.open_question_en, 'The statistics office publishes the figure in March 2027.');
});

// ---- Both sites get the same record (decision 0007) -----------------------------------

const BILINGUAL = 'a published text is missing its French or English version: the quote and each evidence excerpt need a translation into French and into English, except into their own language (where there must be none); speaker role, criteria, summary and open question must be in both languages or in neither';

test('a claim cannot be confirmed while any published text lacks its French or English version', () => {
  const db = freshDb();
  // Each case starts from a publishable claim and takes away one translation.
  const cases = {
    // A French original needs no French translation, but a German one does.
    quote_fr: ({ claim }) => db.prepare("UPDATE claims SET lang = 'de' WHERE id = ?").run(claim),
    quote_en: ({ claim }) => db.prepare("UPDATE claims SET quote_en = ' ' WHERE id = ?").run(claim),
    speaker_role_fr: ({ claim }) => db.prepare('UPDATE claims SET speaker_role_fr = NULL WHERE id = ?').run(claim),
    speaker_role_en: ({ claim }) => db.prepare("UPDATE claims SET speaker_role_en = '　' WHERE id = ?").run(claim),
    summary_fr: ({ verdict }) => db.prepare('UPDATE verdicts SET summary_fr = NULL WHERE id = ?').run(verdict),
    summary_en: ({ verdict }) => db.prepare("UPDATE verdicts SET summary_en = ' ' WHERE id = ?").run(verdict),
    excerpt_en: ({ evidence }) => db.prepare('UPDATE verdict_evidence SET excerpt_en = NULL WHERE id = ?').run(evidence),
    // Evidence from an English source needs a French translation...
    excerpt_fr: ({ verdict }) =>
      addEvidence(db, verdict, addSource(db, 'audit', { lang: 'en' }), 'Section 2.', { excerpt_fr: null, excerpt_en: null }),
    // ...and a translation into the source's own language is a duplicate, not a translation.
    excerpt_into_own_language: ({ evidence }) =>
      db.prepare("UPDATE verdict_evidence SET excerpt_fr = 'Article 1 : X entre en vigueur.' WHERE id = ?").run(evidence),
    excerpt_en_into_english: ({ verdict }) =>
      addEvidence(db, verdict, addSource(db, 'audit', { lang: 'en' }), 'Section 2.', { excerpt_fr: 'Section 2.', excerpt_en: 'Section 2.' }),
    // The row checks accept these in one language; only publication needs both.
    criteria_fr: ({ claim }) => db.prepare('UPDATE claims SET criteria_fr = NULL WHERE id = ?').run(claim),
    criteria_en: ({ claim }) => db.prepare("UPDATE claims SET criteria_en = '\n' WHERE id = ?").run(claim),
    open_question_fr: ({ verdict }) =>
      db.prepare("UPDATE verdicts SET verdict = 'to_evaluate', open_question_en = 'The figure is missing.' WHERE id = ?").run(verdict),
    open_question_en: ({ verdict }) =>
      db.prepare("UPDATE verdicts SET verdict = 'to_evaluate', open_question_fr = 'Le chiffre manque.' WHERE id = ?").run(verdict),
    // Every pair is both-or-neither, even where the text is not required (review round 1).
    criteria_one_sided_after_vague: ({ claim, verdict }) => {
      db.prepare("UPDATE claims SET verifiability = 'vague', criteria_en = NULL WHERE id = ?").run(claim);
      db.prepare("UPDATE verdicts SET verdict = 'unverifiable' WHERE id = ?").run(verdict);
    },
    open_question_fr_only_on_came_true: ({ verdict }) =>
      db.prepare("UPDATE verdicts SET open_question_fr = 'Le chiffre manque.' WHERE id = ?").run(verdict),
    open_question_en_only_on_pending: ({ verdict }) =>
      db.prepare("UPDATE verdicts SET verdict = 'pending', open_question_en = 'The figure is missing.' WHERE id = ?").run(verdict),
  };
  for (const [missing, takeAway] of Object.entries(cases)) {
    const ready = readyClaim(db);
    assert.deepEqual(publicationBlockers(db, ready.claim), [], missing);
    takeAway(ready);
    assert.deepEqual(publicationBlockers(db, ready.claim), [BILINGUAL], missing);
    assert.throws(() => confirm(db, ready.claim, 'founder'), /missing its French or English version/, missing);
    assert.equal(publicRecord(db, ready.claim), null, missing);
  }
  // Optional texts may be left out in both languages at once.
  const { claim, verdict } = readyClaim(db);
  db.prepare("UPDATE claims SET speaker_role_fr = NULL, speaker_role_en = NULL, verifiability = 'vague', criteria_fr = NULL, criteria_en = NULL WHERE id = ?").run(claim);
  db.prepare("UPDATE verdicts SET verdict = 'unverifiable' WHERE id = ?").run(verdict);
  // An original in English needs only the French translation; one in another language needs both.
  const english = readyClaim(db);
  db.prepare("UPDATE claims SET lang = 'en', quote_original = 'We will do X.', quote_fr = 'Nous ferons X.', quote_en = NULL WHERE id = ?").run(english.claim);
  addEvidence(db, english.verdict, addSource(db, 'audit', { lang: 'en' }), 'Section 2.', { excerpt_fr: 'Section 2.', excerpt_en: null });
  const german = readyClaim(db);
  db.prepare("UPDATE claims SET lang = 'de', quote_original = 'Wir werden X tun.', quote_fr = 'Nous ferons X.' WHERE id = ?").run(german.claim);
  addEvidence(db, german.verdict, addSource(db, 'audit', { lang: 'de' }), 'Abschnitt 2.', { excerpt_fr: 'Section 2.', excerpt_en: 'Section 2.' });
  for (const id of [english.claim, german.claim]) assert.deepEqual(publicationBlockers(db, id), [], String(id));
  confirm(db, claim, 'founder');
});

const SUMMARY = 'every verdict except "pending" needs a summary explaining it';

test('a summary of zero-width spaces or byte order marks is no summary', () => {
  const db = freshDb();
  const { claim, verdict } = readyClaim(db);
  db.prepare("UPDATE verdicts SET summary_fr = '\u200b', summary_en = '\ufeff \u200b' WHERE id = ?").run(verdict);
  assert.deepEqual(publicationBlockers(db, claim), [SUMMARY]);
  db.prepare("UPDATE verdicts SET summary_fr = 'Réalisée.' WHERE id = ?").run(verdict);
  assert.throws(() => confirm(db, claim, 'founder'), /missing its French or English version/);
});

test('every verdict except "pending" needs a summary, in both languages', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const law = addSource(db, 'law', { sha256: 'b'.repeat(64) });
  const QUESTION = { open_question_fr: 'Le chiffre manque.', open_question_en: 'The figure is missing.' };
  const withVerdict = (verdict, overrides) => {
    const claim = addClaim(db, platform);
    const extra = verdict === 'to_evaluate' ? QUESTION : {};
    addEvidence(db, addVerdict(db, claim, verdict, { ...extra, ...overrides }), law);
    return claim;
  };
  for (const verdict of ['unverifiable', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true']) {
    for (const none of [{ summary_fr: null, summary_en: null }, { summary_fr: ' ', summary_en: '\n' }]) {
      const claim = withVerdict(verdict, none);
      assert.deepEqual(publicationBlockers(db, claim), [SUMMARY], verdict);
      assert.throws(() => confirm(db, claim, 'founder'), /needs a summary/, verdict);
      assert.equal(publicRecord(db, claim), null, verdict);
    }
    // One half only: the summary is stated, but not in both languages.
    for (const half of [{ summary_fr: null }, { summary_en: '\u3000' }]) {
      const claim = withVerdict(verdict, half);
      assert.deepEqual(publicationBlockers(db, claim), [BILINGUAL], `${verdict} ${JSON.stringify(half)}`);
      assert.throws(() => confirm(db, claim, 'founder'), /missing its French or English version/);
    }
    confirm(db, withVerdict(verdict, {}), 'founder');
  }
  // "pending" needs no summary; if it has one, it is in both languages.
  confirm(db, withVerdict('pending', {}), 'founder');
  assert.deepEqual(publicationBlockers(db, withVerdict('pending', { summary_en: 'Not due yet.' })), [BILINGUAL]);
});

test('a vague or hedged claim can only be published as "unverifiable"; a measurable one as anything', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const law = addSource(db, 'law', { sha256: 'b'.repeat(64) });
  const QUESTION = { open_question_fr: 'Le chiffre manque.', open_question_en: 'The figure is missing.' };
  const FITS = 'a vague or hedged claim can only be "unverifiable"';
  const withVerdict = (verifiability, verdict) => {
    const claim = addClaim(db, platform, verifiability === 'measurable' ? {} : { verifiability, criteria_fr: null, criteria_en: null });
    addEvidence(db, addVerdict(db, claim, verdict, verdict === 'to_evaluate' ? QUESTION : {}), law);
    return claim;
  };
  for (const verifiability of ['vague', 'hedged']) {
    for (const verdict of ['pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true']) {
      const claim = withVerdict(verifiability, verdict);
      assert.deepEqual(publicationBlockers(db, claim), [FITS], `${verifiability} ${verdict}`);
      assert.throws(() => confirm(db, claim, 'founder'), /can only be "unverifiable"/);
    }
    confirm(db, withVerdict(verifiability, 'unverifiable'), 'founder');
  }
  for (const verdict of VERDICTS) confirm(db, withVerdict('measurable', verdict), 'founder');
  // Relabelling a published measurable claim as vague stops it from being confirmed again.
  const claim = withVerdict('measurable', 'came_true');
  confirm(db, claim, 'founder');
  db.prepare("UPDATE claims SET verifiability = 'hedged' WHERE id = ?").run(claim);
  assert.equal(hasUnconfirmedChanges(db, claim), true);
  assert.deepEqual(publicationBlockers(db, claim), [FITS]);
});

test('a published claim whose translation is removed shows as changed and cannot be confirmed again', () => {
  const db = freshDb();
  const { claim, evidence } = readyClaim(db);
  confirm(db, claim, 'founder');
  db.prepare('UPDATE verdict_evidence SET excerpt_en = NULL WHERE id = ?').run(evidence);
  assert.equal(hasUnconfirmedChanges(db, claim), true);
  assert.throws(() => confirm(db, claim, 'founder'), /missing its French or English version/);
  assert.equal(publicRecord(db, claim).snapshot.evidence[0].excerpt_en, 'Article 1: X enters into force on 1 January 2025.');
});

test('the snapshot names the subject by its permanent id, and by its Wikidata id when known', () => {
  const db = freshDb();
  const { claim, platform } = readyClaim(db);
  db.prepare("INSERT INTO subjects (kind, name, country, wikidata_id) VALUES ('person', 'Test Subject', 'FR', 'Q42')").run();
  const namesake = addClaim(db, platform, { subject_id: 2, quote_original: 'Nous ferons W.' });
  addVerdict(db, namesake, 'pending');
  confirm(db, claim, 'founder');
  confirm(db, namesake, 'founder');
  assert.deepEqual(
    [claim, namesake].map((id) => publicRecord(db, id).snapshot.subject),
    [
      { id: 1, wikidata_id: null, name: 'Test Subject', kind: 'person', country: 'FR' },
      { id: 2, wikidata_id: 'Q42', name: 'Test Subject', kind: 'person', country: 'FR' },
    ]
  );
});

// ---- A snapshot cannot be made up ------------------------------------------------------

test('a ledger entry cannot be typed in, altered, or borrowed from another claim', () => {
  const db = freshDb();
  const { claim, platform } = readyClaim(db);
  const other = addClaim(db, platform, { quote_original: 'Nous ferons Y.' });
  addVerdict(db, other, 'pending');
  const insert = db.prepare(
    "INSERT INTO publications (claim_id, status, snapshot, confirmed_by) VALUES (?, 'published', ?, 'founder')"
  );
  const real = publishableSnapshot(db, claim);
  assert.throws(() => insert.run(claim, '{"verdict":{"verdict":"kept"}}'), /exactly what is publishable/);
  assert.throws(() => insert.run(claim, real.replace('came_true', 'not_came_true')), /exactly what is publishable/);
  assert.throws(() => insert.run(other, real), /exactly what is publishable/);
  assert.throws(() => insert.run(999, real), /exactly what is publishable/);
  assert.throws(() => insert.run(claim, null), /NOT NULL|exactly what is publishable/);
  insert.run(claim, real);
});

test('a claim that is not publishable cannot enter the ledger by direct insert either', () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  addVerdict(db, claim, 'not_came_true');
  const insert = db.prepare('INSERT INTO publications (claim_id, status, snapshot, confirmed_by) VALUES (?, ?, ?, ?)');
  assert.throws(() => insert.run(claim, 'published', '{}', 'founder'), /exactly what is publishable/);
  // No other status exists to slip in under: anything that is not a withdrawal must
  // carry the exact publishable snapshot, and even then only the two known statuses exist.
  for (const status of ['draft', 'PUBLISHED', '']) {
    assert.throws(() => insert.run(claim, status, '{}', 'founder'), /exactly what is publishable/, status);
  }
  const { claim: ready } = readyClaim(db);
  const real = publishableSnapshot(db, ready);
  for (const status of ['draft', 'PUBLISHED', '']) {
    assert.throws(() => insert.run(ready, status, real, 'founder'), /CHECK/, status);
  }
  assert.throws(() => insert.run(ready, null, real, 'founder'), /NOT NULL/);
});

test('a confirmation names someone and is timestamped when it is recorded', () => {
  const db = freshDb();
  const { claim } = readyClaim(db);
  assert.throws(() => confirm(db, claim, ' \t'), /CHECK/);
  assert.throws(() => confirm(db, claim, ' '), /CHECK/);
  assert.throws(() => confirm(db, claim, null), /NOT NULL/);
  const real = publishableSnapshot(db, claim);
  const dated = db.prepare(
    "INSERT INTO publications (claim_id, status, snapshot, confirmed_by, confirmed_at) VALUES (?, 'published', ?, 'founder', ?)"
  );
  for (const when of ['1990-01-01T00:00:00Z', '2031-01-01T00:00:00Z', timestamp(-300), timestamp(300), '0', 'yesterday', '']) {
    assert.throws(() => dated.run(claim, real, when), /timestamped when it is recorded/, when);
  }
  confirm(db, claim, 'founder');
  const { confirmed_at: at } = db.prepare('SELECT confirmed_at FROM publications').get();
  assert.match(at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(Math.abs(Date.parse(at) - Date.now()) < 60_000);
});

test('confirming again with nothing changed is refused', () => {
  const db = freshDb();
  const { claim } = readyClaim(db);
  confirm(db, claim, 'founder');
  assert.throws(() => confirm(db, claim, 'founder'), /nothing has changed/);
  assert.equal(ledger(db, claim).length, 1);
});

// ---- Later edits cannot change what is public (review round 2) ------------------------

test('confirm one verdict, then change it: the public record still shows what was confirmed', () => {
  const db = freshDb();
  const { claim, verdict, evidence } = readyClaim(db);
  confirm(db, claim, 'founder');
  assert.equal(hasUnconfirmedChanges(db, claim), false);

  db.prepare("UPDATE verdicts SET verdict = 'not_came_true', summary_fr = 'Le contraire.', summary_en = 'The opposite.' WHERE id = ?").run(verdict);
  db.prepare('DELETE FROM verdict_evidence WHERE id = ?').run(evidence);
  addEvidence(db, verdict, addSource(db, 'audit', { sha256: 'c'.repeat(64) }), 'The audit found no such measure.');

  assert.equal(publicRecord(db, claim).snapshot.verdict.verdict, 'came_true');
  assert.equal(publicRecord(db, claim).snapshot.evidence[0].kind, 'law');
  assert.equal(hasUnconfirmedChanges(db, claim), true);

  confirm(db, claim, 'reviewer');
  assert.deepEqual(
    ledger(db, claim).map((e) => [e.confirmed_by, e.snapshot.verdict.verdict, e.snapshot.evidence[0].kind]),
    [['founder', 'came_true', 'law'], ['reviewer', 'not_came_true', 'audit']]
  );
  assert.equal(hasUnconfirmedChanges(db, claim), false);
});

test('editing the claim, its subject or its sources after confirmation does not touch the public record', () => {
  const db = freshDb();
  const { claim, law, platform } = readyClaim(db);
  confirm(db, claim, 'founder');
  const before = JSON.stringify(publicRecord(db, claim));

  db.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', 'Someone Else', 'US')").run();
  db.prepare("UPDATE claims SET subject_id = 2, criteria_en = 'Something easier.', deadline = '2040-01-01', quote_original = 'Other words.' WHERE id = ?").run(claim);
  db.prepare("UPDATE subjects SET name = 'Renamed' WHERE id = 1").run();
  db.prepare("UPDATE sources SET title = 'Retitled', publisher = 'Another office' WHERE id = ?").run(law);
  assert.throws(() => db.prepare("UPDATE sources SET url = 'https://example.org/elsewhere' WHERE id = ?").run(law), /permanent/);

  assert.equal(JSON.stringify(publicRecord(db, claim)), before);
  assert.equal(hasUnconfirmedChanges(db, claim), true);

  // Relabelling the evidence as a statement makes the claim unpublishable: it still
  // counts as changed, the next confirmation is refused, and the public record stays.
  db.prepare("UPDATE sources SET kind = 'statement' WHERE id = ?").run(law);
  assert.equal(hasUnconfirmedChanges(db, claim), true);
  assert.throws(() => confirm(db, claim, 'founder'), /needs one official document/);
  db.prepare("UPDATE sources SET kind = 'law' WHERE id = ?").run(platform);
  assert.throws(() => confirm(db, claim, 'founder'), /not the speaker's own published words/);
  assert.equal(JSON.stringify(publicRecord(db, claim)), before);
});

test("a speaker's role belongs to the claim, so changing it touches one claim only", () => {
  const db = freshDb();
  const { claim, platform } = readyClaim(db);
  const later = addClaim(db, platform, {
    speaker_role_fr: 'Président', speaker_role_en: 'President', said_on: '2024-01-10', quote_original: 'Nous ferons Z.',
  });
  addVerdict(db, later, 'pending');
  confirm(db, claim, 'founder');
  confirm(db, later, 'founder');
  db.prepare("UPDATE claims SET speaker_role_fr = 'Ancien président', speaker_role_en = 'Former president' WHERE id = ?").run(later);
  assert.equal(hasUnconfirmedChanges(db, later), true);
  assert.equal(hasUnconfirmedChanges(db, claim), false);
  assert.equal(publicRecord(db, claim).snapshot.claim.speaker_role_en, 'Candidate for president, 2022');
});

test('a claim with a public record cannot be deleted or renumbered', () => {
  const db = freshDb();
  const { claim } = readyClaim(db);
  confirm(db, claim, 'founder');
  assert.throws(() => db.prepare('DELETE FROM claims WHERE id = ?').run(claim), /FOREIGN KEY/);
  assert.throws(() => db.prepare('UPDATE claims SET id = 500 WHERE id = ?').run(claim), /FOREIGN KEY/);
});

// ---- The ledger only grows, in order, on any connection --------------------------------

test('the ledger cannot be edited, deleted from or overwritten — even on a plain connection', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kanverify-ledger-'));
  t.after(() => rmSync(dir, { recursive: true }));
  const file = join(dir, 'test.db');

  const db = freshDb(file);
  const { claim } = readyClaim(db);
  confirm(db, claim, 'founder');
  db.close();

  // Not opened through src/db.js: no pragmas set, nothing prepared. It registers the one
  // publisher normalisation, as any connection must to evaluate what is publishable.
  const plain = new DatabaseSync(file);
  plain.function('kv_publisher_key', { deterministic: true }, (n) => publisherKey(n));
  const before = JSON.stringify(plain.prepare('SELECT * FROM publications').all());
  const fromPublishable = "claim_id, 'published', snapshot, 'intern' FROM publishable";
  const attacks = [
    ["UPDATE publications SET snapshot = '{}'", /append-only/],
    ["UPDATE publications SET confirmed_by = 'intern'", /append-only/],
    ["UPDATE publications SET status = 'withdrawn', note_fr = 'x', note_en = 'x'", /append-only/],
    ['DELETE FROM publications', /append-only/],
    [`REPLACE INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT 1, ${fromPublishable}`, /append-only/],
    [`INSERT OR REPLACE INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT 1, ${fromPublishable}`, /append-only/],
    ['UPDATE OR REPLACE publications SET id = 1 WHERE id = 1', /append-only/],
    [`INSERT INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT 1, ${fromPublishable} WHERE true ON CONFLICT(id) DO UPDATE SET confirmed_by = 'intern'`, /append-only/],
    // A caller cannot pick an entry's number.
    [`INSERT INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT 9223372036854775807, ${fromPublishable}`, /numbered in order/],
    [`INSERT INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT 1000, ${fromPublishable}`, /numbered in order/],
    [`INSERT INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT 3, ${fromPublishable}`, /numbered in order/],
    [`INSERT INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT -1, ${fromPublishable}`, /CHECK|numbered in order/],
    [`INSERT INTO publications (id, claim_id, status, snapshot, confirmed_by) SELECT 0, ${fromPublishable}`, /CHECK|numbered in order/],
  ];
  for (const [sql, expected] of attacks) {
    assert.throws(() => plain.exec(sql), expected, sql);
  }
  assert.equal(JSON.stringify(plain.prepare('SELECT * FROM publications').all()), before);

  // The ledger still works normally afterwards, and numbering carries on from 2.
  plain.exec(`INSERT INTO publications (claim_id, status, snapshot, confirmed_by) SELECT ${fromPublishable}`);
  assert.deepEqual(plain.prepare('SELECT id FROM publications ORDER BY id').all().map((r) => r.id), [1, 2]);
  plain.close();
});

// ---- Withdrawal ------------------------------------------------------------------------

test('withdrawing adds an entry that keeps what was withdrawn and why', () => {
  const db = freshDb();
  const { claim } = readyClaim(db);
  confirm(db, claim, 'founder');
  const fr = 'Le passage cité provenait d’un autre programme.';
  const en = 'The quoted passage was attributed to the wrong programme.';
  // The reason is published on both sites, so both halves are required; blank is missing.
  for (const blank of [undefined, null, '', '  ', '\u3000', '\u200b\ufeff', '\u2060\u00ad']) {
    assert.throws(() => withdraw(db, claim, 'founder', { noteFr: blank, noteEn: blank }), /CHECK/, JSON.stringify(blank));
    assert.throws(() => withdraw(db, claim, 'founder', { noteFr: fr, noteEn: blank }), /CHECK/, JSON.stringify(blank));
    assert.throws(() => withdraw(db, claim, 'founder', { noteFr: blank, noteEn: en }), /CHECK/, JSON.stringify(blank));
  }
  assert.throws(() => withdraw(db, claim, 'founder'), /CHECK/);
  withdraw(db, claim, 'founder', { noteFr: fr, noteEn: en });

  const entries = ledger(db, claim);
  assert.deepEqual(entries.map((e) => e.status), ['published', 'withdrawn']);
  assert.deepEqual(entries[1].snapshot, entries[0].snapshot);
  assert.deepEqual([entries[1].note_fr, entries[1].note_en], [fr, en]);
  assert.equal(publicRecord(db, claim).status, 'withdrawn');

  // Nothing is public any more, so workspace edits are not "unconfirmed changes".
  db.prepare("UPDATE claims SET source_locator = 'p. 14' WHERE id = ?").run(claim);
  assert.equal(hasUnconfirmedChanges(db, claim), false);
});

test('only what is currently public can be withdrawn', () => {
  const db = freshDb();
  const { claim, platform, verdict } = readyClaim(db);
  assert.throws(() => withdraw(db, claim, 'founder', REASON), /nothing currently published/);

  const insert = db.prepare(
    "INSERT INTO publications (claim_id, status, snapshot, note_fr, note_en, confirmed_by) VALUES (?, 'withdrawn', ?, 'raison', 'reason', 'founder')"
  );
  // Never published: not by function, not by direct insert.
  const other = addClaim(db, platform);
  addVerdict(db, other, 'pending');
  assert.throws(() => insert.run(other, '{}'), /only what is currently published can be withdrawn/);

  // Published twice: the entry must carry the newest snapshot, not an older one or a made-up one.
  confirm(db, claim, 'founder');
  const first = db.prepare('SELECT snapshot FROM publications WHERE claim_id = ?').get(claim).snapshot;
  db.prepare("UPDATE verdicts SET summary_fr = 'Précisé.', summary_en = 'Clarified.' WHERE id = ?").run(verdict);
  confirm(db, claim, 'founder');
  assert.throws(() => insert.run(claim, first), /only what is currently published can be withdrawn/);
  assert.throws(() => insert.run(claim, '{}'), /only what is currently published can be withdrawn/);

  // Already withdrawn: not again, by function or by direct insert of the same snapshot.
  withdraw(db, claim, 'founder', REASON);
  const newest = db.prepare('SELECT snapshot FROM current_publications WHERE claim_id = ?').get(claim).snapshot;
  assert.throws(() => withdraw(db, claim, 'founder', REASON), /nothing currently published/);
  assert.throws(() => insert.run(claim, newest), /only what is currently published can be withdrawn/);
});

test('after a withdrawal, a corrected version can be confirmed again', () => {
  const db = freshDb();
  const { claim } = readyClaim(db);
  confirm(db, claim, 'founder');
  withdraw(db, claim, 'founder', { noteFr: 'Mauvaise page.', noteEn: 'Wrong locator.' });
  db.prepare("UPDATE claims SET source_locator = 'p. 14' WHERE id = ?").run(claim);
  confirm(db, claim, 'founder');
  assert.deepEqual(ledger(db, claim).map((e) => e.status), ['published', 'withdrawn', 'published']);
  assert.equal(publicRecord(db, claim).snapshot.claim.source_locator, 'p. 14');
});

test('the website view shows only the newest entry of each claim', () => {
  const db = freshDb();
  const { claim, platform, verdict } = readyClaim(db);
  const other = addClaim(db, platform);
  addVerdict(db, other, 'pending');
  confirm(db, claim, 'founder');
  confirm(db, other, 'founder');
  db.prepare("UPDATE verdicts SET summary_fr = 'Précisé.', summary_en = 'Clarified.' WHERE id = ?").run(verdict);
  confirm(db, claim, 'founder');
  const rows = db.prepare('SELECT claim_id, id FROM current_publications ORDER BY claim_id').all();
  assert.deepEqual(rows.map((r) => [r.claim_id, r.id]), [[claim, 3], [other, 2]]);
});

test('review 7 re-check: confirm() refuses a cited source of any kind dated after today', () => {
  const db = freshDb();
  const { claim, law } = readyClaim(db); // came_true resting on a law dated 2025-01-01
  assert.throws(() => confirmOn(db, claim, 'founder', { today: '2024-06-01' }), new RegExp(`the law document \\(source ${law}\\) is dated 2025-01-01, after 2024-06-01; it cannot be cited before it is published`));
  assert.equal(ledger(db, claim).length, 0);
  assert.match(blockersOn(db, claim, { today: '2024-06-01' }).join(), /cannot be cited before it is published/);
  confirmOn(db, claim, 'founder', { today: '2025-01-01' }); // the day it is published is fine
  assert.equal(ledger(db, claim).length, 1);
  db.close();
});

// ---- Fable review 8 ------------------------------------------------------------------

test('review 8, finding 2: confirm() refuses a rules version or a rule id the kept standard does not hold', () => {
  const { db, law, make } = rnSetup();
  const claim = make('came_true', [law], {}, ['EA-1', 'EV-1']);
  const set = (version, rules) => db.prepare('UPDATE verdicts SET rules_version = ?, rules_applied = ? WHERE claim_id = ?').run(version, JSON.stringify(rules), claim);
  // A version of the right form that is not kept: the site could never build this entry.
  set('9.9', ['EA-1', 'EV-1']);
  assert.match(blockersOn(db, claim, { today: BEFORE }).join(), /judged under verdict standard "9\.9", the current one is/);
  assert.throws(() => confirmOn(db, claim, 'founder', { today: BEFORE }), /judged under verdict standard "9\.9"/);
  // An id of the right form that the version does not have.
  set(RULES_VERSION, ['EA-1', 'ZZ-99']);
  assert.match(blockersOn(db, claim, { today: BEFORE }).join(), /"ZZ-99" is not a rule of the verdict standard/);
  assert.throws(() => confirmOn(db, claim, 'founder', { today: BEFORE }), /ZZ-99/);
  // Re-check R4: only the current version is confirmed; a verdict stamped with a kept earlier version is looked at again first.
  set('0.6', ['EA-1', 'EV-1']);
  assert.throws(() => confirmOn(db, claim, 'founder', { today: BEFORE }), new RegExp(`judged under verdict standard "0\\.6", the current one is ${RULES_VERSION.replace('.', '\\.')}`));
  set(RULES_VERSION, ['EA-1', 'EV-1']);
  confirmOn(db, claim, 'founder', { today: BEFORE });
  // Nothing hidden after a NUL or around the version: the row is refused.
  for (const version of [RULES_VERSION + '\u0000x', ` ${RULES_VERSION}`, `${RULES_VERSION}\n`]) {
    assert.throws(() => set(version, ['EV-1']), /constraint/, JSON.stringify(version));
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM publications').get().n, 1);
});

test('review 8, finding 5: a cited reversal means the verdict names RN-1', () => {
  const { db, ren, make } = rnSetup();
  const claim = make('not_came_true', [ren('2025-06-01')], {}, ['EV-3']);
  assert.deepEqual(blockersOn(db, claim, { today: AFTER }), ['a reversal by the speaker is cited, so RN-1 decided the verdict: rules_applied must name RN-1']);
  assert.throws(() => confirmOn(db, claim, 'founder', { today: AFTER }), /must name RN-1/);
  db.prepare('UPDATE verdicts SET rules_applied = \'["RN-1"]\' WHERE claim_id = ?').run(claim);
  confirmOn(db, claim, 'founder', { today: AFTER });
});

test('re-check R3: a "came_true" confirmed on or before the deadline names EA-1 (it is provisional)', () => {
  const { db, law, make } = rnSetup();
  const EA_MSG = '"came_true" on or before the deadline 2027-05-13 is the early, provisional verdict: rules_applied must name EA-1';
  const early = make('came_true', [law], {}, ['OC-1', 'EV-1']);
  for (const today of [BEFORE, '2027-05-13']) assert.deepEqual(blockersOn(db, early, { today }), [EA_MSG], today);
  assert.throws(() => confirmOn(db, early, 'founder', { today: BEFORE }), /must name EA-1/);
  // After the deadline it is the final verdict (DL-2): EA-1 is not required.
  confirmOn(db, early, 'founder', { today: AFTER });
  confirmOn(db, make('came_true', [law], {}, ['EA-1', 'OC-1', 'EV-1']), 'founder', { today: BEFORE });
});
