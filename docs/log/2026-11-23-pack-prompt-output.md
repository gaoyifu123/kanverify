# Output: pack-0.1 (team/run/pack-prompt.md) — developer, 2026-11-23

Saved by the coordinator from the developer's report.

## Task card for later (after record format 11 lands)

1. `node src/pack.js units <source_id>`: print the units from `sourceUnits` (numbers, labels, untranscribed units).
   Needed because the agent cannot otherwise know the program's unit numbers; locators and coverage depend on them.
   The prompt cannot be used until this exists.
2. checkPack requires `made_by.prompt_version` (`/^pack-\d+\.\d+$/`) and a non-empty `session`; the session check in
   rules.js then refuses a pack with no session.
3. checkPack checks the new `read` field (each given source once; `units` "all" or ranges; `not_read_why` when not all;
   each source in `read` also in `sources` or `considered_not_used`).
4. Coverage per source (excerpted / read not excerpted / not read / not transcribed), shown at the desk with the prompt
   version next to "Clipped by" (decision 0012 item 1).
5. Optional: warn when an excerpt does not end at a sentence end.
6. Tests for each.
7. The ten trial packs have no prompt_version/session: re-cut them under pack-0.1.

## Objections and risks (developer)

- The agent cannot know its own session id; for a Claude subagent it may be the parent session, so the cutter and a
  Claude judge from the same session look identical. The program, not the agent, should stamp the session.
- Equal effort stays on the honour system; coverage makes omissions countable, not visible.
- checkPack requires `claim.speaker`; kept (judgeView strips it), name banned everywhere else.
- "Read every unit" plus the 5,000-token limit may push long sources to under-coverage (now shown as "not read").
- Search breadth stays with the fetch role; coverage measures the pack, not the search.
- `made_by.role` kept as "evidence".
