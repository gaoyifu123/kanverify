// Opens the local KANVERIFY database and applies the record format on first use.
// The database is a single file on this machine (principle 8). Nothing here listens
// on a network.
//
// The rules that protect the public record live in db/schema.sql and hold on any
// connection. This module adds: foreign keys on, a wait instead of an immediate failure
// when the file is busy, a refusal to touch a file that is not ours, and kv_publisher_key,
// the one publisher-name normalisation the publication rules use (src/rules.js). A
// connection without that function cannot evaluate what is publishable, so it cannot
// publish anything.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publisherKey } from './rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(here, '../db/schema.sql');
const DEFAULT_DB_PATH = resolve(here, '../data/kanverify.db');
const SCHEMA_VERSION = 11;
const BUSY_WAIT_MS = 5000;

/**
 * @param {string} [path] File path, or ':memory:' for tests.
 * @returns {DatabaseSync}
 */
export function openDatabase(path = DEFAULT_DB_PATH) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { timeout: BUSY_WAIT_MS });
  let inTransaction = false;
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.function('kv_publisher_key', { deterministic: true }, (name) => publisherKey(name));
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
          'No migration exists yet; do not open it with this code.'
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
