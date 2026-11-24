// The lists that may grow (record format 13): claim_domains and source_kinds are the one place a
// domain or a source kind is defined. Every copy in the code must hold exactly those codes, so a
// code added by an upgrade cannot reach the record without a label on the site and the desk.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { DOMAINS as EXTRACT_DOMAINS } from '../src/extract.js';
import { DOMAINS as SITE_DOMAINS, SITE_LABELS } from '../src/site.js';
import { LABELS as DESK_LABELS } from '../src/desk-view.js';
import { EVIDENCE_KINDS } from '../src/pack.js';

function lists() {
  const db = openDatabase(':memory:');
  const read = (table) => db.prepare(`SELECT code FROM ${table} ORDER BY rowid`).all().map((r) => r.code);
  const out = { domains: read('claim_domains'), kinds: read('source_kinds') };
  db.close();
  return out;
}
const sorted = (xs) => [...xs].sort();

test('every domain of claim_domains, and no other, is in the extraction check, the site and the desk', () => {
  const { domains } = lists();
  assert.deepEqual([...EXTRACT_DOMAINS], domains);
  assert.deepEqual([...SITE_DOMAINS], domains);
  for (const lang of ['en', 'fr']) assert.deepEqual(sorted(Object.keys(SITE_LABELS[lang].d)), sorted(domains), lang);
  assert.deepEqual(sorted(Object.keys(DESK_LABELS.domain)), sorted(domains));
});

test('every kind of source_kinds, and no other, is labelled on the site and the desk and classed by the vote checks', () => {
  const { kinds } = lists();
  for (const lang of ['en', 'fr']) assert.deepEqual(sorted(Object.keys(SITE_LABELS[lang].kind)), sorted(kinds), lang);
  assert.deepEqual(sorted(Object.keys(DESK_LABELS.kind)), sorted(kinds));
  assert.deepEqual(sorted([...EVIDENCE_KINDS, 'platform', 'statement']), sorted(kinds));
});

test('a code in use cannot be removed or renamed; an unknown code cannot be used', () => {
  const db = openDatabase(':memory:');
  db.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', 'A', 'FR')").run();
  db.prepare(`INSERT INTO sources (kind, url, title, publisher, retrieved_on, sha256, media_type, lang)
              VALUES ('platform', 'https://example.org/p', 'P', 'X', '2026-11-24', ?, 'text/html', 'fr')`).run('a'.repeat(64));
  db.prepare(`INSERT INTO claims (subject_id, type, domain, quote_original, lang, said_on, source_id, source_locator, verifiability)
              VALUES (1, 'promise', 'tax', 'Q', 'fr', '2022-01-01', 1, 'p. 1', 'vague')`).run();
  assert.throws(() => db.prepare("DELETE FROM claim_domains WHERE code = 'tax'").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("UPDATE claim_domains SET code = 'taxes' WHERE code = 'tax'").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("DELETE FROM source_kinds WHERE code = 'platform'").run(), /FOREIGN KEY/);
  assert.throws(() => db.prepare("INSERT INTO claim_domains (code) VALUES ('Space')").run(), /CHECK/);
  assert.throws(() => db.prepare("INSERT INTO claim_domains (code) VALUES (NULL)").run(), /NOT NULL/);
  db.close();
});
