# KANVERIFY components (MVP)

- Role: designer. Date: 2026-11-22. Status: frozen for the MVP; round 4 the same day (coordinator, on
  the founder's delegation). Tokens: `design/tokens.md`.
  Reference markup and CSS: `design/mockups/` (class names below are the ones used there).
- Labels: six verdicts (decision 0008, revised) — Invérifiable / Unverifiable, En attente / Pending,
  À évaluer / To be assessed, Réalisée / Came true, Partiellement réalisée / Partly came true,
  Non réalisée / Did not come true. Fixed order: unverifiable, pending, to_evaluate, came_true,
  partly_came_true, not_came_true.

| Component | Purpose | Anatomy | States | Content rules |
| --- | --- | --- | --- | --- |
| Header `.site-header` | find your way | brand (home), Topics, Method, FR/EN, theme button | current page `aria-current` | nothing else; no search in MVP |
| Footer `.site-footer` | secondary links | Timeline, Topics, Method, Corrections, Request a correction (`mailto:`) | — | one address |
| Verdict chip `.verdict[data-v]` | name a verdict | pattern icon (0.8em square, the verdict's chart pattern on its hue, CSS) + label, in a bordered box filled with a 50 % wash of the verdict's hue | — | identical for all six; no tick, cross or warning sign; wherever it appears it has its basis next to it (summary line) or sits inside the item's row/link |
| Quote `.quote` + `.translation` | someone's words | serif text, left rule; translation below in `--ink-2` with a "Translation from …" label | translation absent when page language = `lang` | `lang` attribute = ISO 639-1; never paraphrased |
| Row `.row` (accordion, `<details>`) | an item in a list | white card. Closed (summary layer): (name · topic) / original words, 3 lines max / translation, 2 lines max / chip · type · date said and role · deadline and basis / **summary line** / "+" | open: "–", summary line unclamped, then the body: (summary, for To be assessed) · "Based on" + each evidence title · kind, publisher (or "the wording itself · vague/hedged") · deadline and basis · "Confirmed by a person on …" · link "Full record, item n" | summary line = `summary_{lang}`, 2 lines max; for To be assessed it is "What is missing:" + `open_question_{lang}`; none for Pending. Summaries must lead with the outcome and its figures, since only two lines show. Inside a person-page group, date said, role and deadline move into the body |
| Card `.card` | an item on the timeline | white card: name · "due"/"said" date / original words / translation / chip · type / summary line | hover tint | grouped under month headings; whole card is a link (no accordion: the timeline stays a quick scan) |
| Dated chain `.chain` | the verdict's basis on the item page, as a chronicle | heading "Based on, in date order"; one ruled vertical line, one dot per entry; each entry: date / what happened | hollow dot = no date (the wording itself) or not confirmed | entries, in date order: said (link to "Where it was said"), each evidence by `published_on` (title link · kind, publisher for media and studies), deadline with basis, "Confirmed by a person". Evidence without `published_on`: after the dated entries, "Date not stated". Vague/hedged without evidence: one undated entry "The wording itself · vague/hedged · no deadline". A future deadline (early Came true / Partly came true) is placed by its date after the confirmation |
| Document group `.group` | person page: items by where they were said | serif h3 = source title (in its language) / kind · date · role / item count / six counts with swatches (zeros shown) / rows | — | one group per (`origin.id`, role); groups oldest first; rows inside by `said_on`, then id. Counts are of the group within the current topic and period, before the verdict filter |
| Timeline `.tl` | browse by time | year (`--large`) with ‹ ›; line, identical dots (stacked), dashed today line; month/year labels at body size | collapsed row: basis (deadline / date said), type (both / promises / predictions), From–To, This year / All years | dots are pointer shortcuts; cards are the keyboard path; items without a date for the basis are counted in one line |
| Donut `.donut` | one person's verdicts | six patterned sectors clockwise from the top in fixed order, count beside each, total in the centre | — | counts only, never %; followed by "These are counts, not a score." |
| Legend `.legend` | the counts, and a filter | six rows: swatch, label, count (zeros shown) | pressed = filtering (accent border) | tapping again clears; the filtered list contains exactly the items counted in that row (same set, same verdict value, no other condition) |
| Topic list `.topics` | one person's topics | topic label, count, plain bar | pressed | bar is item count, no verdict meaning |
| Side-by-side bars `.people` | everyone on one topic | name · country, item count, patterned bar on one shared scale, six counts written out | pressed = filters the list | order: by name (default) or number of items, never by a verdict; people with no items named in one line; key shown once above |
| Count table | the same numbers as text | rows = people, columns = six verdicts | in a collapsed row | zeros shown |
| Layer row `.layer` | the detail layer | `<details>`: title + one-line description, "+"/"–" | open/closed; opens when its id is the URL hash | one row per evidence, source, criteria, decision, history; never more than about one phone screen when opened |
| Person header | who, how much, as of when, from where | h1 (serif) / kind · country · item count · "verdicts as of {latest confirmed_at}" / one sentence: "These N items come from M documents, listed below with the items taken from each. Anything {name} said outside these documents is not recorded here." | — | numbers computed by the generator; no portrait, party or position label |
| What is missing | principle 1 | h2 + paragraph (`open_question_{lang}`) | — | always in the summary layer for `to_evaluate`; other verdicts show it only if present, as "Open question" |
| Notice `.notice` | withdrawal | date, reason (`note_{lang}`) | — | nothing from the withdrawn snapshot |
| Toggle `.toggle` | choose one option | radio buttons styled as bordered labels | checked = accent border | each label ≥ 44 px high |
| Split `.split` | wide screens | side column + main column | ≥ 1024 px only | running text ≤ 44rem |

## Principles relied on

3 (one chip, equal-ink patterns, neutral order, no good/bad icons), 1 (what is missing never collapsed,
shown on rows too), 2 (summary line on every row and card; dated chain on the item page), 5 (one
component per job, native `<details>` for the accordion: no script needed to open a row).

## Objections and risks

- The donut is a share by shape even without numbers; the counts beside it are mandatory.
- **Chip icons: I did not use ✓ / × / ⚠** although the coordinator listed them as transferable. The
  frozen spec (DESIGN.md, What NOT to do) rules out ticks and crosses, and ✓ next to "Came true" and ×
  next to "Did not come true" is exactly the praise/blame mark principle 3 forbids. The icon is the
  verdict's pattern instead. If the founder wants ✓ / ×, it is his decision to change the spec.
- Two lines of summary cut most summaries short; writers (jury prompt and reviewers) must put the
  outcome and figures first. Worth a line in `team/run/judge-prompt.md` (not my file).
- Rows are longer on phones (summary line + card padding): about 4–5 rows per screen instead of 6.
- An open row shows evidence titles but not excerpts or fingerprints: those stay on the item page.
