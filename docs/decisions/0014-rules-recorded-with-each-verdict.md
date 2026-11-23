# 0014. Rules keep evolving; every verdict records the rules it was judged by

- Date: 2026-11-23
- Decided by: the founder, in chat: "边做边定。在结论的同时也记下判断用的规则" (decide as we go; record the rules used
  for the judgment together with the conclusion). Answers board item `freeze-rules` ("Keep deciding as we go").
- Recorded by: coordinator. Principles: 1, 3, 2.

## Decision

1. Verdict rules are not frozen before launch; they are decided as real claims need them.
2. Because rules change, each verdict carries the rules it was judged by, so an old verdict can always be read against
   the rules of its day, and a rule change never silently rewrites the past (principle 3: one ruler at a time, and
   visibly which one).

## How (coordinator's technical choice; cost stated per the retrospective of 2026-11-23)

- **Rule ids.** Every rule in `docs/methodology/verdict-standard.md` gets a stable short id (for example `DL-1` the
  deadline day is inside the deadline, `DL-2` the state at the deadline counts, `RN-1` a renunciation ends the wait,
  `EA-1` early came true for an act once done). Ids are never reused; a changed rule gets a new id. The standard's
  version number goes up with every change, and each version stays readable (git tag `rules-<version>`).
- **Judges name the rules they applied** (`rules_applied`, ids from the standard) in every vote; the program checks the
  ids exist in the current version.
- **The verdict records** `rules_version` and `rules_applied`; the founder sees and can correct them at the desk. They
  go into the ledger snapshot, so the public record keeps them for good.
- **The site** shows, under each verdict, the rules applied in plain words with a link to the rule text of that
  version.
- **Cost:** record format 12 (two fields + snapshot), a judge prompt version, a desk field, a site line, one Fable
  review. Done as one brief after the pack-rules/judge-0.7 pass now running, so it is not mixed into that work.

## Objections and risks

- More for judges to get right: a wrong rule id is a new way to lose a vote. The check keeps it to ids that exist;
  whether the right ones were named is for the founder at the desk.
- Rules without an id (common sense, wording) are still applied; `rules_applied` lists the rules that decided the
  verdict, not every rule that was read.
