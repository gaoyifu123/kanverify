# Fable 5.2 review 6: pack prompt (pack-0.1) and judge prompt changes (judge-0.5 → judge-0.6)

Date: 2026-11-23. Reviewer: code reviewer on Fable 5.2. Saved by the coordinator (the reviewer cannot write files);
condensed from the report, every finding kept. `npm test` 292/292; probes run with checkPack/voteProblems on an
in-memory database; live database not opened.

## Result: SEND BACK (both)

- pack-0.1 points the right way, but a cutter can still steer the verdict (renunciation, dropping a whole source, the
  limits), and nothing in it is enforced by the program yet.
- judge-0.6: one founder rule is self-contradictory; two disagree with what voteProblems enforces.

## Part 1 — pack-0.1

- **A1 High.** The pack prompt doesn't know the renunciation rule, yet the program ends the wait whenever a source of
  kind renunciation is in the pack. Rule 4a ("bears on the criteria") lets a cutter leave the renunciation out
  (unanimous pending) or include a mere "postponed" labelled renunciation (pending refused for all). It also never asks
  for the state at the renunciation date. Needed: one rule for renunciation sources (always excerpt the abandonment
  whole; excerpt what was done by its date; if not an explicit abandonment, stop and report).
- **A2 High.** A whole source can be dropped unnoticed: the list of given sources exists only in the dispatcher's
  message (probe: decisive audit source omitted → "pack OK"). Needed: the program writes the start of the pack (claim
  from the record, given source ids, session id, prompt version) and checkPack compares against it. This also settles
  the session-id problem.
- **A3 High.** Rule 4c says what to drop first, not what to do when that is not enough; the cutter then chooses freely
  under the 12-excerpt / 5,000-token limits (case: a suspension article dropped "for the limit" → unanimous came_true).
  Needed: a relevant, non-repeat passage is never dropped for the limits; stop and report.
- **A4 High, blocks use.** Nothing of pack-0.1 is enforced: `units` doesn't exist; checkPack ignores prompt_version,
  session, read. The planned regex accepts any old version; compare with the current prompt version as checkVote does.
- **A5 Medium-high.** Truncation passes at both ends ("2,4 millions" from "42,4 millions"; "atteint 100 %" from "n'a
  pas atteint 100 %"; "la cible est atteinte." without "Le ministre a déclaré"; "0,3 %" from "-0,3 %"). Needed in the
  program: refuse excerpts starting/ending inside a word or number or right after a sign; flag non-boundary excerpts at
  the desk. 5b lacks attribution, negation, forecast qualifiers; tables (row + header); qualifying sentence over 1,500
  characters.
- **A6 Medium.** Order and duplicates unenforced (reverse order, triple duplicate → "pack OK"); "order as given" is the
  fetch role's "strongest first". Needed: fixed order applied/checked by the program; overlapping excerpts refused.
- **A7 Medium.** A pack can be cut from a source with missing pages (source-4-text.json lacks pp. 5–6, cited in
  c1-1-27) or with a figure the cutter doubts (the note goes to gaps, judges don't see it). Needed: stop and get the
  transcription fixed first.
- **A8 Medium.** No rule for "nothing bears on the criteria"; checkPack refuses 0 excerpts, so the cheap fix is a
  marginal excerpt. Needed: stop and report; decide who records pending/to_evaluate for a searched-but-empty item.
- **A9 Low-medium.** `read` is declared: the desk must say "declared read". Rule 2's two lists should be a pack field
  hidden from judges so spot checks can compare. Review 5's condition (non-Anthropic reader before auto-approval) stands.
- **A10 Low.** PDF locators: the program checks pdf_page only; law labels are `art. N` etc.; the name ban is one string
  comparison (name in gaps → "pack OK"); a renunciation on a prediction belongs in considered_not_used.

## Part 2 — judge-0.6

- **B1 High.** Early came_true contradicts itself: "done once done (a law passed)" vs "can be repealed … pending" —
  every law can be repealed (c5-1-112). The program can't arbitrate. Needed: a test on what the criteria name — an act
  (pass, sign, build, open) is early came_true once done; a state that must hold at the deadline (a rate, an age in
  force, a tax abolished) waits. The founder confirms the wording (same text in decision 0013 and verdict-standard).
- **B2 High.** A judge citing the renunciation under partly_came_true/came_true loses the vote (pack.js line 349). Fix
  together with record format 11 (allow it next to result evidence) or tell judges not to cite it.
- **B3 Medium-high.** The program ends the wait on the kind label; the prompt lets the judge decide whether it is a
  renunciation. "Nous reportons cet objectif" labelled renunciation → a correct pending is voided. Undated/pre-claim
  renunciations: the date conditions are not in the prompt. Needed in 2e: the date conditions, and what to vote when a
  renunciation document isn't an explicit abandonment (to_evaluate is accepted).
- **B4 Medium.** 2e moves the measuring date later when the renunciation comes after the deadline. 2e must apply only
  to a renunciation on or before the deadline.
- **B5 Medium.** Renounced, excerpts silent: 3d says not_came_true; step 4 says not_came_true needs positive evidence
  and silence is to_evaluate. State the exception once in step 4's not_came_true bullet.
- **B6 Medium.** 2d has no rule when no passage gives the state at the deadline (figures before and after only). One
  sentence on which figures may stand for it; otherwise to_evaluate naming the missing date.
- **B7 Low.** Leftovers: the pending row in the table; source-rule lines 33, 56–58 and evidence-prompt 55–57 ("before
  the deadline", "only did not come true"); verdict-standard table line 52; prompt notes cite source-rule 0.4.

What holds: each rule has one home; renunciation is no longer a verdict in the table; the vague/hedged exception
matches voteProblems; the deadline-day rule is intact; probes consistent for partly (figure only), not_came_true
(renunciation alone), to_evaluate, and pending refused after a renunciation.

## Objections and risks (reviewer)

- A promise renounced in 2023 and then delivered in 2026, before its 2027 deadline, is not_came_true under 2e + 2d;
  the delivery appears only in the summary. Faithful to decision 0013's words; the founder should confirm he means it.
- B1 is a contradiction in a founder decision; it goes to the board.
- pack-0.1 narrows the honour system, doesn't end it.
- Principle 4: the renunciation rule now lives in eight places; B2, B3, B7 are drift. Fix in one pass with format 11.
- Task card disagreements: item 5 not optional and covering the start; item 3 needs the program-written list; item 2
  compares with the current version.

## Not verified

No model called (B1, B5, B6 are predicted splits); format 11, ledger, schema not reviewed; trial packs not probed;
desk handling of rewritten claim fields not tested (checkPack itself accepts them); units/coverage/read don't exist
yet; fetch.md not read; printed page numbers in PDF transcriptions not checked.

## Coordinator's decision

- B1 and the "renounced, then delivered" consequence go to the founder (board).
- A8, decided by the coordinator (technical, principle 1): a searched pack with nothing relevant is not cut; the item
  gets `pending` before the deadline / `to_evaluate` after it, with the search record as its "what is missing",
  confirmed at the desk without a jury vote. The founder can overrule on the board.
- Everything else in one pass after record format 11 lands (principle 4): pack-0.2 with a program-written pack header,
  checkPack enforcement (A2, A4–A7, A10), the `units` command, judge-0.7 (B2–B6), doc drift (B7). Then this reviewer
  re-checks once.
