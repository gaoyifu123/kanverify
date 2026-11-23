# 0013. Verdict rules after Fable review 1, calibration count, launch scope, judge file access

- Date: 2026-11-23
- Decided by: the founder, on the board (answers stored under the item ids below)
- Recorded by: coordinator

## Decisions

| Board item | Founder's choice | Rule from now on | Principle |
| --- | --- | --- | --- |
| `state-at-deadline` | At the deadline | The verdict judges the state **at the deadline**. What happened after it is mentioned in the summary and does not change the verdict. | 3 (one ruler: one moment for everyone) |
| `renunciation-order` | Ends the wait only | A public, explicit renunciation of a promise **ends the wait**: the claim is then judged as if its deadline had passed on the renunciation's date, on what was actually done. Partial result shown by evidence → `partly_came_true`; no result → `not_came_true` (the renunciation is enough evidence for that); criteria fully met → `came_true`. | 3, 2 |
| `early-revertible` | Only for one-off results | Early `came_true` only for a result that is done once done (a law passed, a facility built). If the criteria name a level at a date, or the measure can be repealed or undone, wait for the deadline. | 3 |
| `vague-renounced` | A: stays unverifiable | A `vague` or `hedged` promise stays `unverifiable` even after an explicit renunciation; the renunciation is mentioned in the summary. | 3 (one rule) |
| `calibration-count` | Use the stricter count | The 10/30/100 test (decision 0003) counts only measurable items with a real outcome; on those the desk hides the jury votes until the founder has picked a verdict; a send-back or a rewritten summary on a unanimous item counts as a jury miss; on 1 item in 5 the founder opens the original document. | 7, 6 |
| `judge-file-access` | Accept with the guards | Judges keep running on this computer with the reply guard (`src/ai/secrets.js`) and founder confirmation before anything is published. Revisit before reader submissions open. | 8 |
| `principles-en` | Approve this English text | PRINCIPLES.md starts with the English text; the Chinese original stays underneath. Judges receive the English text only (the cut at the first `##`). | — |
| `launch-scope` | Publish more verdicts | See below. | 1, 2 |
| `claude-cli` | Check the terms and install | The coordinator checks the terms of using the Claude Code command line with the founder's subscription for the isolated Claude judge, then installs it if they allow it. | 8 |

Founder's note on the board (2026-11-23): "Unverifiable ones are important too. It gives a lot of info on credibility
of person." → `unverifiable` items are published at launch like any other verdict, with the reason the wording cannot
be checked. They are cheap to confirm (no evidence search), so they add to the published verdicts directly.

## Launch scope, as the coordinator reads "Publish more verdicts"

- Every recorded promise is published with its source.
- Verdicts are published wherever the full chain exists: evidence pack, jury, founder's confirmation at the desk.
  That includes all `unverifiable` items (wording only) and as many outcome verdicts as can be checked before
  5 December, not a cap of 20–40.
- An item nobody has searched evidence for is shown as "not yet checked", not as `pending`: `pending` would say we
  looked. This is a display label on the site, not a verdict, and it is not stored in the ledger.

## Objections and risks

- **More verdicts means more of the founder's time at the desk.** Every outcome verdict still needs his confirmation
  (CLAUDE.md: no unconfirmed conclusions). With the stricter calibration count the first measurable items are slower.
  The desk shows a running count so he can decide when to stop.
- **"Not yet checked" is the coordinator's reading,** not an answer the founder gave. If he wants unchecked items to
  read `pending`, say so on the board; the coordinator's view is that it would mislead (principle 2).
- **Rule changes reach the judges only through a new prompt version (judge-0.6).** Votes under judge-0.5 and earlier
  are not comparable and the 10 trial claims are re-voted anyway. judge-0.6 is a small change to a reviewed prompt;
  the same Fable reviewer re-checks only the changed steps.

## Claude command line: terms checked, installed (2026-11-23)

- Checked: Anthropic documents `claude -p` (non-interactive) for scripts on one's own plan; plan limits assume ordinary
  individual use; what is forbidden is routing other people's requests through a plan's credentials
  (code.claude.com/docs/en/headless, code.claude.com/docs/en/legal-and-compliance,
  support.claude.com/en/articles/11145838). Our use, the founder's own judge votes on his own computer at a few hundred
  calls, fits. If the site ever lets readers trigger a vote, this no longer fits: that path must use the API.
- Installed: `@anthropic-ai/claude-code` 2.1.330 (npm, global). The founder signs in once himself (`claude`, then
  follow the login); the coordinator never handles the login. Wiring the isolated Claude judge (`src/ai/claude-cli.js`,
  like `codex-cli.js`) comes after the desk fix, as one writer at a time.

## Amendment (2026-11-23 afternoon, founder on the board): simpler rules

| Board item | Founder's choice | Rule from now on |
| --- | --- | --- |
| `stepback-renunciation` | Simplify: giving up = did not come true | A public, explicit renunciation of a promise, dated on or after the day it was made and on or before its deadline, makes the verdict `not_came_true`, whatever was done in part. It may be the only evidence. A renunciation after the deadline changes nothing (the state at the deadline counts). Replaces "ends the wait only". |
| `renounced-then-delivered` | The renunciation verdict stays | A promise delivered after it was renounced stays `not_came_true`; the delivery is mentioned in the summary. |
| `early-act-state` | "achieved once = achieved" | Early `came_true` whenever the evidence shows the criteria fully met before the deadline, whether the result could later be undone or not. Replaces "only for one-off results". |

Unchanged: a vague or hedged promise stays `unverifiable` even when renounced; the state at the deadline counts.
One case follows from "achieved once = achieved" and goes into the truth table for review: criteria fully met before
the renunciation → `came_true`.

Consequence (coordinator): record format 11's widening (a renunciation beside other evidence under partly / came_true /
to_evaluate / unverifiable) and the site's "the wait ends here" display are no longer needed and are removed in record
format 12, the same change that puts decision 0014 into effect (rules recorded with each verdict; 0014 stays in force). The step-back
(docs/log/2026-11-23-step-back-renunciation.md) is closed by this choice.

Correction (2026-11-23 evening): the coordinator's install ran inside its sandbox and never reached the real system.
The founder installed `@anthropic-ai/claude-code` 2.1.330 himself (`npm install -g --allow-scripts=...`) and signed in
with his subscription; checked in his terminal: `claude -p` answers. Lesson: installs and anything that must persist
outside the project are checked in the founder's own terminal, not from the coordinator's shell.
