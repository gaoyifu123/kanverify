# KANVERIFY design brief

- Role: designer. Written 2026-11-22; revised three times the same day after the founder's reviews.
  **Status: frozen as the MVP spec** (founder, round 2: "方向对，继续"; round 3: "先这样做出MVP吧").
  Round 4, same day: changes learned from the reference site the founder likes (memoiresdefrance.com;
  `design/reference-memoiresdefrance.md`), approved by the coordinator on the founder's delegation.
  Verdict colour: the founder chose palette B (muted hues, no red or green) on 2026-11-22.
  **Frozen for the developer.**
- Companion files: `tokens.md` (type, colour, space, breakpoints, patterns), `components.md`,
  `ia.md` (pages, URLs, fields, what the generator outputs). Reference mockups: `design/mockups/`.
- Every design task starts here. Where `frontend-design` defaults conflict, this brief wins (decision 0004).

## 1. What the site is

A chronicle of what public figures, parties, governments and commentators said would happen —
promises and predictions alike, including judgments about where an industry or a trend is heading —
and what became of it, checked against original documents. A promise and a prediction are the same
thing in essence: words said in the past about a future that may or may not come true.

The site shows only the ledger: the snapshot JSON (`publishable` view, record format 9) frozen into
`publications`, plus each entry's `status`, `note_fr`/`note_en`, `confirmed_at`. Lists, charts and the timeline read
`current_publications` with status `published` only.

## 2. Feel

- **A history book, not a newspaper.** The timeline is the identity.
- **Extremely minimal, and calm to read.** Two type sizes, two weights, one accent colour (founder,
  round 3). Every element earns its place; when in doubt, leave it out or move it one layer deeper.
- **First screen simple and readable on a 375 px phone.** No methodology, no detail before browsing.
- **Wide screens use the width** (founder, round 3): side-by-side columns at 1024 px and 1440 px, while
  running text stays under 44rem.
- **Clearly unlike existing trackers:** no meters, gauges, mascots, portraits, party colours, newsroom
  density or campaign-poster feel.
- **Words describe outcomes, never motives** (principle 3). No exclamation marks, rhetorical questions,
  irony or superlatives.

## 3. Words

- Item types: **Promise / Promesse**, **Prediction / Prévision**, shown as a quiet label and a filter.
- Record unit: **item / fiche**. Collective: "promises and predictions" / "promesses et prévisions".
  Not "statement / déclaration", which is the name of a source kind that is never evidence.
- **Six verdicts**, one set for both types (decision 0008, revised), always in this order:

| Value | English | Français | Page shows |
| --- | --- | --- | --- |
| unverifiable | Unverifiable | Invérifiable | the summary: why (vague, hedged, or which condition never arose) |
| pending | Pending | En attente | deadline; no summary required |
| to_evaluate | To be assessed | À évaluer | the summary and, always, "What is missing / Ce qui manque" |
| came_true | Came true | Réalisée | the summary; the criteria were met in full; may be given before the deadline |
| partly_came_true | Partly came true | Partiellement réalisée | the summary with the figures (what was promised, what the documents show); may be given before the deadline |
| not_came_true | Did not come true | Non réalisée | the summary; only after the deadline, or earlier if the person publicly gave it up (the renunciation is the evidence) |

- Vague and hedged claims are always Unverifiable; the "Based on" line says "the wording itself".

## 4. Rules that are never broken

1. **No verdict without its basis on the same screen.** On the item page the chip is followed by its
   summary and "Based on, in date order": said → each evidence document → deadline → confirmed.
   Excerpts, fingerprints, jury and history are one tap deeper. In lists and on cards the chip is
   followed by two lines of its summary (or of "What is missing"), and a list row opens in place to
   show the documents.
2. **Equal weight.** One chip style for all six, with the verdict's pattern as its icon (no tick, no
   cross); charts use six patterns in one ink; Came true "/", Partly came true "|" and Did not come
   true "\" carry the same ink. Each verdict also has a muted hue of similar lightness (no green, no
   red); the pattern and the label are always there, so colour is never the only cue.
3. **"What is missing" is never collapsed** for To be assessed (principle 1).
4. **Original words first**, in their own `lang`; the page-language translation follows, labelled.
5. **Every item shows where it came from** (detail layer): title, publisher, locator, date, URL,
   retrieval date, SHA-256. Archived files are not public.
6. **Deadlines say whose they are**: "Deadline inferred: end of term" / "Échéance déduite : fin du mandat".
7. **Withdrawn items** keep their URL with the notice only (date, reason) and leave no trace anywhere
   else except Corrections.
8. **Counts, never shares.** No percentages, scores, ranks or best/worst anywhere. Counts sit with the
   full six-verdict breakdown, zeros included, and filter to the items. The person page says once:
   "These are counts, not a score."
9. **Side by side, neutral order.** The topic view shows everyone on one shared scale; order by name or
   number of items only.
10. **Optional texts appear only when present**; blank = absent; no empty boxes.
11. **The person before the machine.** "Confirmed by a person on …" before the jury's votes.

## 5. Two layers

| Page | Summary layer | Detail layer |
| --- | --- | --- |
| Home | tagline, year, timeline, cards (with summary line), people | period / basis / type in one collapsed row |
| Person | name, "as of" date, coverage sentence, donut + legend, topics, items grouped by where they were said (rows with summary line) | period filter; each row opens in place |
| Topic | everyone side by side, item list | counts table, period filter; each row opens in place |
| Item | who, when, words, chip, summary, what is missing, dated chain (said → evidence → deadline → confirmed) | one row each: evidence 1…n, where it was said, criteria, how decided, history |

A tap never opens more than about one phone screen of text. Nothing is cut, only moved deeper. On
screens ≥ 1024 px the item's summary and detail layers sit side by side.

## 6. Visual system (summary; numbers in `tokens.md`)

- Type: 17 px for everything, 24 px for the page title and the year; weights 400 and 600. Sans for our
  words; serif for quoted words and their document titles (it marks "their words, not ours"), and
  since round 4 for the display style: page title and year, 24 px bold (no new size or weight);
  mono only for fingerprints and model ids.
- Colour: paper, ink, a secondary ink, one ink-blue accent, and six muted verdict hues (stone, paper,
  ochre, blue, lavender, clay; numbers and contrast in `tokens.md`). Light and dark themes equal. Lists and
  timeline cards are white cards (8 px radius) on the paper background.
- No photos, logos, flags, icons, mascots, meters. No motion.
- Labels for domains, source kinds and other codes: tables below.

### Fixed labels

Policy domain (`claim.domain`), "Topic / Thème":

| Code | Français | English |
| --- | --- | --- |
| economy | Économie | Economy |
| tax | Fiscalité | Tax |
| employment | Emploi et travail | Employment and work |
| health | Santé | Health |
| education | Éducation et recherche | Education and research |
| environment | Environnement | Environment |
| energy | Énergie | Energy |
| defence | Défense | Defence |
| security | Sécurité intérieure | Internal security |
| justice | Justice | Justice |
| immigration | Immigration et asile | Immigration and asylum |
| foreign_affairs | Affaires étrangères et européennes | Foreign and European affairs |
| institutions | Institutions et vie publique | Institutions and public life |
| social | Protection sociale | Social protection |
| housing | Logement | Housing |
| transport | Transports | Transport |
| agriculture | Agriculture et pêche | Agriculture and fisheries |
| digital | Numérique | Digital |
| culture | Culture, médias et sport | Culture, media and sport |
| other | Autres sujets | Other topics |

Source kind (`origin.kind`, `evidence[].kind`):

| Code | Français | English |
| --- | --- | --- |
| platform | Programme | Platform |
| statement | Déclaration | Statement |
| renunciation | Renonciation publique | Public renunciation |
| law | Texte de loi | Law |
| gazette | Journal officiel | Official gazette |
| statistic | Statistique officielle | Official statistics |
| budget | Document budgétaire | Budget document |
| parliament | Document parlementaire | Parliamentary record |
| court | Décision de justice | Court decision |
| audit | Rapport d'audit public | Public audit report |
| official | Document officiel | Official document |
| media | Article de presse | News report |
| dataset_study | Étude avec données publiées | Study with published data |

Other codes: `subject.kind` Personne / Parti / Gouvernement / Institution — Person / Party / Government /
Institution. `claim.type` Promesse / Prévision — Promise / Prediction. `claim.verifiability` Mesurable /
Imprécise / Assortie de réserves — Measurable / Vague / Hedged. `subject.country`: country name.
Dates: "22 novembre 2026", "1er" for the first; "22 November 2026". French spacing before `: ; ? !` and
inside « ».

## 7. Accessibility

WCAG 2.2 AA in both themes; text 4.5:1, UI edges and chart strokes 3:1; never colour alone; visible
focus; keyboard path through cards and controls; 44 px targets; usable at 200% zoom and 320 px; every
chart has its counts as text; `lang` on every passage. Reading works without JavaScript: the generator
prints the default lists into the HTML; JavaScript only adds the timeline, charts and filters.

## 8. What NOT to do

Percentages, scores, ranks, meters; verdict colours that mean good or bad (green, red, traffic
lights), colour without pattern and label, ticks, crosses; portraits, party colours,
logos, flags; hero sections, carousels, pop-ups, share images; methodology on the home page; more than
two type sizes or two weights; a tap that opens more than one phone screen; curated or "featured"
items; paraphrased quotes; web fonts and third-party assets; lorem ipsum (mockups use bannered
fictional data until confirmed records exist).

## How KANVERIFY looks different

| Site | Taken | Rejected |
| --- | --- | --- |
| Lui Président (luipresident.fr) | plain counts that link to filtered lists | per-leader illustrations, inconsistent verdict order, no timeline |
| PolitiFact Obameter | dated history on the item; counts that filter | meter graphic, percentages, photos, newsroom density, evidence only in separate articles |
| Polimeter-style government trackers | exhaustive coverage of a platform (same mechanical rule) | single government, colour scales (page not readable on 2026-11-22) |
| Histography | dots on a line, adjustable period | the dense full-history canvas |
| Mémoires de France (memoiresdefrance.com), round 4 | rows that open in place with analysis and typed sources; items grouped by occasion with counts; dated chronology on a focus page; serif display titles; white cards on warm paper; one plain "counts, not a judgment" sentence | percentages, gauges, "score global", portraits, party and left/right labels, importance tags, ✓ / × chip icons, red-to-green verdict colours, publishing unverified analyses |

## What I cut or moved deeper (principle 5)

Round 4: nothing cut. Added only what reuses existing fields: summary line, accordion rows, groups by
source, dated chain (replaces the "Based on" list: same content, ordered by date), coverage sentence.
Not added: breadcrumbs (the item title already links to the person), monospace for dates and ids, focus
pages and a method version (both need record-format fields).

Round 3: the small type size, the third and fourth weights, serif headings, the verdict chip's large
variant, the "not assessed" category (now a verdict), the sixth verdict, unused round-1 styles (side
table of contents, counts grid, search box, evidence block). Earlier rounds: methodology and "latest
confirmations" on home, the Browse page, verdict glyphs, two verdict vocabularies, withdrawn items on
person pages, evidence excerpts on the first screen (moved deeper).

## Decided

| Question | Decision (founder, 2026-11-22) |
| --- | --- |
| Subject identity, languages, domains | decision 0007 |
| Verdicts | six, one set for promises and predictions (decision 0008, revised 15:05: partly came true restored; came true / partly may be given early) |
| Round 4 changes | six patterns ("\|" for partly), dated chain, summary line, accordion rows, groups by source, coverage + "counts, not a score" (coordinator, on the founder's delegation) |
| Verdict colour | palette B: six muted hues, no red/green, always with pattern and label (founder, 2026-11-22, after comparing A and B side by side) |
| Renunciation | the person's own public abandonment is evidence for Did not come true only (0008) |
| Corrections, archives, withdrawn items, jury | one email; files not public; notice only; shown as is, person first |
| Statistics | donut per person, bars per topic, everyone side by side; counts only; neutral sort |
| Home | timeline of the current year with cards that follow the period |
| Layers | summary first, detail one tap deeper, nothing cut |
| Type | two sizes, two weights (round 3) |
| Wide screens | use the width at 1024 / 1440 px (round 3) |

## Principles relied on

3 (one ruler: one chip, equal-ink patterns, no tick/cross, one vocabulary, neutral order, no shares),
1 ("What is missing" never collapsed, and shown on rows), 2 (summary line next to every chip; dated
chain), 5 (cuts above; round 4 reuses existing fields), 8 (no third-party assets or web fonts).

## Objections and risks

- Resolved in round 4: partial results now have their own verdict and pattern.
- **Verdict colour can become a good/bad code (异议与风险, kept after the founder's choice).** Before he
  chose, I preferred one ink: even muted hues get learned ("blue = came true") and then colour judges
  before the summary is read. Mitigation in the design: no green and no red; all six hues of similar
  lightness; the pattern and the label are always present, so colour never stands alone; counts, never
  shares. If readers or the neutrality review show colour being read as a score, revisit.
- Muted fills are 1.0–2.1:1 against the page; sectors and segments are identified by their ink outline
  and pattern instead (WCAG 1.4.11), see the contrast table in `tokens.md`.
- **Chip icons.** The reference site uses ✓ / × / ⚠. I used the verdict's pattern instead: a tick and a
  cross are praise and blame (principle 3, and "What NOT to do" below). The founder may overrule.
- **Two-line summaries** truncate; summaries must lead with the outcome and figures.
- **Unverifiable mixes two different things**: words too vague to check, and a condition that never
  arose. In counts they look the same; a person with many conditional promises looks "vague". The
  summary says which, but charts cannot.
- **Two layers** mean excerpts are one tap from the verdict; the "Based on" line is my guard.
- **Side-by-side comparison** across offices and countries can be read as a ranking; country is on
  every row and a country filter exists.
- **The donut is a share by shape**; counts on every sector are mandatory.
- **Still open**: no neutrality-review
  result in the record; the corrections address does not exist yet.
