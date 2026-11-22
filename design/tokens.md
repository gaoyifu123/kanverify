# KANVERIFY design tokens (MVP)

- Role: designer. Date: 2026-11-22. Status: frozen for the MVP (founder: "先这样做出MVP吧").
  Round 4, same day (coordinator, on the founder's delegation): six verdict patterns, serif display style,
  card radius; verdict hues (founder chose palette B, 2026-11-22). **Frozen for the developer.**
- Source of truth in code: the custom properties at the top of `design/mockups/kanverify.css`. The
  developer copies them as they are; any change goes back to design first.

## Type

| Token | Value | Used for |
| --- | --- | --- |
| `--text` | 1.0625rem (17 px) | everything: body, metadata, labels, buttons, chips, table cells, chart text |
| `--large` | 1.5rem (24 px) | the page title (h1) and the timeline year; nothing else |
| `--regular` | 400 | default |
| `--bold` | 600 | headings h2/h3, verdict chips, person names in lists, counts in the legend are regular |
| `--leading` | 1.55 (1.25 for `--large`) | |

Two sizes, two weights, no small size (founder: "避免很多不同的字体大小粗细"). Secondary information is
told apart by colour (`--ink-2`), never by a smaller size.

Families:

- `--sans` (system UI stack): everything we write.
- `--serif` (system serif stack): the words someone else said (the quote, evidence excerpts, their
  lines in rows and cards, the titles of their documents as group headings), at `--text`, regular.
  It separates "their words" from "our words" (principle 2).
  **Round 4: also the display style** — the page title (h1) and the timeline year, at `--large`, bold.
  The founder liked serif display headings on the reference site. This adds no size and no weight:
  serif-large-bold (title) and serif-body-regular (quotes) never meet at the same size and weight, so
  the "their words" meaning survives. Everything else, including h2/h3, stays sans.
- `--mono`: SHA-256 fingerprints and model ids only, at 0.9375em so a 64-character hash wraps sanely.

No web fonts (principle 8).

## Colour

| Token | Light | Dark | Use | Contrast on `--bg` |
| --- | --- | --- | --- | --- |
| `--bg` | #f7f6f3 | #171716 | page | |
| `--surface` | #ffffff | #1f1f1d | controls, pattern background | |
| `--ink` | #1c1c1a | #e8e6e1 | text, chart ink | 16:1 / 14.8:1 |
| `--ink-2` | #4a4945 | #bdbab3 | secondary text | 8.6:1 / 9.6:1 |
| `--rule` | #dcd9d2 | #353430 | separators only (decorative) | — |
| `--edge` | #85827a | #7f7c75 | borders of chips, controls, quotes | 3.6:1 / 4.1:1 |
| `--tint` | #eeece7 | #272725 | chip fill, hover, notices | — |
| `--accent` | #1d4f7a | #9cc2e5 | links, focus, selected state | 8.0:1 / 9.4:1 |

Plus the six verdict hues below (palette B); no other colour. Theme follows the system; `data-theme` on `<html>`
overrides it (button in the header).

## Space and size

| Token | Value |
| --- | --- |
| `--s1` … `--s7` | 0.25, 0.5, 0.75, 1, 1.5, 2, 3 rem |
| `--measure` | 44rem — maximum width of running text |
| `--radius` | 3px — chips, controls |
| `--radius-card` | 8px — item rows and timeline cards (white cards on the paper background) |
| `--target` | 44px — minimum touch target |

## Breakpoints

Mobile first: designed at 375 px; one column below 1024 px.

| Name | Min width | What changes |
| --- | --- | --- |
| base | 0 | one column, `.wrap` max 44rem |
| `wide` | 64rem (1024 px) | `.wrap` max 72rem; `.split` = two columns (26rem side, rest main); item page summary and detail side by side (1fr/1fr); home cards in 2 columns; people list in 2 columns; running text stays ≤ 44rem (`.prose`) |
| `xwide` | 90rem (1440 px) | `.wrap` max 84rem; side column 28rem; item summary 40rem + detail; home cards in 3 columns; item lists in the main column in 2 columns |

Small step inside components: `36rem` (576 px) turns key–value lists into two columns and puts the
donut beside its legend.

## Verdict patterns

Six patterns in one ink on the verdict's hue (`--v-*`, below), 8 × 8 px tiles, stroke 1.3 px, every shape outlined in
`--ink`. Fixed order everywhere: unverifiable, pending, to_evaluate, came_true, partly_came_true,
not_came_true.

| Verdict | Pattern | Chip icon (CSS, 0.8em square) |
| --- | --- | --- |
| unverifiable | horizontal line | horizontal lines, 4 px pitch |
| pending | blank | empty square |
| to_evaluate | dots | dots, 4 px grid |
| came_true | diagonal "/" | "/" lines |
| partly_came_true | **vertical line "\|"** (round 4) | vertical lines, 4 px pitch |
| not_came_true | diagonal "\" (mirror of came_true) | "\" lines |

"/", "|" and "\" are one line per tile each: the same ink, so none of the three outweighs the others.
The chip carries the same pattern as a small icon, so a chip and a chart sector are read the same way.
Ticks, crosses and warning signs are not used (DESIGN.md, What NOT to do).

**375 px test for "|" against "—" (reasoned, not rendered: I have no browser in this session).**
- Legend swatch (18 px): two vertical against two horizontal lines. Orientation 90° apart is among the
  easiest differences to see; the swatch sits next to its label anyway.
- Donut (≈ 240 px wide on a 375 px phone, ring ≈ 33 px): tiles are in the chart's own units, so the
  pitch stays ≈ 8 px. The lines keep their absolute direction around the ring, as in the legend.
- Topic bars (≈ 330 px for 300 units, 22 px high): vertical lines every ≈ 9 px across the bar, against
  2–3 horizontal lines along it. Different at a glance. **The real risk is elsewhere:** in a one-item
  segment (≈ 20 px) two vertical lines look like segment borders. Segments keep their 1.5 px gap and
  ink outline; if testing shows confusion, raise the pattern to 1.3 px dashes. Not needed on paper.
- Verdict: **kept "|"**. No change to the horizontal line.

## Verdict colour (founder, 2026-11-22: palette B, the only palette)

Each verdict has a muted hue of similar lightness, with **no green and no red**, so no hue says "good" or
"bad". The hue is always under the verdict's ink pattern and always next to its label: colour is never
the only cue. Chart tiles, swatches and chip icons fill with `--v-*`; the chip takes a 50 % wash of its
hue (`color-mix(in srgb, var(--v-*) 50%, var(--surface))`); text stays `--ink`.

| Verdict | `--v-*` light | `--v-*` dark |
| --- | --- | --- |
| unverifiable | #d8d4ca stone | #47453f |
| pending | #f1efea paper | #262624 |
| to_evaluate | #e9d7a6 ochre | #5a4e2c |
| came_true | #abc7e3 blue | #2f4964 |
| partly_came_true | #c8bfe2 lavender | #474063 |
| not_came_true | #dbc2b0 clay | #5a4537 |

**Contrast, calculated** (WCAG relative luminance, sRGB; ratios rounded down to one decimal).
Backgrounds: light `--bg` #f7f6f3 (L 0.922), `--surface` #fff (L 1.000); dark `--bg` #171716 (L 0.0085),
`--surface` #1f1f1d (L 0.0136). Ink: light #1c1c1a (L 0.0115), dark #e8e6e1 (L 0.792).

| Verdict | L light | fill vs `--bg` / `--surface` | ink pattern on fill | chip text on wash | L dark | fill vs `--bg` / `--surface` | ink pattern on fill | chip text on wash |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| unverifiable | 0.660 | 1.3 / 1.4 | 11.5 | ≈ 14 | 0.060 | 1.8 / 1.7 | 7.6 | ≈ 12 |
| pending | 0.864 | 1.0 / 1.1 | 14.8 | 17.0 (white chip) | 0.019 | 1.1 / 1.0 | 12.1 | 13.2 (surface chip) |
| to_evaluate | 0.687 | 1.3 / 1.4 | 11.9 | ≈ 14 | 0.078 | 2.1 / 2.0 | 6.5 | 9.6 |
| came_true | 0.551 | 1.6 / 1.7 | 9.7 | 13.1 | 0.063 | 1.9 / 1.7 | 7.4 | 9.3 |
| partly_came_true | 0.550 | 1.6 / 1.7 | 9.7 | ≈ 13 | 0.059 | 1.8 / 1.7 | 7.7 | 11.1 |
| not_came_true | 0.568 | 1.5 / 1.6 | 10.0 | ≈ 14 | 0.067 | 2.0 / 1.8 | 7.1 | 9.9 |

Reading the table:
- **Text (AA 4.5:1): passes everywhere.** Chip text ≥ 13:1 light, ≥ 9.3:1 dark.
- **Patterns on their fill (3:1): pass everywhere**, ≥ 9.7:1 light, ≥ 6.5:1 dark.
- **Fill against the page (3:1): fails everywhere (1.0–2.1:1), by design.** A muted fill cannot reach
  3:1 against paper: in light mode that needs L ≤ 0.27, i.e. mid-tone colours that are no longer
  muted. This is still WCAG 1.4.11-compliant because the fill is not what identifies a sector or a
  segment: every sector, segment, swatch and chip icon has a 1 px `--ink` outline (16:1 light, 14.8:1
  dark against `--bg`) and an ink pattern (above), and every chart has its counts as text.
- **Fill against fill:** came_true and partly_came_true are almost the same lightness (1.0:1) and close
  in hue for tritan colour vision; "/" against "|" carries the difference. Pending is close to paper on
  purpose ("nothing yet").
- Values marked ≈ were computed for the dominant channel only; all are far above 4.5:1.

## Principles relied on

3 (one ruler: equal-ink patterns, no good/bad hues, no green/red), 5 (two sizes, two weights; serif
display adds neither), 8 (no external fonts).

## Objections and risks

- Without a small size, metadata lines are as large as body text; rows are longer on phones. Accepted
  for calm; colour carries the hierarchy.
- `--edge` at 3.6:1 is above the 3:1 UI minimum but not by much; do not lighten it.
- **Colour can become a good/bad code** (my objection before the founder chose B; kept, principle 6).
  Readers may learn "blue = came true" and start reading colour as praise. Mitigation: no green and no
  red, similar lightness for all six, the pattern and the label always present, counts never shares.
  If readers or the neutrality review show colour being read as a score, come back to this.
- System serif (Charter / Georgia / Cambria) is plainer than the reference site's display face. We do
  not load web fonts (principle 8), so the headings will look less "designed" than theirs.
- `color-mix()` needs a 2023+ browser; older ones show the chip in `--tint` (the icon keeps its hue),
  which is safe.
- The contrast table is calculated, not measured in a browser; the accessibility review should confirm.
