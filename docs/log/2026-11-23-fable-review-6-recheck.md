# Fable 5.2 review 6, re-check: pack-0.2 and judge-0.7 (2026-11-23)

Saved by the coordinator, condensed, every finding kept. `npm test` 310/310; probes in memory only.

## Result

- **Part 1, pack-0.2 and checkPack: PASS**, with follow-ups R1–R3. A1–A10 closed (A1 in the prompt; A2 with the
  stated residual; A3–A10 closed).
- **Part 2, judge-0.7: SEND BACK, narrow.** B1 (pending the founder), B2, B5, B7 closed; B3, B4, B6 closed in the
  prompt with N1 and N2 below.

## Part 1 follow-ups

- **R1 Medium.** A given renunciation can be parked in `considered_not_used` with `text: null` ("pack OK"; a unanimous
  pending then passes), or listed undated (every judge dead-ends). checkPack should, for a promise, refuse a given
  renunciation that is undated, dated before said_on, or not in `sources`.
- **R2 Medium-low.** A given official source parked with `text: null` is nearly invisible at the desk (only in the
  collapsed "considered, not used"). List every uncited given evidence source with its `why`, in the open.
- **R3 Low.** "raccordables fin 2025." cut from "non-raccordables" passes with only a flag; a hyphen between letters is
  inside a word → refuse.
- Developer's residuals judged: header not tamper-proof (accepted; the prompt notes' "need not be taken on trust"
  overclaims — correct it); the stamped session is not a control (the same-session refusal can never fire; say in
  judge.md that Claude's independence is on the honour system until the isolated Claude judge is wired); boundary
  flags acceptable while the founder confirms everything, must block automatic approval; A7 strictness accepted; trial
  packs failing expected. Low: `before_reading` of "." passes; source order by id follows archiving order.

## Part 2

- **N1 Medium-high.** 2d's new "no figure at the date → to_evaluate" applied at a renunciation date makes "partly"
  almost unreachable (no statistic is dated on the day of a speech), contradicting decision 0013 and pack rule 4c.
  Needed: one sentence on which figure counts at a renunciation date (e.g. the latest dated on or before it).
- **N2 Medium, escalated.** The program still accepts not_came_true resting only on a renunciation made after the
  deadline (`renunciationCounts`, schema mirror), while judge-0.7 2e and source-rule 0.5 say it changes nothing.
  Closing it needs a date condition in rules.js and the schema. Until then the desk should not confirm such a verdict.
- B3 dead ends: fail closed; a "signal" to_evaluate on a mislabelled renunciation must not be published as an
  ordinary to_evaluate (desk not tested).

## Objections and risks

- Principle 4: the renunciation rule was fixed in eight places and N1/N2 are in it again. Before the next edit, write
  its truth table once (date vs claim, deadline, today; cited or not; alone or not; verdict) and derive prompt,
  rules.js and schema from it.
- Votes under judge-0.7 are provisional (B1 pending, N1): not for the 10/30/100 count.
- The program catches a careless cutter, not one who edits the header or parks a relevant source with a plausible
  `why`. A non-Anthropic reader of the full sources remains the condition for automatic approval.

## Coordinator's decision

- Commit Part 1 (code, pack-0.2, method-document drift fixes). judge-prompt 0.7 stays uncommitted.
- N2 is not a new founder decision: the written rules (decision 0008's exception "before the deadline", source-rule
  0.5, judge-0.7 2e) already say a renunciation after the deadline changes nothing; the program is made to match.
- Third time the renunciation rule needs a fix → step back as the reviewer and the retrospective say: one truth table
  first, then prompt, rules.js and schema derived from it, inside the record-format-12 brief (decision 0014 rule ids).
  N1, N2, R1–R3 and the two note corrections go into that same brief.
