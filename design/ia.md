# KANVERIFY information architecture — MVP spec

- Role: designer. Date: 2026-11-22. **Status: frozen for the MVP.** Brief: `DESIGN.md`; tokens:
  `tokens.md`; components: `components.md`; reference mockups: `design/mockups/`.
- Record format 9 (`db/schema.sql`). Six verdicts (decision 0008, revised).
- Round 4 (2026-11-22, coordinator on the founder's delegation): summary line on rows and cards,
  rows open in place, person page grouped by source document, dated chain on the item page. No change
  to the record format.

## 1. Data rules

- Input: the ledger only. `current_publications` (newest entry per claim) for every page except item
  history and Corrections, which read all of `publications`.
- "Current published set" = rows of `current_publications` with `status = 'published'`. Every list,
  count, chart and index uses this set and nothing else. Withdrawn claims never appear in it.
- A withdrawal entry's `snapshot` repeats the withdrawn content: the generator must never render it
  and must never copy it into any public file (including `index.json`).
- Internal, never output: `publications.confirmed_by`, `publications.review_seconds`.
- `{lang}` = `fr` on `/fr/`, `en` on `/en/`. For a pair `x_fr`/`x_en`, show `x_{lang}`. Blank = absent;
  absent = the block and its heading are not output.
- Quoted text (decision 0007 addendum): if `claim.lang` (or `evidence[].lang`) = `{lang}`, show
  `quote_original` (or `excerpt`) alone. Otherwise show `quote_{lang}` (or `excerpt_{lang}`) as the main
  text, labelled "Translation" / « Traduction », and directly underneath `quote_original` (or `excerpt`)
  with its own `lang`, labelled "Original ({language})" / « Original ({langue}) ». The original is never
  hidden or collapsed. Typography: `components.md`, "Translated quote".
- Codes are never shown raw: domain, kind, type, verifiability, verdict and country use the label
  tables in `DESIGN.md`. The order of the domain codes in those tables is not significant (the
  generator lists `security` before `defence`; either is fine). Topic lists sort by label.
- Withdrawal notes are bilingual (`publications.note_fr` / `note_en`); pages show `note_{lang}`.

## 2. What the generator outputs

Static files, one set per language (`fr`, `en`), no server code:

| Path | Count | Built from |
| --- | --- | --- |
| `/{lang}/index.html` | 1 | the current published set |
| `/{lang}/topic/{domain}/index.html` | 20 (every domain code, even empty) | the current published set |
| `/{lang}/subject/{subject.id}-{slug}/index.html` | one per subject with ≥ 1 published item | the current published set |
| `/{lang}/subject/{subject.id}/index.html` | same | a redirect (meta refresh + link) to the slugged URL |
| `/{lang}/claim/{claim.id}/index.html` | one per claim that has ever had a ledger entry | newest entry; history from all entries |
| `/{lang}/method/index.html` | 1 | static text (mockup `method.{lang}.html`) |
| `/{lang}/method/rules-{version}/index.html` | one per `rules_version` in any ledger entry | `src/standard.js` (components.md "Rules applied and the rules page") |
| `/{lang}/corrections/index.html` | 1 | all of `publications` |
| `/index.html` | 1 | language choice, links to `/fr/` and `/en/` |
| `/assets/kanverify.css`, `/assets/site.js` | 1 each | mockup CSS; `stats.js` + view scripts + theme script |
| `/{lang}/index.json` | 1 per language | the current published set, one object per item, fields below |

`slug` = `subject.name` lower-cased, accents removed, non-letters → "-". The id decides; the slug is
decoration. Header and footer on every page as in the mockups. Every page must be readable with
JavaScript off: the generator prints the default list (below) as HTML; scripts then replace it.


### `index.json` (the only data the scripts read)

One object per item in the current published set (the shape of `design/mockups/sample-data.js`):
`id` (claim.id), `s` (subject.id), `type`, `domain`, `said` (said_on), `deadline`, `basis`
(deadline_basis), `verif` (verifiability), `verdict`, `confirmed` (confirmed_at, date part), `lang`,
`q` (quote_original), `fr`/`en` (quote_fr/quote_en, null when absent), `role_fr`/`role_en`
(speaker_role, null when absent). Plus a `subjects` map: `id`, `name`, `kind`, `country`, `slug`.

**Added in round 4** (all already in the `publishable` snapshot; no new field in the record format):

| Key | From | Used for |
| --- | --- | --- |
| `sum_fr`, `sum_en` | `verdict.summary_fr/_en` (absent for pending) | summary line on rows and cards; open row |
| `oq_fr`, `oq_en` | `verdict.open_question_fr/_en`, **only when the verdict is `to_evaluate`** | "What is missing:" line |
| `src` | `origin.id` | person-page group key |
| `ev` | `evidence[]`: `t` title, `k` kind, `p` publisher, `l` lang, in the snapshot's order | "Based on" in an open row |
| `sources` map | keyed by `src`: `title`, `kind`, `publisher`, `date` (published_on), `lang`, from `origin` | group headings |

Still never in the index: excerpts, URLs, hashes, jury votes, criteria, history (those live on the item
page). The index roughly doubles in size; at 1,000 items that is still well under 1 MB.

## 3. Pages: which fields each shows

### Home `/{lang}/`

- Tagline (static).
- Timeline (script): items of the current published set placed by `claim.deadline` (default) or
  `claim.said_on`; current year by default; filters basis, type, period.
- Cards: `subject.name`, the chosen date, the quoted text (translation first, as above), verdict label, type label,
  summary line (see Row); link to the claim page. No-JS default: the cards of the current calendar year
  by deadline, printed.
- People and parties: every subject with ≥ 1 published item: `name`, `kind`, `country`, item count;
  alphabetical; link to the subject page.

### Topic `/{lang}/topic/{domain}/`

- Controls: topic (20 links/options with counts), country, order (name / number of items).
- Per subject with ≥ 1 item in the topic: `name`, `country`, item count, patterned bar (shared scale:
  longest = most items), the six counts as text. Subjects with none: named in one line.
- Detail layer: the same counts as a table (six columns, zeros); period filter.
- Item list: rows (below) for the topic. No-JS default: all items of the topic, by subject then said_on.

### Subject `/{lang}/subject/{id}-{slug}/`

- `name` (h1), then one line: `kind`, `country`, item count, "verdicts as of {latest `confirmed_at` of
  this subject's published items}"; Wikidata id as a plain link if `wikidata_id` is set.
- Coverage sentence: "These {N} items come from {M} documents, listed below with the items taken from
  each. Anything {name} said outside these documents is not recorded here." / « Ces {N} fiches
  proviennent de {M} documents, présentés ci-dessous avec les fiches tirées de chacun. Les propos de
  {name} tenus hors de ces documents ne sont pas enregistrés ici. » M = distinct `origin.id`.
- Donut and legend: the six counts of this subject's published items (zeros shown), then "These are
  counts, not a score." / « Ce sont des décomptes, pas une note. » Every count is also a filter, and
  the filtered list must contain exactly the items counted (matched on `verdict.verdict` alone, within
  the same topic and period). The same holds for topic counts and for each person's row on the topic
  page.
- Topics: per domain with ≥ 1 item: label and count. A filter, as before (no longer the grouping).
- Detail layer: period filter.
- Item list, "Items, by where they were said": one group per (`origin.id`, `speaker_role_fr`), groups ordered by their earliest `said_on`, then
  the key. Group heading: source `title` (its own
  `lang`), then kind label · `published_on` · role, then the item count and the six counts of the
  group (within the current topic and period, before the verdict filter). Rows inside by `said_on`,
  then id; inside a group a row does not repeat the date said, role and deadline when closed. Groups
  with no rows under the current filters are not shown. No-JS default: the same groups, all items.
- Withdrawn items: none, not even a count.

### Row (used on topic and subject pages)

A `<details>` accordion. Closed: `subject.name` and domain label (topic page only); `quote_original`
(translation first when said in another language); verdict label; type label; `said_on` and `speaker_role_{lang}`; `deadline` with basis
label if present; summary line = `summary_{lang}` (2 lines), or for `to_evaluate` "What is missing:" +
`open_question_{lang}`; none for pending. Open: for `to_evaluate` also `summary_{lang}`; "Based on":
each `evidence[]` title · kind label, publisher (or "the wording itself · {verifiability}" for vague and
hedged); deadline + basis or "No deadline"; "Confirmed by a person on {confirmed_at}"; link "Full
record, item {id}" to the claim page. Works without JavaScript (native `<details>`).

### Claim `/{lang}/claim/{id}/` — current entry `status = 'published'`

Summary layer:

1. claim.id · type label · domain label (link to topic).
2. Heading: `subject.name` (link), `said_on`.
3. The quoted text: translation first, original directly underneath (see §1).
4. Verdict label; the jury line (`components.md` "Jury line": `confirmed_at`, the votes of `based_on_round`,
   `jury[].provider` / `verdict`); `verdict.summary_{lang}` (required for all but pending).
5. If `to_evaluate`: heading "What is missing / Ce qui manque" + `open_question_{lang}`. Otherwise, if
   present: "Open question / Question en suspens" + `open_question_{lang}`.
6. "Based on, in date order" / « Fondé sur, dans l'ordre des dates »: one list, sorted by date
   (ties: said, evidence, deadline, confirmation):
   - `said_on`: "Said, in the {origin kind label}, {source_locator}" (link to `#src-{id}`, the "Where
     it was said" row, which gets that id);
   - each `evidence[]` by `published_on`: `title` (link to `#ev-{id}-{n}`) · kind label (· publisher
     for media and studies). Evidence without `published_on`: after all dated entries, date column
     "Date not stated";
   - `deadline`: "Deadline, stated in the promise" or "Deadline, inferred: end of term". No deadline:
     no entry (the vague/hedged entry says it);
   - vague or hedged with no evidence: one undated entry "The wording itself · {verifiability label} ·
     no deadline";
   - `confirmed_at`: "Confirmed by a person".
   A deadline later than the confirmation (early Came true / Partly came true) is simply placed last.
   After the chain, last in the summary layer: "Rules applied, version {rules_version}" and one line per id in
   `rules_applied`, plain words + id linking to `/{lang}/method/rules-{version}/#{id}` (components.md).

Detail layer ("Full record"), one `<details>` each, in this order, omitted when empty:

- Evidence n (`id="ev-{claim.id}-{n}"`): summary line kind · publisher · published_on; body: `excerpt`
  (translation first when in another language, see §1), `title`, `locator`, `url`, `retrieved_on`, `sha256`.
- Where it was said (`id="src-{claim.id}"`): `subject.name`, `speaker_role_{lang}`, `origin.title`,
  `origin.publisher`, `origin.published_on`, `claim.source_locator`, `origin.url`,
  `origin.retrieved_on`, `origin.sha256`; the fixed line about copies not being published.
- Criteria: verifiability label, `criteria_{lang}`, deadline basis explained.
- How this was decided: "Confirmed by a person on {confirmed_at}", `decided_by` in words, `jury[]` table
  (provider, model, prompt_version, verdict label).
- History: every entry of this claim in `publications`, oldest first: `confirmed_at` date, verdict label
  or "Withdrawn"; when it changed, a link to `/{lang}/corrections/#entry-{publications.id}`.

Then "Request a correction" (`mailto:` with the claim id).

### Claim page when the current entry is `withdrawn`

Only: claim.id, "This item was withdrawn", `confirmed_at` of the withdrawal, `note_{lang}`, one line of
history dates (published …, withdrawn …), link to `/{lang}/corrections/#entry-{publications.id}` of the
withdrawal. Nothing from any snapshot.

### Method `/{lang}/method/`

Static text, as in `method.{lang}.html`.

### Corrections `/{lang}/corrections/` (not drawn; build plainly)

Every ledger entry that is not a claim's first, newest first, each with `id="entry-{publications.id}"`
(the anchor contract that item History and withdrawn pages link to): date, claim id (link), verdict
before → after, or "Withdrawn" with `note_{lang}`. Then the correction address. No reply-deadline
promise.

### Root language choice `/index.html` (not drawn; build plainly)

Brand name, one line in each language ("Une chronique des promesses et prévisions publiques" / "A
chronicle of public promises and predictions"), and two links: "Français" → `/fr/` (`lang="fr"`),
"English" → `/en/` (`lang="en"`). No automatic redirect, no script, no cookie. `<html lang="fr">`
with the English line marked `lang="en"`.

## 4. Navigation

Home timeline → card → claim summary → detail row. Home → subject → filtered list → row (opens in
place) → claim. Topic → subject row → filtered list → row → claim. Every verdict label appears either
with its summary line in its item's row or card, or on the claim page itself.

## Principles relied on

3 (one set, neutral order, withdrawn absent everywhere), 1 (what is missing always in the summary
layer, and on rows), 2 (summary line on every row and card; dated chain), 5 (static files, one JSON
index, native disclosure), 8 (no external requests).

## Objections and risks

1. Resolved: withdrawal notes are bilingual since format 8.
2. Resolved: `partly_came_true` now exists; `came_true` means met in full.
3. The generator must strip withdrawal snapshots from every public output; a slip here publishes what
   the founder decided to hide. Worth a test.
4. Not drawn: Corrections page, review desk, the root language page (specified in §3).5. Person-page groups by document: a person quoted in many interviews gets many one-item groups.
   Proposed fallback (not built): above 8 groups, group by year of `said_on` instead.
6. Done in record format 12: the method version and rules on each verdict ("Rules applied"). Still wanted, needs
   the record format: a topic/dossier link per claim for focus pages (one policy, everyone's words
   and the official documents in date order).
