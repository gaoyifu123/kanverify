// Opens the local KANVERIFY database and applies the record format on first use; upgrades an
// existing file to a newer record format in place.
// The database is a single file on this machine (principle 8). Nothing here listens
// on a network.
//
// The rules that protect the public record live in db/schema.sql and hold on any
// connection. This module adds: foreign keys on, SQLite's defensive mode on (no writable_schema,
// no direct edits of the file's pages through SQL), a wait instead of an immediate failure
// when the file is busy, a refusal to touch a file that is not ours, and kv_publisher_key,
// the one publisher-name normalisation the publication rules use (src/rules.js). A
// connection without that function cannot evaluate what is publishable, so it cannot
// publish anything.

import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, constants, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publisherKey } from './rules.js';
import { LOOKUP_TABLES, checkMigrationStatement, normalize, splitStatements } from './sql-statements.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, '../db/schema.sql');
const MIGRATIONS_DIR = resolve(here, '../db/migrations');
const DEFAULT_DB_PATH = resolve(here, '../data/kanverify.db');
export const SCHEMA_VERSION = 13;
const BUSY_WAIT_MS = 5000;

/** The settings every connection gets, on any file. */
function prepareConnection(db) {
  // Defensive mode: SQLite refuses writable_schema and the other ways to edit the file's
  // structure through SQL. A Node without it gets no connection (Fable review 11).
  if (typeof db.enableDefensive !== 'function') {
    throw new Error("This Node's SQLite module has no defensive mode (DatabaseSync.enableDefensive); use a newer Node.");
  }
  db.enableDefensive(true);
  db.exec('PRAGMA foreign_keys = ON');
  db.function('kv_publisher_key', { deterministic: true }, (name) => publisherKey(name));
}

/**
 * @param {string} [path] File path, or ':memory:' for tests.
 * @returns {DatabaseSync}
 */
export function openDatabase(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: BUSY_WAIT_MS });
  let inTransaction = false;
  try {
    prepareConnection(db);
    const readVersion = () => db.prepare('PRAGMA user_version').get().user_version;

    // An existing database is only read here, so opening it never waits on other work.
    let version = readVersion();
    if (version === 0) {
      // A new file. Take the write lock, then look again, so two processes cannot both
      // decide to create the record format.
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      version = readVersion();
      if (version === 0) {
        const { n } = db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
        if (n > 0) {
          throw new Error('This file already holds tables but is not a KANVERIFY database. Refusing to touch it.');
        }
        db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        version = SCHEMA_VERSION;
      }
      db.exec('COMMIT');
      inTransaction = false;
    }
    if (version !== SCHEMA_VERSION) {
      throw new Error(
        `Database is at record format ${version}, code expects ${SCHEMA_VERSION}. ` +
          (version < SCHEMA_VERSION && version >= 13
            ? 'Upgrade it first: node src/db.js upgrade (stop the review desk and the inbox job before).'
            : 'There is no upgrade route for it; do not open it with this code.')
      );
    }
    return db;
  } catch (error) {
    if (inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original error is the one worth reporting.
      }
    }
    db.close();
    throw error;
  }
}

// ------------------------------------------------------------------ upgrading in place

/** A digest of rows that tells every value's type apart (an integer 1, a real 1.0, a text '1'). */
function digestRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  statement.setReadBigInts(true);
  const hash = createHash('sha256');
  const part = (tag, bytes) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(tag).update(length).update(bytes);
  };
  let count = 0;
  for (const row of statement.iterate(...params)) {
    count += 1;
    part('R', Buffer.alloc(0));
    for (const [column, value] of Object.entries(row)) {
      part('c', Buffer.from(column, 'utf8'));
      if (value === null) part('n', Buffer.alloc(0));
      else if (typeof value === 'bigint') part('i', Buffer.from(value.toString(), 'utf8'));
      else if (typeof value === 'number') {
        const real = Buffer.alloc(8);
        real.writeDoubleBE(value);
        part('r', real);
      } else if (typeof value === 'string') part('s', Buffer.from(value, 'utf8'));
      else part('b', Buffer.from(value));
    }
  }
  return { count, digest: hash.digest('hex') };
}

const quoteName = (name) => `"${name.replaceAll('"', '""')}"`;

/** The ledger as it is: every row, every column, typed; its count and highest id. */
export function ledgerState(db) {
  const { count, digest } = digestRows(db, 'SELECT * FROM publications ORDER BY id');
  const maxId = db.prepare('SELECT max(id) AS m FROM publications').get().m ?? 0;
  return { count, maxId, digest };
}

function workspaceTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> 'publications' ORDER BY name")
    .all()
    .map((r) => r.name);
}

/** Per workspace table: its columns, its rows (count, highest rowid) and a digest of every row. */
function workspaceState(db) {
  const state = new Map();
  for (const table of workspaceTables(db)) {
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteName(table)})`).all().map((c) => c.name);
    const maxRowid = db.prepare(`SELECT max(rowid) AS m FROM ${quoteName(table)}`).get().m ?? 0;
    const { count, digest } = digestRows(db, rowsSql(table, columns), [maxRowid]);
    state.set(table, { columns, maxRowid, count, digest });
  }
  return state;
}

const rowsSql = (table, columns) =>
  `SELECT rowid AS "kv rowid", ${columns.map(quoteName).join(', ')} FROM ${quoteName(table)} WHERE rowid <= ? ORDER BY rowid`;

/** Every schema object: type and name -> its table and its normalised text. */
function schemaObjects(db) {
  const objects = new Map();
  for (const r of db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master').all()) {
    objects.set(`${r.type} ${r.name}`, `${r.tbl_name} | ${r.sql === null ? '' : normalize(r.sql)}`);
  }
  return objects;
}

function compareSchemas(fresh, migrated) {
  const a = schemaObjects(fresh);
  const b = schemaObjects(migrated);
  const problems = [];
  for (const [key, text] of a) {
    if (!b.has(key)) problems.push(`${key} is in the schema but not in the upgraded file`);
    else if (b.get(key) !== text) problems.push(`${key} differs from the schema`);
  }
  for (const key of b.keys()) if (!a.has(key)) problems.push(`${key} is in the upgraded file but not in the schema`);
  // The lookup lists are part of the format: the same codes in the same order.
  for (const table of LOOKUP_TABLES) {
    if (!a.has(`table ${table}`) || !b.has(`table ${table}`)) continue;
    const sql = `SELECT * FROM ${quoteName(table)} ORDER BY rowid`;
    if (digestRows(fresh, sql).digest !== digestRows(migrated, sql).digest) problems.push(`the rows of ${table} differ from the schema`);
  }
  return problems;
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

const sha256File = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/**
 * Upgrades a KANVERIFY file to a newer record format in place, without touching the ledger
 * (decision 0005, addendum of 2026-11-24; Fable review 10). In one transaction, taken before
 * anything is read or copied: a byte-identical backup next to the file; the migration files
 * db/migrations/<format>.sql for each format after the file's, every statement checked against
 * the whitelist (src/sql-statements.js) before it runs, every SELECT an assertion that must
 * return no rows; then, before COMMIT: the ledger exactly as before (every row and column, typed,
 * its count and highest id), every workspace row that existed unchanged in every column it had
 * (rows added only to the lookup lists), SQLite's counters unchanged, integrity and foreign keys
 * sound, and the schema equal to a fresh one from db/schema.sql in both directions (tokens
 * compared, so spaces and comments do not count) with the same lookup rows. Any failure rolls
 * everything back; the file is then as it was.
 *
 * Stop the review desk and the inbox job first: a connection left open would carry on with code
 * written for the old format.
 *
 * @param {string} [path]
 * @param {{ schemaPath?: string, migrationsDir?: string, targetVersion?: number,
 *   busyTimeoutMs?: number, now?: Date }} [options] the defaults are the real ones; tests change them
 * @returns {{ upgraded: boolean, from: number, to: number, sqliteVersion: string,
 *   backup?: string, backupSha256?: string, ledger: { count: number, maxId: number, digest: string } }}
 */
export function upgradeDatabase(path = DEFAULT_DB_PATH, options = {}) {
  const {
    schemaPath = SCHEMA_PATH,
    migrationsDir = MIGRATIONS_DIR,
    targetVersion = SCHEMA_VERSION,
    busyTimeoutMs = 2000,
    now = new Date(),
  } = options;
  if (path === ':memory:' || !existsSync(path)) throw new Error(`No database file at ${path}`);
  for (const suffix of ['-journal', '-wal']) {
    if (existsSync(`${path}${suffix}`)) {
      throw new Error(`${path}${suffix} exists: the file is in use or was not closed cleanly. Stop the review desk and the inbox job, open the file once with openDatabase, then try again.`);
    }
  }
  const db = new DatabaseSync(path, { timeout: busyTimeoutMs });
  let inTransaction = false;
  try {
    prepareConnection(db);
    const sqliteVersion = db.prepare('SELECT sqlite_version() AS v').get().v;
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      if (/locked|busy/i.test(error.message)) {
        throw new Error('The database is in use by another program (the review desk or the inbox job?). Stop it and try again.');
      }
      throw error;
    }
    inTransaction = true;
    if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') {
      throw new Error('The file is not in the rollback-journal mode this code uses; refusing to upgrade it.');
    }
    const from = db.prepare('PRAGMA user_version').get().user_version;
    if (from < 13) throw new Error(`The file is at record format ${from}; in-place upgrades start at format 13.`);
    if (from > targetVersion) throw new Error(`The file is at record format ${from}, newer than this code (${targetVersion}).`);
    const before = ledgerState(db);
    if (from === targetVersion) {
      db.exec('ROLLBACK');
      inTransaction = false;
      return { upgraded: false, from, to: from, sqliteVersion, ledger: before };
    }
    const files = [];
    for (let v = from + 1; v <= targetVersion; v += 1) {
      const file = join(migrationsDir, `${String(v).padStart(4, '0')}.sql`);
      if (!existsSync(file)) throw new Error(`No migration to record format ${v}: ${file} is missing.`);
      files.push({ version: v, file, statements: splitStatements(readFileSync(file, 'utf8')) });
    }

    // A byte-identical backup, taken under the write lock, so it is the file as it stands.
    const backup = join(dirname(path), `${basename(path).replace(/\.db$/, '')}-format${from}-backup-${stamp(now)}.db`);
    copyFileSync(path, backup, constants.COPYFILE_EXCL);
    const backupSha256 = sha256File(backup);
    if (sha256File(path) !== backupSha256) throw new Error('The backup differs from the file; nothing was changed.');

    const workspaceBefore = workspaceState(db);
    const sequenceBefore = db.prepare('SELECT name, seq FROM sqlite_sequence ORDER BY name').all();

    const created = new Set();
    for (const { version, file, statements } of files) {
      for (const statement of statements) {
        const context = {
          tables: new Set(workspaceTables(db).map((t) => t.toLowerCase())),
          created,
          triggers: new Map(db.prepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger'").all()
            .map((r) => [r.name.toLowerCase(), r.tbl_name.toLowerCase()])),
        };
        let checked;
        try {
          checked = checkMigrationStatement(statement, context);
        } catch (error) {
          throw new Error(`${basename(file)}: refused: ${error.message}\n  ${statement.text.split('\n')[0]}`);
        }
        if (checked.kind === 'assertion') {
          const rows = db.prepare(statement.text).all();
          if (rows.length > 0) throw new Error(`${basename(file)}: an assertion found ${rows.length} row(s) that break it:\n  ${statement.text.split('\n')[0]}`);
        } else {
          // prepare() runs one statement only: if SQLite read the text as more than one, the rest
          // would not run (and the schema check below would fail), never run unchecked.
          db.prepare(statement.text).run();
          if (checked.created) created.add(checked.created);
        }
      }
      db.exec(`PRAGMA user_version = ${version}`);
    }

    // Everything below must hold before COMMIT.
    const problems = [];
    const after = ledgerState(db);
    if (after.count !== before.count || after.maxId !== before.maxId || after.digest !== before.digest) {
      problems.push('the ledger changed');
    }
    for (const [table, was] of workspaceBefore) {
      const columns = new Set(db.prepare(`PRAGMA table_xinfo(${quoteName(table)})`).all().map((c) => c.name));
      if (columns.size === 0) { problems.push(`table ${table} is gone`); continue; }
      const lost = was.columns.filter((c) => !columns.has(c));
      if (lost.length > 0) { problems.push(`${table} lost column(s) ${lost.join(', ')}`); continue; }
      const current = digestRows(db, rowsSql(table, was.columns), [was.maxRowid]);
      if (current.count !== was.count || current.digest !== was.digest) problems.push(`rows of ${table} that existed before were changed or removed`);
      const added = db.prepare(`SELECT count(*) AS n FROM ${quoteName(table)} WHERE rowid > ?`).get(was.maxRowid).n;
      if (added > 0 && !LOOKUP_TABLES.includes(table)) problems.push(`${added} row(s) were added to ${table}, which is not a lookup list`);
    }
    const sequenceAfter = new Map(db.prepare('SELECT name, seq FROM sqlite_sequence').all().map((r) => [r.name, r.seq]));
    for (const { name, seq } of sequenceBefore) if (sequenceAfter.get(name) !== seq) problems.push(`the id counter of ${name} changed`);
    const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') problems.push(`integrity check: ${integrity.slice(0, 3).join('; ')}`);
    const orphans = db.prepare('PRAGMA foreign_key_check').all();
    if (orphans.length > 0) problems.push(`${orphans.length} row(s) point at rows that do not exist (first: ${orphans[0].table})`);
    const fresh = new DatabaseSync(':memory:');
    try {
      prepareConnection(fresh);
      fresh.exec(readFileSync(schemaPath, 'utf8'));
      problems.push(...compareSchemas(fresh, db));
    } finally {
      fresh.close();
    }
    if (db.prepare('PRAGMA user_version').get().user_version !== targetVersion) problems.push('the record format number was not set');
    if (problems.length > 0) throw new Error(`Upgrade refused, nothing was changed:\n  - ${problems.join('\n  - ')}`);

    db.exec('COMMIT');
    inTransaction = false;
    return { upgraded: true, from, to: targetVersion, sqliteVersion, backup, backupSha256, ledger: after };
  } catch (error) {
    if (inTransaction) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original error is the one worth reporting.
      }
    }
    throw error;
  } finally {
    db.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'init') {
  const db = openDatabase();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  console.log(`Local database ready at ${DEFAULT_DB_PATH}`);
  console.log(`Tables: ${tables.join(', ')}`);
  db.close();
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === 'upgrade') {
  const path = process.argv[3] ? resolve(process.argv[3]) : DEFAULT_DB_PATH;
  try {
    const r = upgradeDatabase(path);
    console.log(`SQLite ${r.sqliteVersion}`);
    if (!r.upgraded) console.log(`${path} is already at record format ${r.to}; nothing to do.`);
    else {
      console.log(`${path}: record format ${r.from} -> ${r.to}`);
      console.log(`backup ${r.backup} sha256 ${r.backupSha256}`);
    }
    console.log(`ledger: ${r.ledger.count} entries, highest id ${r.ledger.maxId}, digest ${r.ledger.digest} (unchanged)`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
