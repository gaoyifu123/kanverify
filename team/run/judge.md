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

The vote file around the answer (`kind`, `pack_sha256`, `promptVersion`, `system_sha256`, `provider`, `channel`, `via`,
`model`, `model_requested`, `created_at`, `usage`, …) is written by the program (`askVote` in `src/jury.js`) for every judge:
Codex and Claude through their command-line tools under the founder's subscriptions, Gemini through its API. The Claude
vote also carries `made_by.session`, the session id its command-line run reported.

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

## Independence of the Claude judge (2026-11-23)

The Claude subscription judge is run by the program like Codex (`src/ai/claude-cli.js`, decision 0013): a new
`claude -p` process per vote, started in an empty temporary folder, with no tools at all (no file reading, no shell, no
web), no MCP servers, skills, hooks, plugins, CLAUDE.md or settings files, an allowlist of environment variables, and
the same system text and prompt as every other judge. It cannot see the project, the pack file, the cutter's session or
another judge's vote; it is not the session that cut the pack, because the program starts it. A reply is refused unless
the tool reports one turn, no permission denials, success, and the model that answered. The program writes its vote
file and records the tool's version, the fixed identity sentence Claude Code puts before our system text
(`raw.system_prefix`, "You are a Claude agent, built on Anthropic's Claude Agent SDK."; `system_sha256` covers only our text), the session id the tool reported (`made_by.session`) and those run facts (`raw`).

What this does **not** prove: vote files are not signed. Anyone (or any agent) that can write in the pack folder can
write a file that names a session and looks like a command-line vote. A named session shows how the program made a
vote, not that a file on disk was made that way; the desk says so. Before a member votes again, the program moves its
earlier vote file aside (`<name>.superseded-<time>.vote-<provider>-<channel>.json`, which no step reads as a vote), so a
failed call cannot leave an old vote counting.

Until 2026-11-23 the Claude vote was written by a fresh subagent (`team/run/judge-subscription.md`, now superseded),
whose independence was on the honour system. Votes made that way name no session or a session the subagent wrote
itself; the desk says so when a Claude vote names none. Such votes are not re-checked after the fact: re-vote the pack
with the command-line judge where it matters.

## Must not

- Cite anyone's statement as evidence, including the speaker's own. The only exception is the speaker's own public
  public reversal of a promise, cited as the prompt's step 2e says (RN-1).
- Invent or alter evidence text.
- Adjust a verdict to guess what other members will say.
