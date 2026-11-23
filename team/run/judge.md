# Run group · jury member

Version 0.6 (2026-11-23). Cut to role and boundaries after Fable review 1 (finding 14): the judging rules live in one
place only, the prompt `team/run/judge-prompt.md` (judge-0.5), so they cannot drift apart again.
Earlier versions (0.1–0.5, in Chinese) repeated the rules here; see the history in the prompt's notes.

## Role

Give an independent first verdict on one claim (promise or prediction). A jury member cannot see the other members'
verdicts and must not adjust its own to guess at them. The program (`src/jury.js`) puts the eight principles of
`PRINCIPLES.md` (not the status table) before the prompt as the system text.

## Input

The judge input `<name>.judge-input.md`, made by `node src/jury.js judge-input <name>.pack.json` (or by the `vote` step).
It holds the principles, the prompt, today's date and the evidence pack as judges see it (`judgeView` in `src/pack.js`):
the claim (quote, the speaker's role but not their name, origin, type, verifiability, deadline, criteria), the
sources' metadata, and the excerpts. Judges do **not** see the pack's "considered but not used" list, its `gaps` note,
or who cut the pack.

## Output

Six possible verdicts. The answer fields, as the prompt's "Answer format" gives them:

| field | content |
| --- | --- |
| `verdict` | `unverifiable`, `pending`, `to_evaluate`, `came_true`, `partly_came_true` or `not_came_true` |
| `evidence` | list of `{ source_id, excerpt, locator, pdf_page }`, each excerpt verbatim from one excerpt of the pack |
| `reasoning` | at most three sentences, English |
| `open_question_fr`, `open_question_en` | for `to_evaluate`; otherwise `null` |
| `summary_fr`, `summary_en` | for every verdict, `pending` included |

The vote file around the answer (`kind`, `pack_sha256`, `promptVersion`, `system_sha256`, `provider`, `channel`, `model`, …)
is described in `team/run/judge-subscription.md` and written by the program for the judges it calls itself.

## What the program checks

`src/pack.js` `checkVote` and `voteProblems`: the six values; deadline rules (the deadline day is inside the deadline;
the date checked is the "made" date of the judge input, not a date the judge writes); vague or hedged claims only
`unverifiable`; summaries and open questions; the evidence rule (one official kind, or two independent publishers;
renunciation only for `not_came_true` on a promise); every quote verbatim inside one excerpt; for law texts, the
locator names the article; the vote is bound to the pack (`pack_sha256`), the prompt version and the system text
(`system_sha256`). A vote that fails any check is void and is not counted.

What the program cannot check is left to the other judges, the neutrality review and the founder: whether a passage
positively shows the outcome (silence is not evidence), whether an `official` document only assesses its own work,
and whether a partial result is a result on the measure.

## Must not

- Cite anyone's statement as evidence, including the speaker's own. The only exception is the speaker's own public
  renunciation of a promise, for `not_came_true` on that promise.
- Invent or alter evidence text.
- Adjust a verdict to guess what other members will say.
