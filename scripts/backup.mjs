// Backup of the local data onto the founder's own USB drive (decision 0005, backup addendum, 2026-11-24).
// Usage: node scripts/backup.mjs <target folder on the USB drive>
//
// Nothing leaves the machine except onto that drive; no network. Nothing on the target is ever
// deleted or overwritten. Into <target>/kanverify-backups/:
//   <date-time>/kanverify.db     SQLite's online backup of data/kanverify.db (consistent while the desk
//                                runs; never a raw file copy, never VACUUM INTO), then checked
//   <date-time>/desk/actions.jsonl, <date-time>/candidates/...   copied, each copy's sha256 checked
//   evidence/<sha256>            shared by every backup: archived originals are content-addressed, so a
//                                file already there with the same sha256 is not copied again
//   <date-time>/manifest.json    written last, only when every check passed
//
// Why a script and not a service (principle 5): the founder plugs the drive in and runs one command.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup } from 'node:sqlite';
import { ledgerState, openDatabase } from '../src/db.js';

export const SCRIPT_VERSION = 1;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA_NAME = /^[0-9a-f]{64}$/;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * Which drive a folder is on. On Windows: the volume root of its real path ("D:\", or "\\server\share\"
 * for a network share), compared case-insensitively, and also the volume serial number Node reports as
 * stat().dev; elsewhere stat().dev, the device id. Two paths with the same id are on the same drive.
 */
export function driveOf(path) {
  const real = realpathSync(path);
  const dev = String(statSync(real).dev);
  return process.platform === 'win32' ? `${parse(real).root.toLowerCase()}|${dev}` : dev;
}

const sameDrive = (a, b, idOf) => {
  const [x, y] = [idOf(a), idOf(b)];
  if (process.platform !== 'win32' || idOf !== driveOf) return x === y;
  // Either the same root letter or the same volume serial is the same drive.
  const [rx, dx] = x.split('|');
  const [ry, dy] = y.split('|');
  return rx === ry || dx === dy;
};

const inside = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
};

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}T${p(date.getHours())}-${p(date.getMinutes())}-${p(date.getSeconds())}`;
}

/** Every table's row count, for the manifest and the comparison with the copy. */
function tableCounts(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  return Object.fromEntries(names.map((n) => [n, db.prepare(`SELECT count(*) AS n FROM "${n.replaceAll('"', '""')}"`).get().n]));
}

function stateOf(db) {
  return {
    user_version: db.prepare('PRAGMA user_version').get().user_version,
    ledger: ledgerState(db),
    tables: tableCounts(db),
  };
}

/** Writes bytes to a path that must not exist yet, then reads them back and checks the sha256. */
function writeNew(path, bytes, expected) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { flag: 'wx' }); // never over an existing file
  const got = sha256(readFileSync(path));
  if (got !== expected) throw new Error(`the copy ${path} does not read back with the same sha256`);
}

/** The files under a folder, as paths relative to it, in a fixed order. */
function filesUnder(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

/**
 * Runs one backup. `idOf` is how drives are told apart (tests give their own; the CLI always uses
 * driveOf). Throws with the reason on any refusal or failed check; a dated folder left by a failed run
 * has no manifest.json and is never removed.
 */
export async function runBackup({ target, dataDir = join(ROOT, 'data'), projectRoot = ROOT, now = new Date(), idOf = driveOf } = {}) {
  if (!target) throw new Error('Usage: node scripts/backup.mjs <target folder on the USB drive>');
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`the target ${target} does not exist (plug the drive in, or create the folder first)`);
  const real = realpathSync(target);
  for (const [what, folder] of [['the project folder', projectRoot], ['the data folder', dataDir]]) {
    if (existsSync(folder) && inside(real, realpathSync(folder))) throw new Error(`the target is inside ${what}: a backup must be on another drive`);
  }
  if (sameDrive(real, dataDir, idOf)) throw new Error('the target is on the same drive as data/: a backup must be on another drive (the USB drive)');
  const dbPath = join(dataDir, 'kanverify.db');
  if (!existsSync(dbPath)) throw new Error(`no database at ${dbPath}`);

  const base = join(real, 'kanverify-backups');
  const folder = join(base, stamp(now));
  mkdirSync(base, { recursive: true });
  mkdirSync(folder); // fails if a backup of the same second exists: nothing is overwritten

  // (2) The database, by SQLite's online backup, through a connection opened the project's way.
  const copyPath = join(folder, 'kanverify.db');
  const live = openDatabase(dbPath);
  let before;
  let after;
  try {
    before = stateOf(live);
    await backup(live, copyPath);
    after = stateOf(live);
  } finally {
    live.close();
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error('the database changed while it was being copied; run the backup again when the review desk is idle');
  }
  // The copy: an existing file of the current record format, so openDatabase only reads it.
  const copy = openDatabase(copyPath);
  let copied;
  let integrity;
  try {
    integrity = copy.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
    copied = stateOf(copy);
  } finally {
    copy.close();
  }
  if (integrity.length !== 1 || integrity[0] !== 'ok') throw new Error(`the copy fails integrity_check: ${integrity.join('; ')}`);
  if (JSON.stringify(copied) !== JSON.stringify(before)) throw new Error('the copy differs from the live database (record format, ledger or row counts)');
  const dbBytes = readFileSync(copyPath);

  // (3) Evidence: shared and content-addressed. A file already there is checked, never replaced.
  const evidenceDir = join(base, 'evidence');
  const evidence = { copied: 0, already_present: 0, files: [] };
  for (const name of filesUnder(join(dataDir, 'evidence'))) {
    const bytes = readFileSync(join(dataDir, 'evidence', name));
    const sum = sha256(bytes);
    if (!SHA_NAME.test(name) || name !== sum) throw new Error(`data/evidence/${name} is not named by its sha256 (${sum}); look at it before backing up`);
    const to = join(evidenceDir, name);
    if (existsSync(to)) {
      if (sha256(readFileSync(to)) !== sum) throw new Error(`the target's evidence/${name} has other content; it is left as it is, look at it`);
      evidence.already_present += 1;
    } else {
      writeNew(to, bytes, sum);
      evidence.copied += 1;
    }
    evidence.files.push(sum);
  }

  // The desk log and the candidates: into the dated folder.
  const files = [];
  const copyInto = (from, rel) => {
    const bytes = readFileSync(from);
    const sum = sha256(bytes);
    writeNew(join(folder, rel), bytes, sum);
    files.push({ path: rel.split(sep).join('/'), sha256: sum, bytes: bytes.length });
  };
  const actions = join(dataDir, 'desk', 'actions.jsonl');
  if (existsSync(actions)) copyInto(actions, join('desk', 'actions.jsonl'));
  for (const rel of filesUnder(join(dataDir, 'candidates'))) copyInto(join(dataDir, 'candidates', rel), join('candidates', rel));

  // (4) The manifest, last: a dated folder without one is an incomplete backup.
  const manifest = {
    kind: 'kanverify-backup', script_version: SCRIPT_VERSION, created_at: now.toISOString(),
    database: {
      file: 'kanverify.db', sha256: sha256(dbBytes), bytes: dbBytes.length, method: 'node:sqlite backup()',
      integrity_check: 'ok', user_version: copied.user_version, ledger: copied.ledger, tables: copied.tables,
    },
    evidence: { folder: '../evidence', count: evidence.files.length, copied: evidence.copied, already_present: evidence.already_present, sha256: evidence.files },
    files,
  };
  writeFileSync(join(folder, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return { folder, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBackup({ target: process.argv[2] }).then(({ folder, manifest: m }) => {
    console.log(`Backup written: ${folder}`);
    console.log(`  database: record format ${m.database.user_version}, integrity ok, ${m.database.ledger.count} publications, ${Object.values(m.database.tables).reduce((a, b) => a + b, 0)} rows in ${Object.keys(m.database.tables).length} tables`);
    console.log(`  evidence: ${m.evidence.count} files (${m.evidence.copied} copied, ${m.evidence.already_present} already on the drive), every sha256 checked`);
    console.log(`  other files: ${m.files.length} (desk log, candidates), every sha256 checked`);
  }).catch((error) => {
    console.error(`Backup refused or failed: ${error.message}`);
    console.error('Nothing on the drive was deleted; a dated folder without manifest.json is incomplete.');
    process.exitCode = 1;
  });
}
