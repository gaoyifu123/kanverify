# Fable 5.2 review 10: ledger migration proposal (design only), 2026-11-24

Reviewed docs/log/2026-11-24-ledger-migration-proposal.md. Saved by the coordinator, condensed, every finding kept.
Claims tested on the real db/schema.sql in memory (SQLite 3.54.1) with a ledger holding published, re-confirmed and
withdrawn entries.

## Result: PASS as a design, with conditions

Route (a) in place, with (c)'s freeze policy, is sound: view swap under the ledger triggers works; ADD COLUMN works;
user_version is transactional; integrity and foreign-key checks see the uncommitted state; the ledger still works
afterwards; the digest is necessary (a dropped-and-recreated trigger with a rewritten row passes schema equality
alone); PRAGMA foreign_keys=OFF is a no-op in a transaction but writable_schema / ignore_check_constraints /
defer_foreign_keys do take effect, so "no PRAGMA in a migration" matters. (b) rightly rejected.

What it cannot do, wider than proposed: no workspace table can ever be rebuilt (rename fails through ledger_exact →
publishable; DROP of claims/sources fails on foreign keys). So no column definition or table CHECK can change again —
including claims.domain ("the list can grow"), sources.kind, subjects.kind, claims.type, deadline_basis, the six
verdicts, the blank-character list.

1. **High, decide now:** the enumerated lists freeze at the first confirmation. Either move the growable lists
   (at least claims.domain, sources.kind) into lookup tables with foreign keys in format 13, via one last copy
   migration while the ledger is empty, or accept in writing that they are frozen. Reviewer's lean: lookup tables
   for those two; verdicts and types stay; a seventh verdict would be a founder-level event with no clean route.
2. **Medium:** the snapshot's `format` key must count the snapshot shape, not user_version — otherwise every upgrade
   flags every published claim as changed.
3. **Medium:** the checks don't guard the workspace (a DELETE of unpublished claims passes every check). Runner:
   row counts unchanged unless declared; digest of pre-existing columns; DELETE forbidden.
4. **Medium:** the runner should refuse forbidden statements by parsing (whitelist: ADD COLUMN on workspace tables,
   CREATE TABLE/INDEX, view and workspace-trigger drop/create, UPDATE of workspace tables); also refuse ATTACH,
   DETACH, VACUUM, REPLACE, sqlite_sequence, triggers on publications or views; RENAME/DROP COLUMN.
5. **Medium-low:** table-text equality needs a tokenising normaliser with its own tests, both-direction object-set
   comparison, LF-pinned db/**/*.sql (core.autocrlf true, no .gitattributes). Simpler: the runner recreates every view
   and workspace trigger from db/schema.sql itself.
6. **Low:** take BEGIN IMMEDIATE before copying the backup; companion assertion queries for rules moved to triggers;
   digest with SELECT *, typed, with highest id; stop the desk and inbox job, fail cleanly on a busy file.

Reviewer rules: add RENAME/DROP COLUMN, DELETE, ATTACH/DETACH/VACUUM, triggers on publications or views,
sqlite_sequence; any runner change that narrows a check or commits after an error; a test exemption for building
old-format files with a non-empty ledger; reword the general view/trigger item to the narrow migration exemption;
explicit ids stay forbidden. Retire the copy exemption after the last copy migration, with both counters and all
workspace tables.

Objections: order of work becomes format 13 (last copy migration) then format 14 (first in-place) before the first
confirmation — about a day more; triggers return to the workspace; mixed shapes and standards on the site for good;
no backup off this machine (more serious from the first confirmation on).

Not verified: no code yet; SQLite 3.54.1 only; whether DatabaseSync offers defensive mode (if so, turn it on); site.js
dependence on the snapshot shape; live database not opened.

## Coordinator's decision

Technical, decided by the coordinator (principle 5 vs. a frozen schema): finding 1 as the reviewer leans — format 13
is the last copy migration: lookup tables for claims.domain and sources.kind, the snapshot `format` key as a shape
counter; then the in-place runner with findings 3–6 and the reviewer rules. The founder is told that the first
confirmation moves by about a day and that a seventh verdict would have no clean route.
