# Retrospective: why simple mechanisms took so many rounds (2026-11-23)

Asked by the founder: "复盘一下，为什么简单的机制需要这么多轮". Written by the coordinator, who caused most of it.

## What happened

| Mechanism | Rounds | What each round found |
| --- | --- | --- |
| Desk: which judge votes a verdict rests on | 3 builds, 3 Fable reviews | 1: desk guessed from files → old verdict published. 2 (my decision 9, a patch): still guessing → duplicate jury rows. 3 (after step-back): the jury step closes rounds; passed. |
| Renunciation "ends the wait" (founder's rule this morning) | judge prompt 0.6 + code part 2 + format 11 + fixes + re-check; prompt still being fixed | The rule lives in ~9 places (schema, rules.js, pack.js, ledger, desk, judge prompt, pack prompt, source rule, evidence prompt, verdict standard). Each round found the next place that disagreed. |
| Early "came true" for one-off results | 1 board answer, then sent back | My own wording on the board contradicted itself ("a law passed counts" / "anything repealable waits"). |
| Evidence-pack rules | 1 draft, sent back | Rules on the honour system that the program should check. |

## Causes (most important first)

1. **I patched instead of stepping back.** The desk's first failure was a design flaw (the wrong component deciding when votes are complete). I answered it with a rule on top (decision 9) instead of asking where that knowledge lives. The circuit breaker only fired after the second failure, as written; for a design-level finding it should fire at the first.
2. **I recommended the more complex option without saying what it costs.** "A renunciation ends the wait; judge on what was done" was my recommendation. The simpler option ("renunciation = did not come true") needed almost no code. The board question did not say that one option meant a record-format change and three reviews. The founder chose without the price (principle 5, principle 6: I should have said it).
3. **One rule, many homes.** Verdict rules are written in prose (prompts, methodology), in SQL and in JavaScript, separately. A rule change done piece by piece is found piece by piece by the reviewer. I briefed it in pieces: prompt text by me, code by the developer, ledger "later".
4. **I wrote rule text myself, fast, and it went straight to review.** judge-0.6 and decision 0013's wording were mine; the contradictions Fable found were mine. Doing and checking were separated for code but not for the rule text I wrote.
5. **The bar is genuinely high** (public, append-only record; independent judges; nothing unconfirmed). Some rounds are the price of that and are worth it: the desk would have put wrong jury rows into the permanent public record. But that explains perhaps a third of the rounds, not all.

## What changes from now

- **Cost in every board question.** Each option says what it costs in code/review ("no code" / "record-format change + review"). Before launch, the default recommendation is the option with less machinery; rare edge cases get the simple rule and a note, and are revisited after launch.
- **Step back at the first design-level finding**, not the second. A finding that says "this component cannot know X" means stop and move the responsibility, never add a rule.
- **A rule change is one brief:** where the rule lives (list every place), the data model first, then code, then prompts and docs — one developer, one review.
- **I don't draft rule text that goes to review.** The developer or designer drafts; I check against the founder's decision.

## Proposed to the founder (board)

Freeze the verdict rules until launch: no new edge-case rules before 5 December unless a real claim needs one. The ones already built stay.
