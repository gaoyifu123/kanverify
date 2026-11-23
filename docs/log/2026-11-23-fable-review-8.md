# Fable 5.2 review 8: record format 12 and verdict standard 0.6 (2026-11-23)

Saved by the coordinator, condensed, every finding kept. `npm test` 338/338; 46 ledger probes, 27 vote probes, one
site build probe; migration verified on scratch copies.

## Result: SEND BACK (narrow)

The truth table states the founder's decisions faithfully; every derived place attacked agrees with it; the migration
is sound (user_version 12, 22 objects identical, integrity ok, 38 sources identical, counter 43). Reviewer: "the
single-table method worked — the first pass on the renunciation rule where schema, shared rules, vote checks and
prompts agreed on every probe."

## Gaps in the table

- **A** (→ finding 1) two founder decisions collide.
- **B** "precise" missing from the public ST-1 and RN-1 lines.
- **C** judge-0.8 decides "follow the rule and say so" when rule and common sense disagree; belongs in the standard.
- **D** a promise made again after a reversal: not stated (new claim by row 5's logic).
- **E** "same speaker" undefined for governments, parties, institutions (not urgent).
- **F** rows 2, 4, 7: "the summary mentions the reversal" while it is never cited → an unsourced fact in the record.
- **G** row 8 "recorded as a claim of its own" has no mechanism.

## Findings

1. **Medium-high.** Met, then undone before the deadline: judged in 2025 → came_true (EA-1); first judged in 2028 →
   not_came_true (DL-2, state at the deadline). Needs the founder: after the deadline, does "fully met at some point on
   or before the deadline" give came_true, or does the deadline day decide?
2. **Medium.** An unknown rules version or id confirmed through `confirm()` directly stops the site build for good
   (append-only ledger); version check lacks the NUL guard. confirm() must refuse versions/ids `src/standard.js` does
   not hold.
3. **Medium.** `rules_version` doesn't pin its text: editing the standard without a version bump silently changes what
   every past verdict shows. Keep the frozen copy `versions/verdict-standard-0.6.md` now and test that the live file
   equals the copy of its own version.
4. **Low-medium.** French public lines use « reniée » (moral blame; section 8 forbids emotive words); « prédiction »
   vs the site's « prévision »; "formulée avec réserve" clearer than "affirmation prudente".
5. **Low.** Named rules need not fit the verdict; the ledger doesn't require RN-1 for a reversal-only not_came_true;
   which rule list a unanimous item gets is arbitrary; a vague prediction is recorded as VG-1 only (not VG-3);
   judge-0.8 has no line for an undated/pre-claim reversal in whole-document mode; a vote may cite the later of two
   reversals; dead `basisInferred` wording.

Developer's risks judged: hard-coded ids acceptable (pinned by test); made-up ids via confirm() not acceptable
(finding 2); deliberate voids accepted; "a standard change voids all votes" accepted, founder should know (every rule
edit, even a typo fix after finding 3, means re-voting unconfirmed items); partial step back = separate claim is
faithful — a promise openly cut in half waits as pending until its deadline, and nobody records the separate claim yet.

## Objections and risks

Row 4/5 and row 5/8 splits are judgment only; nothing ties a renunciation source to this claim but its label; whether
correcting a unanimous item's rule ids counts as a jury miss is undefined.

## Not verified

Browser; desk end-to-end; how judges fill rules_applied (no model called); R1/R3 read not probed; some prompts only
grepped; migration script provenance.

## Coordinator's decision

- Finding 1 → the founder (board).
- F: summaries state only what cited evidence shows; where the reversal is not cited (rows 2, 4, 7) the summary does
  not mention it (principle 2).
- G: when a cutter stops on row 8, the statement goes to the link inbox as a new candidate claim for queue A.
- D: a promise made again after a reversal is a new claim (row added). E: deferred until a non-person subject is
  recorded; noted in the standard.
- 4: use « sur laquelle son auteur est explicitement et publiquement revenu », « prévision », « formulée avec réserve »
  (designer and reviewer agree; the founder may override).
- 2, 3, 5 (except the verdict-to-rule fit check, left to the founder at the desk), B, C → the same developer, with the
  designer's rules-line spec. Then the same reviewer re-checks.

# Re-check (same day): SEND BACK, one small item

Findings 2–5 and gaps B–G fixed and held; migration step 2 verified (user_version 12, 22 objects identical, integrity
ok, 38 sources identical, counter 43, backup hashes match).

- **R1 Medium.** Row 4 after the deadline: table and judge step 2e say "do not cite the reversal"; the program voids
  a not_came_true that doesn't cite the earliest reversal. Coordinator: cite it in that branch.
- **R2 Medium-low.** The deadline re-check clears on any newer round, even one judged before the deadline. Needed:
  the clearing round's judge-input date is after the deadline.
- **R3 Medium-low.** EA-1 not required on an early came_true (its line is the only public "provisional" wording);
  nothing on the site marks an overdue re-check (→ designer); the item only returns if its pack is on disk.
- **R4 Low.** confirm() accepts any kept version, not only the current one.

Developer's risks judged: EA-1 keeping its id accepted once (ledger empty; only safe with R4 closed; not to be
repeated after the first confirmation); judge-0.8 / pack-0.3 not bumped accepted (unreleased); schema comments saying
0.6 accepted until the next format change; date-dependent desk test accepted.

Objections and risks: every early came_true is now a debt — judged again after its deadline with a new pack and round;
for a five-year term, years of open items, listed only by the desk's pack scan. The row-8 inbox step is manual.
Still standing: the ledger sees only cited evidence; a renunciation is what its label says; rows 4/5 and 5/8 are
judgment; the migration route for a non-empty ledger is not designed.

Coordinator: R1 (cite), R2, R3 (EA-1 check), R4 → developer; overdue re-check marker → designer; the founder is told
that an early came_true costs two confirmations.

# Final re-check (same day): PASS

R1–R4 fixed; nothing broken (12 new ledger probes; live database at user_version 12, schema identical, sources
identical, integrity ok). Follow-ups, not blocking: the vote check doesn't require EA-1 while the ledger does (add to
the shared rules and judge step 5 with the next prompt version); R2 uses the pack's current judge-input date, not one
stored with each round (store it in the round line when it closes); comments in src/rules.js 162 and src/desk.js 839
still say 0.7. Accepted: judge-0.8 keeps its name (no vote exists); three standard versions in one day with the same
EA-1 id, acceptable only because the ledger is empty and confirm() takes the current version alone.
