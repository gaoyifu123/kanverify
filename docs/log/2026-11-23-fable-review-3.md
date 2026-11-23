# Fable review 3 — record formats 6–9 together (what can be published)

Reviewer: code reviewer, Fable 5.2. Date: 2026-11-23. Saved by the coordinator from the reviewer's report (the reviewer may not write files).

**Verdict: SEND BACK (narrow).** The ledger and the source/bilingual rules hold. 241 tests pass. Scratch scripts in the coordinator's scratchpad (`fr3/`).

## What holds
- Ledger append-only on an ordinary connection: forged snapshots, upserts, chosen ids, backdated timestamps, UPDATE/DELETE on publications, deleting/renumbering a published claim, bad withdrawals — all refused.
- Bilingual withdrawal note enforced (one language or zero-width English refused).
- `publishable` vs `voteProblems` over 396 combinations: 0 disagreements once deadlines are factored out.
- Source rule in `publication_checks`: platform/statement as evidence, renunciation outside its case, renunciation as origin — all blocked.

## Findings
1. **Medium — the deadline rule is not in the publication policy.** `confirm()` publishes verdicts the verdict standard forbids (early `not_came_true` / `partly_came_true` / `to_evaluate` / measurable `unverifiable`; `pending` after the deadline). Only the desk guards it. The `db/schema.sql` header is wrong twice (line 11 says partly may be early; line 13 says the check is in jury.js).
2. **Medium-low — `confirm()` can report success without writing** (no `changes` check; returns a stale `lastInsertRowid`).
3. **Low — "two different publishers" normalised differently** in the database (`lower(trim())`, ASCII) and in `pack.js` (Unicode); the same file (same sha256) under two publisher names counts as two; `filled()` in pack.js misses invisible characters the database treats as blank.
4. **Low — a renunciation is not tied to the claim's date** (`published_on < said_on` accepted).
5. **Low — source ids are public but not stable** (no AUTOINCREMENT; rows editable in place, so `origin.id` can point to another document).
6. **Low — a measurable claim without a deadline is publishable with any verdict.**
7. **Question for the founder** — a vague promise explicitly abandoned can only be `unverifiable`; decision 0008 and verdict-standard §2 should say which wins.

## Objections and risks
- Putting a date check into `publication_checks` makes it time-dependent (UTC vs local date) — think it through, don't patch.
- Not reviewed: desk files, real two-process concurrency, out-of-scope paths.
