# 0018. Cost discipline until launch

- Date: 2026-11-24
- Decided by: the founder ("All of them"), after the usage review of 2026-11-24
- Principles: 5 (keep it simple), 4, 8 (self-funded)

## Why

Usage review of the coordinator session (2026-11-21 to 2026-11-24), effective usage (cache reads 0.1×, cache
writes 2×, output 5×), about 235M in total: developer agents ~46% (47 agents; the record format changed 9 times),
the coordinator conversation itself ~37% (1,262 turns, each carrying the long context), Fable reviews ~10%
(17, many re-checks of the same item), Sonnet helpers ~4%, blog extraction ~3%, code reviews ~1%. At this rate the
subscription would run out before the weekend.

## Rules until launch (5 December 2026)

1. **A fresh coordinator conversation**, started from docs/log/2026-11-24-handoff.md, the board, decisions and logs —
   not from this long one. Start a fresh one again whenever a conversation gets long.
2. **Architecture frozen.** No record-format change, no new judge. Mistral stays parked (code kept, off, unverified)
   until after launch. Only launch work: confirming verdicts, cutting packs, voting, the site.
3. **Review by level.** Fable only for changes that can alter the public record (ledger, schema, judge prompt,
   publication rules). Everything else gets one Opus code review. One re-check at most; if it still fails, the
   coordinator decides, records the risk, and moves on (or stops the item).
4. **Fewer, bigger agent tasks.** One agent per coherent piece of work, briefed with everything it needs, rather than
   many small ones that each re-read the project.
5. **Sonnet for rule-following batch work** (cutting packs, transcription, extraction); Opus for design and hard
   problems; Fable as in rule 3.
6. **Board updated two or three times a day**, progress reported in batches, not after every small result.
