// Upgrading a record format in place (src/db.js upgradeDatabase; Fable review 10).
//
// The fixture is a file in the kept format 13 (db/formats/schema-13.sql) with a ledger holding a
// published, a re-confirmed and a withdrawn entry, and an unpublished claim. The upgrade goes to a
// test format 14 written here: a new column, a new domain, a new row guard with its companion
// assertion, and the publishable view recreated with the same shape.
//
// Test exemption (code-reviewer.md item 7): after the upgrade the file is format 14, which
// openDatabase refuses, so it is read with DatabaseSync directly, with the same settings.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_VERSION, ledgerState, openDatabase, upgradeDatabase } from '../src/db.js';
import { confirm, hasUnconfirmedChanges, withdraw } from '../src/ledger.js';
import { publisherKey } from '../src/rules.js';
import { buildSite } from '../src/site.js';
import { normalize, splitStatements, tokenize } from '../src/sql-statements.js';
import { freshDb, readyClaim } from './helpers.js';

const ROOT = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, ROOT), 'utf8');
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const NOW = new Date(2026, 10, 24, 12, 0, 0);

test('the kept copy of the current format is db/schema.sql byte for byte', () => {
  assert.equal(SCHEMA_VERSION, 13);
  assert.equal(read(`db/formats/schema-${SCHEMA_VERSION}.sql`), read('db/schema.sql'));
});

// ------------------------------------------------------------------ the test format 14

const BASE = read('db/formats/schema-13.sql');
const GUARD = `CREATE TRIGGER claims_review_note_not_blank BEFORE UPDATE OF review_note ON claims
WHEN NEW.review_note IS NOT NULL AND length(trim(NEW.review_note)) = 0
BEGIN
  SELECT RAISE(ABORT, 'a review note is not blank');
END`;
const PUBLISHABLE = BASE.slice(BASE.indexOf('CREATE VIEW publishable AS'), BASE.indexOf('AND k.rules_recorded AND k.bilingual;') + 'AND k.rules_recorded AND k.bilingual'.length);

function target14() {
  const one = (s, a, b) => {
    assert.equal(s.split(a).length, 2, a);
    return s.replace(a, b);
  };
  let s = one(BASE, '  criteria_en    TEXT,\n', '  criteria_en    TEXT,\n  review_note    TEXT,\n');
  s = one(s, "('culture'), ('other');", "('culture'), ('other'), ('space');");
  return `${s}\n${GUARD};\n`;
}

const GOOD = [
  'ALTER TABLE claims ADD COLUMN review_note TEXT;',
  "INSERT INTO claim_domains (code) VALUES ('space');",
  `${GUARD};`,
  '-- companion assertion: no row breaks the new guard',
  'SELECT id FROM claims WHERE review_note IS NOT NULL AND length(trim(review_note)) = 0;',
  'DROP VIEW publishable;',
  `${PUBLISHABLE};`,
].join('\n');

/** A format-13 file with a non-empty ledger, built once and copied for each test. */
let fixture = null;
function fixtureFile(t) {
  if (!fixture) {
    const dir = mkdtempSync(join(tmpdir(), 'kv-upgrade-base-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'base.db');
    const db = freshDb(file);
    const a = readyClaim(db);
    confirm(db, a.claim, 'founder');
    db.prepare("UPDATE verdicts SET summary_en = 'Summary, corrected.' WHERE id = ?").run(a.verdict);
    confirm(db, a.claim, 'founder'); // re-confirmed
    const b = readyClaim(db);
    confirm(db, b.claim, 'founder');
    withdraw(db, b.claim, 'founder', { noteFr: 'Erreur de source.', noteEn: 'Wrong source.' });
    const c = readyClaim(db); // never published
    db.close();
    fixture = { file, claims: { a: a.claim, b: b.claim, c: c.claim } };
  }
  const dir = mkdtempSync(join(tmpdir(), 'kv-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'kanverify.db');
  copyFileSync(fixture.file, file);
  return { dir, file, claims: fixture.claims };
}

function upgrade(dir, file, migration, { schema = target14(), ...options } = {}) {
  const migrations = join(dir, 'migrations');
  mkdirSync(migrations, { recursive: true });
  if (migration !== null) writeFileSync(join(migrations, '0014.sql'), migration);
  writeFileSync(join(dir, 'schema-14.sql'), schema);
  return upgradeDatabase(file, { schemaPath: join(dir, 'schema-14.sql'), migrationsDir: migrations, targetVersion: 14, now: NOW, busyTimeoutMs: 50, ...options });
}

function rawOpen(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  db.function('kv_publisher_key', { deterministic: true }, (name) => publisherKey(name));
  return db;
}

const ledgerRows = (db) => db.prepare('SELECT * FROM publications ORDER BY id').all();

// ------------------------------------------------------------------ the route that works

test('an upgrade with a non-empty ledger leaves every ledger row as it was and the ledger working', (t) => {
  const { dir, file, claims } = fixtureFile(t);
  const before = openDatabase(file);
  const rowsBefore = ledgerRows(before);
  const stateBefore = ledgerState(before);
  before.close();
  assert.deepEqual(rowsBefore.map((r) => r.status), ['published', 'published', 'published', 'withdrawn']);
  const fileSha = sha(file);

  const r = upgrade(dir, file, GOOD);
  assert.equal(r.upgraded, true);
  assert.equal(r.from, 13);
  assert.equal(r.to, 14);
  assert.match(r.sqliteVersion, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(r.ledger, stateBefore);
  assert.ok(existsSync(r.backup));
  assert.equal(r.backupSha256, fileSha); // the backup is the file as it was
  assert.match(r.backup, /kanverify-format13-backup-20261124-120000\.db$/);

  const db = rawOpen(file);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    assert.deepEqual(ledgerRows(db), rowsBefore);
    assert.ok(db.prepare('PRAGMA table_xinfo(claims)').all().some((c) => c.name === 'review_note'));
    assert.ok(db.prepare("SELECT 1 FROM claim_domains WHERE code = 'space'").get());
    assert.throws(() => db.prepare("UPDATE claims SET review_note = '  ' WHERE id = ?").run(claims.c), /a review note is not blank/);
    // Same snapshot shape: the upgrade does not make a published claim look changed (review 10, finding 2).
    assert.equal(hasUnconfirmedChanges(db, claims.a), false);
    // The ledger works on: an old entry withdrawn, a new claim confirmed.
    withdraw(db, claims.a, 'founder', { noteFr: 'Retiré.', noteEn: 'Withdrawn.' });
    const id = confirm(db, claims.c, 'founder');
    assert.equal(id, rowsBefore.length + 2);
    assert.deepEqual(ledgerRows(db).slice(0, rowsBefore.length), rowsBefore);
    const out = join(dir, 'site');
    buildSite(db, out);
    assert.ok(existsSync(join(out, 'en', 'claim', String(claims.c), 'index.html')));
  } finally {
    db.close();
  }
});

test('a file already at the target format is left alone', (t) => {
  const { dir, file } = fixtureFile(t);
  const fileSha = sha(file);
  const r = upgrade(dir, file, null, { targetVersion: 13 });
  assert.equal(r.upgraded, false);
  assert.equal(sha(file), fileSha);
});

// ------------------------------------------------------------------ refusals

/** The upgrade is refused and the file is exactly as it was, still format 13 with its ledger. */
function assertRefused(t, migration, pattern, options) {
  const { dir, file } = fixtureFile(t);
  const fileSha = sha(file);
  assert.throws(() => upgrade(dir, file, migration, options), pattern);
  assert.equal(sha(file), fileSha, 'the file is unchanged');
  const db = openDatabase(file); // still format 13
  assert.equal(ledgerRows(db).length, 4);
  db.close();
}

const ADD = 'ALTER TABLE claims ADD COLUMN review_note TEXT;\n';
const REFUSED = [
  ['DELETE', 'DELETE FROM jury_votes;', /DELETE FROM: not allowed/],
  ['DROP TABLE', 'DROP TABLE jury_votes;', /DROP TABLE: not allowed/],
  ['RENAME TO', 'ALTER TABLE claims RENAME TO claims_old;', /only ADD COLUMN/],
  ['RENAME COLUMN', 'ALTER TABLE claims RENAME COLUMN criteria_en TO c;', /only ADD COLUMN/],
  ['DROP COLUMN', 'ALTER TABLE claims DROP COLUMN criteria_en;', /only ADD COLUMN/],
  ['ATTACH', "ATTACH DATABASE 'other.db' AS other;", /ATTACH may not appear/],
  ['DETACH', 'DETACH other;', /DETACH may not appear/],
  ['VACUUM', 'VACUUM;', /VACUUM may not appear/],
  ['REPLACE INTO', "REPLACE INTO claim_domains (code) VALUES ('tax');", /REPLACE may not appear/],
  ['INSERT OR REPLACE', "INSERT OR REPLACE INTO claim_domains (code) VALUES ('tax');", /REPLACE may not appear/],
  ['UPDATE OR REPLACE', "UPDATE OR REPLACE claims SET domain = 'tax';", /REPLACE may not appear/],
  ['ON CONFLICT REPLACE', 'CREATE TABLE notes (x TEXT UNIQUE ON CONFLICT REPLACE);', /REPLACE may not appear/],
  ['UPDATE OR IGNORE', "UPDATE OR IGNORE claims SET domain = 'tax';", /UPDATE OR/],
  ['PRAGMA foreign_keys', 'PRAGMA foreign_keys = OFF;', /PRAGMA may not appear/],
  ['PRAGMA writable_schema', 'PRAGMA writable_schema = ON;', /PRAGMA may not appear/],
  ['a pragma function', 'SELECT * FROM pragma_table_info(\'claims\') WHERE 0;', /pragma_table_info may not appear/],
  ['sqlite_sequence', "UPDATE sqlite_sequence SET seq = 1 WHERE name = 'sources';", /sqlite_sequence may not appear/],
  ['sqlite_master', 'SELECT * FROM sqlite_master WHERE 0;', /sqlite_master may not appear/],
  ['a trigger on the ledger', 'CREATE TRIGGER t BEFORE INSERT ON publications BEGIN SELECT 1; END;', /publications may not appear/],
  ['dropping a ledger trigger', 'DROP TRIGGER ledger_now;', /not on a workspace table/],
  ['a trigger on a view', 'CREATE TRIGGER t INSTEAD OF INSERT ON publishable BEGIN SELECT 1; END;', /no triggers on views/],
  ['a trigger that writes', 'CREATE TRIGGER t AFTER INSERT ON claims BEGIN DELETE FROM jury_votes WHERE 0; END;', /only hold SELECT/],
  ['current_publications', 'DROP VIEW current_publications;', /current_publications may not appear/],
  ['reading the ledger', 'SELECT * FROM publications WHERE 0;', /publications may not appear/],
  ['INSERT into a workspace table', "INSERT INTO subjects (kind, name, country) VALUES ('person', 'X', 'FR');", /only into a lookup table/],
  ['a transaction', 'COMMIT;', /COMMIT: not allowed/],
  ['TEMP', 'CREATE TEMP TABLE notes (x TEXT);', /TEMP may not appear/],
  ['another database', 'CREATE TABLE other.notes (x TEXT);', /only the main database/],
  // Fable review 11.
  ['CREATE TABLE IF NOT EXISTS on an existing table', 'CREATE TABLE IF NOT EXISTS jury_votes (x TEXT);', /jury_votes: the table already exists/],
  ['a single-quoted ledger name', "SELECT * FROM 'publications' WHERE 0;", /'publications' may not appear/],
  ['WITHOUT ROWID', 'CREATE TABLE notes (x TEXT PRIMARY KEY) WITHOUT ROWID;', /WITHOUT ROWID tables are not allowed/],
  ['a NUL that would cut the statement short', "UPDATE claims SET review_note = 'x'\u0000 WHERE id = 0;", /control character U\+0000/],
  ['another control character', 'SELECT 1\u000b WHERE 0;', /control character U\+000B/],
  ['a no-break space before a name', 'CREATE TABLE notes (a TEXT);', /non-ASCII character U\+00A0/],
  ['a line separator before a name', 'CREATE TABLE notes (a TEXT);', /non-ASCII character U\+2028/],
  ['a non-ASCII quoted name', 'CREATE TABLE "straße" (x TEXT);', /non-ASCII character U\+00DF/],
];

for (const [name, statement, pattern] of REFUSED) {
  test(`refused, file unchanged: ${name}`, (t) => assertRefused(t, ADD + statement, pattern));
}

test('refused, file unchanged: an UPDATE that changes a column that existed (review 10, finding 3)', (t) => {
  assertRefused(t, `${GOOD}\nUPDATE claims SET quote_original = quote_original || '!';`, /rows of claims that existed before were changed or removed/);
});

test('refused, file unchanged: a companion assertion that finds rows', (t) => {
  assertRefused(t, `${GOOD}\nSELECT id FROM claims;`, /an assertion found 3 row\(s\)/);
});

test('refused, file unchanged: the upgraded schema lacks what db/schema.sql has', (t) => {
  assertRefused(t, "INSERT INTO claim_domains (code) VALUES ('space');", /table claims differs from the schema[\s\S]*trigger claims_review_note_not_blank is in the schema but not in the upgraded file/);
});

test('refused, file unchanged: the upgraded file has an object db/schema.sql lacks', (t) => {
  assertRefused(t, `${GOOD}\nCREATE INDEX claims_by_domain ON claims(domain);`, /index claims_by_domain is in the upgraded file but not in the schema/);
});

test('refused, file unchanged: a lookup list that differs from db/schema.sql', (t) => {
  assertRefused(t, GOOD.replace("('space')", "('spaces')"), /the rows of claim_domains differ from the schema/);
});

test('refused, file unchanged: a view text that differs from db/schema.sql', (t) => {
  assertRefused(t, GOOD.replace("'format', 1,", "'format', 2,"), /view publishable differs from the schema/);
});

test('refused, file unchanged: no migration file for the next format', (t) => {
  assertRefused(t, null, /No migration to record format 14/);
});

test('refused cleanly: the file is busy with another writer', (t) => {
  const { dir, file } = fixtureFile(t);
  const other = new DatabaseSync(file);
  other.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => upgrade(dir, file, GOOD), /in use by another program/);
  } finally {
    other.exec('ROLLBACK');
    other.close();
  }
  const db = openDatabase(file);
  db.close();
});

test('refused: a journal file next to the database', (t) => {
  const { dir, file } = fixtureFile(t);
  writeFileSync(`${file}-journal`, '');
  assert.throws(() => upgrade(dir, file, GOOD), /-journal exists/);
  rmSync(`${file}-journal`);
});

test('refused: a file older than format 13 has no in-place route', (t) => {
  const { dir, file } = fixtureFile(t);
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 12');
  raw.close();
  assert.throws(() => upgrade(dir, file, GOOD), /in-place upgrades start at format 13/);
});

// ------------------------------------------------------------------ the pieces

test('without defensive mode in this Node, no connection is opened (Fable review 11)', () => {
  const original = DatabaseSync.prototype.enableDefensive;
  DatabaseSync.prototype.enableDefensive = undefined;
  try {
    assert.throws(() => openDatabase(':memory:'), /no defensive mode/);
  } finally {
    DatabaseSync.prototype.enableDefensive = original;
  }
});

test('normalize: a quoted name is not its words; ASCII case only; comments and strings may hold any text (Fable review 11)', () => {
  assert.notEqual(normalize('CREATE TABLE t ("id INTEGER PRIMARY KEY")'), normalize('CREATE TABLE t (id INTEGER PRIMARY KEY)'));
  assert.notEqual(normalize('CREATE TABLE t ([a b])'), normalize('CREATE TABLE t (a b)'));
  assert.equal(normalize('CREATE TABLE t ("id" TEXT)'), normalize('create table T (ID text)')); // a plain identifier, quoted or not
  assert.notEqual(normalize('CREATE TABLE t ("a b" TEXT)'), normalize('CREATE TABLE t ("A B" TEXT)'));
  assert.throws(() => normalize('CREATE TABLE straße (x TEXT)'), /non-ASCII/);
  assert.throws(() => normalize('CREATE TABLE t (x TEXT)\u0000 extra'), /control character/);
  assert.equal(normalize("CHECK (x <> 'straße') -- café"), normalize("check (x <> 'straße')"));
});

test('defensive mode: no connection made by openDatabase can switch on writable_schema', () => {
  const db = openDatabase(':memory:');
  db.exec('PRAGMA writable_schema = ON');
  assert.equal(db.prepare('PRAGMA writable_schema').get().writable_schema, 0);
  db.close();
});

test('the ledger digest moves with any new entry', (t) => {
  const { file, claims } = fixtureFile(t);
  const db = openDatabase(file);
  const a = ledgerState(db);
  confirm(db, claims.c, 'founder');
  const b = ledgerState(db);
  db.close();
  assert.equal(b.count, a.count + 1);
  assert.equal(b.maxId, a.maxId + 1);
  assert.notEqual(b.digest, a.digest);
});

test('normalize ignores spaces, comments, line ends and keyword case, and nothing else', () => {
  const a = "CREATE TABLE t (\r\n  a TEXT, -- note\n  b /* x */ INTEGER CHECK (a <> 'X  y')\n) STRICT";
  assert.equal(normalize(a), normalize("create table T (a text, b integer check (a<>'X  y')) strict"));
  assert.equal(normalize(a), normalize('CREATE TABLE "t" (a TEXT, b INTEGER CHECK (a <> \'X  y\')) STRICT'));
  assert.notEqual(normalize(a), normalize("CREATE TABLE t (a TEXT, b INTEGER CHECK (a <> 'x  y')) STRICT"));
  assert.notEqual(normalize(a), normalize("CREATE TABLE t (a TEXT, b INTEGER CHECK (a <> 'X y')) STRICT"));
  assert.notEqual(normalize('CHECK (x > 10)'), normalize('CHECK (x > 1.0)'));
  assert.notEqual(normalize('CHECK (x >= 1)'), normalize('CHECK (x > 1)'));
});

test('splitStatements keeps a trigger body whole, CASE ... END and quoted semicolons included', () => {
  const parts = splitStatements(`SELECT 'a;b';\nCREATE TRIGGER t BEFORE UPDATE ON c WHEN NEW.x IS NOT OLD.x\nBEGIN\n  SELECT CASE WHEN 1 THEN RAISE(ABORT, 'x;y') END;\n  SELECT 2;\nEND;\n-- trailing comment\nDROP VIEW v`);
  assert.equal(parts.length, 3);
  assert.match(parts[1].text, /^CREATE TRIGGER t[\s\S]*SELECT 2;\nEND$/);
  assert.equal(parts[2].text, 'DROP VIEW v');
  assert.throws(() => tokenize("SELECT 'open"), /not closed/);
});
