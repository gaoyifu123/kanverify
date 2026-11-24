# Proposal: upgrading the record format when the ledger holds entries

- Role: developer (Opus 5.5). Date: 2026-11-24. Design only: no code changed, nothing committed, `data/` only read.
- For: the open item in decision 0005 ("migration exemption" addendum), Fable review 7 re-check objection, board item.
- Needs: Fable review (record format and ledger, `team/README.md` items 1 and 3), then the founder's decision.

## The problem, as it stands today

Formats 8 to 12 were upgraded by copying rows into a fresh file made by `openDatabase`. That route needs every table
except `sources` to be empty. Two things now break it:

1. **The ledger.** Once `publications` holds entries, plain INSERTs into a fresh file are refused: `ledger_now` (the
   original `confirmed_at` is more than 60 s old), `ledger_exact` (an old snapshot is not what `publishable` gives now,
   and its shape may differ), `ledger_withdraw` (a withdrawal must follow its published entry in the same file).
2. **Already now, before any publication.** The live file (read through `openDatabase`, 2026-11-24) holds 2 subjects,
   38 sources, 173 claims and 6 jury votes. The format-12 script refuses that (`claims is not empty`). So the next
   format change needs a new route whether or not the founder has confirmed anything.

What must stay true through any upgrade: every ledger row (id, claim_id, status, snapshot, notes, confirmed_by,
confirmed_at, review_seconds) is byte for byte what it was; nothing is renumbered; the triggers that guard the ledger
are the same afterwards; and the step that touches the schema is one reviewed, recorded act.

## Facts checked (SQLite 3.54.1, Node's built-in module, in memory, scratch folder)

- DDL is transactional: `ALTER TABLE ... ADD COLUMN`, `DROP VIEW` / `CREATE VIEW` inside `BEGIN IMMEDIATE` roll back
  cleanly; after `COMMIT` the ledger rows are unchanged and the next confirmation gets the new snapshot shape.
- A view can be dropped and recreated in the same transaction while `ledger_exact` refers to it by name.
- `ADD COLUMN` with a `CHECK` checks the existing rows and fails if one breaks it. `NOT NULL` needs a default.
- `ADD COLUMN` writes the new column into the stored `CREATE TABLE` text after the last column and before the
  table-level `CHECK`s.
- `ALTER TABLE claims RENAME ...` rewrites the `REFERENCES` text inside `publications`. So the usual 12-step table
  rebuild (new table, copy, drop, rename) cannot be used on a table that `publications` refers to (`claims`) without
  changing the ledger's own definition, and on any parent table it needs `PRAGMA foreign_keys = OFF` (always sent back).

## Option (a): migrations applied in place, ledger untouched

**What changes.**
- `db/migrations/0013.sql` (one file per format step): only `ALTER TABLE ... ADD COLUMN`, `CREATE TABLE`,
  `CREATE INDEX`, `DROP VIEW` + `CREATE VIEW`, `DROP TRIGGER` + `CREATE TRIGGER` on workspace triggers, and
  `UPDATE` on workspace rows when a backfill has a stated source.
- `db/formats/schema-12.sql`: a byte copy of each released schema, kept for ever (as `docs/methodology/versions/`).
- `src/db.js` gains `upgradeDatabase(path)` and `node src/db.js upgrade`, the only code that runs migration files. It:
  refuses if a `-wal` or `-journal` file exists; makes a byte-identical backup (`COPYFILE_EXCL`) and records its sha256;
  opens the file with the same settings as `openDatabase` (foreign keys on, `kv_publisher_key`); `BEGIN IMMEDIATE`;
  checks `user_version` is the expected old format; computes the **ledger digest** (sha256 over every `publications`
  row in id order, all columns, length-prefixed) and the row count; runs the migration file(s) in order; sets
  `user_version`; then, **before `COMMIT`**: ledger digest and count unchanged, `PRAGMA integrity_check` = ok,
  `PRAGMA foreign_key_check` empty, every view, trigger and index text identical to a fresh `openDatabase(':memory:')`,
  every table equal after normalising (comments stripped, whitespace collapsed), `sqlite_sequence` unchanged, every
  archived file still hashes to its `sources.sha256`. Any mismatch: `ROLLBACK`, and the file is as it was. There is no
  delete-and-rename swap; SQLite's commit is the swap.
- `openDatabase` still refuses any other version, with a message pointing to `node src/db.js upgrade`. It never
  upgrades on its own: the upgrade is a deliberate act with a backup.
- The script that ran is the committed code plus the committed `.sql` file, so "the recorded text is what ran" (Fable
  review 7 re-check, Low) holds by construction. The run prints the backup sha256, the ledger digest and the counts;
  the developer copies that output into `docs/log/`.

**What could go wrong.**
- Not every change fits. A new or tighter `CHECK` on `claims`, `sources`, `subjects` or `verdicts` needs a rebuild that
  (a) forbids. Such a rule becomes either a `publication_checks` condition (refuses publication, not storage) or a pair
  of `BEFORE INSERT` / `BEFORE UPDATE` row triggers, with the migration checking that no existing row breaks it. Format
  12's VG-3 claims check is an example that would have gone this way. This adds workspace triggers, which decision 0005
  cut on purpose.
- A required column on a table that has rows needs a value for the old rows. A default made up to satisfy `NOT NULL`
  would be data without a source (principle 2). Rule: add it nullable and let `publication_checks` refuse until a
  person fills it in, or backfill only with a stated source.
- Table text comparison relies on a normaliser (comments, whitespace). A bug there could hide a real difference. The
  normaliser gets its own test with a mismatching table.
- Views change under the ledger. A wrong `publication_checks` lets the wrong things through, as with any schema change.
  Fable reviews it, as today.

**How it is verified.** Each run checks itself inside the transaction (above). Each migration also has a test that
runs on every `npm test`: build a file from `db/formats/schema-<old>.sql`, fill it including a non-empty ledger
(published, re-confirmed and withdrawn entries, made through the old schema's own triggers), upgrade it, and assert:
digest unchanged; schema equal to fresh; `confirm()` and `withdraw()` work afterwards; a withdrawal of an old-shape
entry still works; the site builds from a ledger with mixed snapshot shapes; and a migration that touches
`publications` is rolled back.

**Reviewer's always-send-back list would need** (replacing today's copy exemption, item 7):
- Any statement in a migration that writes `publications` (INSERT, UPDATE, DELETE), or alters, drops or renames it.
- Dropping or recreating any `ledger_*` trigger, or `current_publications`, in a migration. If ever needed, that is a
  separate founder decision, not a migration.
- `RENAME` or `DROP` of any table in a migration (the rebuild route), and any `PRAGMA` in a migration file
  (`user_version` is set by the runner only).
- Any code other than `upgradeDatabase` that runs a migration file or sets `user_version`.
- A runner change that moves any check to after `COMMIT`, or that skips the backup.
- A migration with no upgrade test from the kept old schema with a non-empty ledger.
- A backfill `UPDATE` without a stated source for the values it writes.
- Exemption, narrow: `DROP VIEW` / `CREATE VIEW` and `DROP TRIGGER` / `CREATE TRIGGER` on workspace triggers are
  allowed **inside `db/migrations/*.sql` only**.

## Option (b): copy into a fresh file, ledger carried over by a dedicated import path

**What changes.** A fresh file from the new `db/schema.sql`; every workspace table copied with its ids (more than
`sources` now); the ledger rows inserted with their original `confirmed_at` and snapshots. The triggers refuse this, so
the import needs one of: (1) a flag table that `ledger_now`, `ledger_exact` and `ledger_withdraw` consult; (2)
`openDatabase` splitting the schema into "tables" and "ledger guards" with an import step between; (3) running a schema
without the ledger triggers, then adding them.

**What could go wrong.**
- The import path is a tool that writes any snapshot with any date into a ledger. With (1) it lives in the schema for
  good: any connection that writes the flag switches off the ledger's guards, a hole kept closed by review alone.
  (2) and (3) keep it in code, but it is still a permanent forging capability.
- Imported old snapshots can never satisfy `ledger_exact` again, so their exactness rests only on the comparison with
  the backup.
- More moving parts: every table copied in foreign-key order, `sqlite_sequence` for `subjects` and `sources` must come
  out equal without being written, the delete-and-rename swap is not atomic (Fable review 7 re-check, Low).
- The one benefit: the new file's schema text is exactly `db/schema.sql`, so no normaliser is needed.

**Verified by** row-for-row comparison of every table with the backup, the same ledger digest, schema text equality,
the counters and archived files, all before the swap. **Reviewer's list** would need: the import function never
exported or callable outside the migration runner; the flag (if used) never written outside it; the digest compared
before the swap; the swap order (rename before delete). This list is longer and it guards a stronger tool.

## Option (c): freeze old snapshots as they are, change only the views for new entries

**What changes.** Old ledger entries are never rewritten into a new shape: they are the public record of what was
confirmed, on the date it was confirmed, under the rules of that time. A new format changes `publishable` (and
`publication_checks`), so only new confirmations get the new shape. Rewriting old snapshots is ruled out: it would be
publishing something nobody confirmed (principle 2, decision 0005).

**What could go wrong.**
- (c) is a policy, not a mechanism. It says what happens to old entries (nothing); it does not say how new columns get
  into the workspace tables. It needs (a) or (b) underneath.
- The site has to read every snapshot shape ever written, for ever. Today it guesses from missing keys
  (`s.jury || []`, `Number.isInteger(v.based_on_round)`). That gets fragile as shapes add up.
- After a shape change, every published claim compares unequal to `publishable`, so `hasUnconfirmedChanges` is true for
  all of them, and the desk shows them all as changed. Re-confirming makes new entries (in the new shape, under today's
  rules); a claim that no longer passes today's rules keeps its old entry as its public state.

**Verified by** the same ledger digest before and after, and a site test with entries of every kept shape.

## Recommendation: (a) with (c)'s policy, plus one snapshot field added while it is still free

1. Upgrades run in place through `upgradeDatabase` (option a). The ledger table, its rows and its triggers are never
   touched; old snapshots stay as they were (option c).
2. **In the next format (13), before the first confirmation, add `'format', 13` at the top of the snapshot.** One
   sentence on why existing parts are not enough (principle 5): a frozen snapshot must say which shape it has, so the
   site and anyone reading the published data do not have to guess from missing keys, and adding the field costs
   nothing only while the ledger is empty. A snapshot with no `format` key is format 12 or earlier, and none of those
   will be in the live ledger.
3. Retire the copy exemption (reviewer item 7) once (a) is built and reviewed: one route, not two.
4. If a future change truly needs a rebuild of `claims` or the ledger, that is not a migration: it comes back as its own
   decision, with (b) designed and reviewed then.

Why (a): it is the smallest code (a runner of roughly 60 to 80 lines and one SQL file per step); the ledger rows are
never read back in or written, so there is nothing to forge with; the transaction makes the upgrade all-or-nothing with
no file swap; and the migration SQL runs in every `npm test`, not once from a scratch folder. Its limit (no rebuilds of
parent tables) is a limit on what a format change may do, which is the right place for it.

Order of work, if accepted: decision 0005 addendum (founder), then format 13 (snapshot `format` key, runner,
`db/formats/schema-12.sql`, upgrade test, reviewer list change) in one brief, then Fable review, then upgrade the live
file with the new runner before the first confirmation.

## Principles

- 2: the public record is never re-derived or rewritten. An old entry stays what was confirmed, and its bytes are proven
  unchanged by a digest checked before commit.
- 4: the copy route has stopped working (the claims table is already full). This is a designed route before the first
  real verdict, not a patch made under pressure afterwards.
- 5: no copy of the data, no import tool, no new table; one runner and one SQL file per step. The snapshot `format` key
  is the one addition, justified above.
- 8: everything stays in the local file. The backup is local.

## Objections and risks

- **The workspace will grow triggers.** Under (a), new row rules on `claims`, `sources`, `subjects` or `verdicts` can
  only become row triggers or publication checks. That works against decision 0005's choice of few triggers. I accept
  it as the price of never rebuilding a table under the ledger. If it gets out of hand, that is the signal to rethink.
- **Re-confirmation load after a shape change.** Every published claim will show as changed and needs a person to
  confirm it again (principle 7 tension). The desk could label "only the format changed", but that is the designer's
  call and is not proposed here. Until then, avoid shape changes that are not needed once the ledger fills.
- **Old snapshots keep old rules for good.** A claim confirmed under verdict standard 0.8 stays public under 0.8 until
  someone re-confirms it. That is honest (the site names the version), but readers will see mixed standards.
- **No backup off this machine yet.** The runner's backup is local. A disk failure during the weeks between formats
  loses the ledger. That needs the backup decision, not this proposal.
- **Normaliser risk.** The table-text comparison is only as good as the comment and whitespace stripping. It needs its
  own failing-case test.
- **SQLite version drift.** The facts above were checked on 3.54.1 only. A Node upgrade could change `ADD COLUMN` text
  placement. The runner should print `sqlite_version()`, and the upgrade test would catch a change.
- **Disagreement with the framing:** the brief treats this as a problem for after the first publication. It is already
  a problem now (173 claims), so it blocks the next format change, not just the first confirmation.

## Not done, not verified

- No code, no migration file, no test written. Nothing was run on `data/` beyond counting rows through `openDatabase`.
- The SQLite behaviour above was checked in memory on small tables, not on the real schema. The view swap was not tried
  with `publication_checks` and `kv_publisher_key`.
- I have not checked how much of `src/site.js` depends on today's snapshot shape beyond the lines cited.
