# Step-back: the review desk's handling of new votes, not solved after two attempts

Written when the same problem has been changed twice without being solved (CLAUDE.md, principle 4).
The founder confirms before the code is touched again.

- Date: 2026-11-23
- Author: coordinator

## 1. The problem and what was tried

The desk must know which set of judge votes a verdict is based on, and must react correctly when votes change.

- **Attempt 1 (desk as first built):** the desk looked at whatever vote files existed. Fable review 2 found that after a
  second jury run the desk published the *old* verdict while showing the new one, and that a published item never came
  back when new votes arrived.
- **Attempt 2 (coordinator decision 9):** "a round = one pack + its set of vote files, recorded the first time the desk
  sees it; verdicts tied to a round". The re-check found that this records a round while votes are still arriving
  (vote 1 → round 1, votes 1–2 → round 2, …), and freezes all of them into the public ledger (six jury rows for three
  votes). Removing a stray vote file makes the item disappear from the queue. Same root: the desk guesses when a set of
  votes is complete.

Nothing wrong has been published (the database is still empty of publications); the desk is not in use yet.

## 2. The assumption that failed

We assumed the desk could infer a round from the files on disk. It can't: votes from different judges arrive at different
times, and the desk scans on every page load. Only the step that runs the jury knows when a round is complete.

## 3. Three ways

- **Change the implementation (recommended):** the jury runner (`node src/jury.js tally`) closes a round explicitly — it
  writes a small, append-only round file (pack sha256, the list of vote files with their sha256, time, "complete").
  The desk ingests only closed rounds, never infers one from loose files, and ignores files that belong to no closed round.
  A vote that arrives later goes into the next closed round. This moves one responsibility to the place that has the facts;
  the desk gets simpler, not more complex.
- **Change the route:** the desk stops recording rounds at all; the jury runner writes `jury_votes` itself when it closes a
  round, and the desk only reads. Cleaner separation, but the runner then writes to the database (today only the desk and
  ledger do) — one more writer to review.
- **Don't do it:** keep one round per claim and refuse any re-vote. Loses "pending now, re-judged at the deadline",
  which the founder's rules need.

## 4. Recommendation

The first way. While doing it, also fix the four smaller re-check findings (C: a sent-back vague item never returns;
D: the cached view ignores corrected subject/source rows; E: the PDF-opened mark is written before the file is served;
F: small items). Then the same Fable reviewer re-checks once.

## Founder's decision

2026-11-23 10:26 (board): "Fix it as recommended". The developer implements closed rounds plus C–F; the same Fable
reviewer re-checks once afterwards.
