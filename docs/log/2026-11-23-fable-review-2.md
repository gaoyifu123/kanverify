# Fable 5.2 review 2: review desk

Date: 2026-11-23. Reviewer: code reviewer on Fable 5.2 (claude-fable-5-2). Queue item 2 of `docs/review-queue-fable.md`.
Scope: `src/desk.js`, `src/desk-view.js`, `src/desk-assets/*`, `test/desk.test.js`, against `design/review-desk.md`
(including the coordinator's decisions). Commit 1634f5d. Only the points listed in the queue item.

## Result: SEND BACK

The local server's security holds: I could not get a write, a token or a ledger entry past it. The send-back is for
what the desk does when a jury votes a second time. Finding 1 publishes a verdict the current jury did not give, with
one key press, under a line that says the opposite. Finding 2 makes the main life cycle (pending, then an outcome)
impossible at the desk.

## How it was checked

- Read the files above, `src/ledger.js`, `voteProblems` / `checkVote` in `src/pack.js`, the tables and views involved.
- Scratch scripts on in-memory databases and temporary folders (outside the project), using the same fixtures as
  `test/desk.test.js`; a desk server on a random 127.0.0.1 port for the HTTP attacks. `data/` was not read or written.
- `npm test`: 235 tests, 233 pass. `test/desk.test.js`: 26 of 26 pass. The 2 failures are in `test/site.test.js`
  (they expect "22 November 2026" and get today's date); outside this item, same as in review 1.
- Not checked: no real browser was used (see the last section).

## Findings

### 1. High. After a second jury run, C publishes the old verdict while the page says the new one is pre-selected

- Where: `src/desk.js` 631 (`preselect` only when the workspace has no verdict), 644-652 (no stop for it), 792-797
  (pack and vote hashes re-checked, and votes recorded, only when `adoptVote` is set); `src/desk-view.js` 329.
- Reproduction: votes split came_true / partly_came_true. Adopt vote 1. Send back, reason 2 "Jury again". Write three new
  votes, all not_came_true. The item returns:
  - agreement line: "3 : 0 agree. All 3 votes say "Did not come true"; that vote is pre-selected."
  - publish box: "Came true, edited at the desk (decided by jury), evidence [1]"; no vote column is marked.
  - `canConfirm` is true. C, then commit, writes ledger entry 1: verdict `came_true`, `decided_by: jury`,
    jury `1:came_true, 1:partly_came_true`. The three new votes are in no table.
- Same cause, second route: adopt, press C, replace the vote files during the 5 seconds with 2 : 0 not_came_true. The
  commit succeeds and publishes came_true (the "changed during the window" check runs only for a pre-selected vote).
- Why it matters: "send back to the jury" is the desk's own workflow, and the returned item looks like the fastest
  kind (unanimous, C enabled). The public record then says the jury decided something no current juror voted, and
  freezes a superseded round as its jury (principle 2; decision 0003 calibration data is wrong too).

### 2. High. A published item never comes back to queue B when a new pack and new votes arrive

- Where: `src/desk.js` 688-689 (item dropped when the workspace still equals the ledger), 651, 631.
- Reproduction: claim with deadline 2027-12-31, two `pending` votes, C: published as pending. Move the clock past the
  deadline, write a new pack and two came_true votes. `verdictQueue()` returns 0 items and 0 unlinked; the page says
  "Verdicts · 0 left / No verdicts waiting". The workspace verdict stays `pending`. Same result for a published
  came_true followed by a 3 : 0 not_came_true re-run.
- Why it matters: only the desk writes the workspace verdict, and it only shows published items whose workspace
  already differs from the ledger. So "pending now, checked at the deadline" cannot be completed at the desk, and a
  jury that now disagrees with a public verdict is invisible. This is a legitimate workflow the rules make
  impossible. `design/review-desk.md` 5.1 only covers re-confirmation after a workspace change, so the designer and
  the coordinator need to decide how such an item returns; the developer should not invent it.

### 3. Medium. Undo deletes jury rounds, and the round number is then used again

- Where: `src/desk.js` 259-260 and 838-840 (`restoreVerdictState` deletes every `jury_votes` row of the claim).
- Reproduction: adopt (round 1: two votes). New votes arrive, adopt vote 3 (round 2: came_true, not_came_true,
  came_true). Z: round 2 is gone. A third vote set, adopt: round 2 is now partly_came_true x2. Z, Z: `jury_votes`
  is empty. The dissenting not_came_true vote survives only inside a `before`/`after` blob in the desk log.
- `test/desk.test.js` 300 asserts this deletion, while the test at 528 is titled "rounds are appended, never deleted".
- Related gap, by reading: votes are recorded only on adopt, edit or a pre-selected commit. Votes on an item that is
  sent back or rejected without adopting are never recorded.

### 4. Medium. At the real queue size every request takes seconds, so working during the window loses the confirmation

- Where: `src/desk.js` 665-695 (every request rebuilds the whole verdict queue: every pack and vote file re-read and
  re-checked, a savepoint preview per item), 633 (the whole desk log parsed once per item), 703-705, 920-923.
- Measured (scratch, tiny sources, this machine): 200 packs: about 1.4 s per page or action. 444 packs: 3.3-3.8 s
  each for the C request, the next page, a skip, and the page after it.
- Consequence, by reading `desk-client.js` 157-165 and `commit` 785-791: the commit request is sent 5.2 s after C and is
  refused after 7 s. One action on the next item during the window (a skip is 3.5 s plus 3.5 s for its page, on a
  single-threaded server) pushes the commit past 7 s: "abandoned ... nothing was written". Safe direction, nothing is
  published wrongly, but "the next item is already shown" stops working at about the size the project has today, and
  no key press meets the 10-second target (principle 7). Not confirmed in a browser.

### 5. Low. Notes

- Blank-looking text. The founder's summary of U+180E, U+2800 or U+115F is saved and `canConfirm` is true; a judge's
  vote with it passes too, so the ruler is the same, but neither `filled()` in `src/pack.js` nor the schema's trim list
  knows these characters. U+200B, U+2060 and U+00AD are saved to the workspace and then stopped by the database.
- Changing the verdict keeps the adopted vote's evidence. Adopt a came_true vote, edit to not_came_true: saved
  (`decided_by: human`), `canConfirm` true, with the excerpt "X est en vigueur depuis 2025" as its evidence. It meets
  the judges' rule (one official document), so "one ruler" holds formally; it is the same weakness as review 1,
  finding 1, and the founder cannot change evidence at the desk.
- `claims.id` is reused. Reject item #1 (the highest id), accept another candidate: "workspace item #1". Log lines
  keyed `c1` / `claim_id: 1` then describe two different claims. Never-published ids only, so no public URL is reused.
- Undo cannot go behind a confirmation: the `confirm` entry is never popped (`src/desk.js` 819), so earlier accepts and
  rejects can no longer be undone. The design does not say this.
- `rejectClaim` writes the log line before the delete (`src/desk.js` 777-778); if the delete failed, the log would keep
  a `reject_claim` for an item that still exists. By reading only; I found no input that makes the delete fail.

## What held (attacked, no finding)

- Token: only in the `#fragment`, moved to `sessionStorage`, address cleaned; never in a page, never accepted from the
  query string or a cookie. Pages have no inline script, style or handler; CSP is `default-src 'none'; script-src 'self'`.
- Host: 8 variants (no port, trailing dot, localhost, [::1], 0.0.0.0, decimal IP, missing, two Host headers) all 421,
  for reads too. Origin: null, trailing slash, upper case, other port all 403. Token: wrong case, extra characters,
  empty all 403. Non-JSON 415, PUT 405, 300 KB body cut off, array / string / null bodies and `__proto__` refused.
  No CORS header anywhere. Path tricks under `/assets` and `/original` give 404.
- Window: commit at 4999 ms refused, at 7001 ms abandoned, wrong id refused, second commit of the same id refused,
  two commits at once give one entry. A page load without the view id (reload, other tab) cancels at once; the
  pending id is only in the reply to C. Undo cancels. A changed vote file or a vanished pack during the window writes
  nothing (pre-selected case). Cross-site requests, `/original` and assets do not end a window. The pending item
  cannot be adopted, edited, rejected or confirmed again.
- One ruler: the founder's pending after the deadline, an outcome without evidence, to_evaluate with one language or
  blanks, and an unknown verdict are all refused with the judges' wording; a workspace verdict that breaks the rules
  blocks C.
- Originals: HTML with `Content-Security-Policy: sandbox`, PDF as attachment, SVG / XML / odd media types as
  `text/plain` with `nosniff`.
- Rejecting a published or withdrawn claim is refused. The ledger is written only through `confirm()`; no
  forbidden statement, pragma or direct database open in the desk files or their tests.

## Objections and risks

- Findings 1 and 2 share a cause: the desk has no notion of "the votes changed since this verdict was written".
  Patching the label in finding 1 alone would leave the rest. I would ask for one rule, decided by the coordinator
  and the designer, for what a new vote set does to an existing workspace verdict and to a published item.
- Finding 3 contradicts the queue item's own wording ("appended, never deleted"). If undo is meant to delete, the
  rule should say so; I reviewed against the rule as written.

## Not done and not verified

- No browser: bfcache, what `Sec-Fetch-Site` a reload sends, and sandbox behaviour were judged from headers and code.
  HTML originals are always served as UTF-8 (`src/desk.js` 1103); a page in another encoding may show wrongly. Untested.
- The real packs and votes in `data/` were not opened; timings used tiny sources and will be worse with PDFs.
- Queue A (candidates) and `auto-import` were read but not attacked: outside the listed points.
- `src/extract.js` has uncommitted changes from another developer; desk tests passed with them present.

---

# Re-check after decision 9, record format 10 and decision 0012 A2-A5 (same day)

Scope: the uncommitted rework of `src/desk.js`, `src/desk-view.js`, `src/desk-assets/desk-client.js`, `test/desk.test.js`.
`npm test`: 280 of 280 pass. Same method: scratch databases and folders, a desk on a random 127.0.0.1 port, `data/` untouched.

## Result: SEND BACK (one new finding that reaches the public record; the earlier five are fixed)

## Earlier findings

1. Fixed. Send back, new 3 : 0 round: banner "New votes since your last decision", the new vote is pre-selected and
   published; C with the old round number is refused. Votes replaced during the window: commit refused.
2. Fixed. A published item returns as "Re-check of a published item" and a second ledger entry is written.
3. Fixed. Two undos leave both rounds in `jury_votes`; reject then undo restores them under the same numbers.
4. Fixed. 444 packs, warm: page 120-280 ms, C 95 ms, skip 110 ms, commit 69 ms (first read 2.8 s, done at start).
5. Blank characters fixed. The other notes are unchanged and the developer says so; I accept them as low.

## New findings

### A. High. A round is recorded while the votes are still arriving, and all of it is frozen into the ledger

- Where: `src/desk.js` 689-692 (any set of counted votes not seen before is a new round, on any request).
- Reproduction: write the pack and vote 1, load a page; write vote 2, load a page; write vote 3, load a page.
  `jury_votes`: round 1 = 1 vote, round 2 = 2 votes, round 3 = 3 votes. Adopt, C: the ledger entry's jury is
  `1:came_true, 2:came_true, 2:came_true, 3:came_true, 3:not_came_true, 3:came_true`: six rows for three votes.
- Why it matters: votes come from different providers at different times (subscription sessions, Codex, API), and the
  scan runs at start-up and on every page load, so this is the normal case once the desk is open during a jury run.
  Rounds are append-only, so the rows cannot be removed, the public snapshot lists them, and the calibration counts
  each early vote two or three times. Decision 9 does not say when a round is complete; that needs the coordinator.

### B. Medium. A passing change in the vote files takes the item out of queue B for good

- Same cause as A. A second file from the same model appears: a one-vote "round 2" is recorded. The file is removed:
  0 items, and under "packs without a workspace item": "the pack of round 2 is no longer on disk" (it is on disk).
- Also: when the votes stop counting (I set `promptVersion` to judge-0.4 in both files, as a prompt bump would), an
  item that has a round disappears with the same wrong message, instead of showing "0 votes pass".

### C. Medium. A vague or hedged item that is sent back never returns

- Where: `src/desk.js` 904 (hidden while the quote is unchanged).
- Reproduction: vague item, write the summary, send back with reason 3 "Translation". Correct `quote_en`: queue 0.
  Change the summary too: queue 0. Only a change of `quote_original` or of verifiability brings it back, so
  reasons 2, 3 and 4 of its own send-back panel lead nowhere.

### D. Medium. After a subject or source row is corrected, C is refused until the desk is restarted

- Where: `src/desk.js` 861 and 881-883 (the cached view depends only on the count and highest id of those tables).
- Reproduction: load the queue, `UPDATE subjects SET name = ...` (or a source title), press C: "the item changed
  during the window ... nothing was written", every time; the page shows no stop. Safe direction, wrong message.

### E. Low to medium. The "PDF opened" marker is set even when no PDF was served

- Where: `src/desk.js` 1370-1375 (marked before the file is looked for and its hash checked).
- Reproduction: remove the archived file, follow the page's link: 404, and C is enabled; `opened_original` logged.

### F. Low

- 205 page loads from another site (it cannot read them) push the founder's page value out of the 200-entry map; his
  link then marks nothing until he reloads. Safe direction.
- `opened_original` is logged as the item's last action, so a sent-back item returns if its old PDF link is used.
- Session check: "S1" and "s1" count as different sessions; a vote that names no session counts (disclosed, shown).
- "Figures" means ASCII digits in the excerpt; numbers written in words are not caught (disclosed in part).

## What held

- The page value for the PDF marker: new on every page load, 128 bits, refused when missing, empty, in upper case,
  from another site, or sent by POST; a new round needs a new opening. Tick: the body cannot choose the publisher,
  it is logged with the normalised key, survives a restart, can be undone, and C is refused without it.
- No new write path reaches the ledger: `publications` is still written only through `confirm()`. The new writes are
  `jury_votes` (ingest, on GET too, as decision 9 asks), `verdicts.based_on_round`, and log lines.
- Vague items: the verdict is forced to "unverifiable", `decided_by` human, no evidence, blank-looking text refused;
  adopt, tick and wrong-kind are refused on them.
- Host / Origin / token refusals re-run: unchanged. No forbidden statement or direct database open in the desk files.

## Not verified

- No browser: the O key's redraw after 800 ms and the download behaviour were read, not run.
- The second window route and the PDF marker over HTTP were run; K (wrong kind) only through the developer's test.

# Second re-check (after the step-back on vote rounds, same day)

Reviewer: code reviewer on Fable 5.2. Scope: closed rounds (`src/jury.js` closeRound/readRounds), `src/desk.js`,
`src/desk-view.js`, `src/rules.js`, `src/pack.js`, `src/ledger.js`, their tests. `npm test`: 292/292. Saved by the
coordinator (the reviewer cannot write files).

## Result: the round mechanism PASSES; SEND BACK on the renunciation rule (record-format questions)

Earlier findings A–F: all fixed (A–D re-run; E, F by reading plus the developer's tests).

Attacks that held: re-vote overwriting a file during the commit window (refused); a third vote closing a new round
during the window (refused, item returns stale); rounds file deleted after publication (stop; tally restores, no
duplicates); rounds file cut short (line skipped); forged line naming a file outside the pack (ignored); desk log deleted
twice (nothing re-ingested or duplicated); reject then undo (same round numbers); loose vote after a send-back (no
return; the next closed round does).

### 1. High. On a renounced promise, judges and desk allow verdicts that `confirm()` refuses

`src/pack.js` looks for a renunciation among the pack's documents; `src/ledger.js` deadlineBlocker only among the
verdict's evidence, where `db/schema.sql` admits a renunciation under `not_came_true` alone. Before the deadline with a
renunciation in the pack: `not_came_true` citing the renunciation publishes; `not_came_true`, `partly_came_true` or
`to_evaluate` citing only the law are valid votes but C is off with "deadline not over"; `partly_came_true` citing law
and renunciation is refused as a vote. So decision 0013's "partial result → partly came true" can never be published
before the deadline, and the stop names the wrong cause. Reverse gap: `confirm()` called directly publishes `pending`
on that promise (only the desk's check against the pack stops it).

### 2. Medium (public). The snapshot does not say which round the verdict rests on; the site counts all rounds as one jury

`db/schema.sql` 412–431 lists every `jury_votes` row with no `based_on_round`; `src/site.js` 1011–1017 counts them all.
Re-judged item: snapshot jury `1:pending, 1:pending, 2:came_true, 2:came_true` → the site shows 4 votes, not unanimous,
for a 2:0 round. Same with a late Gemini vote (five rows for three votes).

### 3. Low

- A closed round overwritten by a re-vote before the desk looked is never written to `jury_votes`; its votes are lost
  (the rounds file keeps only hashes). Matters for "record every vote" (decision 0003). By reading.
- Stops quote the pack file's round number, the banner the claim's round number; they differ once a round was skipped.
- Two simultaneous tally runs can append the same round number; the desk takes the first. By reading.
- A renunciation ends the wait by its `kind` label in the pack, cited or not; remedy for a wrong label is the
  "wrong kind" send-back.

### Record-format change needed?

- Finding 1: yes — admit a renunciation as an additional, never sole, evidence row for the other outcome verdicts on a
  promise, or link the claim to the renunciation source. Do not loosen `confirm()` to trust the pack (the ledger would
  depend on a file outside the database).
- Finding 2: recommended — put `based_on_round` into the snapshot's verdict object.
- Round bookkeeping: no.

### Objections and risks

- Closing a round needs only the two subscription votes, so a unanimous 2:0 can be confirmed while a third vote is on
  its way. Accepted by the step-back; named so it is a known choice.

### Not verified

No browser; site not built (finding 2 read against a real scratch snapshot); queue A and auto-import not re-checked;
judge-prompt and verdict-standard changes not reviewed here.

## Coordinator's decision

The round mechanism is accepted and committed (tag `fable-desk-2026-11-23`). Findings 1, 2 and the lost-votes item go
into record format 11, done by the developer and reviewed by Fable (record-format area). Until format 11 lands, a
renounced promise can only be published as `not_came_true` (citing the renunciation) or early `came_true` before the
deadline — the safe direction.
