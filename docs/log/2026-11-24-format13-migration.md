# Record format 13: migration script (2026-11-24) — the last copy migration

One-off script, run from the scratch folder, not kept in `src/`. Recorded here so its method can be reviewed; its
sha256 (below) is that of the file that ran, so the text here can be checked against it.
Method: the written migration exemption of decision 0005 (`.claude/agents/code-reviewer.md` item 7), extended by the
coordinator's decision on Fable review 10 to every workspace table and both id counters: byte-identical backup
first; the old file read only through a read-only `DatabaseSync` (`openDatabase` refuses format 12); a fresh
database made by `openDatabase` (it runs `db/schema.sql` as is); every row of `subjects`, `sources`, `claims`,
`verdicts`, `verdict_evidence` and `jury_votes` copied with its ids, column by column, in one transaction with plain
INSERTs, no REPLACE, `sqlite_sequence` never written; then, before the swap, every row compared typed with the
backup, both counters, the empty ledger, the lookup lists, every schema object's text against `db/schema.sql`,
integrity and foreign keys, every archived file, and the live file unchanged since the backup. The swap moves the
old file aside before putting the new one in place (Fable review 7 re-check, Low). Refuses if the ledger holds
anything. After this, the copy exemption is retired: format 14 onward goes through `upgradeDatabase`.

What format 13 changes: `claims.domain` and `sources.kind` refer to the lookup tables `claim_domains` and
`source_kinds` (seeded with the lists of format 12) instead of CHECK lists; the snapshot gets `"format": 1`, a counter
of the snapshot's shape, separate from `user_version`. Nothing else.

Script sha256: `edecc2655be8125f81800f26374d229e02a7659b06eae1d6f2187b94e55f5749`.

## Dry run on a copy of the live file (developer, 2026-11-24)

`KV_DATA=<scratch>/dry node migrate-12-to-13.mjs`, on a copy of `data/kanverify.db` taken while no journal file existed:

```
backup .../dry/kanverify-format12-backup-20261124.db sha256 ed2abf1f6d4ad4edc9b593f5346dff6581b670aa3553c664a419b88abea8c930
subjects 2, sources 38, claims 173, verdicts 0, verdict_evidence 0, jury_votes 6 equal to the format-12 backup (typed, every column); counters [[["name","string","sources"],["seq","number","43"]],[["name","string","subjects"],["seq","number","2"]]]; ledger empty; lookup lists = db/schema.sql; 24 tables, views, triggers and indexes = db/schema.sql; integrity and foreign keys ok; files 38/38 match; live opens as format 13 with 173 claims
```

Then `node src/db.js upgrade` on the migrated copy: "already at record format 13; nothing to do"; on the format-12
backup: "in-place upgrades start at format 13" (exit 1).

## Live run

Run on 2026-11-24 in the founder's terminal, with the review desk and the review server stopped first by the
coordinator. Output below exactly as printed (confirmed by the coordinator from the terminal). The values are the same
as in the dry run.

```
backup C:/Users/gaoyi/Desktop/KANVERIFY/data/kanverify-format12-backup-20261124.db sha256 ed2abf1f6d4ad4edc9b593f5346dff6581b670aa3553c664a419b88abea8c930
subjects 2, sources 38, claims 173, verdicts 0, verdict_evidence 0, jury_votes 6 equal to the format-12 backup (typed, every column); counters [[["name","string","sources"],["seq","number","43"]],[["name","string","subjects"],["seq","number","2"]]]; ledger empty; lookup lists = db/schema.sql; 24 tables, views, triggers and indexes = db/schema.sql; integrity and foreign keys ok; files 38/38 match; live opens as format 13 with 173 claims
```

## migrate-12-to-13.mjs

```js
// One-off: record format 12 -> 13 for data/kanverify.db, the LAST copy migration (Fable review 10, finding 1;
// coordinator's decision), under the written migration exemption of decision 0005 (.claude/agents/code-reviewer.md
// item 7), extended to every workspace table and both id counters: byte-identical backup first; the old file read
// only through a read-only DatabaseSync (openDatabase refuses format 12, correctly); a fresh database made by
// openDatabase (it runs db/schema.sql as is: no writable_schema, no pragma changes); every row of every workspace
// table copied with its ids, column by column, in one transaction with plain INSERTs, no REPLACE; sqlite_sequence
// never written; then, before the swap: every row of every table equal to the backup (typed), both counters
// (subjects, sources) equal, the ledger empty, the lookup lists as in db/schema.sql, every table, view and trigger
// text equal to db/schema.sql, integrity and foreign keys sound, every archived file matching its sha256, and the
// live file unchanged since the backup (no other writer). Refuses if the ledger holds anything.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, constants, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/gaoyi/Desktop/KANVERIFY';
const { openDatabase } = await import(pathToFileURL(`${ROOT}/src/db.js`).href);
const { DEFAULT_EVIDENCE_DIR, evidencePath } = await import(pathToFileURL(`${ROOT}/src/archive.js`).href);

// KV_DATA: a folder holding a copy of the database, for a dry run; the real run uses data/.
const DATA = process.env.KV_DATA ?? `${ROOT}/data`;
const LIVE = `${DATA}/kanverify.db`;
const BACKUP = `${DATA}/kanverify-format12-backup-20261124.db`;
const NEW = `${DATA}/kanverify-format13-new.db`;
const OLD = `${DATA}/kanverify-format12-old.db`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };
// Foreign-key order. Column lists are read from the old file; format 13 changes none of them.
const TABLES = ['subjects', 'sources', 'claims', 'verdicts', 'verdict_evidence', 'jury_votes'];

for (const p of [`${LIVE}-wal`, `${LIVE}-journal`, NEW, BACKUP, OLD]) if (existsSync(p)) fail(`${p} exists; stop`);

// 1. Byte-identical backup (refuses to overwrite one).
copyFileSync(LIVE, BACKUP, constants.COPYFILE_EXCL);
const backupSha = sha(readFileSync(BACKUP));
if (sha(readFileSync(LIVE)) !== backupSha) fail('backup differs from the live file');
console.log(`backup ${BACKUP} sha256 ${backupSha}`);

// Typed rows: an integer, a real and a text never compare equal.
const typed = (rows) => JSON.stringify(rows.map((r) => Object.entries(r).map(([k, v]) => [k, typeof v, v === null ? null : String(v)])));
const readAll = (db, table) => {
  const s = db.prepare(`SELECT * FROM ${table} ORDER BY id`);
  s.setReadBigInts(true);
  return s.all();
};

// 2. Read the old rows from the backup, read-only.
const old = new DatabaseSync(BACKUP, { readOnly: true });
if (old.prepare('PRAGMA user_version').get().user_version !== 12) fail('backup is not format 12');
if (old.prepare('SELECT count(*) AS n FROM publications').get().n !== 0) fail('the ledger is not empty; a copy cannot carry it');
const data = {};
const columns = {};
for (const t of TABLES) {
  columns[t] = old.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  data[t] = readAll(old, t);
}
const oldSeq = typed(old.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all());
old.close();

// 3. Fresh format-13 database; every row copied with its ids (the established id-preserving migration copy).
const db = openDatabase(NEW);
for (const t of TABLES) {
  const now = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (JSON.stringify(now) !== JSON.stringify(columns[t])) fail(`${t}: columns differ between format 12 and 13`);
}
db.exec('BEGIN IMMEDIATE');
try {
  for (const t of TABLES) {
    const ins = db.prepare(`INSERT INTO ${t} (${columns[t].join(', ')}) VALUES (${columns[t].map(() => '?').join(', ')})`);
    for (const r of data[t]) ins.run(...columns[t].map((c) => r[c]));
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

// 4. Verify before the swap.
if (db.prepare('PRAGMA user_version').get().user_version !== 13) fail('new file is not format 13');
const counts = [];
for (const t of TABLES) {
  if (typed(readAll(db, t)) !== typed(data[t])) fail(`${t}: rows differ`);
  counts.push(`${t} ${data[t].length}`);
}
if (db.prepare('SELECT count(*) AS n FROM publications').get().n !== 0) fail('ledger not empty');
const seq = typed(db.prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name").all());
if (seq !== oldSeq) fail(`counters ${seq}, were ${oldSeq}`);
const schema = readFileSync(`${ROOT}/db/schema.sql`, 'utf8').replace(/\r\n/g, '\n');
let objects = 0;
for (const { name, sql } of db.prepare("SELECT name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()) {
  if (!schema.includes(sql.replace(/\r\n/g, '\n'))) fail(`${name} differs from db/schema.sql`);
  objects += 1;
}
const fresh = openDatabase(':memory:');
for (const t of ['claim_domains', 'source_kinds']) {
  const a = JSON.stringify(fresh.prepare(`SELECT code FROM ${t} ORDER BY rowid`).all());
  if (JSON.stringify(db.prepare(`SELECT code FROM ${t} ORDER BY rowid`).all()) !== a) fail(`${t} differs from db/schema.sql`);
}
fresh.close();
const integrity = db.prepare('PRAGMA integrity_check').all();
if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') fail('integrity check failed');
if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) fail('foreign key check failed');
const snapshotFormat = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'publishable'").get().sql.includes("'format', 1,");
if (!snapshotFormat) fail('publishable has no format key');
let files = 0;
for (const r of data.sources) {
  const p = evidencePath(DEFAULT_EVIDENCE_DIR, r.sha256);
  if (!existsSync(p) || sha(readFileSync(p)) !== r.sha256) fail(`archived file of source ${r.id} missing or altered`);
  files += 1;
}
db.close();
if (sha(readFileSync(LIVE)) !== backupSha) fail('the live file changed during the migration (another writer); nothing swapped');

// 5. Swap in: move the old file aside first, so the live name is never empty of a database; then drop it
// (the backup holds the same bytes).
renameSync(LIVE, OLD);
renameSync(NEW, LIVE);
if (sha(readFileSync(OLD)) !== backupSha) fail('moved-aside file differs from the backup; kept for inspection');
rmSync(OLD);
const check = openDatabase(LIVE);
const n = check.prepare('SELECT count(*) AS n FROM claims').get().n;
check.close();
console.log(`${counts.join(', ')} equal to the format-12 backup (typed, every column); counters ${seq}; ledger empty; lookup lists = db/schema.sql; ${objects} tables, views, triggers and indexes = db/schema.sql; integrity and foreign keys ok; files ${files}/${data.sources.length} match; live opens as format 13 with ${n} claims`);
```
