# Source rule: no evidence, no claim

Version 0.4 (2026-11-23). Restored and consolidated after the file was found reverted to an early 0.1 draft
(overwritten on 2026-11-22 around 17:06, cause unknown). Content follows the founder's decisions recorded in
`docs/decisions/0002`, `0008` (renunciation), `0011`, and the founder's board answers of 2026-11-21/22.
History: 0.1 first draft → 0.2 founder simplified evidence (one official document, or two independent media) →
0.3 an official body assessing its own work is not evidence → renunciation exception (promises only) → Légifrance API data.

We look at the evidence, not at who is speaking. The same rule applies to the speaker, governments, the opposition,
media and commentators.

## Four rules

1. **Claims only from the speaker's own words.** A promise or prediction is recorded only from material the person
   (or their own campaign) published, quoted verbatim with page or section.
2. **A verdict needs evidence:** one document issued by an official body, **or** two independent sources from
   different publishers that each establish the fact themselves.
3. **Statements are leads, not evidence.** Nobody's statement counts as evidence, including the speaker's own.
   If a statement points to evidence, find that evidence and cite it.
4. **No evidence, no verdict.** After the deadline the verdict is "to be assessed" (`to_evaluate`), stating where it
   is stuck and what is missing (principle 1).

## Kinds of source

| Class | `kind` in the database | Can it be evidence for a verdict? |
| --- | --- | --- |
| The speaker's own words: campaign platform | `platform` | No — only the origin of a claim |
| Anyone's words: speeches, press releases, interviews, comments; an official body's assessment of its own work | `statement` | No — a lead only |
| Documents issued by an official body: law, official gazette, official statistics, budget and accounts, parliamentary record, court ruling, audit report | `law` `gazette` `statistic` `budget` `parliament` `court` `audit` | Yes — one is enough |
| Other documents issued by an official body | `official` | Yes — one is enough |
| Independent, non-official: a news outlet's own reporting | `media` | Yes — but two from different publishers |
| Independent, non-official: research that publishes its raw data | `dataset_study` | Yes — but two from different publishers |
| The speaker's own public, explicit abandonment of a **promise** | `renunciation` | Only for "did not come true" on a promise; otherwise a lead |

The database enforces the table (`db/schema.sql`, `publication_checks`): a verdict about an outcome needs one official
document or two independent sources from different publishers; `platform` and `statement` are never accepted as evidence.

## What "two media, each establishing it" means

- **Each establishes it:** each outlet got the fact through its own reporting, investigation or checking.
- **Not counted:** reporting what someone said ("the minister said…", "the opposition claims…"). That is a statement.
- **Not two:** one outlet repeating another, or both quoting the same agency wire. That counts as one.
- The database can only check that the publisher names differ. Whether each outlet established the fact is judged by
  the jury and the neutrality review, and confirmed by the founder.

## An official body assessing its own work is not evidence (founder, 2026-11-22)

A government's or agency's press release or progress report saying "this promise has been delivered" is registered as
`statement`, not `official`. It is a lead: find the law text or data it refers to and cite that.
Test: does the document **record** something (a law, a budget figure, a statistic, a ruling) or **assess** how well the
body did? The first is evidence; the second is a statement. The kind label is necessary, not sufficient: a judge who sees
an `official` document that only assesses its own success treats it as a statement.

## Exception: the speaker's own public renunciation (founder, 2026-11-22; decision 0008)

Before the deadline, the speaker's own public, explicit words abandoning a **promise** are registered as `renunciation`
and may be the only evidence for "did not come true". Only for that verdict and only for promises; for predictions and
for every other verdict it is a lead like any statement. Anything unclear ("postponed", "reconsidering") is a `statement`.

## French law texts: Légifrance official API data (founder, 2026-11-22)

French laws and official gazette texts are taken from the Légifrance official API (PISTE, run by DILA). We store the
API's response and its hash, register it as `law` or `gazette`, and link to the public Légifrance page.
Stated plainly on the site: this is a copy from the official database, not the electronically signed gazette PDF
(the API terms say only the signed PDF has legal force). Disputed items can be backed by the signed PDF, downloaded
by the founder. The hash of the public page will differ from ours; that is known.

## Archiving

Every source is archived when registered: original file, original address, retrieval date and SHA-256.
A source without a hash cannot enter the database. If the page later disappears or changes, we can still show the original.

## The cost of this rule

- Judges must quote evidence verbatim; a vote citing only someone's statement is refused by the program.
- Whether something is a quote of someone else needs judgement; machines only do part of it.
- "To be assessed" will be more frequent than on other trackers. Acceptable, because each states what is missing (principle 1).
