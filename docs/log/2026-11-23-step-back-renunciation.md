# Step-back: the renunciation rule, fixed three times and still not consistent

Written under the circuit breaker (CLAUDE.md, principle 4). The founder confirms before the code is touched again.

- Date: 2026-11-23
- Author: coordinator

## 1. The problem and what was tried

The founder's rule (decision 0013): a public renunciation of a promise ends the wait; the promise is then judged on
what was done. It had to be added to a program and prompts built for "a renunciation is evidence for did not come true".

- **Attempt 1:** judge-0.6 text and a code change in rules.js / pack.js / ledger.js. Review: the ledger could not
  publish "partly came true" after a renunciation (needs the database format).
- **Attempt 2:** record format 11 (renunciation admitted beside other evidence) plus fixes after review 7. Passed, with
  the warning: "if a third fix is needed in this area, the circuit breaker applies".
- **Attempt 3:** judge-0.7. Review 6 re-check: two new gaps — N1, which figure counts at a renunciation date (as
  written, "partly" is almost unreachable); N2, the program accepts a renunciation made after the deadline as the only
  evidence, while the written rules say it changes nothing.

## 2. The assumption that failed

That the rule could be added place by place. It lives in about nine places (schema, rules.js, pack.js, ledger, desk,
judge prompt, pack prompt, source rule, verdict standard), each written separately; every pass finds the next place
that disagrees.

## 3. Three ways

- **Change the method (recommended):** write the rule once as a truth table — renunciation date against the claim,
  the deadline and today; cited or not; alone or not; which verdicts it allows and which figure counts — reviewed on
  its own first. Then derive rules.js, the schema check, the judge prompt and the pack prompt from that one table, in
  the same brief as record format 12 (decision 0014 gives each rule an id, so the table becomes rule RN-1 with its
  cases). One developer, one Fable review.
- **Simplify the rule:** a renunciation before the deadline makes the promise "did not come true", full stop (the
  option the founder did not pick this morning). Almost no code; loses "partly came true after giving up".
- **Don't do it now:** leave renounced promises to the deadline until after launch. Loses the founder's rule for now.

## 4. Recommendation

The first way. Meanwhile, no jury run on a renounced promise and no confirmation of a verdict that rests on a
renunciation (the desk shows them, the founder holds them). Work that does not touch the rule continues (site display
of the design spec, transcription, desk browser test).

## Founder's decision

2026-11-23 16:40 (board): "Simplify: giving up = did not come true". See decision 0013, amendment. The rule is rebuilt once, from one truth table, in record format 12.
