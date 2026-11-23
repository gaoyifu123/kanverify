# Fable review 4 — fetching code (downloads and credentials)

Reviewer: code reviewer, Fable 5.2. Date: 2026-11-23. Saved by the coordinator from the reviewer's report.

**Verdict: SEND BACK** — two concrete defects (F1, F2). The SSRF and credential core held under attack
(address checks incl. numeric/mapped forms, DNS rebinding, redirect schemes and user info, Légifrance token never forwarded,
no credential in errors, hash-named paths, exclusive fsynced temp files, Codex without shell and with prompt on stdin).

## Findings
- **F1 (medium)** `registerSource` (and the same pattern in legifrance.js) deletes an evidence file it did not create when an insert fails and *this* database has no row for the hash — can delete another database's or the founder's file.
- **F2 (medium)** A Codex timeout on Windows surfaces as EPERM from the temp-folder cleanup (masking the AbortError) and leaks both temp folders.
- **F3 (medium, founder decision)** Codex's read-only sandbox can read any file on the machine; an injected instruction in untrusted pack text could make it quote a secret (.env, ~/.codex/auth.json) into a stored vote. Nothing scans replies.
- **F4 (low-medium)** The Codex child environment is filtered by a name denylist; `PISTE_CLIENT_ID` and other secrets pass. Use an allowlist.
- **F5 (low)** A close-delimited response cut by the server is stored as a whole file; for PDFs, require `%%EOF` near the end.
- **F6 (low)** Short `writeSync` not looped in `archive()`; redirect chain not kept in a provenance file; source row keeps the model-chosen kind after a cross-host redirect; `64:ff9b:1::/48` not forbidden; literal bidi characters in a federalregister.js regex; crash orphans not swept; `archiveLegifranceText` duplicates rows; Codex stderr tail can echo the prompt into a vote error.

## Re-check 1: SEND BACK (R1 Codex timeout not bounded; R2 JSON-escaped secrets). Re-check 2: PASS. Residual F3 risk awaits the founder (board item `judge-file-access`).
