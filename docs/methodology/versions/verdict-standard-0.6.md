# Verdict standard

Version 0.6 (2026-11-23)

0.6: the founder's three standards (decision 0015) head the file, and every rule cites the standard it comes from;
every verdict rule has a stable id (decision 0014) and is listed once, in the tables "Standards" and "Rules" below;
the renunciation rule is one truth table (RN-1): an explicit, precise public reversal of the same promise by the same
speaker, between the day it was made and its deadline, means it did not come true (decision 0013 amendment;
decision 0015 S1 as narrowed by the founder: anything less precise is a separate claim; predictions excluded).
ST-2 gives VG-3: a prediction states its own time range or is vague.
Rewritten in English (working language). Everything that applies these rules
(db/schema.sql, src/rules.js, src/pack.js, src/ledger.js, the desk, team/run/judge-prompt.md, team/run/pack-prompt.md,
source-rule.md) is derived from this file and cites the rule ids. 0.5: wording aligned with decision 0013 (Fable
review 6, B7). 0.4: decision 0013. 0.3: six verdicts, early "came true" (decision 0008 revision).

Still a draft: not yet tested on real items. Planned: tested on all items of the first country and compared with
existing trackers, then raised to 1.0.

**Versions.** Rule ids are never reused; a changed rule gets a new id. Every change raises the version number. Each
verdict records the version and the ids it was judged by (`verdicts.rules_version`, `verdicts.rules_applied`, in the
ledger snapshot). When the version changes, the old file is first copied unchanged to
`docs/methodology/versions/verdict-standard-<old version>.md`, so the site can still show the rules of every published
verdict (src/standard.js reads it), and the commit is tagged `rules-<old version>`.

## Standards

Decision 0015 (founder, 2026-11-23). Every judgment keeps to these three; every rule below comes from one of them.
The founder calls them S1, S2, S3; their ids have the same form as the rules' (ST-1, ST-2, ST-3), so judges can name
them in `rules_applied` and the site can show them like any rule.

| id | rule | règle |
| --- | --- | --- |
| ST-1 | S1, words are gold: we check what was publicly said, then and now; only an explicit public reversal of the same promise by the same speaker negates it. | S1, la parole est d’or : nous vérifions ce qui a été dit publiquement, hier comme aujourd’hui ; seul un revirement public explicite du même auteur sur la même promesse l’annule. |
| ST-2 | S2, history moves in cycles: a promise is judged over the time its maker has the power to keep it, a prediction over its time range. | S2, l’histoire a ses cycles : une promesse est jugée sur la période où son auteur a le pouvoir de la tenir, une prédiction sur sa période. |
| ST-3 | S3, common sense: claims and evidence are read with common sense, not legalistically, and the final result at the deadline counts. | S3, le bon sens : affirmations et preuves sont lues avec bon sens, sans juridisme, et c’est le résultat final à l’échéance qui compte. |

- **ST-1** gives RN-1 (section 5). It also means the claim is what was said, quoted verbatim (section 1), and that a
  later statement which does not exactly reverse it is a claim of its own, recorded and judged in turn.
- **ST-2** gives the deadlines (section 3): a stated deadline; for a campaign promise without one, the end of the term
  campaigned for (`inferred`); for a prediction, the end of its time range.
- **ST-3** governs how judges read everything below: the plain meaning of the claim and of the evidence, not a
  technicality in either; and the result at the deadline (DL-2), not the effort (OC-3). The rules below never require
  a legalistic reading; where a rule and common sense seem to disagree, the judge says so in `reasoning`.

## Rules

The table is what programs read (src/standard.js, together with the "Standards" table): one row per rule, the id, then
the rule in plain words in English and in French. The sections after it give the detail. Judges name the ids that decided their verdict in
`rules_applied` (team/run/judge-prompt.md); the site shows them under each verdict.

| id | rule | règle |
| --- | --- | --- |
| VG-1 | A vague or hedged claim is “unverifiable”, at any date, even if its speaker later reversed it. | Une affirmation vague ou prudente est « invérifiable », à toute date, même si son auteur l’a reniée ensuite. |
| VG-2 | A measurable claim is “unverifiable” only if a condition attached to it did not arise by the deadline. | Une affirmation mesurable n’est « invérifiable » que si une condition posée ne s’est pas réalisée à l’échéance. |
| VG-3 | A prediction must state its own time range: without one it is vague, and a prediction never gets an inferred deadline (ST-2). | Une prédiction doit fixer elle-même sa période : sinon elle est vague, et une prédiction ne reçoit jamais d’échéance déduite (ST-2). |
| DL-1 | The deadline day itself is still within the deadline. | Le jour de l’échéance fait encore partie du délai. |
| DL-2 | After the deadline, the state on the deadline counts; what happened later is only mentioned. | Après l’échéance, c’est l’état à l’échéance qui compte ; la suite est seulement mentionnée. |
| DL-3 | Before the deadline the verdict is “pending”, unless EA-1 or RN-1 applies. | Avant l’échéance, le verdict est « en attente », sauf si EA-1 ou RN-1 s’applique. |
| DL-4 | After the deadline a verdict is never “pending”: without enough evidence it is “to be assessed”, saying what is missing. | Après l’échéance, jamais « en attente » : faute de preuves suffisantes, « à évaluer », en disant ce qui manque. |
| EA-1 | “Came true” may be given before the deadline once the evidence shows the criteria fully met, even if it could later be undone. | « Réalisée » peut être donné avant l’échéance dès que les preuves montrent les critères entièrement remplis, même si cela peut être défait ensuite. |
| RN-1 | A promise its speaker explicitly and publicly reversed between the day it was made and its deadline did not come true, unless it was already fully met before; a postponement or a changed figure is a separate claim. | Une promesse que son auteur a explicitement et publiquement reniée entre le jour où il l’a faite et son échéance n’est pas réalisée, sauf si elle l’était déjà entièrement ; un report ou un chiffre modifié est une affirmation distincte. |
| EV-1 | An outcome needs one official document, or two independent sources from different publishers. | Un résultat demande un document officiel, ou deux sources indépendantes d’éditeurs différents. |
| EV-2 | Statements are leads, never evidence, whoever made them; an official body assessing its own work is a statement. | Les déclarations sont des pistes, jamais des preuves, quel qu’en soit l’auteur ; un organisme public qui évalue son propre travail fait une déclaration. |
| EV-3 | Silence is not evidence: “did not come true” needs a passage that shows the criteria not met (RN-1 aside). | Le silence n’est pas une preuve : « non réalisée » demande un passage qui montre les critères non remplis (sauf RN-1). |
| OC-1 | “Came true” means every criterion fully met; a bundle of measures needs every measure. | « Réalisée » veut dire tous les critères entièrement remplis ; un ensemble de mesures les demande toutes. |
| OC-2 | “Partly came true”, after the deadline: a result on the measure that falls short of the whole, with the figures. | « Partiellement réalisée », après l’échéance : un résultat sur la mesure, inférieur au tout, chiffres à l’appui. |
| OC-3 | Steps toward a result (a bill tabled, money announced) are not a result. | Des étapes vers un résultat (un projet de loi déposé, des crédits annoncés) ne sont pas un résultat. |

Which rules a program checks, and where: see "Where each rule is applied" at the end.

## 1. What is recorded

A **promise** (or prediction) is a forward-looking statement of a verifiable action or result.

- Recorded: "Raise the legal retirement age to 65 during the term."
- Not recorded: slogans and statements of values ("make the country fairer"), descriptions of the present, criticism
  of others.

The first layer is mechanical: every statement in a platform that fits this definition is recorded, none is picked.
Importance and ease of checking are not reasons to skip one.

## 2. Verifiability (VG-1, VG-2)

| class | meaning | handling |
| --- | --- | --- |
| `measurable` | a measurable result and a deadline | criteria written at recording time; judged at the deadline |
| `vague` | a clear direction, no measurable result | recorded; verdict "unverifiable" (VG-1) |
| `hedged` | reserved wording ("seek to", "strive to") | recorded; verdict "unverifiable" (VG-1) |

`vague` and `hedged` items do not count as right or wrong; they count towards how much of a person's words can be
checked. **VG-1** holds at any date and also when the speaker later reversed the claim; the summary mentions the
reversal (RN-1, row 2). **VG-2:** on a measurable claim, "unverifiable" has one use only: a condition attached to
the claim ("if growth exceeds 2%") did not arise by the deadline, and evidence shows it did not. It waits for the
deadline like any other verdict (DL-3) and needs evidence (EV-1). "Unverifiable" is about the wording, never about
missing evidence.

**VG-3** (ST-2; founder, 2026-11-23, decision 0015 question 2). A prediction is a judgement about how the world works,
not tied to an office, so nothing gives it a deadline but its own words. A prediction that does not itself state a
clear time range is recorded as `vague`, so its verdict is "unverifiable" (VG-1). A prediction never has an
`inferred` deadline; the record format refuses one (db/schema.sql, claims).

## 3. Deadlines (DL-1 to DL-4)

From ST-2: a claim is judged over the period it belongs to.

- The deadline stated in the text is used (`stated`). A campaign promise without one gets the end of the term
  campaigned for, the period in which the speaker has the power to keep it (`inferred`), shown as inferred on the
  site. An inferred deadline is a deadline like a stated one. Promises only: a prediction is judged against the time
  range it states itself, whose end is its (`stated`) deadline; without one it is `vague` (VG-3).
- Reading of wordings (founder, 2026-11-22): "d'ici 2027" counts as 2027-12-31, literally; "fin de la décennie" as
  2030-12-31.
- **DL-1.** The deadline day is inside the deadline. "Before the deadline": the date of judging (the judge input's
  date; the date of confirmation) is on or before the deadline. "After the deadline": it is later.
- **DL-2** (decision 0013; ST-3, the final result). After the deadline, the verdict judges the state at the deadline. What happened after it
  (met late; met and undone) goes in the summary and does not change the verdict. When the criteria name a level, the
  state at the deadline is shown by a passage dated on the deadline, about a period ending on it, or saying the level
  held on that date; a figure dated before the deadline counts only if the passage says it still applied then. With
  figures only before and after the deadline, the verdict is "to be assessed" and the open question names the date
  whose figure is missing.
- **DL-3.** Before the deadline the only verdicts are: "came true" under EA-1; "did not come true" under RN-1;
  "unverifiable" under VG-1; otherwise "pending", whatever has or has not been done, and also when the evidence is
  not enough to tell. "Partly came true" and "to be assessed" wait for the deadline.
- **DL-4.** After the deadline the verdict is never "pending". Evidence not enough to decide gives "to be assessed",
  which says where it is stuck and what is missing (principle 1).

## 4. Early "came true" (EA-1)

Decision 0013, amendment ("achieved once = achieved"): before the deadline, "came true" is given as soon as the
evidence shows the criteria fully met (OC-1), whether the result could later be repealed or undone or not. No test of
"act or state". What happens afterwards is a new fact for the summary of a later confirmation, not a reason to wait.

## 5. Public reversal by the speaker (RN-1)

From ST-1, "words are gold" (decision 0015, as narrowed by the founder on 2026-11-23: "what is said now is gold, what
was said then is gold"), on top of decision 0013's amendment ("giving up = did not come true"). A later **public**
statement by the **same speaker** negates a claim **only if it explicitly and precisely reverses that same claim**:
the same measure, the same scope, said not to be done, or the opposite said. Then, if it is dated on or after the day
the claim was made and on or before its deadline, the verdict is "did not come true", whatever was done in part. It
may be the only evidence (EV-3 does not apply). It stays "did not come true" if the result is delivered later; the
delivery is mentioned in the summary. A reversal after the deadline changes nothing (DL-2). From "achieved once =
achieved" (EA-1): criteria fully met before the reversal → "came true".

Anything less precise is **not a negation** but **a separate claim**, recorded and judged on its own: a postponement
(a new date), a changed figure, a softer or hedged wording, a partial step back, a statement on a topic that is not
exactly the same. The earlier claim is judged by the other rules, at its own deadline.

The source kind stays `renunciation` (db/schema.sql, source-rule.md): it is the speaker's explicit public reversal of
the claim. Renaming it would touch the record format, every prompt and the site for no change in what is stored.

**Which claims it applies to: promises only** (founder, 2026-11-23, decision 0015 question 1: a person may revise a
prediction every month; each prediction is a separate claim judged on its own against the outcome, and a later
revision never negates or replaces an earlier one: "words are gold, we weigh them all"). Grouping a person's revised
predictions into a series is a later item, not part of 0.6. This one line is the switch: the programs hold the same list once each (`REVERSAL_TYPES` in src/rules.js; the `c.type IN (...)`
lists of `outcome_has_evidence` and `evidence_is_primary` in db/schema.sql; a test checks that they agree). A type
taken off the list falls under row 1.

**Truth table.** This table is the single statement of RN-1. R is the date of the reversal (`sources.published_on`),
"said" the day the claim was made (`claims.said_on`), "today" the date of judging: the judge input's date for a vote,
the date of confirmation for the ledger. With more than one reversal, the earliest one that falls in row 4 or 5
counts.

| row | claim | the later statement | criteria fully met before R | verdict | cite it? | the only evidence? |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | of a type not on the list above | any | — | by the other rules; it is a lead like a statement (EV-2) | never | — |
| 2 | `vague` or `hedged` | any | — | "unverifiable" (VG-1); the summary mentions it | never | — |
| 3 | `measurable` | a reversal, undated or R before said | — | it reverses nothing yet said: the evidence pack is refused until its date or kind is corrected | never | — |
| 4 | `measurable` | a reversal, said ≤ R ≤ deadline, R ≤ today | yes | "came true" (EA-1, OC-1); the summary mentions the reversal | never | — |
| 5 | `measurable` | a reversal, said ≤ R ≤ deadline, R ≤ today | no: nothing, a part, or done only after R | "did not come true", from R on, before or after the deadline; what was done in part, or later, goes in the summary | always | yes |
| 6 | `measurable` | a reversal, said ≤ R ≤ deadline, R after today | — | not yet: the other rules (before the deadline, "pending", DL-3) | not yet | — |
| 7 | `measurable` | a reversal, R after the deadline | — | changes nothing: the state at the deadline (DL-2) by the other rules; the summary may mention it | never | — |
| 8 | any | **a separate claim, not a reversal:** a postponement, a changed figure, a softer or hedged wording, a partial step back, a topic not exactly the same | — | the earlier claim is judged by the other rules; the later statement is recorded as a claim of its own (kind `statement` as a lead here); a document labelled `renunciation` that is one of these has its kind corrected and the pack is cut again | never | — |
| 9 | any | someone else's words (a minister, a spokesperson, a journalist), or no statement about the claim ("reconsidering", "studying") | — | not a reversal: a statement (EV-2); kind corrected if labelled `renunciation` | never | — |

What follows from the table, for the programs:

- In rows 4 and 5 only "came true" and "did not come true" are possible: not "pending", "partly came true", "to be
  assessed" or "unverifiable".
- A reversal is cited only in row 5, so it may stand among a verdict's evidence only under "did not come true", on a
  measurable claim of a listed type, dated said ≤ R ≤ deadline and R ≤ today. There it is enough evidence on its own
  (EV-1 is met by it).
- Whether the criteria were fully met *before* R (row 4 against row 5), and whether a statement is an explicit and
  precise reversal of the same claim (rows 5 against 8 and 9), are judgement: the judges, the neutrality review and
  the founder, not the program. In doubt, it is not a reversal (row 8).

## 6. The six verdicts (decision 0008 and its revision)

Promises and predictions share one set of verdicts.

| value | English | Français | when |
| --- | --- | --- | --- |
| `unverifiable` | Unverifiable | Invérifiable | VG-1; or VG-2 |
| `pending` | Pending | En attente | before the deadline (DL-3) |
| `to_evaluate` | To be assessed | À évaluer | after the deadline, evidence not enough (DL-4) |
| `came_true` | Came true | Réalisée | criteria fully met (OC-1); before the deadline too (EA-1) |
| `partly_came_true` | Partly came true | Partiellement réalisée | after the deadline, a result short of the whole (OC-2) |
| `not_came_true` | Did not come true | Non réalisée | after the deadline, criteria shown not met (EV-3); or reversed by the speaker (RN-1 row 5) |

- **OC-1.** A sentence that bundles several measures is "came true" only when every measure is done; some of them is
  "partly came true" (founder, 2026-11-22).
- **OC-2.** "Partly came true" needs a result on the measure the criteria use, short of the whole (64 of 65; 94% of
  100%; two of three bundled measures), after the deadline. The summary gives the figures. Never rounded up.
- **OC-3.** The result is judged, not the effort: a bill tabled and not passed is not "came true".
- **EV-1, EV-2, EV-3:** what counts as evidence is source-rule.md. A verdict about an outcome ("came true", "partly
  came true", "did not come true", and "unverifiable" on a measurable claim) needs one official document or two
  independent sources from different publishers (EV-1), or, for "did not come true", RN-1 row 5.
- Every verdict except "pending" has a one-sentence summary, in French and in English, saying what the evidence shows,
  not an opinion. "Unverifiable" and "to be assessed" are not negative judgements.

## 7. Criteria are written when the item is recorded

Every `measurable` item states at recording time what result counts as "came true" and which kind of evidence checks
it. The criteria are not changed after the result is known; a correction that is needed is recorded and public.

## 8. Wording

Published text describes results, never motives, with no emotive words. Not "lied", "betrayed", but "the deadline
has passed; the official gazette contains no such law". Came true and did not come true are said in the same plain
tone.

## 9. Who judges

1. The jury: at least two different models, each independently, without seeing each other's verdict.
2. The neutrality review: choice of items, wording, evidence.
3. The founder confirms each item before it is published.

Target: automatic approval when four models agree, after 10, then 30, then 100 items where unanimous jury verdicts
match the founder's confirmation at 99% (decision 0003).

## 10. Corrections

Anyone can ask for a correction. How the recorded person's reply is published is decided when there is a real case
(decision 0007). Every change to a published verdict is public, before and after, with its date.

## Not decided yet

- How predictions (as distinct from promises) are judged: baseline and minimum sample; how revised predictions of the
  same event are shown together (a later item; each stays a claim of its own).
- Whether a reversal by someone else than the speaker (a minister, a spokesperson) counts: not now (RN-1 row 9).
- How much of a result is "partly" rather than "came true", and how the summary says it: to be calibrated on real items.
- How many items a person needs before a ratio is shown; until then the person page shows counts per verdict.

## Where each rule is applied

| rule | program (refuses) | people (judge) |
| --- | --- | --- |
| VG-1 | schema `verdict_fits_verifiability`; vote check; the desk records VG-1 for vague and hedged items | — |
| VG-2 | schema `outcome_has_evidence`; deadline rule (`deadlineProblem`, src/rules.js) | whether the condition did not arise |
| VG-3 | schema: a prediction's deadline is never `inferred` (claims row check); extraction marks a prediction without a time range `vague` | whether the range is clear |
| DL-1, DL-3, DL-4 | `deadlineProblem`, used by `confirm()` and the vote checks | whether evidence is enough |
| DL-2 | — | which passage shows the state at the deadline |
| EA-1 | `deadlineProblem` lets "came true" through before the deadline | whether the criteria are fully met |
| RN-1 | schema `evidence_is_primary` and `outcome_has_evidence` (row 5 only; type on the list; date said ≤ R ≤ deadline); `futureEvidence` (R ≤ today); `deadlineProblem` (row 5 before the deadline); `checkPack` (row 3, and a reversal on a claim of a listed type is always excerpted); vote check `renunciationProblems` (rows 4 and 5: only "came true" or "did not come true", row 5 cites it, RN-1 named) | rows 4 against 5 (met before R?), rows 5 against 8 and 9 (an explicit, precise reversal of the same claim?) |
| ST-1, ST-2, ST-3 | through the rules that come from them | ST-3: how every passage and claim is read |
| EV-1 | schema `outcome_has_evidence`; vote check | whether each source establishes the fact itself |
| EV-2 | schema `evidence_is_primary`; vote check | whether an `official` document only assesses its own work |
| EV-3, OC-1, OC-2, OC-3 | — | yes |
| every rule | `rules_applied` ids must exist in the standard's current version (src/standard.js); schema `rules_recorded` | whether the right ids are named: the founder, at the desk |
