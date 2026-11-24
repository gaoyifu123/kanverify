# Fable 5.2 review 9: isolated Claude judge; judge channel as a setting (2026-11-24)

Queue item 6. Commits 7c8739d, fb2bf7c. Saved by the coordinator, condensed, every finding kept. `npm test` 366/366;
probes in a scratch copy; no real `claude -p` call; data/ untouched.

## Result: SEND BACK (F1–F3 before real packs go through the Claude judge)

1. **Medium. Any CLI version is accepted, and the vote records things nobody observed.** The version is only
   recorded; `system_prefix` is a constant whatever the CLI sent; the founder's everyday Claude Code updates itself;
   the refusals detect tool use, not tools being available or the system text no longer replacing the default. Ask:
   refuse versions not in a short verified list (the smoke script adds a version); consider reading the tool's own
   init report (`--output-format stream-json --verbose`) instead of the model's self-report.
2. **Medium–high if it reproduces; not verified. `@path` mentions in pack text may be expanded by the CLI itself**
   (harness-side, so `--tools ""` may not stop it; one turn, no denials — every refusal passes). Case: an excerpt
   containing `@~/.claude/.credentials.json` or `@~/Desktop/KANVERIFY/.env` plus an instruction to quote it. Must be
   probed with a canary file before real packs are judged; if it reproduces, neutralise or refuse at the adapter. The
   smoke probe's `cwd` answer is also never checked.
3. **Medium. A vote can be checked against a date its judge was never shown.** The judge input is rewritten on every
   `vote` run; a skipped member's earlier vote stays and is then checked against the new `made` date (regression of
   review 1 finding 10). Ask: the vote carries the date it was shown and checkVote requires it to equal the header's
   `made`, or the judge input is not rewritten while an older vote remains.
4. **Low–medium.** "The only model listed" accepts a different model than requested (opus requested, haiku answered
   → valid). Accept only the requested name or it plus a date suffix.
5. **Low.** A round's recorded jury takes channel/model from the settings at closing time, not from its votes.
6. **Low.** Facts the Claude adapter checks (made_by.tool, tool_version, session, num_turns) are not re-checked when a
   vote file is read.
7. **Low.** A format-2 round line without `jury` is read as format 1; require it for format ≥ 2.
8. **Low.** `findOnPath` accepts the extensionless npm shim on Windows that Node cannot spawn.
9. **Low.** Settings with fewer than two members on: tally says "agree" on one vote; with none, junk round lines.
Nits: stale doc comment; a test title; the "no hooks or plugins" comment overstates `--safe-mode`.

Open items judged: R1 = part of F1; R2 acceptable for launch (fails closed), simpler route: skip a member that
already has a vote on this pack, prompt and judge-input date — must keep F3's date.

What held: env allowlist; the fail-closed refusals; juryVoteProblems; readRounds; one vote per company; superseded
files never read; key handling; principle 8; principle 5.

## Objections and risks (reviewer)

- Vote files are unauthenticated: any process that can write in the pack folder — including the layer-1 agents that
  cut packs — can write vote files that tally, closeRound and the desk count. The founder's per-item confirmation is
  the remaining guard; decide before automatic approval (decision 0003).
- The isolation rests on flag behaviour of a self-updating vendor tool; F1's version list makes that a visible stop.
- A subscription vote records cost 0; if the CLI login were ever an API account it would be billed and still say 0.

## Not verified

Real CLI behaviour (F2, context added, files written under ~/.claude, modelUsage keys); smoke output not in docs/log;
HTTP adapters, rest of desk/pack, judge prompt, decision 0016; macOS/Linux path logic.

## Coordinator's decision

- No real votes until F1–F3 are fixed and F2 is probed in the founder's terminal.
- Split by file, one writer each: claude-cli.js / codex-cli.js / smoke script (F1, F2 probe and fix, F4, F8, nits) →
  the developer who built the CLI judge; jury.js / pack.js (F3, F5, F6, F7, F9, R2 route) → the developer who built
  the channel setting. Then this reviewer re-checks.
- Vote-file authentication goes to the board as a decision before any automatic approval.

# Re-check 1 (same day): SEND BACK for F2 only; everything else passes

Smoke run in the founder's terminal (CLI 2.1.330): 8 checks PASS (vote, model, no tools by model and by the tool's
init report, empty cwd, our system text first after the verified prefix, prefix recorded, adapter refuses an @path
prompt); with the refusal switched off, **both canaries leaked** and input tokens jumped (13,907 vs 790): Claude Code
expands @path mentions itself, even with `--tools ""` and `--safe-mode`. F2 is real.

- **F2a High.** The refusal regex stops at a quote/apostrophe: `@d'abord/../../../../Users/x/.claude/.credentials.json`,
  `@l'annexe\..\..\x`, `@a"b/../../../x` are sent (path resolution is lexical). Ask: normalise (NFKC, drop format
  characters); for every `@` take the whole run to the next whitespace (or the closing quote) and refuse if it starts
  with ~ / \ . $ % or a drive letter, or contains `..` anywhere; keep refusing, not rewriting.
- **F2b Medium, unverified.** Zero-width space, fullwidth ＠, ～, ／ forms pass the raw-text check; harmless only if the
  tool doesn't normalise. Second layer worth a probe: a Read deny rule via `--settings`, tested with the canaries.
- **F2c Medium.** The smoke script can never pass (refusal-off canaries always leak by design): record that as a fact
  about the version; make pass/fail the bypass forms being refused and, if adopted, canaries not leaking with the deny
  rule on.
- **F2d Low.** A pack whose text would be refused is only found at vote time; `pack.js pack` should report it.
- Stronger isolation: a separate home/config does not help (the login must be in it; absolute paths ignore home);
  real containment = an OS boundary (new part, not before needed). For launch: tightened refusal + deny-rule layer if
  it works + reply guard + the founder reading every vote are enough; before automatic approval they are not. The
  simplest full fix exists: set anthropic to `api` (HTTP, no harness) — a cost trade for the founder.
- **Codex judge: same probe needed, exposure larger** — its model has a read-only file sandbox, so an injected line can
  just ask it to read a file. Ask: a Codex smoke with the canaries (@ mention and a plain "copy the contents of
  <path>"); if Codex reports tool activity as events, refuse any vote whose run read a file or ran a command.
- F1, F3, F4, F5, F6, F8, F9, R2: PASS. F7 PASS with a residue (`format: "2"` or no format read as format 1).
  Low: initProblems ignores extra init fields; hand-typed tool_version; a stale comment.
- Principle 4: F2 has had one fix; a second failed fix triggers the circuit breaker.

## Coordinator's decision

- F2a–c and the Codex probe/refusal → the CLI-judge developer; F2d and the F7 residue → the jury-side developer.
- The subscription-vs-API trade for the judges goes to the founder on the board.
- No real votes until F2 passes.

# Re-check 2 (same day): F2 PASS; Codex event check SEND BACK (C1–C3); C4 to the founder

Smoke runs in the founder's terminal: Claude 2.1.330 all 10 checks PASS (every @ form refused without a call; deny
rule on: no canary, 784 vs control 789 tokens; without anything stopping it the tool reads @ files: 13,894). Codex
0.172.0 (installed on the real system today; earlier Codex runs were from the coordinator's sandbox): control, @
mention and plain "copy the contents" probes PASS (model answered without tools, +51/+54 tokens); with --json the
model name is not reported.

- **F2 PASS.** The rule follows how a path resolves; every earlier bypass refused; second layer (Read deny rule)
  probed on the real tool; 0 of 20 existing packs refused. Low: enforce `denyBlocksMentions` in the adapter; the smoke
  "INCONCLUSIVE" branch would block adding a safer version.
- **C1 Medium.** Only `item.*` events are judged; other event kinds (exec_command_begin, tool.started, two turns) pass.
  Allow-list event types and require exactly one completed turn.
- **C2 Medium.** The refusal has never fired on the real tool (the model declined on its own). Add a positive control:
  ask Codex directly to run a harmless command / read canary A; PASS only if the adapter refuses.
- **C3 Low–medium.** Error items accepted unread (a reroute notice would pass); Codex version not recorded. Keep error
  messages in raw.run, accept only known-harmless ones; record `codex --version` (or pin like Claude).
- **C4 (founder).** Codex votes cannot report the answering model. Record honestly (`model_reported: false`, judge.md
  says "requested, not confirmed"); founder chooses: accept for OpenAI on subscription, or OpenAI on the API.
  Reviewer: accept for launch, not for automatic approval.
- Objections: Codex is the weaker judge by construction (its model can read files; we only see it afterwards) — if one
  judge moves to the API for safety it should be OpenAI, not Anthropic. Sandbox-made Codex votes must be re-made.
  An untracked `.codex/agents/` folder appeared (now excluded locally, not committed).

# Re-check 3 (same day): Codex part PASS — item 6 passes as a whole

First positive control on 0.172.0: a blocked action emits no command/file item; traces are the re-sent context
(input ~17k → ~35k) and a second agent_message. Rule added: exactly one completed agent_message. Second smoke run:
control, mention (+49), plain (+50) accepted with no canary; positive control refused ("2 answer messages"). C1–C4 and
the Claude low items PASS.

- **D1 (low–medium, follow-up, not blocking):** a blocked action with no preamble leaves one answer message and is
  accepted; use the doubled input tokens (per-version overhead from the smoke control + generous prompt estimate +
  margin) as a second check; meanwhile record `actionsBlocked: true` in the 0.172.0 entry.
- Low: re-check Codex run facts when a vote file is read (as for Claude); stale 0.171.0 header comment.
- Objections: Codex safety on this machine rests mainly on its own execution policy, seen in one run on one version;
  the adapter detects, it doesn't prevent. "Model not confirmed" for OpenAI still awaits the founder (fine for launch,
  not for automatic approval). Sandbox-made Codex votes must be re-made.
- D1 and the low items can go to an ordinary Opus review. Tag after commit: fable-cli-judges-2026-11-24.
