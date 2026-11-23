# Fable review 5 — top-level design critique (jury, evidence packs, calibration)

Reviewer: Fable 5.2. Date: 2026-11-23. Saved by the coordinator. Read-only, nothing run.

**Verdict:** safe to launch only while the founder confirms every item, and only with fixes 1–3. Not yet a basis for automatic approval.
The independence question is aimed at the wrong place: the decisive judgement is made by the one layer-1 agent that cuts the evidence pack; no judge of any vendor can see an omission.

## Ranked risks and cheapest fixes
1. **Pack cutting has no written rules, version or check** (biggest). Omission/truncation/labelling all pass `checkPack`; before the deadline a thin pack yields a unanimous `pending`. Fix: `team/run/pack-prompt.md` (versioned; search met and not-met equally; excerpt to the end of the qualifying sentence; list every source opened); `checkPack` requires `made_by.prompt_version`; the program computes coverage per cited source and shows it at the desk. Before auto-approval: a non-Anthropic reader checks the full cited sources for a passage that would change the verdict.
2. **Calibration measures agreement produced by construction** (vague/hedged forced to `unverifiable`, `pending` default; founder anchored by pre-selection; misses not counted). Fix: count only measurable outcome verdicts (+ early came_true); blind-first for those (votes hidden until the founder picks); send-back/reject/rewritten summary on a unanimous item counts as a miss; 1 in 5 opens the original. Founder's call (changes decision 0003's counting).
3. **The Claude vote is on the honour system** (a project subagent with file tools, sees CLAUDE.md etc.; broken once). Fix: run Claude non-interactively like Codex from an empty temp folder (needs the Claude Code CLI; terms unverified); until then `tally` refuses a Claude vote whose `made_by` matches the dispatching session.
4. **PDF "verbatim" checks rest on a Claude transcription.** Fix: second, non-Anthropic transcription of cited pages with a digit diff, or the desk requires opening the original for PDF evidence with figures.
5. **Source labels are layer-1 free text the program trusts.** Fix: show kind and publisher beside each excerpt at the desk with a one-key "wrong kind" send-back; founder ticks each `official` publisher on first use; don't list the neutrality review as a control until it exists.
6. **Launch readiness:** no votes under judge-0.5 yet; Gemini never voted; rules 4c/7/11 open; volume 0 of 100–200. Fix: decide rule 11; skip pack and jury for vague/hedged items (verdict forced); launch with every item's record but outcome verdicts only on the 20–40 checked against originals; don't publish `pending` for items nobody searched.

## What holds
Votes bound to pack hash, prompt version and system hash; quotes inside one excerpt; speaker name hidden; no pre-selection on a split; judges don't see the unused list or gaps (keep it that way).
