# Record format 12: migration script (2026-11-23)

One-off script, run once from the scratch folder, not kept in `src/`. Recorded here so its method can be reviewed.
Method: the written migration exemption of decision 0005 (`.claude/agents/code-reviewer.md` item 7), as for format 11:
byte-identical backup first; the old file read only through a read-only `DatabaseSync` (`openDatabase` refuses
format 11); a fresh database made by `openDatabase` (it runs `db/schema.sql` as is: no `writable_schema`, no pragma
changes); `sources` rows copied with their ids in one transaction with plain INSERTs, no REPLACE, `sqlite_sequence`
never written; then every column, the other tables, the `sources` counter, every table/view/trigger text against
`db/schema.sql` and every archived file checked before the swap. Valid only while every other table is empty, which it
was (the ledger is still empty).

Result (developer, 2026-11-23):

- Backup `data/kanverify-format11-backup-20261123.db`, sha256
  `df0184dd1c61c959a8aace795abf501278be4142bf4ff01222059dab4628e3dd`.
- 38 rows, ids 1-43, equal to the backup; 38/38 archived files match their sha256; other tables empty; counter 43;
  19 tables, views and triggers equal to `db/schema.sql`; `verdicts` has `rules_version` and `rules_applied`; the live
  file opens as format 12 with 38 sources.

## Step 1: migrate-11-to-12.mjs

```js
// One-off: record format 11 -> 12 for data/kanverify.db, under the written migration exemption of decision 0005
// (.claude/agents/code-reviewer.md item 7): byte-identical backup first; the old file read only through a read-only
// DatabaseSync (openDatabase refuses format 11, correctly); a fresh database made by openDatabase (it runs
// db/schema.sql as is: no writable_schema, no pragma changes); sources copied with their ids in one transaction with
// plain INSERTs, no REPLACE; sqlite_sequence never written; then every column, the other tables, the sources counter,
// the view texts and every archived file checked before the swap. Only valid while every table but sources is empty.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, constants, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/gaoyi/Desktop/KANVERIFY';
const { openDatabase } = await import(pathToFileURL(`${ROOT}/src/db.js`).href);
const { DEFAULT_EVIDENCE_DIR, evidencePath } = await import(pathToFileURL(`${ROOT}/src/archive.js`).href);

const LIVE = `${ROOT}/data/kanverify.db`;
const BACKUP = `${ROOT}/data/kanverify-format11-backup-20261123.db`;
const NEW = `${ROOT}/data/kanverify-format12-new.db`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };
const COLS = ['id', 'kind', 'url', 'title', 'publisher', 'published_on', 'retrieved_on', 'sha256', 'media_type', 'lang'];
const OTHER = ['subjects', 'claims', 'verdicts', 'verdict_evidence', 'jury_votes', 'publications'];

for (const p of [`${LIVE}-wal`, `${LIVE}-journal`, NEW, BACKUP]) if (existsSync(p)) fail(`${p} exists; stop`);

// 1. Byte-identical backup (refuses to overwrite one).
copyFileSync(LIVE, BACKUP, constants.COPYFILE_EXCL);
const backupSha = sha(readFileSync(BACKUP));
if (sha(readFileSync(LIVE)) !== backupSha) fail('backup differs from the live file');
console.log(`backup ${BACKUP} sha256 ${backupSha}`);

// 2. Read the old rows from the backup, read-only.
const old = new DatabaseSync(BACKUP, { readOnly: true });
if (old.prepare('PRAGMA user_version').get().user_version !== 11) fail('backup is not format 11');
for (const t of OTHER) if (old.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${t} is not empty; this script copies sources only`);
const rows = old.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
const oldSeq = old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
old.close();

// 3. Fresh format-12 database, rows copied with their ids (the established id-preserving migration copy).
const db = openDatabase(NEW);
db.exec('BEGIN IMMEDIATE');
try {
  const ins = db.prepare(`INSERT INTO sources (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`);
  for (const r of rows) ins.run(...COLS.map((c) => r[c]));
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

// 4. Verify: columns, other tables, counter, every view and trigger text equal to db/schema.sql's, archived files.
if (db.prepare('PRAGMA user_version').get().user_version !== 12) fail('new file is not format 12');
const copied = db.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
if (JSON.stringify(copied) !== JSON.stringify(rows)) fail('rows differ');
for (const t of OTHER) if (db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${t} not empty`);
const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
if (seq !== oldSeq) fail(`sources counter ${seq}, was ${oldSeq}`);
const schema = readFileSync(`${ROOT}/db/schema.sql`, 'utf8').replace(/\r\n/g, '\n');
let objects = 0;
for (const { name, sql } of db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('view', 'trigger', 'table') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()) {
  if (!schema.includes(sql.replace(/\r\n/g, '\n'))) fail(`${name} differs from db/schema.sql`);
  objects += 1;
}
const cols = db.prepare('PRAGMA table_info(verdicts)').all().map((c) => c.name);
for (const c of ['rules_version', 'rules_applied']) if (!cols.includes(c)) fail(`verdicts.${c} missing`);
let files = 0;
for (const r of copied) {
  const p = evidencePath(DEFAULT_EVIDENCE_DIR, r.sha256);
  if (!existsSync(p) || sha(readFileSync(p)) !== r.sha256) fail(`archived file of source ${r.id} missing or altered`);
  files += 1;
}
db.close();

// 5. Swap in (the backup holds the old bytes).
rmSync(LIVE);
renameSync(NEW, LIVE);
const check = openDatabase(LIVE);
const n = check.prepare('SELECT count(*) AS n FROM sources').get().n;
check.close();
console.log(`rows ${copied.length} (ids ${copied[0].id}-${copied.at(-1).id}) equal to the format-11 backup; files ${files}/${copied.length} match; other tables empty; counter ${seq}; ${objects} tables, views and triggers = db/schema.sql; verdicts has rules_version and rules_applied; live opens as format 12 with ${n} sources`);
```

## Step 2: migrate-12-redo.mjs (after Fable review 8)

Fable review 8 (finding 2) added a NUL guard to `verdicts.rules_version`, so the live file was rebuilt with the final
format-12 schema, as format 11's step 2 was. Result: draft kept as `data/kanverify-format12-draft-backup-20261123.db`,
sha256 `23ec2d85ec6d2a1bc5cb388d97ab39a196451014359c57cdc68a40290753e9ab`; rows copied again from the format-11 backup
after checking the draft held the same rows; 38 rows, ids 1-43; 38/38 files match; counter 43; 19 tables, views and
triggers equal to `db/schema.sql`; the guard present; `PRAGMA integrity_check` ok.

```js
// One-off, second step of format 12: Fable review 8 added a NUL guard to verdicts.rules_version, so the live file
// (made from the first format-12 schema) is rebuilt with the final schema. Same method as migrate-11-to-12.mjs: the
// current file is kept byte for byte, a fresh database is made by openDatabase (it runs db/schema.sql; no
// writable_schema, no pragma changes), and the sources rows are copied with their ids, from the format-11 backup, in
// one transaction with plain INSERTs, after checking the draft holds exactly the same rows; then everything is checked.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, constants, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/gaoyi/Desktop/KANVERIFY';
const { openDatabase } = await import(pathToFileURL(`${ROOT}/src/db.js`).href);
const { DEFAULT_EVIDENCE_DIR, evidencePath } = await import(pathToFileURL(`${ROOT}/src/archive.js`).href);

const LIVE = `${ROOT}/data/kanverify.db`;
const FORMAT11 = `${ROOT}/data/kanverify-format11-backup-20261123.db`;
const DRAFT = `${ROOT}/data/kanverify-format12-draft-backup-20261123.db`;
const NEW = `${ROOT}/data/kanverify-format12-new.db`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };
const COLS = ['id', 'kind', 'url', 'title', 'publisher', 'published_on', 'retrieved_on', 'sha256', 'media_type', 'lang'];
const OTHER = ['subjects', 'claims', 'verdicts', 'verdict_evidence', 'jury_votes', 'publications'];

for (const p of [`${LIVE}-wal`, `${LIVE}-journal`, NEW, DRAFT]) if (existsSync(p)) fail(`${p} exists; stop`);

// 1. Keep the draft byte for byte.
copyFileSync(LIVE, DRAFT, constants.COPYFILE_EXCL);
if (sha(readFileSync(LIVE)) !== sha(readFileSync(DRAFT))) fail('draft backup differs');
console.log(`draft backup ${DRAFT} sha256 ${sha(readFileSync(DRAFT))}`);

// 2. Read the rows (read-only) from the format-11 backup and from the draft; nothing may have changed since.
const read = (path, version) => {
  const db = new DatabaseSync(path, { readOnly: true });
  if (db.prepare('PRAGMA user_version').get().user_version !== version) fail(`${path} is not format ${version}`);
  for (const t of OTHER) if (db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${path}: ${t} not empty`);
  const rows = db.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
  db.close();
  return { rows, seq };
};
const old = read(FORMAT11, 11);
const draft = read(DRAFT, 12);
if (JSON.stringify(old) !== JSON.stringify(draft)) fail('the draft holds other sources than the format-11 backup');

// 3. Fresh database through openDatabase; copy with ids preserved (the established migration copy).
const db = openDatabase(NEW);
db.exec('BEGIN IMMEDIATE');
try {
  const ins = db.prepare(`INSERT INTO sources (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`);
  for (const r of old.rows) ins.run(...COLS.map((c) => r[c]));
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
}

// 4. Verify: rows, other tables, counter, every table/view/trigger text equals db/schema.sql's, the new guard, files.
if (db.prepare('PRAGMA user_version').get().user_version !== 12) fail('not format 12');
const copied = db.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
if (JSON.stringify(copied) !== JSON.stringify(old.rows)) fail('rows differ');
for (const t of OTHER) if (db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${t} not empty`);
const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
if (seq !== old.seq) fail(`counter ${seq}, was ${old.seq}`);
const schema = readFileSync(`${ROOT}/db/schema.sql`, 'utf8').replace(/\r\n/g, '\n');
let objects = 0;
for (const { name, sql } of db.prepare("SELECT name, sql FROM sqlite_master WHERE type IN ('view', 'trigger', 'table') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'").all()) {
  if (!schema.includes(sql.replace(/\r\n/g, '\n'))) fail(`${name} differs from db/schema.sql`);
  objects += 1;
}
if (!db.prepare("SELECT sql FROM sqlite_master WHERE name = 'verdicts'").get().sql.includes('length(CAST(rules_version AS BLOB)) = length(rules_version)')) fail('the rules_version guard is missing');
if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('integrity check failed');
let files = 0;
for (const r of copied) {
  const p = evidencePath(DEFAULT_EVIDENCE_DIR, r.sha256);
  if (!existsSync(p) || sha(readFileSync(p)) !== r.sha256) fail(`archived file of source ${r.id} missing or altered`);
  files += 1;
}
db.close();

// 5. Swap in.
rmSync(LIVE);
renameSync(NEW, LIVE);
const check = openDatabase(LIVE);
const n = check.prepare('SELECT count(*) AS n FROM sources').get().n;
check.close();
console.log(`rows ${copied.length} (ids ${copied[0].id}-${copied.at(-1).id}) equal to the format-11 backup; files ${files}/${copied.length} match; other tables empty; counter ${seq}; ${objects} tables, views and triggers = db/schema.sql; rules_version guard present; integrity ok; live opens as format 12 with ${n} sources`);
```
