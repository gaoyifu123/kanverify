// Tests for opening the database file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { openDatabase } from '../src/db.js';

const here = dirname(fileURLToPath(import.meta.url));

function tempFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kanverify-db-'));
  // If a handle were left open, removing the directory would fail on Windows.
  t.after(() => rmSync(dir, { recursive: true }));
  return join(dir, 'test.db');
}

test('a new file gets the record format, and reopening keeps the data', (t) => {
  const file = tempFile(t);
  let db = openDatabase(file);
  db.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', 'A', 'FR')").run();
  db.close();
  db = openDatabase(file);
  assert.equal(db.prepare('SELECT count(*) AS n FROM subjects').get().n, 1);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
});

test('a file that is some other database is refused and left untouched', (t) => {
  const file = tempFile(t);
  const other = new DatabaseSync(file);
  other.exec('CREATE TABLE notes (body TEXT)');
  other.close();
  assert.throws(() => openDatabase(file), /not a KANVERIFY database/);
  const check = new DatabaseSync(file);
  const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  check.close();
  assert.deepEqual(tables.map((row) => row.name), ['notes']);
});

test('a database from a different record format is refused', (t) => {
  const file = tempFile(t);
  openDatabase(file).close();
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openDatabase(file), /record format 99/);
});

test('a database in an earlier record format (5 to 11) is refused', (t) => {
  const file = tempFile(t);
  openDatabase(file).close();
  for (const old of [5, 6, 7, 8, 9, 10, 11]) {
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${old}`);
    raw.close();
    assert.throws(() => openDatabase(file), new RegExp(`record format ${old}, code expects 12`), String(old));
  }
});

test('several processes opening one new file at once all succeed', async (t) => {
  const file = tempFile(t);
  const script =
    "import { openDatabase } from " + JSON.stringify(pathToFileURL(resolve(here, '../src/db.js')).href) + ";" +
    "const db = openDatabase(process.argv[1]);" +
    "db.prepare(\"INSERT INTO subjects (kind, name, country) VALUES ('person', 'P', 'FR')\").run();" +
    "db.close();";
  const exits = await Promise.all(
    Array.from({ length: 8 }, () =>
      new Promise((done) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: 'ignore' });
        child.on('exit', done);
      })
    )
  );
  assert.deepEqual(exits, Array(8).fill(0));
  const db = openDatabase(file);
  assert.equal(db.prepare('SELECT count(*) AS n FROM subjects').get().n, 8);
  db.close();
});

test('an existing database opens while another connection is reading or writing', (t) => {
  const file = tempFile(t);
  openDatabase(file).close();

  const reader = new DatabaseSync(file);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM subjects').get();
  openDatabase(file).close();
  reader.exec('COMMIT');
  reader.close();

  const writer = new DatabaseSync(file);
  writer.exec('BEGIN IMMEDIATE');
  writer.exec("INSERT INTO subjects (kind, name, country) VALUES ('person', 'A', 'FR')");
  openDatabase(file).close();
  writer.exec('COMMIT');
  writer.close();
});
