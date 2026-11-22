# Fable 5.2 review queue

Fable 5.2 quota is limited. Use it only for the items below, in this order, one review agent per item,
scoped to what changed. Everything else gets Opus 5.5. Rules: `team/README.md` ("When to use Fable 5.2").

Each review: read-only, scratch databases and folders only, never `data/`, no network except where stated,
report "pass / send back" with ranked findings and reproductions. The reviewer writes its report to
`docs/log/<date>-fable-review-<n>.md`. Stop the queue when the quota runs out; note where it stopped in the daily log.

## 1. Judge prompt (team/README.md rule 4: if it is wrong, every verdict is wrong)

- Files: `team/run/judge-prompt.md` (judge-0.4), `team/run/judge.md`, `team/run/judge-subscription.md`.
- Context: `docs/methodology/verdict-standard.md` (v0.3: six verdicts, only `came_true` before the deadline,
  deadline readings, bundles), `docs/methodology/source-rule.md` (incl. renunciation, self-assessment, Légifrance).
- Questions: does the prompt state every rule exactly once and unambiguously? Could a judge misread
  "partly", "pending", "to_evaluate", "unverifiable"? Is pack text treated as data (prompt-injection resistance)?
  Is it neutral (principle 3)? Never reviewed by Fable.

## 2. Review desk (security: a local server that can publish)

- Files: `src/desk.js`, `src/desk-view.js`, `src/desk-assets/*`, `test/desk.test.js`.
- Already reviewed once by Opus (sent back, 8 findings fixed) and browser-tested. Fable checks only:
  token in `#fragment` → sessionStorage; Host/Origin/token checks; the 5–7 s commit window and abandon logic;
  "one ruler" edit checks; `jury_votes` rounds; served originals (HTML sandbox, PDF as attachment).

## 3. Record formats 6–9 together (what can be published)

- Files: `db/schema.sql`, `src/ledger.js`, `src/pack.js` vote checks, related tests.
- Changes since the last Fable review (format 5): six verdicts, renunciation (promises only), measurable
  `unverifiable` needs evidence, bilingual withdrawal note, `origin.id` / `evidence[].source_id` in the snapshot,
  `question_stated` removed, early-verdict rule in `pack.js`. Opus reviewed each step; Fable checks the combined result.

## 4. Fetching code (security: downloads and credentials)

- Files: `src/archive.js` (since the last Fable review: manual redirects, `node:http` transport with lookup-hook
  address checks, `storeEvidenceBytes` / `registerSource`, `expectMediaType`), `src/legifrance.js`,
  `src/federalregister.js`, `src/ai/codex-cli.js`.
- Opus reviewed each; Fable checks the combined attack surface (SSRF, credential leaks, file integrity).

## Not for Fable (Opus is enough)

Site generator, extraction prompt (its output is reviewed before use), design, docs, board.
