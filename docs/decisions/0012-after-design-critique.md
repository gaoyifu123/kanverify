# 0012 Changes after the Fable design critique (review 5)

- Date: 2026-11-23
- Status: coordinator decided items A; items B wait for the founder (board).
- Basis: `docs/log/2026-11-23-fable-review-5.md`; principles 1, 2, 3, 5, 7.

## A. Decided by the coordinator (technical)
1. **Pack cutting gets written, versioned rules:** `team/run/pack-prompt.md`; `checkPack` requires `made_by.prompt_version`; the program computes coverage per cited source (units excerpted / not excerpted / not transcribed) and the desk shows it.
2. **Claude vote integrity, interim:** `tally` and the desk refuse a Claude vote whose `made_by` session equals the session that cut the pack; judge-subscription instructions say so. Long-term: run Claude like Codex (needs the founder's OK to install the Claude Code CLI).
3. **PDF figures:** until a second, non-Anthropic transcription exists, the desk requires opening the original (key O) before confirming a verdict whose PDF evidence contains figures.
4. **Source labels at the desk:** kind and publisher beside each excerpt, one key to send back "wrong kind"; the first use of each `official` publisher needs the founder's tick.
5. **Vague/hedged claims skip pack and jury** — their verdict is forced to `unverifiable` by the rules; the desk confirms them directly with a summary.
6. The neutrality review is not described as an existing control until it is built.

## B. For the founder
- How the 10/30/100 calibration counts (blind-first, which items count, what is a miss) — changes decision 0003.
- Launch scope: publish every recorded item, but outcome verdicts only on items checked against the originals; never publish `pending` for an item nobody searched.
- Install the Claude Code CLI so the Claude judge runs isolated like Codex.
