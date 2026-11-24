// scripts/backup.mjs: refusals, the online database copy and its checks, content-addressed evidence,
// nothing overwritten or deleted on the target. Temp folders only; data/ is never touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBackup } from '../scripts/backup.mjs';
import { ledgerState, openDatabase } from '../src/db.js';
import { addSource, freshDb } from './helpers.js';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const ROOT = resolve(fileURLToPath(import.meta.url), '../..');
// Tests run on one drive; this stands in for "data on C:, target on the USB drive".
const twoDrives = (path) => (resolve(path).includes('kv-usb-') ? 'usb' : 'internal');

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-backup-'));
  const usb = mkdtempSync(join(tmpdir(), 'kv-usb-'));
  t.after(() => { rmSync(dir, { recursive: true, force: true }); rmSync(usb, { recursive: true, force: true }); });
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'evidence'), { recursive: true });
  mkdirSync(join(dataDir, 'desk'), { recursive: true });
  mkdirSync(join(dataDir, 'candidates', 'packs-1'), { recursive: true });
  const db = freshDb(join(dataDir, 'kanverify.db'));
  addSource(db, 'gazette');
  db.close();
  const evidence = ['%PDF-1.4 one', '<p>two</p>'].map((text) => {
    const b = Buffer.from(text);
    writeFileSync(join(dataDir, 'evidence', sha(b)), b);
    return sha(b);
  });
  writeFileSync(join(dataDir, 'desk', 'actions.jsonl'), '{"a":1}\n');
  writeFileSync(join(dataDir, 'candidates', 'c.json'), '{"c":1}');
  writeFileSync(join(dataDir, 'candidates', 'packs-1', 'c1.pack.json'), '{"p":1}');
  return { dir, usb, dataDir, evidence };
}

test('backup: refuses a missing target, a target in the project or data folder, and the same drive as data/', async (t) => {
  const s = setup(t);
  await assert.rejects(runBackup({ target: join(s.usb, 'absent'), dataDir: s.dataDir, idOf: twoDrives }), /does not exist/);
  await assert.rejects(runBackup({ target: ROOT, dataDir: s.dataDir, idOf: twoDrives }), /inside the project folder/);
  await assert.rejects(runBackup({ target: join(s.dataDir, 'evidence'), dataDir: s.dataDir, idOf: twoDrives }), /inside the data folder/);
  // The real drive check: the temp target is on the same drive as the temp data folder.
  await assert.rejects(runBackup({ target: s.usb, dataDir: s.dataDir }), /same drive as data\//);
  assert.deepEqual(readdirSync(s.usb), [], 'nothing written on a refusal');
});

test('backup: an online copy of the database that passes its checks, evidence and files with their sha256, and a manifest', async (t) => {
  const s = setup(t);
  writeFileSync(join(s.usb, 'notes.txt'), 'the founder\'s own file');
  const now = new Date(2026, 10, 24, 9, 30, 5);
  const { folder, manifest } = await runBackup({ target: s.usb, dataDir: s.dataDir, idOf: twoDrives, now });
  assert.equal(folder, join(s.usb, 'kanverify-backups', '2026-11-24T09-30-05'));
  // The copy: integrity ok, same record format, ledger and row counts as the live file.
  const copy = openDatabase(join(folder, 'kanverify.db'));
  const live = openDatabase(join(s.dataDir, 'kanverify.db'));
  try {
    assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(ledgerState(copy), ledgerState(live));
    assert.equal(copy.prepare('SELECT count(*) AS n FROM sources').get().n, 1);
  } finally {
    copy.close();
    live.close();
  }
  assert.equal(manifest.database.tables.sources, 1);
  assert.equal(manifest.database.sha256, sha(readFileSync(join(folder, 'kanverify.db'))));
  assert.deepEqual([manifest.evidence.count, manifest.evidence.copied, manifest.evidence.already_present], [2, 2, 0]);
  for (const h of s.evidence) assert.equal(sha(readFileSync(join(s.usb, 'kanverify-backups', 'evidence', h))), h);
  assert.deepEqual(manifest.files.map((f) => f.path), ['desk/actions.jsonl', 'candidates/c.json', 'candidates/packs-1/c1.pack.json']);
  for (const f of manifest.files) assert.equal(sha(readFileSync(join(folder, f.path))), f.sha256);
  assert.deepEqual(JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8')), manifest);
  assert.equal(manifest.script_version, 1);

  // A second backup: evidence already there is not copied again; nothing earlier is touched or deleted.
  const again = await runBackup({ target: s.usb, dataDir: s.dataDir, idOf: twoDrives, now: new Date(2026, 10, 25, 9, 0, 0) });
  assert.deepEqual([again.manifest.evidence.copied, again.manifest.evidence.already_present], [0, 2]);
  assert.ok(existsSync(join(folder, 'manifest.json')));
  assert.equal(readFileSync(join(s.usb, 'notes.txt'), 'utf8'), 'the founder\'s own file');
  // The same second again: refused rather than overwritten.
  await assert.rejects(runBackup({ target: s.usb, dataDir: s.dataDir, idOf: twoDrives, now }), /EEXIST/);
});

test('backup: evidence on the drive with other content is left alone and stops the run; a misnamed original is refused', async (t) => {
  const s = setup(t);
  const shared = join(s.usb, 'kanverify-backups', 'evidence');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, s.evidence[0]), 'tampered');
  await assert.rejects(runBackup({ target: s.usb, dataDir: s.dataDir, idOf: twoDrives }), /has other content; it is left as it is/);
  assert.equal(readFileSync(join(shared, s.evidence[0]), 'utf8'), 'tampered', 'never overwritten');
  const [dated] = readdirSync(join(s.usb, 'kanverify-backups')).filter((n) => n !== 'evidence');
  assert.equal(existsSync(join(s.usb, 'kanverify-backups', dated, 'manifest.json')), false, 'an incomplete backup has no manifest');

  const s2 = setup(t);
  writeFileSync(join(s2.dataDir, 'evidence', 'a'.repeat(64)), 'not that hash');
  await assert.rejects(runBackup({ target: s2.usb, dataDir: s2.dataDir, idOf: twoDrives }), /is not named by its sha256/);
});
