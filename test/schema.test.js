// Workspace rules: facts about a single row, enforced by column types and CHECK
// constraints. Each test tries to store something malformed and expects to be refused.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHA, freshDb, addSource, addClaim, addVerdict, addEvidence, addVote, VERDICTS } from './helpers.js';

test('a claim cannot be stored without a source', () => {
  const db = freshDb();
  assert.throws(() => addClaim(db, null), /NOT NULL/);
  assert.throws(() => addClaim(db, 999), /FOREIGN KEY/);
});

test('a claim needs its verbatim quote and a locator inside its source', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  assert.throws(() => addClaim(db, platform, { source_locator: '  ' }), /CHECK/);
  assert.throws(() => addClaim(db, platform, { quote_original: '\r\n' }), /CHECK/);
});

// Every character the schema treats as blank (see "Not blank" in db/schema.sql).
const BLANKS = [
  ' ', '\t', '\n', '\v', '\f', '\r', '\u0085', ' ', '­', ' ',
  ...Array.from({ length: 14 }, (_, i) => String.fromCharCode(0x2000 + i)), // U+2000 to U+200D
  ' ', ' ', ' ', ' ', '⁠', '　', '﻿',
];

test('blank means blank: invisible spaces, zero-width spaces and byte order marks do not count as content', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  for (const blank of [...BLANKS, BLANKS.join(''), '  \t　\n']) {
    const label = JSON.stringify(blank);
    assert.throws(() => addClaim(db, platform, { quote_original: blank }), /CHECK/, label);
    assert.throws(() => addSource(db, 'law', { title: blank }), /CHECK/, label);
  }
  // A zero-width space or a byte order mark is not an open question.
  const claim = addClaim(db, platform);
  assert.throws(() => addVerdict(db, claim, 'to_evaluate', { open_question_fr: '​', open_question_en: '﻿' }), /CHECK/);
  assert.throws(() => addVerdict(db, claim, 'to_evaluate', { open_question_fr: '﻿​ ' }), /CHECK/);
  addVerdict(db, claim, 'to_evaluate', { open_question_fr: '﻿Le chiffre manque.' });
  // Nor is a quote made of word joiners and soft hyphens.
  assert.throws(() => addClaim(db, platform, { quote_original: '⁠‌‍­' }), /CHECK/);
});

test('a language is a lowercase two-letter ISO 639-1 code', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  for (const bad of ['FR', 'fra', 'fr-FR', 'f', '', ' fr', 'fr\0x', 'français']) {
    const label = JSON.stringify(bad);
    assert.throws(() => addClaim(db, platform, { lang: bad, quote_fr: 'x' }), /CHECK/, label);
    assert.throws(() => addSource(db, 'law', { lang: bad }), /CHECK/, label);
  }
  addClaim(db, platform, { lang: 'de', quote_fr: 'Nous ferons X.' });
  addSource(db, 'law', { lang: 'en' });
});

test('a quote has no translation into its own language: the original is that text', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  for (const duplicate of ['Nous ferons X avant 2027.', '', ' ']) {
    const label = JSON.stringify(duplicate);
    assert.throws(() => addClaim(db, platform, { lang: 'fr', quote_fr: duplicate }), /CHECK/, label);
    assert.throws(() => addClaim(db, platform, { lang: 'en', quote_en: duplicate, quote_fr: 'x' }), /CHECK/, label);
  }
  const claim = addClaim(db, platform, { lang: 'fr' });
  assert.throws(() => db.prepare("UPDATE claims SET lang = 'en' WHERE id = ?").run(claim), /CHECK/);
  db.prepare("UPDATE claims SET lang = 'en', quote_en = NULL, quote_fr = 'Nous ferons X.' WHERE id = ?").run(claim);
});

test('a source id is never reused, and its id, address and file never change', () => {
  const db = freshDb();
  const first = addSource(db, 'law');
  const highest = addSource(db, 'law', { url: 'https://example.org/second' });
  db.prepare('DELETE FROM sources WHERE id = ?').run(highest);
  assert.ok(addSource(db, 'law', { url: 'https://example.org/third' }) > highest);
  for (const sql of [
    "UPDATE sources SET url = 'https://example.org/elsewhere' WHERE id = ?",
    `UPDATE sources SET sha256 = '${'d'.repeat(64)}' WHERE id = ?`,
    'UPDATE sources SET id = 500 WHERE id = ?',
    'UPDATE sources SET rowid = 500 WHERE id = ?',
    'UPDATE sources SET oid = 500 WHERE id = ?',
    'UPDATE sources SET _rowid_ = 500 WHERE id = ?',
  ]) {
    assert.throws(() => db.prepare(sql).run(first), /permanent/, sql);
  }
  assert.throws(
    () => db.prepare(`INSERT INTO sources (id, kind, url, title, publisher, retrieved_on, sha256, media_type, lang)
      VALUES (?, 'law', 'u', 't', 'p', '2026-11-23', '${'a'.repeat(64)}', 'text/html', 'fr')
      ON CONFLICT(id) DO UPDATE SET url = 'https://example.org/upsert'`).run(first),
    /permanent/
  );
  // Everything else about a source may be corrected.
  db.prepare("UPDATE sources SET title = 'Corrected title', publisher = 'Corrected', published_on = '2025-02-02' WHERE id = ?").run(first);
});

test('a measurable claim always has a deadline', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  assert.throws(() => addClaim(db, platform, { deadline: null, deadline_basis: null }), /CHECK/);
  const claim = addClaim(db, platform);
  assert.throws(() => db.prepare('UPDATE claims SET deadline = NULL, deadline_basis = NULL WHERE id = ?').run(claim), /CHECK/);
  addClaim(db, platform, { verifiability: 'hedged', criteria_fr: null, criteria_en: null, deadline: null, deadline_basis: null });
});

test('the desk bookkeeping columns: a vote names its pack by hash; a verdict may name its round', () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  for (const bad of [null, 'abc', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64) + '\0x', '']) {
    assert.throws(() => addVote(db, claim, 'm', 'pending', { pack_sha256: bad }), /CHECK|NOT NULL/, JSON.stringify(bad));
  }
  addVote(db, claim, 'm', 'pending', { pack_sha256: 'f'.repeat(64) });
  const v = addVerdict(db, claim, 'pending');
  assert.equal(db.prepare('SELECT based_on_round FROM verdicts WHERE id = ?').get(v).based_on_round, null);
  db.prepare('UPDATE verdicts SET based_on_round = 2 WHERE id = ?').run(v);
});

test('a subject id is never reused and never changed', () => {
  const db = freshDb();
  const insert = db.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', ?, 'FR')");
  insert.run('Second');
  const highest = Number(insert.run('Third').lastInsertRowid);
  db.prepare('DELETE FROM subjects WHERE id = ?').run(highest);
  assert.ok(Number(insert.run('Fourth').lastInsertRowid) > highest);
  for (const sql of [
    'UPDATE subjects SET id = 100 WHERE id = 2',
    'UPDATE OR REPLACE subjects SET id = 1 WHERE id = 2',
    'UPDATE subjects SET id = id + 1000',
    // id is the rowid, reachable under its other names too (review round 2).
    'UPDATE subjects SET rowid = 100 WHERE id = 2',
    'UPDATE subjects SET oid = 100 WHERE id = 2',
    'UPDATE subjects SET _rowid_ = 100 WHERE id = 2',
    "INSERT INTO subjects (id, kind, name, country) VALUES (2, 'person', 'X', 'FR') ON CONFLICT(id) DO UPDATE SET rowid = 100",
  ]) {
    assert.throws(() => db.prepare(sql).run(), /subject id is permanent/, sql);
  }
  assert.deepEqual(db.prepare('SELECT id FROM subjects ORDER BY id').all().map((r) => r.id), [1, 2, 4]);
  // Renaming works, and so does writing the same id back.
  db.prepare("UPDATE subjects SET name = 'Renamed' WHERE id = 2").run();
  db.prepare("UPDATE subjects SET id = 2, name = 'Renamed again' WHERE id = 2").run();
  assert.equal(db.prepare('SELECT name FROM subjects WHERE id = 2').get().name, 'Renamed again');
});

test('a source cannot be stored without the hash of its archived copy', () => {
  const db = freshDb();
  assert.throws(() => addSource(db, 'law', { sha256: null }), /NOT NULL/);
  assert.throws(() => addSource(db, 'law', { sha256: 'not-a-hash' }), /CHECK/);
  assert.throws(() => addSource(db, 'law', { sha256: 'A'.repeat(64) }), /CHECK/);
  assert.throws(() => addSource(db, 'law', { sha256: 'a'.repeat(63) }), /CHECK/);
  assert.throws(() => addSource(db, 'law', { sha256: SHA + '\0ZZZ' }), /CHECK/);
});

test('a text column holds text and nothing else', () => {
  const db = freshDb();
  const bytes = new Uint8Array([1, 2, 3]);
  assert.throws(() => addSource(db, 'law', { sha256: new Uint8Array(64) }), /cannot store BLOB/);
  assert.throws(() => addSource(db, 'law', { title: bytes }), /cannot store BLOB/);
  const platform = addSource(db, 'platform');
  assert.throws(() => addClaim(db, platform, { speaker_role_fr: bytes }), /cannot store BLOB/);
  assert.throws(() => db.prepare('UPDATE subjects SET name = ? WHERE id = 1').run(bytes), /cannot store BLOB/);
  // Every table that feeds the public snapshot, and the ledger itself.
  const claim = addClaim(db, platform);
  const verdict = addVerdict(db, claim, 'pending');
  addEvidence(db, verdict, addSource(db, 'law'));
  addVote(db, claim, 'model-1', 'came_true');
  assert.throws(() => db.prepare('UPDATE verdicts SET summary_en = ?').run(bytes), /cannot store BLOB/);
  assert.throws(() => db.prepare('UPDATE verdict_evidence SET excerpt = ?').run(bytes), /cannot store BLOB/);
  assert.throws(() => db.prepare('UPDATE verdict_evidence SET excerpt_en = ?').run(bytes), /cannot store BLOB/);
  assert.throws(() => db.prepare('UPDATE subjects SET wikidata_id = ?').run(bytes), /cannot store BLOB/);
  assert.throws(() => db.prepare('UPDATE jury_votes SET model = ?').run(bytes), /cannot store BLOB/);
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO publications (claim_id, status, snapshot, confirmed_by) VALUES (?, 'published', ?, 'founder')")
        .run(claim, bytes),
    /cannot store BLOB/
  );
});

test('a source says where it came from and what kind of file it is', () => {
  const db = freshDb();
  assert.throws(() => addSource(db, 'law', { url: '\n' }), /CHECK/);
  assert.throws(() => addSource(db, 'law', { publisher: '\t' }), /CHECK/);
  assert.throws(() => addSource(db, 'law', { media_type: 'pdf' }), /CHECK/);
  // A kind is a row of source_kinds (format 13).
  assert.throws(() => addSource(db, 'rumour'), /FOREIGN KEY/);
});

test('dates are real calendar dates in one format', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  for (const bad of ['2022', '2022-02-31', 'last spring', '17/03/2022', '2022-3-17']) {
    assert.throws(() => addClaim(db, platform, { said_on: bad }), /CHECK/, bad);
    assert.throws(() => addClaim(db, platform, { deadline: bad }), /CHECK/, bad);
    assert.throws(() => addSource(db, 'law', { retrieved_on: bad }), /CHECK/, bad);
    assert.throws(() => addSource(db, 'law', { published_on: bad }), /CHECK/, bad);
  }
  addSource(db, 'law', { published_on: null });
});

test('a country is a two-letter code', () => {
  const db = freshDb();
  const insert = db.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', 'B', ?)");
  assert.throws(() => insert.run('France'), /CHECK/);
  assert.throws(() => insert.run('fr'), /CHECK/);
  insert.run('US');
});

test('a measurable claim must state its criteria at recording time, in at least one language', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  for (const blank of [null, '', ' \n', '　']) {
    assert.throws(() => addClaim(db, platform, { criteria_fr: blank, criteria_en: blank }), /CHECK/, String(blank));
  }
  // One language is enough to record it; the translation can follow (publication needs both).
  addClaim(db, platform, { criteria_en: null });
  const claim = addClaim(db, platform, { criteria_fr: ' ' });
  assert.throws(() => db.prepare('UPDATE claims SET criteria_en = NULL WHERE id = ?').run(claim), /CHECK/);
  addClaim(db, platform, { verifiability: 'vague', criteria_fr: null, criteria_en: null, deadline: null, deadline_basis: null });
});

test('a policy domain is one code of claim_domains', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const domains = ['economy', 'tax', 'employment', 'health', 'education', 'environment', 'energy', 'security',
    'defence', 'justice', 'immigration', 'foreign_affairs', 'institutions', 'social', 'housing', 'transport',
    'agriculture', 'digital', 'culture', 'other'];
  for (const domain of domains) addClaim(db, platform, { domain });
  for (const bad of ['Economy', 'économie', 'pensions', 'defense', 'economy ', '']) {
    assert.throws(() => addClaim(db, platform, { domain: bad }), /FOREIGN KEY/, bad);
  }
  assert.throws(() => addClaim(db, platform, { domain: null }), /NOT NULL/);
});

test('a Wikidata id is optional, well formed, and belongs to one subject only', () => {
  const db = freshDb();
  const insert = db.prepare("INSERT INTO subjects (kind, name, country, wikidata_id) VALUES ('person', 'Same Name', 'FR', ?)");
  insert.run(null);
  insert.run(null);
  insert.run('Q42');
  insert.run('Q1');
  for (const bad of ['Q', 'Q0', 'Q042', 'q42', '42', 'Q4 2', ' Q42', 'Q42 ', 'Q42a', 'P31', 'Q42\0X', '']) {
    assert.throws(() => insert.run(bad), /CHECK/, JSON.stringify(bad));
  }
  assert.throws(() => insert.run('Q42'), /UNIQUE/);
  assert.throws(() => db.prepare("UPDATE subjects SET wikidata_id = 'Q42' WHERE id = 1").run(), /UNIQUE/);
});

test('a deadline always says whether it was stated or inferred', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  assert.throws(() => addClaim(db, platform, { deadline_basis: null }), /CHECK/);
  assert.throws(() => addClaim(db, platform, { deadline: null }), /CHECK/);
});

test('"to_evaluate" cannot be saved without saying what is missing', () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  for (const blank of [null, '', '   ', '\n\t', ' ']) {
    assert.throws(() => addVerdict(db, claim, 'to_evaluate', { open_question_fr: blank, open_question_en: blank }), /CHECK/);
    assert.throws(() => addVote(db, claim, 'model-1', 'to_evaluate', { open_question: blank }), /CHECK/);
  }
  // One language is enough to record it; publication needs both (see the ledger tests).
  addVerdict(db, claim, 'to_evaluate', { open_question_en: 'The 2026 figure is not published yet.' });
  assert.throws(() => db.prepare('UPDATE verdicts SET open_question_en = NULL WHERE claim_id = ?').run(claim), /CHECK/);
  const other = addClaim(db, addSource(db, 'platform'));
  addVerdict(db, other, 'to_evaluate', { open_question_fr: "Le chiffre de 2026 n'est pas encore publié." });
});

test('a verdict is one of six values, the same for promises and predictions', () => {
  const db = freshDb();
  const platform = addSource(db, 'platform');
  const question = { open_question_fr: 'Le chiffre manque.', open_question_en: 'The figure is missing.' };
  for (const type of ['promise', 'prediction']) {
    for (const verdict of VERDICTS) {
      const claim = addClaim(db, platform, { type });
      addVerdict(db, claim, verdict, verdict === 'to_evaluate' ? question : {});
      addVote(db, claim, 'model-1', verdict, { open_question: verdict === 'to_evaluate' ? 'Missing figure.' : null });
    }
  }
  const claim = addClaim(db, platform);
  for (const old of ['kept', 'partly_kept', 'not_kept', 'condition_unmet', 'undeterminable', 'Pending', 'partly', 'partly-came-true', '']) {
    assert.throws(() => addVerdict(db, claim, old, question), /CHECK/, old);
    assert.throws(() => addVote(db, claim, 'model-1', old, { open_question: 'x' }), /CHECK/, old);
  }
});

test('a claim has one working verdict', () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  addVerdict(db, claim, 'pending');
  assert.throws(() => addVerdict(db, claim, 'came_true'), /UNIQUE/);
});

test('each jury member votes once per round on a claim', () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  addVote(db, claim, 'model-1', 'came_true');
  assert.throws(() => addVote(db, claim, 'model-1', 'not_came_true'), /UNIQUE/);
  addVote(db, claim, 'model-1', 'not_came_true', { round: 2 });
  addVote(db, claim, 'model-2', 'not_came_true');
});

test("a vote's evidence is a list", () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  assert.throws(() => addVote(db, claim, 'model-1', 'came_true', { evidence_json: 'not json' }), /CHECK/);
  assert.throws(() => addVote(db, claim, 'model-1', 'came_true', { evidence_json: '{"a":1}' }), /CHECK/);
  addVote(db, claim, 'model-1', 'came_true', { evidence_json: '[{"source_id":2,"excerpt":"x","locator":"art. 1"}]' });
});

test('an unpublished claim can be removed together with its verdict, evidence and votes', () => {
  const db = freshDb();
  const claim = addClaim(db, addSource(db, 'platform'));
  const verdict = addVerdict(db, claim, 'came_true');
  addEvidence(db, verdict, addSource(db, 'law'));
  addVote(db, claim, 'model-1', 'came_true');
  db.prepare('DELETE FROM claims WHERE id = ?').run(claim);
  for (const table of ['verdicts', 'verdict_evidence', 'jury_votes']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
});
