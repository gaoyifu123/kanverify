# Run group · jury member

Version 0.8 (2026-11-23). Cut to role and boundaries after Fable review 1 (finding 14). The verdict rules live in one
place, `docs/methodology/verdict-standard.md` (0.8, each rule with an id); the prompt `team/run/judge-prompt.md`
(judge-0.8) is derived from it and names the version it is written for.
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
its `header`, `before_reading`, `read` or `transcription_doubts`, or who cut the pack.

## Output

Six possible verdicts. The answer fields, as the prompt's "Answer format" gives them:

| field | content |
| --- | --- |
| `verdict` | `unverifiable`, `pending`, `to_evaluate`, `came_true`, `partly_came_true` or `not_came_true` |
| `evidence` | list of `{ source_id, excerpt, locator, pdf_page }`, each excerpt verbatim from one excerpt of the pack |
| `rules_applied` | the ids of the rules that decided the verdict, from the verdict standard (e.g. `["DL-2", "EV-1"]`; decision 0014) |
| `reasoning` | at most three sentences, English |
| `open_question_fr`, `open_question_en` | for `to_evaluate`; otherwise `null` |
| `summary_fr`, `summary_en` | for every verdict, `pending` included |

The vote file around the answer (`kind`, `pack_sha256`, `promptVersion`, `system_sha256`, `provider`, `channel`, `model`, …)
is described in `team/run/judge-subscription.md` and written by the program for the judges it calls itself.

## What the program checks

`src/pack.js` `checkVote` and `voteProblems`, with `src/rules.js`, each message naming its rule id: the six values;
deadline rules (DL-1, DL-3, DL-4, EA-1; the date checked is the "made" date of the judge input, not a date the judge
writes); vague or hedged claims only `unverifiable` (VG-1); summaries and open questions; the evidence rule (EV-1,
EV-2); RN-1 from its truth table: a renunciation is cited only under `not_came_true` on a measurable promise, dated
between the day it was made and its deadline, and once such a one is in the pack only `came_true` or `not_came_true`
citing it is accepted; `rules_applied` lists distinct ids of the current verdict standard (VG-1 on a vague or hedged
claim, RN-1 when a reversal decided it), and the judge prompt must name that standard's version, or no vote counts;
no cited document dated after the judge input's date; every quote verbatim inside one excerpt; for
law texts, the locator names the article; the vote is bound to the pack (`pack_sha256`), the prompt version and the
system text (`system_sha256`); the pack names the session the program stamped when it was started, and a vote from
that session is refused. A vote that fails any check is void and is not counted.

What the program cannot check is left to the other judges, the neutrality review and the founder: whether a passage
positively shows the outcome (silence is not evidence), whether an `official` document only assesses its own work,
whether a partial result is a result on the measure, whether a statement is an explicit, precise reversal of the same
promise (RN-1 rows 5, 8), and whether the right rule ids are named (the founder sees and corrects them at the desk).

## Independence of the Claude judge (honest note, Fable review 6 re-check)

The program refuses a vote from the session that cut the pack only when the vote names that session
(`made_by.session`). A Claude Code subagent writes that field itself, and the pack's session id is in a file it could
read, so for the Claude subscription judge this check cannot actually fire: its independence from the cutter is on the
honour system (a fresh subagent per vote, given only the judge input, team/run/judge-subscription.md). It becomes a
real check when the isolated Claude command-line judge (`src/ai/claude-cli.js`, like `codex-cli.js`; decision 0013) is
wired, which runs from an empty folder and records its own session. Until then the desk says so only when a Claude
vote names no session; a vote that names one is not thereby shown to be independent.

## Must not

- Cite anyone's statement as evidence, including the speaker's own. The only exception is the speaker's own public
  public reversal of a promise, cited as the prompt's step 2e says (RN-1).
- Invent or alter evidence text.
- Adjust a verdict to guess what other members will say.
