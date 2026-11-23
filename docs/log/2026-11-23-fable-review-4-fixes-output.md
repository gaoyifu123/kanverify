# Output: fixes for Fable review 4 (fetching code)

- Role: developer
- Model and prompt version: Opus 5.5 (build team; no run-team prompt changed)
- Date: 2026-11-23
- Input: `docs/log/2026-11-23-fable-review-4.md`, coordinator's instructions F1–F6

## What changed

Thought first (principle 4): F1 and F2 are both "cleanup that destroys or masks something it does not own".
The fix in both cases is to make ownership explicit (who created the file / when the child has really exited)
rather than to add more cleanup.

**F1 — only the creator deletes (`src/archive.js`, `src/legifrance.js`)**
- New internal `placeEvidence()`: the finished temp file is put in place with a hard link, which fails if the
  name exists, so "this call created the file" is decided atomically. If a file is already there with the right
  bytes it is kept; with wrong bytes it is replaced (repaired) but not counted as created. File systems without
  hard links fall back to look-then-rename.
- `storeEvidenceBytes()` and `archive()` return `created`. `registerSource()` no longer deletes anything.
  New `removeIfCreated(db, stored)` removes a file only if this call created it and no row in this database uses it.
  `archive()` and `archiveLegifranceText()` call it on a failed registration.

**F2 — Codex cleanup (`src/ai/codex-cli.js`)**
- `spawnCodex` now settles only after the child's `close` event, so the AbortError is raised after the child
  has exited and released its working folder (a child that never started is rejected at once).
- Folder removal uses `rmSync` with `maxRetries: 10, retryDelay: 100` and never throws, so it cannot replace
  the original error. Folders that still cannot be removed are swept on a later call (`sweepStaleFolders`,
  our own `kv-codex-*` folders older than an hour). New option `tmpRoot` (tests).

**F3 — reply guard (`src/ai/secrets.js`, `src/ai/index.js`, `src/ai/errors.js`)**
- `ask()` checks every reply, for every provider including codex, before anything is returned:
  the answer text and web-search results against all values from `.env` and secret-named variables (8+ characters),
  JWT-like (`eyJ…`), `sk-…` keys, and runs of 32+ base64 (mixed case + digits) or hex (letters + digits).
  A token-like run that also appears in the request (a quoted pack excerpt) or sits inside a URL is allowed;
  `.env` values are refused even then. The vendor's raw response is checked for `.env` values only.
- Refusal is `AiError('secret_in_reply')`, no JSON retry, and the message names only the kind of thing found.

**F4 — Codex environment allowlist**: `childEnv` keeps only PATH, SystemRoot, SYSTEMDRIVE, USERPROFILE, APPDATA,
LOCALAPPDATA, TEMP, TMP, HOME, CODEX_HOME, COMSPEC, PATHEXT (case-insensitive names, original casing kept).

**F5 — incomplete PDFs**: with `expectMediaType: 'application/pdf'`, `archive()` requires `%%EOF` within the last
1 KB (the tail is kept while streaming).

**F6**
- Short writes in `archive()` are looped (`writeAll`).
- `archive()` appends to `data/candidates/archive-provenance.jsonl`: source id, sha256, requested URL, every hop,
  final URL, time. Only for the real evidence folder by default (tests write nothing unless they pass
  `provenanceFile`). A failed append does not undo a successful registration; it is returned as `provenanceError`.
- A redirect to another host is refused unless the caller passes `allowCrossHost` (CLI: `--allow-cross-host`).
  `jury.js` does not pass it, so such suggestions now end as `archive_error`.
- `64:ff9b:1::/48` is forbidden.
- `src/federalregister.js`: the literal bidi characters in `UNPRINTABLE_RE` are now `\u` escapes. A new test fails if
  any file under `src/` contains literal control or bidi characters.
- `node src/archive.js orphans` lists hash-named files with no row in this database; it deletes only with `--delete`.
  Nothing deletes them automatically. On the real database today: 0 orphans.
- `archiveLegifranceText()` returns the existing row when the same text (public URL from the cid) with the same
  sha256 is already registered (`duplicate: true`); the CLI says so and appends no provenance line.
- Codex errors keep at most the last 3 stderr lines, dropping every line that also appears in the prompt.

**Tests.** New: `test/codex-cli.test.js` (5, including a real child process that holds a file in its working folder and is
aborted; I checked that this test fails with the old reject-at-once and no-retry code), `test/ai-secrets.test.js` (5);
`test/archive.test.js` +9, `test/legifrance.test.js` +2. Fixtures for fake PDFs now end with `%%EOF`
(`archive.test.js`, `federalregister.test.js`); one existing redirect-to-private test now passes `allowCrossHost` so it
still reaches the address check. **`npm test`: 274 tests, 274 pass.** At the start of this task 54 tests in
db/desk/ledger/site were failing because of the parallel format-10 work; they pass now.

Not touched: `db/schema.sql`, `src/ledger.js`, `src/pack.js`, `src/desk*`, `src/site.js`, design, board. No git.

## Principles

- 2 (nothing without a source): incomplete PDFs and cross-host substitutes are not registered; every download's path is recorded.
- 8 (no lock-in, data local): the guard and allowlist live in the AI layer; provenance files stay in `data/candidates/`.
- 4: the circuit breaker was not needed; each finding was fixed once.
- 6: objections below.

## Objections and risks

1. **F3 is a heuristic; the founder decides the residual risk.** Not caught: secrets shorter than 8 characters,
   a secret the model splits, re-encodes or paraphrases, a plain run hidden inside a URL, and secrets from files
   other than `.env` that are not token-shaped. False refusals are possible: any `.env` value that is an ordinary word or model
   name (8+ characters) will refuse every reply that mentions it, so `.env` should hold only keys. A long mixed-case path or id
   that the model writes itself (not quoted from the prompt, not in a URL) is also refused.
   A refused jury vote costs a call and needs a rerun.
2. **Cross-host refusal changes jury behaviour.** Suggestions whose site redirects to another host (http → https on another
   name, `www.` added or removed) now fail with `archive_error` instead of being archived with a warning. This is stricter and may
   lose some valid evidence; a person can archive them by hand with `--allow-cross-host`.
3. **Grandchildren of Codex.** Killing the Node wrapper does not kill a native process it may have started on Windows; such a
   process can keep the folder locked longer than the retries. The folder is then removed by the next call's sweep (after an
   hour), not leaked forever. Not tested with the real Codex binary.
4. **Two databases sharing one evidence folder**: `removeIfCreated` checks only this database's rows. If another database
   registered a file in the moment between our creation and our failed insert, we could still remove it. Narrow, but real.
5. **Hard-link fallback.** On a file system without hard links, "created" is decided by look-then-rename, which has a small race.
   The evidence folder is on NTFS here, which supports hard links.
6. The dedupe in `archiveLegifranceText` rarely triggers in practice: each response carries `executionTime`, so the bytes
   usually differ between fetches.

## Not done / not verified

- Not run against the real Codex binary or the real network in this round (the real-child test uses a stand-in script).
- `team/run/fetch.md` still describes the close-delimited limit in general terms; for PDFs it is now checked (`%%EOF`).
  Updating that role file is left to the coordinator.
- Code not self-reviewed; the same Fable reviewer re-checks.

## Re-check items R1 and R2 (2026-11-23)

- **R1:** `spawnCodex` now settles on the launcher's `exit`, waits at most 1 s more for the pipes to close, and after an abort
  gives up waiting after 3 s even without `exit`. It then destroys the pipes. Folder removal retries 6 times (about 2.1 s).
  So a call settles within about 3–5 s of its timeout even when a descendant keeps the pipes open. New real-child test:
  a launcher with a detached grandchild that inherits stdio and the working folder. The call rejects with AbortError about 3 s after the abort, and the
  test fails (20 s) with the old close-only settling.
  Residual: such a grandchild keeps running and keeps the working folder locked. The folder is removed by the
  sweep on a later call after an hour. Killing the whole process tree (e.g. `taskkill /T`) is not done.
- **R2:** with `json: true`, `ask()` also runs the guard on every string (and key) of the parsed value, so `\u`-escaped and
  `\/` or `\"`-escaped secrets are refused. I checked that the test fails without this check.
- **sha256 in a reasoning:** already allowed when the hash appears in the request (pack prompts carry each source's
  sha256). A 64-hex string that is not in the request is still refused. Both cases are tested.
- `npm test`: 283 tests, 283 pass.
