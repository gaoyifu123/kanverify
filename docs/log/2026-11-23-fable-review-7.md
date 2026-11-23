# Fable 5.2 review 7: record format 11

Date: 2026-11-23. Reviewer: code reviewer on Fable 5.2. Saved by the coordinator, condensed, every finding kept.
`npm test` 296/296; 25 ledger probes, 15 vote probes, one closeRound probe; migration checked on scratch copies.

## Result: SEND BACK (narrow)

The core holds: widened evidence rule, ledger deadline handling, `based_on_round` in the snapshot, the site's round
filter, the migration (user_version 11; 22 schema objects identical to a fresh schema; integrity and foreign keys ok;
every table row-for-row equal to the format-10 backup; sources sequence at 43; no forbidden statements).

## Findings

1. **Always-send-back item (harmless today).** `src/desk.js` 1144–1149 passes `today` (from the desk's injectable
   clock) to `confirm()`. Committed in 29675e8 (tag `fable-desk-2026-11-23`) — missed by the desk reviews. Case:
   `createDesk({ now: () => new Date('2099-01-01') })` publishes not_came_true before the deadline. Fix: drop `today`
   from that call; keep the clock for previews only.
2. **Medium.** A kept vote text is never checked against its hash and never read: a Windows-1252 vote file closes a
   round whose stored text doesn't hash back; `readRounds` accepts mismatching or missing text; nothing ingests an
   overwritten round.
3. **Medium-low.** `unverifiable` on a renounced measurable promise is a dead end; both stops send the user in a circle.
4. **Medium-low.** An undated renunciation in the pack lets `pending` through silently.
5. **Medium-low, public.** The site lists a renunciation as "Evidence N" under came_true/partly, although it is never
   evidence of a result there. Design question → designer.
6. **Low.** A future-dated renunciation can be published under came_true/to_evaluate; `waitHint` names only the first
   renunciation; the desk's friendly stop text is stale; near-duplicate helpers.

Developer's own gaps: the hand-written `pending` through `confirm()` directly is confirmed and acceptable as a recorded
limit (whoever builds review 6 A8 must know there is no pack check there). "Judges must cite the renunciation" is
confirmed and blocks use: no jury run on a renounced promise before judge-0.7.

## Objections and risks (reviewer)

- The evidence-row route causes findings 3–5 and the pending gap; a claim-to-renunciation link would avoid them. Not
  asking for a redo; but a third fix in this area triggers the circuit breaker and the link should be reconsidered.
- The kind label carries more weight: relabelling a cited statement as `renunciation` now ends the wait for partly /
  to_evaluate. The founder's reading at the desk is the only guard.
- A renunciation dated after the deadline is still sole evidence for not_came_true (unchanged).

## Not verified

The migration script (not in the tree); browser; the site on real data; desk end-to-end on a renounced promise;
whether dropping `today` breaks desk tests; prompt files.

## Coordinator's decision

Back to the same developer for 1–4 and 6. Finding 3: admit the renunciation beside other evidence under `unverifiable`
for a measurable promise (the founder's rule: ends the wait whatever the verdict). Finding 2: a round overwritten
before the desk saw it is kept on disk only, stated in decision 0005. Finding 5 goes to the designer. The migration
script is to be attached for review. Then the same reviewer re-checks. Noted: the circuit-breaker warning on the
renunciation route.

# Re-check (same day): PASS on the code, with one condition on the migration method

Findings 1–4 and 6 fixed and re-attacked (34 ledger cases, 22 vote cases, rounds with non-UTF-8, BOM and forged
lines); `npm test` 301/301. Live database re-verified on scratch copies: user_version 11, 22 schema objects identical to
a fresh schema, integrity and foreign keys ok, all tables row-for-row equal to the format-10 backup, counter 43.

Condition: the migration scripts insert into `sources` with explicit ids and open the old file with `DatabaseSync`
outside `test/` — both on the always-send-back list. Sound here, but needs a written exemption before commit.
Low: `rmSync(LIVE)` runs before `renameSync`; the scripts ran from the scratchpad, so the recorded text can't be proven
to be what ran; they read `sqlite_sequence` and never write it.

Objections and risks: this migration method stops working at the first publication (needs a decided route for a
non-empty ledger before the first real confirmation); only renunciations are checked for a future date (`came_true` on
a law dated 2030 still publishes); still standing: hand-written `pending` gap, the kind label deciding what a
renunciation is, judge-0.6 not telling judges to cite the renunciation (no jury run on a renounced promise before
judge-0.7), the claim-link alternative if a third fix is needed; desk preview vs ledger at midnight (ledger decides).

Coordinator: exemption written into `.claude/agents/code-reviewer.md` and decision 0005; the non-empty-ledger route
is added to the plan before the first confirmation; committed with tag `fable-record-format-11-2026-11-23`.
