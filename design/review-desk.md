# Review desk (local) — design spec

- Role: designer. Date: 2026-11-22. Status: first draft, for the coordinator and the founder before it
  goes to the developer. Revised the same day after the coordinator's changes: candidates without flags
  are accepted automatically and only flagged ones go to queue A; queue B gains "Reject the item".
  Translated into English the same day (the project's working language is now English).
- Mockup: `design/mockups/desk.html` (fictional data; both queues and the main states on one page,
  read top to bottom).
- Based on: `PRINCIPLES.md` (principle 7 above all), `design/DESIGN.md`, `tokens.md`, decisions 0005,
  0008, 0010, `src/pack.js`, `src/ledger.js`, `db/schema.sql`.

## 1. What it is, and what it is not

A local page that runs only on the founder's own computer (listening on `127.0.0.1` only) and does the
two things a machine cannot do:

| Queue | The question the page answers | Target time per item |
| --- | --- | --- |
| A Candidates (flagged ones only) | "What do I do about the doubt this review flagged?" | under 10 seconds for a simple one |
| B Verdicts (every item passes here) | "Is this a promise or prediction we should record? Can its verdict and evidence be published under my name?" | no target, only measured (§6) |

**Automatic acceptance (coordinator's change, 2026-11-22, principle 7).** A candidate whose quote was
verified word for word (`verbatim: true`, same page), whose review raised no flag, and whose fields pass
the database rules is written straight into the workspace `claims` by the program, without the desk; the
desk log records an `auto_accept` line. Today about 90 of about 444 candidates carry a flag; only those
go to queue A. The others are not unseen: every one of them reaches the founder in verdict queue B, where
he sees the quote and can reject the item itself (§5.3 `X`). So "accepted" means "in the workspace";
"published" always requires confirmation in B.

A candidate goes to queue A if any of these holds: the review `status` is `duplicate` or
`possible_duplicate`; it has a `not_a_promise` or `continuation` flag; it has `proposed_fixes`;
`needs_founder: true`; the verbatim check failed; a field fails the database rules (e.g. measurable
without criteria); the source is not linked to a speaker. A `consistency_note` alone (for information
only) does not send it to the queue.

It is not the website and is never public. **The interface is in English.** Quotes and evidence stay in
their original language (with `lang`), and **no translation is shown for French or English text**: the
founder reads both. For a quote in a third language, the French and English translations are shown
under it. No search, filters, charts or multi-user features.

## 2. Visual

Same system as the site: the variables in `kanverify.css`, palette B, the verdict chip (`.verdict`:
pattern + hue + label), `.quote` (serif: their words), `.meta`. Two sizes, two weights, nothing new.
Laptop screens (1366 × 768 and up): two columns above 1024 px; one column below, still usable. Light
and dark follow the system.

Desk-only elements: key caps `kbd`, the fixed action bar at the bottom, a one-line toast at the top, and
the publication warning box (2 px ink border, never red). "Did not come true" and "Came true" look the
same here too, with no warning colour (principle 3).

## 3. Top line (shared by both queues)

`KANVERIFY review desk | Candidates · N left | Verdicts · N left | Today: auto-accepted k · accepted a · rejected r · confirmed c · rejected items x · human time m min (candidates avg x s, verdicts avg y s)`

"Auto-accepted" comes first so the founder sees every day how many items entered the workspace without
him.

- "Today" follows the local date and resets at midnight. Sources of the numbers: §7.
- Counts only: no progress bars, no target lines, no streaks.

## 4. Queue A: candidates

### 4.1 One screen (top to bottom = reading order)

Left column:
1. **Review flags** (from `flags`, `status`, `proposed_fixes` in `review-*.json`), only when present:
   - duplicate / possible duplicate: the other candidate's id, page and quote, so no lookup is needed;
   - not a promise (high / low): the reason, verbatim;
   - "continue / poursuivre" type: "needs a baseline";
   - proposed fix: `field old → new` + the reason verbatim + "Press F to apply and accept". Fixes with
     `needs_founder: true` are shown the same way and are not pre-applied;
   - consistency note: one grey line (alone it does not queue the item; shown only next to other flags).
2. **The quote** (serif, original language) + page / § + the program's check ("Verbatim match (p. 9)",
   or a failed check, see 4.4).
3. **Translation**: none for French or English quotes. A quote in a third language shows its French and
   English translations, labelled.
4. **Fields**: speaker and role, type, topic, verifiability, deadline and basis (stated / inferred),
   criteria FR, criteria EN. Codes are always shown by their English label (§9), never raw like
   `foreign_affairs`.

Right column: **the source page** (PDFs: the archived transcription `source-<id>-text.json`; web pages:
paragraphs; legal texts: articles). The candidate's quote is marked with `<mark>` and scrolled into view;
Space scrolls the right column; `O` opens the local archived original in the system viewer.

Title line: `Candidate n / N` (position within the source) + source name + total left + timer for this
item.

### 4.2 Order

By source, then by the candidate's order in the source (`index`). Candidates from the same page follow
each other, so the right column does not change page: fastest. Skipped items go to the end of the queue.

### 4.3 Actions and keys

| Key | Action | What is written |
| --- | --- | --- |
| `A` | Accept | Inserts a row in workspace `claims` (field mapping in 4.5); appends an `accept` line to the desk log |
| `F` | Apply the proposed fixes and accept (only when there are fixes) | As above, after applying the fixes; the log says which fixes were applied |
| `E` | Edit, then accept | Opens the field form: `Tab` through fields, `Ctrl+Enter` save and accept, `Esc` discard. On save the program re-checks the quote (4.4) and the database rules (measurable needs criteria; a deadline needs a basis); if they fail it stays in the form and says which field and why |
| `R` | Reject | Reason panel: `1` duplicate (pre-selected when there is a duplicate flag, with the other id) `2` not a promise or prediction `3` the quote is wrong `4` other (one sentence required); `Enter` done, `Esc` cancel. Nothing is written to the database; appends a `reject` line to the log |
| `S` | Skip | Appends a `skip` line; the item moves to the end |
| `Z` | Undo the last action; press again to go further back (only actions since the page was opened) | Accept: deletes the `claims` row just inserted (only if nothing changed it since and it has no verdict; otherwise "This item has later changes; edit it in the workspace"). Reject and skip: appends an `undo` line pointing to the undone line. Returns to that item |
| `Q` | Switch to the verdict queue | — |
| `?` | Keyboard shortcuts | — |

After each action the next item shows at once; the toast says "Accepted s4-26 → workspace item #212.
Z to undo" until the next action. Buttons and keys are equivalent; keys work only when focus is not in
a text field.

### 4.4 When an item cannot be accepted (`A` and `F` disabled, dashed buttons, reason under the quote)

- The program cannot find the quote word for word in the source (`verbatim: false`), or finds it on a
  different page than the candidate states. Only `E` (fix and re-check) or `R` (reason 3).
- The source or its transcription is missing or its hash does not match (`sourceUnits` returns
  `error`): the right column shows the error verbatim; only `S`.
- Measurable without criteria: only `E`.
- The source is not linked to a speaker yet (see 4.5): every candidate from that source is disabled;
  the top line says so.

### 4.5 Fields written to `claims` on accept

`subject_id` (the person linked to the source, see Objections 1), `speaker_role_fr/en`, `type`,
`domain`, `quote_original`, `lang`, `quote_fr`, `quote_en`, `said_on` = the source's `published_on`,
`source_id`, `source_locator` = the candidate's `locator`, `verifiability`, `deadline`,
`deadline_basis`, `criteria_fr`, `criteria_en`. Subjects are inserted without an explicit `id`
(decision 0005).

### 4.6 How 10 seconds is reached

Items without flags are already accepted, so every queued item has exactly one doubt: the doubt goes on
top, followed by what answers it. A possible duplicate shows the other quote inside the flag; a proposed
fix is one key, `F`. A simple item: read the flag, read the quote, press `F`, `A` or `R 1 Enter`. No
confirmation dialog; mistakes are undone with `Z`.

## 5. Queue B: verdicts

### 5.1 One screen

1. **Publication warning** (always shown, cannot be dismissed):
   "Confirm = publish. Once written to the ledger it cannot be changed or deleted, only withdrawn, and
   the withdrawal is public too. After C you have 5 seconds: Z cancels and nothing is written."
2. **The item**: speaker, role, origin (title, date, location), quote (original language; translations
   only for a third language, as in 4.1), type, topic, verifiability, deadline and basis, criteria
   FR/EN. The title line says how it entered the workspace: "Auto-accepted" or "Accepted from the
   candidate queue". For an auto-accepted item this is the first time a person sees it, so below the
   item there is a collapsed row "Source passage (P)": the archived paragraph containing the quote,
   marked with `<mark>`, the same component as queue A's right column. An item coming back for
   re-confirmation says "Unconfirmed changes" in its title line (`hasUnconfirmedChanges`) and lists the
   fields that differ from the last ledger snapshot.
3. **Evidence pack** (left): excerpts numbered `[1]…[n]`, each with the source kind (English label),
   title (serif), publisher, date, location, then the excerpt verbatim. Below, two collapsed rows:
   "Considered, not used: k (U)" and "Gaps" (`considered_not_used`, `gaps`; decision 0010 needs them
   visible for spot checks). The clipper and its model in one grey line.
4. **Jury votes** (right, side by side, one column each): number `1/2/3`, model (mono), channel
   (subscription / API), verdict chip, which excerpts it cites (click to jump to the excerpt), French
   summary, English summary (grey), and a collapsed "Reasoning (working notes, not published)". A vote
   that fails the program's check (`checkVote`) is still shown but marked "This vote failed the
   program's check: …" and does not count towards agreement.
5. **Agreement**: `3 : 0 agree` / `2 : 1 split` / `1 : 1 : 1 split`, followed by one plain sentence.
   Agreement is shown in words, never in colour.
6. **What will be published**: verdict chip + which vote is adopted + evidence numbers + summary FR/EN +
   the publication check (`publicationBlockers` empty: "All checks pass"; otherwise each reason, see
   5.4). Verdict and evidence on one screen, principle 2.

### 5.2 Order

Agreeing items that pass the checks first, split votes next, failing checks last; within a group, by
item id. Reason: clear the fastest first, and keep the ones that need thought together.

### 5.3 Actions and keys

| Key | Action | What is written |
| --- | --- | --- |
| `C` | Confirm and publish | First a 5-second wait (the next item is already shown; the toast says "Item #87 will be written to the ledger in 4 s. Z to cancel"); then `confirm(db, claimId, 'founder', { reviewSeconds })`, and the toast becomes "Written to the ledger, entry #1043 (81 s)". Disabled while checks fail |
| `1` `2` `3` | Adopt vote n | The workspace `verdicts` row takes that vote's verdict, summary FR/EN, and for To be assessed "What is missing" FR/EN, `decided_by = 'jury'`; `verdict_evidence` is replaced by the excerpts that vote cites (text and location from the pack). Pre-selection: see the coordinator's decision 7 below; when nothing is pre-selected, `C` stays disabled until a vote is chosen |
| `E` | Edit the summary | Form: summary FR, summary EN; for To be assessed also "What is missing" FR/EN; plus a verdict menu (six, fixed order). `Ctrl+Enter` saves to workspace `verdicts`, `Esc` discards. Text-only edits keep `decided_by`; changing the verdict sets `'human'`. The publication check runs again after saving |
| `B` | Send back | Panel: to whom — `1` evidence pack `2` jury again `3` the item itself `4` translation; one sentence (required). Nothing in the database; appends `send_back` to the log; the item leaves the queue until its pack or votes change |
| `X` | Reject the item (it should never have been recorded) | Panel: `1` not a promise or prediction `2` extraction error (quote cut wrongly, wrong page, wrongly split or merged) `3` duplicate of another item (give the id) `4` other (one sentence required); `Enter` done. Appends a `reject_claim` line **with the item's full workspace content (its `claims`, `verdicts`, `verdict_evidence`, `jury_votes` rows)**, then deletes the item from the workspace (with its verdict, evidence and votes; decision 0005 allows workspace deletion). Only for items never published; for published ones it is disabled with "Published items can only be withdrawn"; withdrawal is not done at the desk |
| `S` | Skip | Appends `skip`; to the end of the queue |
| `Z` | Undo | Reject: puts the item back into the workspace from the log (new id), appends `undo`. Within the 5 seconds: cancels the pending confirmation (nothing written). After the 5 seconds: a confirmation cannot be undone; "Written to the ledger; it can only be withdrawn in the workspace". Adopt and edit: restores the previous `verdicts` row |
| `U` | Show / hide "Considered, not used" | — |
| `P` | Show / hide "Source passage" | — |
| `Q` / `?` | Switch to candidates / keyboard shortcuts | — |

**Reject the item (`X`) versus send back (`B`):** send back means "this item belongs here, but the
evidence, the verdict or the translation must be redone"; reject means "these words should never have
come in". Reject reasons also test automatic acceptance: the share of `reject_claim` lines whose item
came from `auto_accept` is the share the review flags missed (Objection 10).

**Why confirm is `C`, not `A`:** after hundreds of `A` presses in the candidate queue the hand
remembers; publishing gets a different key so the hand does not press it by habit.

**Why a 5-second wait instead of a dialog:** after hundreds of dialogs people dismiss them unread; the
wait keeps the rhythm and still gives one chance to change one's mind. If the page closes within the
5 seconds, nothing is written (the safe direction).

### 5.4 When an item cannot be confirmed

The reasons returned by `publicationBlockers` are listed in its order, with this wording (the developer
uses this table):

| Check | Desk shows |
| --- | --- |
| has_subject | The person this item points to does not exist |
| origin_is_own_words | The origin is missing, or is not the person's own public words |
| has_verdict | No verdict yet |
| verdict_fits_verifiability | A vague or hedged item can only be "Unverifiable" |
| summary_stated | Every verdict except "Pending" needs a summary |
| outcome_has_evidence | This verdict needs one official document, or independent reports from two different publishers (a public renunciation counts only for "Did not come true" on a promise) |
| evidence_is_primary | The evidence includes a speech, a platform, a renunciation or a missing source; evidence must be official documents or independent reports |
| bilingual | A French or English version is missing: say which (quote, excerpt n, role, criteria, summary, what is missing) |

At the desk only the summary and the verdict can be fixed (`E`, `1–3`); everything else is `B` (send
back) or `S` (skip). If the evidence pack itself fails `checkPack`, the whole item is disabled, the
problems are listed verbatim, and the only action is send back (reason 1).

## 6. Timing (principle 7)

- Each item is timed from when it is shown until the action completes; the timer pauses when the page
  is not in front or after 120 seconds without keyboard or mouse activity (lunch is not counted).
- Verdict queue: seconds go into `publications.review_seconds` through `confirm()`; seconds for send
  back and skip go into the desk log.
- Candidate queue: seconds go into the desk log.
- **The timer is shown only in the candidate queue.** The verdict queue records it but does not show it:
  a stopwatch next to a verdict pushes people to press before reading.

## 7. Desk log (one new file, not a new table)

Candidate rejections, skips and send-backs have no place in the database (principle 5: what exists is
not enough, so something is added). The smallest addition is one append-only text file,
`data/desk/actions.jsonl`, one action per line:

`{"at":"2026-11-22T10:31:07+01:00","by":"founder|program","queue":"candidate","item":"s4-27","action":"auto_accept|accept|accept_with_fixes|reject|skip|send_back|reject_claim|confirm|undo","reason":1,"note":null,"claim_id":212,"publication_id":null,"fixes":["domain"],"edited":["criteria_en"],"seconds":7,"undoes":null,"removed":null}`

- `auto_accept` is written by the intake program (`by: "program"`, `seconds` empty); `reject_claim`
  stores the deleted workspace rows in `removed`, for undo and later review.
- The candidate queue uses it to know what is done (the last action not undone decides).
- "Today" numbers: auto-accepted, accepted, rejected and rejected items come from it; confirmed comes
  from `publications` (today, status published); human time is the sum of human seconds from both.
- The coordinator reads `send_back` lines and dispatches the work to the right role.
- Append-only like the ledger; an undo is another line.

## 8. Empty, error, loading

| Situation | Shows |
| --- | --- |
| Queue empty | "No verdicts waiting. Today: 7 confirmed, 2 sent back." / "All candidates done. Today: 86 accepted, 31 rejected." + how many are left in the other queue, `Q` to switch |
| Only skipped items left | "The 12 items left were all skipped." The first one shows as usual |
| Write failed (database locked, rule refused) | Stays on the item, does not move on; the top line gives the database's reason verbatim and "Nothing was written" |
| Write failed during the 5 seconds | Returns to that item and gives the reason |
| Source, transcription or pack file missing or hash mismatch | The matching column names the file and the problem; the item is disabled and can be skipped |
| Server not running | The browser cannot open the page; the terminal shows the start command (developer's choice) |

## 9. Labels for codes (desk)

The desk uses the site's English labels (`DESIGN.md`, "Fixed labels"): type Promise / Prediction;
verifiability Measurable / Vague / Hedged; deadline basis Stated / Inferred; verdicts Unverifiable,
Pending, To be assessed, Came true, Partly came true, Did not come true; topics and source kinds as in
the `DESIGN.md` tables (e.g. `foreign_affairs` → "Foreign and European affairs", `gazette` → "Official
gazette").

## 10. Security (for the developer and the critical review)

Listening on `127.0.0.1` is not enough: any website open in the founder's browser can send requests to
`localhost`. So write actions (above all confirm) must carry a token generated at start-up (the terminal
prints the URL with the token), and the server checks `Host` and `Origin`; requests without the token are
refused. Under `team/README.md` this "affects what can be published", so its review uses Fable 5.2 (or
that day's Opus stand-in).

## Cut (principle 5)

- Bulk actions (e.g. "reject all 48 duplicates"): every item gets at least one look; the duplicate flag
  already makes it two keys. Can be added later if the desk log shows how often the founder agrees with
  duplicate flags.
- Search, filters, sort options, charts, multiple users, login: one person, one computer.
- Rendering the source PDF: the right column uses the transcription, because that is what the program
  checks the quote against; `O` opens the layout.
- Confirmation dialogs: replaced by the 5-second undoable wait.
- The timer display in the verdict queue.
- Progress bars: only n / N.
- Translations of French and English text (working-language change, 2026-11-22).

## Principles relied on

- 7 (automate what can be): one key per action, pre-filled reasons, same-page candidates in a row,
  automatic timing; only judgments a machine cannot make are left to a person.
- 2 (no source, no record): the source page next to the quote; evidence excerpts and the publication
  check next to the verdict; failing checks block accept and confirm.
- 1 (questions matter as much as answers): "What is missing" for To be assessed shown in votes and in
  the publication preview; a send-back needs one sentence about what is missing.
- 3 (one ruler): one style for all six verdicts, no warning colour for "Did not come true"; agreement in
  words.
- 5 (simplest): reuses the site styles; no new table, one append-only file; cuts above.
- 6 (say it): below.

## Objections and risks

1. **Candidates have no speaker.** `claims.subject_id` is required, but neither candidate nor review
   files carry a person id. I proposed a file-level `subject_id` in the candidate file (filled by the
   extraction role, checked by `checkCandidatesFile`); a file format, not `db/schema.sql`. Without it
   the desk must ask "who is the speaker" once per source, an extra manual step.
2. **Jury summaries are not in the database.** `jury_votes` has `reasoning` and one-language
   `open_question`, no `summary_fr/en`; those are only in the vote files (`answerOf`). To show them side
   by side and copy them on "adopt vote n", the desk must read the vote files. It works, but one vote
   lives in two places.
3. **Translation must be done before the verdict queue.** The publication check needs every excerpt in
   both languages, and packs and votes lack translations. If translation came after the desk, almost
   every item would stop on "bilingual". Pipeline order: jury → translation → desk.
4. **Rejections, skips and send-backs are not in the database**, only in `data/desk/actions.jsonl`. Local
   like the database, but the backup plan must include it. A `desk_actions` table was the alternative; I
   chose the file because it does not touch a record format that has been through four reviews.
5. **Agreeing items get confirmed "in passing".** Putting them first is fastest and also the easiest way
   to build a press-without-reading habit, while "unanimous = auto-approved" must be calibrated on the
   founder's real judgment in this period (decision 0003). Mitigation: no timer, a warning that cannot be
   dismissed, the 5-second window. Stronger (not in this version): every 20 agreeing items, hide the
   votes once and let him choose first.
6. **Defaults influence judgment.** See the coordinator's decision 7 on pre-selection.
7. **What `decided_by` means**: text-only edits stay `jury`, a changed verdict is `human`. This shapes
   the later "do the jury and the person agree" statistics.
8. **One 17 px body size on a 768 px-high screen**: the verdict screen scrolls more than one screen. The
   action bar is fixed at the bottom, so no scrolling is needed to act; with three long jury summaries
   the right column gets taller than the left. Not tested in a browser.
9. **Security** (§10): a local server can still be called by web pages in the browser; the token and
   origin checks are not optional.
10. **Automatic acceptance (coordinator's change; I agree with the direction, three risks):**
    a) The review flags are now the only gate: a non-promise the flags miss goes into the workspace,
    costs a pack and three votes, and is only rejected in B. Little money (subscription plus one API
    vote), but it uses the night's subscription quota. Mitigation: "auto-accepted" shown daily; a weekly
    count of "auto-accepted then rejected" from the log; tighten the queue-A conditions if it is high.
    b) Rejecting deletes workspace data, including the jury's votes on the item; they are kept in the
    log's `removed`. The alternative, a "rejected" status on `claims`, would change the record format.
    c) Queue B now answers two questions (should it be recorded; can its verdict be published), so each
    item is slower; part of the time saved by automatic acceptance moves here. "Source passage" is
    collapsed by default so it is read only when needed.

## Not done and not verified

- Layout, focus order and 200 % zoom not tested in a browser; accessibility-review not run.
- The edit forms (candidate `E`, verdict `E`) and the shortcut sheet (`?`) are specified in words only,
  not drawn.
- The weekly human-time report (principle 7) is out of scope; its data sources are fixed in §6 and §7.

## Coordinator's decisions (2026-11-22)

1. File-level `subject_id` in the candidate file (file format, not record format).
2. Jury summaries FR/EN stay out of the database; the desk reads the vote files
   (`data/candidates/packs-*/`).
3. Pipeline order: jury → translation → desk.
4. Rejections, skips, send-backs, item rejections and automatic acceptances go into the append-only
   `data/desk/actions.jsonl`; backups must include it.
5. Rejecting an item deletes it from the workspace (with verdict, evidence and votes) after writing it
   in full to the desk log; `Z` puts it back. The ledger is not affected.
6. `decided_by`: text-only edits stay `jury`; a changed verdict is `human`.
7. On a 2 : 1 split, **no** vote is pre-selected (defaults must not steer a judgment that is being used
   to calibrate the jury); when all three agree, that vote is pre-selected.
8. The local server's security requirements (start-up token, `Host` and `Origin` checks, `127.0.0.1`
   only) go through the critical review.

## Coordinator decision 9 (2026-11-23, after Fable review 2): votes are rounds, verdicts are tied to a round

Fable review 2 found that the desk has no notion of "the votes changed since this verdict was written". One rule fixes
both high findings (principle 4: one rule, not two patches):

1. **A round** is one set of votes for one pack (pack sha256 + the set of vote files). Rounds are numbered per claim and
   are **append-only**: a round is written to `jury_votes` as soon as the desk first ingests it — whether the founder later
   adopts, edits, sends back or rejects. Nothing ever deletes a round (undo included).
2. **Every workspace verdict records the round it was based on.** When a newer round exists for the claim, the verdict is
   **stale**: the item returns to queue B, labelled "new votes since your last decision" — also when the claim is already
   published (then labelled "re-check of a published item"; confirming writes a new ledger entry as usual).
3. **The page shows and pre-selects only the newest round.** Adopt / edit / confirm carry the round id; a commit is refused
   if the newest round changed after the page was shown (always, not only when a vote was pre-selected).
4. **Undo** reverts only the workspace verdict to its previous value; it never removes votes or rounds.
5. **Performance:** the queue is built from an index of packs and vote files (path, size, mtime, sha256), rebuilt only for
   files that changed, so a page or action stays well under one second at 500 packs.
6. Small items from the review: add U+180E, U+2800, U+115F, U+3164 to the blank-character list in the desk checks;
   log desk actions with the claim's quote hash as well as its id; write the reject log line in the same step as the delete.
