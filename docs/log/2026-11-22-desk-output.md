# Output: local review desk (queue A, queue B, auto-import)

- Role: developer (Opus 5.5)
- Date: 2026-11-22
- Built to: `design/review-desk.md` (English version, including "Coordinator's decisions") and
  `design/mockups/desk.html`; coordinator's message of the same day (desk UI in English; quotes, excerpts
  and votes in their original language when French or English, translations only for a third language).
- Written in English: the coordinator relayed that the project's working language is now English. The
  task card asked for Chinese; I followed the later message. Say so if this note should be in Chinese.
- **Security-relevant: a local server that can publish to the ledger. Needs the critical review
  (Fable 5.2, or Opus standing in on a day without Fable quota), per `team/README.md` items 1 and 2.**

## What was done

New files:

- `src/desk.js` — logic, HTTP server and CLI. `npm run desk` starts the desk;
  `npm run desk -- auto-import <candidates file> [--subject <id>] [--review <file>]` imports.
- `src/desk-view.js` — server-rendered HTML for both queues (no inline script or style).
- `src/desk-assets/desk.css` — the mockup's `<style>` block plus dialogs and form errors; tokens from
  `design/mockups/kanverify.css` (served as is, not copied).
- `src/desk-assets/desk-client.js` — shortcuts, item timer (pauses when hidden or idle 120 s), the
  5-second countdown, writes with the token header.
- `test/desk.test.js` — 15 tests, scratch databases and temp folders only.

Changed:

- `src/pack.js` — `checkCandidatesFile` requires a file-level `subject_id` that exists in `subjects`
  (coordinator decision 1). `test/pack.test.js` updated, plus a test for missing / unknown subject.
- `package.json` — `desk` script. `.gitignore` — `data/desk/`.

How it works:

- **Auto-import**: a candidate goes in only if the review file lists the candidates file among its inputs,
  has an entry for it with the same quote, raises no flag (a `consistency_note` alone is not a flag), and the
  program's own check passes (verbatim, same unit, `candidateProblems`). Each insert is logged as
  `auto_accept` with `by: "program"`. Re-running inserts nothing twice. If the file has no `subject_id`,
  `--subject` supplies it and it is written into the file (so the desk sees the same speaker); two
  different speakers are refused. A source without `published_on` is refused (no `said_on`).
- **Queue A**: flagged or failing candidates, by source and index, skipped ones last. A / F / E / R / S / Z /
  O / Q / ? as specified. Every accept re-runs the verbatim and record checks on the server. Undo of an
  accept deletes the row only if it is unchanged and has no verdict, votes or publication.
- **Queue B**: every `*.pack.json` under `data/candidates/packs-*`, its vote files checked with
  `checkVote`, linked to the workspace claim by `claim.claim_id` if present, else by origin source and
  quote (must be exactly one match). Order: agree and passing, split, failing; skipped last.
  Pre-selection only when every valid vote agrees and there are at least two (decision 7); a split
  pre-selects nothing and C stays disabled until 1–3 is pressed. Adopting writes the verdict
  (`decided_by = 'jury'`), the cited pack excerpts as `verdict_evidence`, and the valid votes into
  `jury_votes` (so they are frozen into the snapshot). Editing keeps `decided_by` for text-only edits and
  sets `human` when the verdict changes (decision 6).
- **Confirm**: C records a pending confirmation in memory with the exact snapshot that would be published
  (computed inside a rolled-back savepoint). Nothing is written. After at least 5 seconds the page asks the
  server to commit; the server refuses earlier commits, drops commits more than 60 s late (page closed), and
  refuses if the publishable snapshot changed meanwhile. Then `confirm(db, id, 'founder', { reviewSeconds })`
  in one transaction. Z during the window cancels; after it, undo says "only withdraw".
- **Reject item (X)**: refused when the claim has any ledger row (published or withdrawn). The full
  workspace content (`claims`, `verdicts`, `verdict_evidence`, `jury_votes`) is appended to the log before
  the delete, in the same transaction; Z re-inserts it under a new id.
- **Desk log**: `data/desk/actions.jsonl`, append-only. Fields as in spec §7, plus `id` (so `undoes` can
  point at a line), `source_file`, `row` (inserted claim, for the "unchanged" undo check), `before` /
  `after` (verdict state, for undo of adopt / edit), `pack_sha256` / `votes_sha256` (send back hides an
  item until these change). Extra action names: `adopt_vote`, `edit_verdict` (workspace edits the spec's
  list did not name; logged so they can be undone and counted). `confirm` is logged with its
  `publication_id`; its seconds are counted from `publications` only.
- **Security**: listens on `127.0.0.1` only (port 4818, a random free port if taken). A 32-byte random
  token is printed once in the terminal URL, in the `#fragment` (since send-back 1); the page script moves
  it into `sessionStorage` and strips it from the address bar; it never appears in a page. Every request needs `Host: 127.0.0.1:<port>` exactly
  (blocks DNS rebinding, also for reading); every POST also needs `Origin: http://127.0.0.1:<port>`
  exactly, the token in `X-Desk-Token` (constant-time compare) and `Content-Type: application/json`;
  remote address must be loopback; body capped at 256 KB. No CORS headers at all. Pages carry a strict
  CSP (`script-src 'self'`, no inline), `frame-ancestors 'none'`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `no-store`. Archived originals (`/original/<id>`, key O) are served
  with their hash re-checked, all under `Content-Security-Policy: sandbox` (opaque origin, no script), so
  an archived page cannot read the token or call the desk; PDFs are downloads (since send-back 1).

Tests: `npm test` — 224 pass, 0 fail (was 208). The desk tests cover: Host / Origin / token / content-type
refusals and that refused requests write nothing; 127.0.0.1 binding; no CORS header; token not in pages;
sandboxed originals; auto-import rules and idempotence; each queue A action's database and log effect;
undo of accept, reject, skip, adopt, edit, reject item; undo refused on a changed claim; confirm refused
before 5 s, written after, `review_seconds` stored, cancel within the window writes nothing; expired and
changed-meanwhile confirmations write nothing; split votes pre-select nothing; `decided_by`; reject item
refused once a claim has been published (also after withdrawal); send back hides until votes change;
escaping of file text in pages.

Smoke run on **copies** of the real data (scratch copy of `data/kanverify.db`, copied candidate files and
packs; nothing under `data/` was written): auto-import of source 1 with a test subject imported 148,
queued 48 flagged; the queue A page renders in about 0.5 s. The real packs show 0 valid votes, correctly:
they were cast under judge prompt `judge-0.3`, and the current prompt is `judge-0.4` (`checkVote` rule).
The real database has no subjects and no claims yet, so on real data both queues are empty until a
subject is created and `auto-import` runs.

## Principles

- 7 (automate): auto-import; one key per action; timer recorded, not shown in queue B.
- 2 (nothing without a source): every accept re-checks the quote against the archived text on the
  server; confirm goes only through `ledger.confirm()` and the record-format checks; the snapshot shown is
  the snapshot written, or nothing is.
- 1: "What is missing" shown in votes and in what will be published.
- 3: no colour for agreement or for "Did not come true"; split votes are not pre-selected.
- 5: no new table and no dependency; one append-only file the spec asked for. Why a second module
  (`desk-view.js`): the HTML is half the code and is easier to review apart from the server's checks.
- 8: no model calls; listens on loopback only.

## Objections and risks

1. **Security review needed before first real use** (see top). The parts most worth a second look:
   `deskHandler` (Host / Origin / token order), the `/original/` route (serving archived third-party HTML
   on the desk's origin, sandboxed), and `commit` (window, snapshot comparison, transaction).
2. ~~PDF originals are served without the sandbox CSP.~~ Fixed after the first send-back: PDFs are
   downloads (see below).
3. **"O" opens the original in a browser tab, not "in the system viewer"** as §4.1 says. Spawning a
   system program from a web request is a larger attack surface than serving the file. Interface
   deviation: the designer or coordinator should confirm.
4. **Undo history lasts for the server run, not "since the page was opened"** (§4.3). Pages reload after
   each action, so a per-page history would be empty. Restarting the desk clears it.
5. **The desk writes `jury_votes`.** Nothing else in the pack flow does, and without it the ledger snapshot
   has no jury votes, which decision 0003's calibration counts on. Only votes that pass `checkVote` are
   written (an invalid vote in a public snapshot would mislead); invalid votes stay in their files. The
   coordinator should confirm this is the intended owner.
6. **Fewer than two valid votes blocks C.** The spec does not say this; `team/README.md` requires at least
   two models. With the real packs (old prompt version) nothing can be confirmed until the votes are redone.
7. **Translations of excerpts have no agreed place.** The desk copies `text_fr` / `text_en` from a pack
   excerpt into `verdict_evidence` if present; these field names are my guess for the translation step's
   output (decision 3: jury → translation → desk). Until that step exists, every outcome verdict on a French
   source is blocked by the bilingual rule (an English translation of the excerpt is missing).
8. **Pack-to-claim link.** Without `claim.claim_id` in the pack, the link is "same origin, same quote, exactly
   one claim". If the claim was edited in the workspace after the pack was cut, the desk shows the
   differing fields and blocks C (the votes judged another version). The evidence role could write
   `claim_id` into packs; I did not change the pack format.
9. **`checkCandidatesFile` now requires `subject_id`**, so `node src/pack.js candidates` refuses to rewrite
   the three existing candidate files until a speaker is set. That follows decision 1, but `team/run/extract.md`
   (the extraction role's instructions) does not yet mention `subject_id`.
10. **Source 3 has no publication date**, so none of its candidates can become claims (`said_on` is
    required). It needs a source fix, not a desk change.
11. Log write and database write are in one transaction with the log appended first; if the final commit
    failed after the append, the log would hold a line for something not written. Unlikely, but the log
    is a record of intent, not proof.

## Send-back 1 (security review, same day): what changed

All eight points fixed, each with a test (`test/desk.test.js`, "review 1" to "review 8"; the earlier tests
were updated where the behaviour changed). `npm test`: 232 pass, 0 fail.

1. **Pending confirmation no longer survives its page.** A page never carries the pending id. Only the
   JSON answer to C carries it; the page that pressed C keeps it in memory and asks `/api/commit`.
   The server accepts a commit only between 5 s and 7 s after C (`COMMIT_GRACE_MS = 2000`). So that the
   next item can still be shown during the 5 seconds (§5.3), the client now loads the next page with
   `fetch` and swaps it into the same document, keeping the countdown alive. A page closed or reloaded
   never asks, so nothing is written. A page loaded after an abandoned window says "Cancelled: item #N
   was not written…". A page loaded during someone else's window says the confirmation is waiting in
   the view where C was pressed. In both cases the page changes nothing.
2. **Token in the fragment.** The terminal prints `http://127.0.0.1:<port>/#token=…`. The browser never
   sends a fragment to the server or puts it in a Referer. The client moves it to `sessionStorage` and
   cleans the address with `history.replaceState`. `/` is served directly; there is no redirect anymore.
   A token in the query string counts for nothing. All other checks are unchanged.
3. **One ruler for the founder's edits.** Saving an edited verdict runs `voteProblems` from `pack.js` on
   it: deadlines (only "came true" before the deadline), evidence (one official document or two
   publishers; none when nothing was adopted), both languages for summary and "what is missing". A
   verdict a judge would be refused for is not saved (the transaction is rolled back). The same check
   runs on whatever verdict the workspace holds, and a failure blocks C, so a verdict edited outside the
   desk is held to it too. Every path to a verdict (adopt, edit, edit on a split with nothing adopted,
   confirm of a pre-selected vote) writes the valid votes to `jury_votes`.
4. **Keys.** Desk decisions are filed under `<candidates file name>#<sha256 of the quote>`. The
   `s<source>-<index>` label is kept for display only, in a `label` field of the log. Auto-import, the
   queue and the review-file lookup match on the key. Reordering a candidates file keeps every decision.
   Two candidates with the identical quote in one file share a key; they are the same claim.
5. **Duplicate votes.** Votes are counted per (provider, lower-cased trimmed model). If two files come
   from the same model, **both** are marked and neither is counted: file order should not decide which
   one stands. The pages render this. A pack that throws while being shown is listed with its error
   instead of breaking `/verdicts`. `jury_votes` rounds are appended (round = previous max + 1). Nothing
   is written when the latest round already holds exactly the same votes. Undo of an adopt or edit still
   restores the earlier state exactly, which removes the round that action added.
6. **Attributes.** Every interpolation into an HTML attribute in `desk-view.js` now goes through `esc()`,
   including `lang` (the candidate's language comes from a file). Tested with a hostile language code.
7. **PDFs** are served with `Content-Disposition: attachment; filename="source-<id>.pdf"` and the sandbox
   CSP, like everything else under `/original/`. "O" therefore downloads a PDF instead of showing it.
8. **GET has no side effects.** The toast stays until the next write, and a GET no longer clears it.
   An abandoned confirmation is dropped at the next write, not at a page load. One caveat: a verdict
   page computes "what C will publish" inside a SQLite savepoint that is always rolled back. That
   briefly takes the write lock; nothing is kept.

Still open from this round: the browser test the coordinator has arranged. The client's in-page
navigation (`fetch` + swap, `pushState`, back button) is new and has run only in Node-side tests of the
server, not in a browser.

## After the real-browser test (same day): display and navigation fixes

The data-safety steps passed in the browser. Fixed afterwards: (1) no stale toasts after C: the server
no longer stores a "will be written" toast, and the committing view redraws its page after the commit
(header with "Today", toasts, blockers; only header and toasts if a panel is open or a field has focus);
(2) any page load during the window that is not from the committing view (which sends `X-Desk-View`)
cancels the window at once and shows "Cancelled". Cross-site requests (`Sec-Fetch-Site: cross-site`)
are ignored. This is a deliberate side effect of a GET, in the safe direction: at worst another site could
cancel a pending confirmation, never write one; (3) stale "another confirmation" blockers go with the
redraw; (4) "Today" is refreshed; (5) `replaceState` when the address does not change; (6) a toast
belongs to its queue and is not shown on the other one. Votes are numbered in file order everywhere
(columns, keys, pre-selection text); I found no second numbering. New: `--db <file>` and `--log <file>`
start the desk (or `auto-import`) on another database and log; default stays `data/`. Tests: 235 pass.

## Not done and not verified

- Not opened in a real browser: layout, focus order, 200 % zoom, keyboard flow and the countdown are
  untested by hand (the server, rendering and actions are tested in Node only).
- Weekly human-time report (principle 7) not built; the data is in the log and `publications`.
- `npm run desk` was not started against the real database (I did not want to risk writes; the same code
  path ran on a copy).
- No accessibility review.
