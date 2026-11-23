# KANVERIFY components (MVP)

- Role: designer. Date: 2026-11-22. Status: frozen for the MVP; round 4 the same day (coordinator, on
  the founder's delegation). Tokens: `design/tokens.md`.
  Reference markup and CSS: `design/mockups/` (class names below are the ones used there).
  2026-11-23: record format 12 — public reversal shown as ordinary evidence; rules line and rules page added.
- Labels: six verdicts (decision 0008, revised) — Invérifiable / Unverifiable, En attente / Pending,
  À évaluer / To be assessed, Réalisée / Came true, Partiellement réalisée / Partly came true,
  Non réalisée / Did not come true. Fixed order: unverifiable, pending, to_evaluate, came_true,
  partly_came_true, not_came_true.

| Component | Purpose | Anatomy | States | Content rules |
| --- | --- | --- | --- | --- |
| Header `.site-header` | find your way | brand (home), Topics, Method, FR/EN, theme button | current page `aria-current` | nothing else; no search in MVP |
| Footer `.site-footer` | secondary links | Timeline, Topics, Method, Corrections, Request a correction (`mailto:`) | — | one address |
| Verdict chip `.verdict[data-v]` | name a verdict | pattern icon (0.8em square, the verdict's chart pattern on its hue, CSS) + label, in a bordered box filled with a 50 % wash of the verdict's hue | — | identical for all six; no tick, cross or warning sign; wherever it appears it has its basis next to it (summary line) or sits inside the item's row/link |
| Quote `.quote` | someone's words, said in the page language | serif text, `--ink`, 3 px `--edge` left rule | — | `lang` = ISO 639-1; never paraphrased |
| Translated quote `.translated` + `.original` (decision 0007 addendum) | someone's words, said in another language | 1. `.translated`: label "Translation" / « Traduction » (sans, `--ink-2`), then our translation: **sans**, `--ink`, 3 px `--edge` rule — the main text. 2. directly underneath, `.original`: label "Original (French)" / « Original (anglais) » (sans, `--ink-2`), then their words: **serif**, **`--ink`** (not greyed), 3 px `--rule` rule, `lang` of the original | always both; the original is never collapsed, hidden or truncated on the item page | Typography rule: **serif = their actual words, only.** A translation is our text, so it is sans; the original keeps the serif and full ink even though it comes second. Secondary position is shown by order, the lighter rule and the label, never by grey or a smaller size. Same rule for evidence excerpts (`excerpt_{lang}` sans, `excerpt` serif). Language names: French/English on EN pages, français/anglais on FR pages |
| Row `.row` (accordion, `<details>`) | an item in a list | white card. Closed (summary layer): (name · topic) / words: either the quote (serif, 3 lines max) or, when said in another language, the translation (sans, 3 lines max) then "Original (French): …" (label sans `--ink-2`, words serif `--ink`, 2 lines max) / chip · type · date said and role · deadline and basis / **summary line** / "+" | open: "–", summary line unclamped, then the body: (summary, for To be assessed) · "Based on" + each evidence title · kind, publisher (or "the wording itself · vague/hedged") · deadline and basis · "Confirmed by a person on …" · link "Full record, item n" | summary line = `summary_{lang}`, 2 lines max; for To be assessed it is "What is missing:" + `open_question_{lang}`; none for Pending. Summaries must lead with the outcome and its figures, since only two lines show. Inside a person-page group, date said, role and deadline move into the body |
| Card `.card` | an item on the timeline | white card: name · "due"/"said" date / words (as Row) / chip · type / summary line | hover tint | grouped under month headings; whole card is a link (no accordion: the timeline stays a quick scan) |
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
| Rules applied `.rules-applied` (record format 12, decision 0014) | the rules this verdict was judged by | item page only, see "Rules applied and the rules page" below | — | plain words, never ids alone; never on rows, cards or the timeline |
| Rules page entry `.rules` (`dl`) | one rule of one version, the target of a rules link | id + plain-words sentence | `:target` = accent rule | see below |

## Public reversal by the speaker (record format 12; replaces the 2026-11-23 "the wait ends here" spec)

Retired: the unnumbered "ends the wait" entry, the `#ren-…` anchors and the "Public renunciation" layer. Since the
founder's amendment to decision 0013 (and decision 0015, ST-1 / RN-1), a reversal can only be cited under
`not_came_true`, where it is ordinary evidence: numbered "Evidence N" / « Preuve N », in the chain and the row body
like any other document, anchor `#ev-…`. Kind label: "Public reversal by the speaker" / « Revirement public de
l’auteur » (lower-case in the chain: "public reversal by the speaker" / « revirement public de l’auteur »). Nothing
else is special; the rules line (RN-1) is what tells the reader why a speaker's own words count here.

Label check: both are neutral and describe the act, not a motive. Rejected: "renunciation" (sounds like a confession),
« reniement » (moral blame), "U-turn" / « volte-face » (mocking).

## Rules applied and the rules page (record format 12, decision 0014)

### On the item page

Placed at the **end of the summary layer, after the dated chain** (not between the summary and the chain as in the
placeholder): the order stays chip → summary → what is missing → "Based on" (rule 1 of DESIGN.md), and the rules close
the basis. On ≥ 1024 px it stays in the summary column.

```html
<p class="muted">Rules applied, version 0.6</p>
<ul class="rules-applied">
  <li>After the deadline, the state on the deadline counts; what happened later is only mentioned. <a href="../../method/rules-0.6/#DL-2">DL-2</a></li>
  <li>An outcome needs one official document, or two independent sources from different publishers. <a href="…#EV-1">EV-1</a></li>
</ul>
```

- Label: EN `Rules applied, version {v}` / FR `Règles appliquées, version {v}` (`{v}` = `rules_version`). `.muted`,
  no heading (it is not a section of its own).
- One `li` per id: the rule's sentence in the page language (from `src/standard.js`, that version), then a space and
  the **id as the link** to `/{lang}/method/rules-{v}/#{id}`. The sentence is not the link: a link several lines long
  is hard to read and to tap. Sentence 17/400 `--ink-2`; id 17/400 `--accent`, underlined like every link.
- No bullets, no indent; 0.25rem between items; the same top gap as between other summary-layer blocks.
- Order: the order of the standard (ST-1…3, then the "Rules" table), not the order the judge typed; duplicates once.
- Empty `rules_applied`: nothing shown (the desk already refuses to confirm without rules). Unknown id or version:
  the build stops (as now).
- Not on rows, cards, the timeline or the desk's public view: the item page is one tap away and the rows stay short.
- History layer: past verdicts do not show their rules (cut; their version pages still exist).

### The rules page `/{lang}/method/rules-{version}/`

One page per version used by any ledger entry (current or past), header item "Method" current.

1. `h1` (display: serif 24/600): EN `Verdict rules, version {v}` / FR `Règles de verdict, version {v}`.
2. Intro `p`:
   - EN: `Each verdict on this site names the rules it was judged by. These are the rules of version {v}, in plain words. A rule is never changed in place: a changed rule gets a new id, in a new version.`
   - FR: `Chaque verdict de ce site indique les règles selon lesquelles il a été rendu. Voici les règles de la version {v}, en mots simples. Une règle n’est jamais modifiée sur place : une règle changée reçoit un nouvel identifiant, dans une nouvelle version.`
   This replaces the placeholder's "the full text, in English, is the verdict standard of the method": that text is
   not published on the site, so the sentence would point nowhere. Put it back with a link if the Method page ever
   carries the full standard.
3. Only when `{v}` is not the current version, `.muted` `p`:
   EN `A newer version exists: {link: version 0.7}. Each verdict keeps the version it was judged under.` /
   FR `Une version plus récente existe : {lien : version 0.7}. Chaque verdict garde la version selon laquelle il a été rendu.`
4. `h2` EN `Standards` / FR `Principes de jugement`, then a `dl.rules` with ST-1…3.
5. `h2` EN `Rules` / FR `Règles`, then a `dl.rules` with the other rules, in table order.

`dl.rules`: one `div.rule id="{id}"` per rule, 1 px `--rule` line between them, 0.75rem vertical padding.
`dt` = id, **sans 600 `--ink`** (not mono: mono is kept for fingerprints and model ids); `dd` = the sentence, 17/400
`--ink`, `lang` of the page. Phone: id above the sentence; ≥ 640 px: two columns, id column 4.5rem. `:target`: 3 px
`--accent` left rule, 0.75rem left padding, `scroll-margin-top` clear of the header. No fill, no motion. Running text
≤ 44rem (`.prose`). No new size, weight, colour or icon.

Cut: a short title per rule (would need a new column in the standard's table, not mine), per-rule "comes from ST-n"
lines, a version switcher, a diff between versions, the rules line on rows and cards.

## Principles relied on

3 (one chip, equal-ink patterns, neutral order, no good/bad icons), 1 (what is missing never collapsed,
shown on rows too), 2 (summary line on every row and card; dated chain on the item page; the rules a verdict was
judged by, in plain words, on its page), 3 again (one rule set, shown the same way for every verdict and person), 5 (one
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
- Public reversal (format 12): a statement wrongly labelled `renunciation` would be shown as evidence under
  `not_came_true`; the desk reading is the only guard. The chain still shows the original deadline after the
  reversal's date, which is correct (RN-1) but a quick reader may wonder why; the RN-1 line explains it.
- Rules applied (format 12): the block makes the summary layer longer by 3–6 muted lines on a phone. If judges name
  ST-3 ("common sense") on almost every verdict it becomes noise; ask that judges name a standard only when it decided
  the verdict (team/run/judge-prompt.md, not my file).
- **Wording in the standard (not my file; raised for whoever owns docs/methodology/verdict-standard.md):** the French
  rule texts say « prédiction » (ST-2, VG-3) while the site says « Prévision »; they should match. VG-1 and RN-1 say
  « reniée », which carries blame (principle 3); « sur laquelle son auteur est revenu explicitement et publiquement »
  matches the label « Revirement public de l’auteur ». These sentences are now shown on every item page.
- Decision 0013's amendment says decision 0014 is "removed in record format 12", while the code and 0014 itself show
  it is in force; I designed for "in force". The coordinator should reword the amendment.
