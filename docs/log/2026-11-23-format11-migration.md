# Record format 11: migration scripts (2026-11-23)

One-off scripts, run once from the scratch folder, not kept in `src/`. Recorded here so their method can be reviewed.
Method: byte-identical backup first; a fresh database made by `openDatabase` (it runs `db/schema.sql` as is: no
`writable_schema`, no dropped or edited views, no pragma changes); `sources` rows copied with their ids (the
id-preserving copy used for formats 8-10) in one transaction with plain INSERTs, no REPLACE; then every column, the
other tables, the `sources` counter and every archived file checked. The old file is read only through a read-only
`DatabaseSync`, because `openDatabase` refuses an older format.

Results:

- Step 1 (`migrate-10-to-11.mjs`): backup `data/kanverify-format10-backup-20261123.db`, sha256
  `faa2d396a02c6bc7debbd6a408dcb7e002ac350a6b7e6b414408f64cc7ac8f4d`; 38 rows, ids 1-43, all columns equal; 38/38 files match.
- Step 2 (`migrate-11-redo.mjs`, after Fable review 7 changed the format-11 view): draft kept as
  `data/kanverify-format11-draft-backup-20261123.db`, sha256 `2470659ab8f6e2f8a563534f0fd7f6ea6705505c7555cc49b09c500ee08cd88e`;
  rows copied again from the format-10 backup after checking the draft held the same rows; the view text equals
  `db/schema.sql`; 38/38 files match; counter 43.

## Step 1: migrate-10-to-11.mjs

```js
// One-off: record format 10 -> 11 for data/kanverify.db. Same steps as formats 8-10:
// byte-identical backup, fresh database through openDatabase, sources copied with their ids in one
// transaction (plain INSERTs, no REPLACE, no pragma changes), then every column and every archived file checked.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, constants, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/gaoyi/Desktop/KANVERIFY';
const { openDatabase } = await import(pathToFileURL(`${ROOT}/src/db.js`).href);
const { DEFAULT_EVIDENCE_DIR, evidencePath } = await import(pathToFileURL(`${ROOT}/src/archive.js`).href);

const LIVE = `${ROOT}/data/kanverify.db`;
const BACKUP = `${ROOT}/data/kanverify-format10-backup-20261123.db`;
const NEW = `${ROOT}/data/kanverify-format11-new.db`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };

for (const p of [`${LIVE}-wal`, `${LIVE}-journal`, NEW]) if (existsSync(p)) fail(`${p} exists; stop`);

// 1. Byte-identical backup (refuses to overwrite one).
copyFileSync(LIVE, BACKUP, constants.COPYFILE_EXCL);
const liveSha = sha(readFileSync(LIVE));
const backupSha = sha(readFileSync(BACKUP));
if (liveSha !== backupSha) fail('backup differs from the live file');
console.log(`backup ${BACKUP} sha256 ${backupSha}`);

// 2. Read the old rows from the backup, read-only (openDatabase refuses format 10, correctly).
const old = new DatabaseSync(BACKUP, { readOnly: true });
if (old.prepare('PRAGMA user_version').get().user_version !== 10) fail('backup is not format 10');
for (const t of ['subjects', 'claims', 'verdicts', 'verdict_evidence', 'jury_votes', 'publications']) {
  if (old.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${t} is not empty; this script copies sources only`);
}
const COLS = ['id', 'kind', 'url', 'title', 'publisher', 'published_on', 'retrieved_on', 'sha256', 'media_type', 'lang'];
const rows = old.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
const oldSeq = old.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
old.close();

// 3. Fresh format-11 database, rows copied with their ids (the established id-preserving migration copy).
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

// 4. Verify.
if (db.prepare('PRAGMA user_version').get().user_version !== 11) fail('new file is not format 11');
const copied = db.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
if (copied.length !== rows.length) fail('row count differs');
copied.forEach((r, i) => { for (const c of COLS) if (r[c] !== rows[i][c]) fail(`source ${rows[i].id} column ${c} differs`); });
for (const t of ['subjects', 'claims', 'verdicts', 'verdict_evidence', 'jury_votes', 'publications']) {
  if (db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${t} not empty`);
}
const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
if (seq !== oldSeq) fail(`sources counter ${seq}, was ${oldSeq}`);
let filesOk = 0;
for (const r of copied) {
  const p = evidencePath(DEFAULT_EVIDENCE_DIR, r.sha256);
  if (!existsSync(p)) fail(`archived file of source ${r.id} missing`);
  if (sha(readFileSync(p)) !== r.sha256) fail(`archived file of source ${r.id} does not match its sha256`);
  filesOk += 1;
}
db.close();

// 5. Put the new file in place of the old one (the backup holds the old bytes).
rmSync(LIVE);
renameSync(NEW, LIVE);
const check = openDatabase(LIVE);
const n = check.prepare('SELECT count(*) AS n FROM sources').get().n;
check.close();
console.log(`rows ${copied.length} (ids ${copied[0].id}-${copied.at(-1).id}), every column equal; files ${filesOk}/${copied.length} match sha256; other tables empty; sources counter ${seq}; live file opens as format 11 with ${n} sources`);
```

## Step 2: migrate-11-redo.mjs

```js
// One-off, second step of format 11: the format-11 views changed after Fable review 7, so the live
// file (made from the first format-11 draft) is rebuilt with the final schema. Same method as
// migrate-10-to-11.mjs: the old file is kept byte for byte, a fresh database is made by openDatabase
// (it runs db/schema.sql; no writable_schema, no dropped or edited views, no pragma changes), and the
// sources rows are copied with their ids in one transaction with plain INSERTs, then checked.
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, constants, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/gaoyi/Desktop/KANVERIFY';
const { openDatabase } = await import(pathToFileURL(`${ROOT}/src/db.js`).href);
const { DEFAULT_EVIDENCE_DIR, evidencePath } = await import(pathToFileURL(`${ROOT}/src/archive.js`).href);

const LIVE = `${ROOT}/data/kanverify.db`;
const FORMAT10 = `${ROOT}/data/kanverify-format10-backup-20261123.db`;
const DRAFT = `${ROOT}/data/kanverify-format11-draft-backup-20261123.db`;
const NEW = `${ROOT}/data/kanverify-format11-new.db`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const fail = (m) => { throw new Error(m); };
const COLS = ['id', 'kind', 'url', 'title', 'publisher', 'published_on', 'retrieved_on', 'sha256', 'media_type', 'lang'];
const OTHER = ['subjects', 'claims', 'verdicts', 'verdict_evidence', 'jury_votes', 'publications'];

for (const p of [`${LIVE}-wal`, `${LIVE}-journal`, NEW, DRAFT]) if (existsSync(p)) fail(`${p} exists; stop`);

// 1. Keep the draft byte for byte.
copyFileSync(LIVE, DRAFT, constants.COPYFILE_EXCL);
if (sha(readFileSync(LIVE)) !== sha(readFileSync(DRAFT))) fail('draft backup differs');
console.log(`draft backup ${DRAFT} sha256 ${sha(readFileSync(DRAFT))}`);

// 2. Read the rows (read-only), from the format-10 backup and from the draft; nothing may have changed since.
const read = (path, version) => {
  const db = new DatabaseSync(path, { readOnly: true });
  if (db.prepare('PRAGMA user_version').get().user_version !== version) fail(`${path} is not format ${version}`);
  for (const t of OTHER) if (db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${path}: ${t} not empty`);
  const rows = db.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
  const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
  db.close();
  return { rows, seq };
};
const old = read(FORMAT10, 10);
const draft = read(DRAFT, 11);
if (JSON.stringify(old) !== JSON.stringify(draft)) fail('the draft holds other sources than the format-10 backup');

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

// 4. Verify: columns, other tables, counter, the view text equals db/schema.sql's, archived files.
if (db.prepare('PRAGMA user_version').get().user_version !== 11) fail('not format 11');
const copied = db.prepare(`SELECT ${COLS.join(', ')} FROM sources ORDER BY id`).all();
if (JSON.stringify(copied) !== JSON.stringify(old.rows)) fail('rows differ');
for (const t of OTHER) if (db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n !== 0) fail(`${t} not empty`);
const seq = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sources'").get()?.seq;
if (seq !== old.seq) fail(`counter ${seq}, was ${old.seq}`);
const viewSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'publication_checks'").get().sql;
if (!readFileSync(`${ROOT}/db/schema.sql`, 'utf8').replace(/\r\n/g, '\n').includes(viewSql.replace(/\r\n/g, '\n'))) fail('view differs from db/schema.sql');
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
console.log(`rows ${copied.length} (ids ${copied[0].id}-${copied.at(-1).id}) equal to the format-10 backup; files ${files}/${copied.length} match; other tables empty; counter ${seq}; view = db/schema.sql; live opens as format 11 with ${n} sources`);
```
