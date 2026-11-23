import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { buildSite } from '../src/site.js';
import { confirm, withdraw } from '../src/ledger.js';
import { addClaim, addEvidence, addSource, addVerdict, addVote, freshDb, readyClaim } from './helpers.js';

// Unique strings that must never reach any output file.
const WITHDRAWN = 'Wdmarkqz7';
const UNCONFIRMED = 'Uncnfmarkq8';
const NEVER = 'Nevermarkq9';
const REVIEWER = 'reviewer-zq5'; // publications.confirmed_by is internal
const TODAY = '2026-11-22';
// A confirmation date is publications.confirmed_at, which the schema pins to the real clock
// (trigger ledger_now), so the tests read it back instead of assuming the day they were written.
const confirmedOn = (claimId) => db.prepare('SELECT substr(confirmed_at, 1, 10) AS d FROM publications WHERE claim_id = ? ORDER BY id DESC LIMIT 1').get(claimId).d;
const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};
const longDate = (iso, lang) => `${lang === 'fr' && Number(iso.slice(8, 10)) === 1 ? '1er' : Number(iso.slice(8, 10))}${String.fromCharCode(160)}${MONTHS[lang][Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;

let db;
let out;
let ids;
const files = new Map(); // relative path with "/" → content

function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.set(relative(out, full).split(sep).join('/'), readFileSync(full, 'utf8'));
  }
}

const page = (path) => {
  assert.ok(files.has(path), `missing ${path}`);
  return files.get(path);
};

/** A promise resting on one law, verdict "came_true". */
function outcomeClaim(d, subjectId) {
  const platform = addSource(d, 'platform');
  const law = addSource(d, 'law', { sha256: 'd'.repeat(64) });
  const claim = addClaim(d, platform, { subject_id: subjectId, domain: 'justice' });
  const v = addVerdict(d, claim, 'came_true');
  addEvidence(d, v, law);
  return { claim, v };
}

function fixture() {
  const d = freshDb(); // subject 1: "Test Subject", FR
  const c = {};

  // 1. Came true, two jury votes. Then edited in the workspace without a new confirmation.
  c.cameTrue = readyClaim(d).claim;
  addVote(d, c.cameTrue, 'model-a', 'came_true');
  addVote(d, c.cameTrue, 'model-b', 'to_evaluate', { provider: 'provider-b', open_question: 'Which decree?' });
  confirm(d, c.cameTrue, REVIEWER);
  d.prepare('UPDATE claims SET quote_en = ? WHERE id = ?').run(`We will do X. ${UNCONFIRMED}`, c.cameTrue);

  // 2. Pending prediction, due this year.
  // Its origin address is recorded in a non-normal form (upper case, a space).
  const p2 = addSource(d, 'platform', { url: 'HTTPS://Example.ORG/p2 path' });
  c.pending = addClaim(d, p2, { type: 'prediction', domain: 'health', deadline: '2026-12-31' });
  addVerdict(d, c.pending, 'pending');
  confirm(d, c.pending, REVIEWER);

  // 3. Vague claim whose quote tries to inject markup; its origin address is not http(s).
  const p3 = addSource(d, 'platform', { url: 'javascript:alert(1)' });
  c.vague = addClaim(d, p3, {
    domain: 'environment',
    quote_original: 'Nous ferons <script>alert("x")</script> & mieux.',
    quote_en: 'We will do <script>alert(2)</script> better.',
    verifiability: 'vague',
    deadline: null,
    deadline_basis: null,
    criteria_fr: null,
    criteria_en: null,
  });
  addVerdict(d, c.vague, 'unverifiable');
  confirm(d, c.vague, REVIEWER);

  // 4. To be assessed, confirmed twice (a correction).
  const p4 = addSource(d, 'platform', { url: 'https://example.org/p4' });
  c.toEvaluate = addClaim(d, p4, { domain: 'housing' });
  addVerdict(d, c.toEvaluate, 'to_evaluate', {
    open_question_fr: 'Il manque le registre des logements.',
    open_question_en: 'The housing register is missing.',
  });
  confirm(d, c.toEvaluate, REVIEWER);
  d.prepare("UPDATE verdicts SET summary_en = 'Updated summary.', summary_fr = 'Résumé mis à jour.' WHERE claim_id = ?").run(c.toEvaluate);
  confirm(d, c.toEvaluate, REVIEWER);

  // 5. Published twice, then withdrawn. Its subject has nothing else published.
  d.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', ?, 'CA')").run(`Withdrawn Person ${WITHDRAWN}`);
  const p5 = addSource(d, 'platform', { url: `https://example.org/${WITHDRAWN}`, title: `Platform ${WITHDRAWN}` });
  const law5 = addSource(d, 'law', { url: `https://example.org/law-${WITHDRAWN}`, sha256: 'c'.repeat(64) });
  c.withdrawn = addClaim(d, p5, {
    subject_id: 2,
    domain: 'transport',
    quote_original: `Nous ferons ${WITHDRAWN}.`,
    quote_en: `We will do ${WITHDRAWN}.`,
    criteria_fr: `Critère ${WITHDRAWN}.`,
    criteria_en: `Criterion ${WITHDRAWN}.`,
  });
  const v5 = addVerdict(d, c.withdrawn, 'came_true', { summary_fr: `Résumé ${WITHDRAWN}.`, summary_en: `Summary ${WITHDRAWN}.` });
  addEvidence(d, v5, law5, `Article ${WITHDRAWN}.`, { excerpt_fr: null, excerpt_en: `Article ${WITHDRAWN} (en).` });
  confirm(d, c.withdrawn, REVIEWER);
  d.prepare('UPDATE verdicts SET summary_en = ? WHERE id = ?').run(`Second summary ${WITHDRAWN}.`, v5);
  confirm(d, c.withdrawn, REVIEWER);
  withdraw(d, c.withdrawn, REVIEWER, {
    noteFr: 'Cité d’un brouillon jamais publié.',
    noteEn: 'Quoted from a draft that was never published.',
  });

  // 6. Never confirmed.
  const p6 = addSource(d, 'platform', { url: 'https://example.org/p6' });
  c.never = addClaim(d, p6, { quote_original: `Nous ferons ${NEVER}.` });
  addVerdict(d, c.never, 'pending');

  // 7. Published (came true), withdrawn, then confirmed again as did not come true: P, W, P.
  //    The first entry is the withdrawn content; only the last one may show a verdict.
  d.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', 'Third Subject', 'FR')").run();
  let v;
  ({ claim: c.republished, v } = outcomeClaim(d, 3));
  confirm(d, c.republished, REVIEWER);
  withdraw(d, c.republished, REVIEWER, { noteFr: 'La mauvaise page était citée.', noteEn: 'The wrong page was cited.' });
  d.prepare("UPDATE verdicts SET verdict = 'not_came_true' WHERE id = ?").run(v);
  confirm(d, c.republished, REVIEWER);

  // 8. Published as came true, then as did not come true, then withdrawn: P, P, W.
  //    No verdict of this item may appear anywhere, not even the superseded one.
  ({ claim: c.changedThenWithdrawn, v } = outcomeClaim(d, 1));
  confirm(d, c.changedThenWithdrawn, REVIEWER);
  d.prepare("UPDATE verdicts SET verdict = 'not_came_true' WHERE id = ?").run(v);
  confirm(d, c.changedThenWithdrawn, REVIEWER);
  withdraw(d, c.changedThenWithdrawn, REVIEWER, { noteFr: 'La citation n’était pas de cette personne.', noteEn: 'The quote was not the speaker’s.' });

  // 9. Subject 4, for the person page grouped by where it was said (round 4).
  //    Source g1 (said 2020 and 2021, same role) → one group of two, plus one item in another
  //    role → its own group; source g2 (said 2019) → first group; source g3 → an early "came true"
  //    resting on a dated statistic and an undated Légifrance text; one withdrawn item on g1.
  d.prepare("INSERT INTO subjects (kind, name, country) VALUES ('party', 'Group Party', 'FR')").run();
  const g1 = addSource(d, 'platform', { url: 'https://example.org/g1', title: 'Programme g1', published_on: '2020-01-01' });
  const g2 = addSource(d, 'statement', { url: 'https://example.org/g2', title: 'Interview g2', published_on: null, lang: 'en' });
  const g3 = addSource(d, 'platform', { url: 'https://example.org/g3', title: 'Programme g3' });
  c.g1a = addClaim(d, g1, { subject_id: 4, domain: 'tax', said_on: '2021-03-01', deadline: '2027-01-01' });
  // An open question on a verdict other than to_evaluate: shown on the item page, never as a row's line.
  addVerdict(d, c.g1a, 'pending', { open_question_fr: 'Question ouverte g1a.', open_question_en: 'Open question g1a.' });
  confirm(d, c.g1a, REVIEWER);
  c.g1b = addClaim(d, g1, { subject_id: 4, domain: 'tax', said_on: '2020-06-01', verifiability: 'vague', deadline: null, deadline_basis: null, criteria_fr: null, criteria_en: null });
  addVerdict(d, c.g1b, 'unverifiable');
  confirm(d, c.g1b, REVIEWER);
  c.g1other = addClaim(d, g1, { subject_id: 4, domain: 'tax', said_on: '2022-01-01', speaker_role_fr: 'Maire', speaker_role_en: 'Mayor' });
  addVerdict(d, c.g1other, 'pending');
  confirm(d, c.g1other, REVIEWER);
  c.g2 = addClaim(d, g2, {
    subject_id: 4, domain: 'tax', said_on: '2019-05-01', deadline: '2026-10-01', lang: 'en',
    quote_original: 'We will cut tax Y.', quote_fr: 'Nous baisserons l’impôt Y.', quote_en: null,
  });
  addVerdict(d, c.g2, 'to_evaluate', {
    summary_fr: 'Résumé <b>gras</b> & « citation ».', summary_en: 'Summary <b>bold</b> & "quoted".',
    open_question_fr: 'Il manque <i>le décret</i>.', open_question_en: 'Missing <i>the decree</i>.',
  });
  confirm(d, c.g2, REVIEWER);
  c.g1withdrawn = addClaim(d, g1, { subject_id: 4, domain: 'tax', said_on: '2020-02-01', quote_original: `Nous ferons ${WITHDRAWN} encore.` });
  addVerdict(d, c.g1withdrawn, 'pending');
  confirm(d, c.g1withdrawn, REVIEWER);
  withdraw(d, c.g1withdrawn, REVIEWER, { noteFr: 'Doublon.', noteEn: 'Duplicate.' });
  const stat = addSource(d, 'statistic', { url: 'https://example.org/stat', title: 'Statistique 2025', published_on: '2025-01-01', sha256: 'e'.repeat(64) });
  const lf = addSource(d, 'law', {
    url: 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000000000001', title: 'Loi n° 1', publisher: 'Légifrance (DILA)',
    published_on: null, media_type: 'application/json', sha256: 'f'.repeat(64),
  });
  c.early = addClaim(d, g3, { subject_id: 4, domain: 'tax', said_on: '2023-01-01', deadline: '2027-12-31' });
  const vEarly = addVerdict(d, c.early, 'came_true');
  addEvidence(d, vEarly, lf, 'Article 1er.', { excerpt_fr: null, excerpt_en: 'Article 1.' });
  addEvidence(d, vEarly, stat, 'Chiffre : 100.', { excerpt_fr: null, excerpt_en: 'Figure: 100.' });
  confirm(d, c.early, REVIEWER);

  return { d, c };
}

before(() => {
  ({ d: db, c: ids } = fixture());
  out = mkdtempSync(join(tmpdir(), 'kv-site-'));
  rmSync(out, { recursive: true });
  buildSite(db, out, { today: TODAY });
  walk(out);
});

after(() => {
  rmSync(out, { recursive: true, force: true });
  db.close();
});

test('the fixture really holds the withdrawn content in the ledger', () => {
  const { n } = db.prepare('SELECT count(*) AS n FROM publications WHERE snapshot LIKE ?').get(`%${WITHDRAWN}%`);
  assert.equal(n, 5); // item 5: two confirmations and the withdrawal; item g1withdrawn: one of each
});

test('writes exactly the files listed in ia.md, for both languages', () => {
  const expected = new Set(['.kanverify-site', 'index.html', 'assets/kanverify.css', 'assets/site.js']);
  const domains = ['economy', 'tax', 'employment', 'health', 'education', 'environment', 'energy', 'security', 'defence',
    'justice', 'immigration', 'foreign_affairs', 'institutions', 'social', 'housing', 'transport', 'agriculture',
    'digital', 'culture', 'other'];
  for (const lang of ['fr', 'en']) {
    for (const p of ['index.html', 'index.json', 'method/index.html', 'corrections/index.html']) expected.add(`${lang}/${p}`);
    for (const d of domains) expected.add(`${lang}/topic/${d}/index.html`);
    expected.add(`${lang}/subject/1-test-subject/index.html`);
    expected.add(`${lang}/subject/1/index.html`);
    expected.add(`${lang}/subject/3-third-subject/index.html`);
    expected.add(`${lang}/subject/3/index.html`);
    expected.add(`${lang}/subject/4-group-party/index.html`);
    expected.add(`${lang}/subject/4/index.html`);
    for (const id of [ids.cameTrue, ids.pending, ids.vague, ids.toEvaluate, ids.withdrawn, ids.republished, ids.changedThenWithdrawn, ids.g1a, ids.g1b, ids.g1other, ids.g2, ids.g1withdrawn, ids.early]) expected.add(`${lang}/claim/${id}/index.html`);
  }
  assert.deepEqual([...files.keys()].sort(), [...expected].sort());
});

test('both sites are built in their own language', () => {
  const en = page(`en/claim/${ids.cameTrue}/index.html`);
  const fr = page(`fr/claim/${ids.cameTrue}/index.html`);
  assert.match(en, /<html lang="en">/);
  assert.match(fr, /<html lang="fr">/);
  assert.match(en, /<span class="verdict" data-v="came_true">Came true<\/span>/);
  assert.match(fr, /<span class="verdict" data-v="came_true">Réalisée<\/span>/);
  assert.match(en, /Summary of the outcome\./);
  assert.match(fr, /Résumé du résultat\./);
});

test('the page is in its own language: translation first, the original under it, labelled (decision 0007 addendum)', () => {
  const en = page(`en/claim/${ids.cameTrue}/index.html`);
  const fr = page(`fr/claim/${ids.cameTrue}/index.html`);
  // Item page, English: the translation is the main text, the French original follows, labelled and with its lang.
  // Typography (components.md "Translated quote"): .translated = our translation (sans, labelled),
  // .original = their words (serif, full ink, labelled), and only their own words use the serif .quote.
  assert.ok(en.includes('<div class="translated" lang="en"><span class="label">Translation</span><p>We will do X before 2027.</p></div>\n' +
    '<div class="original"><span class="label">Original (French)</span><p lang="fr">Nous ferons X avant 2027.</p></div>'));
  assert.doesNotMatch(en, /<blockquote class="quote" lang="en">/);
  // The evidence excerpt follows the same rule.
  assert.ok(en.includes('<div class="translated" lang="en"><span class="label">Translation</span><p>Article 1: X enters into force on 1 January 2025.</p></div>'));
  assert.ok(en.includes('<div class="original"><span class="label">Original (French)</span><p lang="fr">Article 1 : X entre en vigueur le 1er janvier 2025.</p></div>'));
  // Already in the page language: shown as before (serif quote), no translation block.
  assert.ok(fr.includes('<blockquote class="quote" lang="fr"><p>Nous ferons X avant 2027.</p></blockquote>'));
  assert.doesNotMatch(fr, /class="(translated|original)"/);
  // An English original on the French site.
  const frG2 = page(`fr/claim/${ids.g2}/index.html`);
  assert.ok(frG2.includes('<div class="translated" lang="fr"><span class="label">Traduction</span><p>Nous baisserons l’impôt Y.</p></div>\n' +
    '<div class="original"><span class="label">Original (anglais)</span><p lang="en">We will cut tax Y.</p></div>'));
  // Rows and cards: translation (sans) then the original (serif) with an inline label.
  assert.ok(page('en/topic/economy/index.html').includes(
    '<span class="row-translated" lang="en"><span class="visually-hidden">Translation: </span>We will do X before 2027.</span>' +
    '<span class="row-original"><span class="label-inline">Original (French): </span><span lang="fr">Nous ferons X avant 2027.</span></span>'));
  const nb = String.fromCharCode(160);
  assert.ok(page('fr/index.html').includes(
    `<p class="card-translated" lang="fr"><span class="visually-hidden">Traduction${nb}: </span>Nous baisserons l’impôt Y.</p>` +
    `<p class="card-original"><span class="label-inline">Original (anglais)${nb}: </span><span lang="en">We will cut tax Y.</span></p>`));
  // The original is never dropped: every published quote appears verbatim on both sites' item pages.
  for (const lang of ['en', 'fr']) {
    for (const item of JSON.parse(page(`${lang}/index.json`)).items) {
      assert.ok(page(`${lang}/claim/${item.id}/index.html`).includes(`lang="${item.lang}">`), `${lang} ${item.id}`);
    }
  }
});

test('counts per verdict on subject and topic pages match the current published set', () => {
  const rows = db
    .prepare("SELECT json_extract(snapshot, '$.verdict.verdict') AS v FROM current_publications WHERE status = 'published' AND json_extract(snapshot, '$.subject.id') = 1")
    .all();
  const expected = { unverifiable: 0, pending: 0, to_evaluate: 0, came_true: 0, partly_came_true: 0, not_came_true: 0 };
  for (const r of rows) expected[r.v]++;
  assert.deepEqual(expected, { unverifiable: 1, pending: 1, to_evaluate: 1, came_true: 1, partly_came_true: 0, not_came_true: 0 });
  const asOf = db.prepare("SELECT max(substr(confirmed_at, 1, 10)) AS d FROM current_publications WHERE status = 'published' AND json_extract(snapshot, '$.subject.id') = 1").get().d;

  for (const lang of ['fr', 'en']) {
    const html = page(`${lang}/subject/1-test-subject/index.html`);
    for (const [v, n] of Object.entries(expected)) {
      assert.match(html, new RegExp(`data-verdict="${v}"><span class="legend-l">[^<]+</span> <span class="n">${n}</span>`), `${lang} ${v}`);
    }
    assert.match(html, new RegExp(`<p class="muted">[^<]+ · ${lang === 'fr' ? '4 fiches · verdicts au' : '4 items · verdicts as of'} <time datetime="${asOf}">`));
    assert.equal((html.match(/<details class="row"/g) || []).length, 4);
  }
  const housing = page('en/topic/housing/index.html');
  assert.match(housing, /<tr><th scope="row">Test Subject<\/th><td class="num">0<\/td><td class="num">0<\/td><td class="num">1<\/td><td class="num">0<\/td><td class="num">0<\/td><td class="num">0<\/td><\/tr>/);
  assert.equal((page('en/topic/transport/index.html').match(/<details class="row"/g) || []).length, 0);

  for (const lang of ['fr', 'en']) {
    const index = JSON.parse(page(`${lang}/index.json`));
    assert.deepEqual(index.items.map((i) => i.id), [ids.cameTrue, ids.pending, ids.vague, ids.toEvaluate, ids.republished, ids.g1a, ids.g1b, ids.g1other, ids.g2, ids.early]);
    assert.deepEqual(Object.keys(index.subjects), ['1', '3', '4']);
    assert.deepEqual(Object.keys(index.items[0]).sort(),
      ['basis', 'confirmed', 'deadline', 'domain', 'en', 'fr', 'id', 'lang', 'q', 'role_en', 'role_fr', 's', 'said', 'type', 'verdict', 'verif',
        'sum_fr', 'sum_en', 'oq_fr', 'oq_en', 'src', 'ev'].sort());
    assert.deepEqual(Object.keys(index).sort(), ['items', 'sources', 'subjects']);
    assert.deepEqual(Object.keys(index.items[0].ev[0]).sort(), ['k', 'l', 'p', 't']);
    assert.deepEqual(Object.keys(Object.values(index.sources)[0]).sort(), ['date', 'kind', 'lang', 'publisher', 'title']);
    assert.deepEqual(index.subjects['1'], { id: 1, name: 'Test Subject', kind: 'person', country: 'FR', slug: 'test-subject' });
  }
});

test('withdrawn content appears in no output file; the item page keeps only the notice', () => {
  for (const [path, content] of files) assert.ok(!content.includes(WITHDRAWN), `withdrawn content in ${path}`);
  const en = page(`en/claim/${ids.withdrawn}/index.html`);
  assert.match(en, /This item was withdrawn/);
  assert.match(en, /Quoted from a draft that was never published\./);
  assert.doesNotMatch(en, /Cité d’un brouillon/);
  assert.doesNotMatch(en, /class="verdict"/);
  const fr = page(`fr/claim/${ids.withdrawn}/index.html`);
  assert.match(fr, /Cette fiche a été retirée/);
  // Each site shows the reason in its own language, and only that one.
  assert.match(fr, /Cité d’un brouillon jamais publié\./);
  assert.doesNotMatch(fr, /Quoted from a draft/);
  // No trace in lists or counts: its subject has no page and is not on the home page.
  assert.ok(![...files.keys()].some((p) => p.includes('/subject/2')));
  assert.doesNotMatch(page('en/index.html'), /Withdrawn Person/);
  // Corrections lists the withdrawal with its reason, and no verdict of the withdrawn item.
  const corr = page('en/corrections/index.html');
  // Each language's punctuation: no space before the colon in English, a no-break space in French.
  assert.ok(corr.includes(`Item ${ids.withdrawn}: Published → Withdrawn</a><p>Quoted from a draft`));
  assert.ok(page('fr/corrections/index.html').includes(`n°${String.fromCharCode(160)}${ids.withdrawn}${String.fromCharCode(160)}: Publiée → Retirée</a>`));
  const corrFr = page('fr/corrections/index.html');
  assert.match(corrFr, /<p>Cité d’un brouillon jamais publié\.<\/p>/);
  assert.doesNotMatch(corrFr, /Quoted from a draft/);
});

test('unconfirmed workspace changes and unconfirmed claims never appear', () => {
  for (const [path, content] of files) {
    assert.ok(!content.includes(UNCONFIRMED), `unconfirmed edit in ${path}`);
    assert.ok(!content.includes(NEVER), `unconfirmed claim in ${path}`);
    assert.ok(!content.includes(REVIEWER), `confirmed_by in ${path}`);
  }
  assert.ok(!files.has(`en/claim/${ids.never}/index.html`));
});

test('all text is escaped and only http(s) addresses become links', () => {
  for (const [path, content] of files) {
    assert.ok(!content.includes('<script>alert'), `unescaped markup in ${path}`);
    assert.ok(!/href="\s*javascript:/i.test(content), `javascript: link in ${path}`);
  }
  const fr = page(`fr/claim/${ids.vague}/index.html`);
  assert.match(fr, /Nous ferons &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; mieux\./);
  assert.match(fr, /<dd>javascript:alert\(1\)<\/dd>/);
  assert.match(page(`en/claim/${ids.vague}/index.html`), /<li class="open"><span class="when">No date<\/span><span>The wording itself · vague · no deadline<\/span><\/li>/);
  // The JSON index keeps the words but cannot be read as markup.
  const index = JSON.parse(page('en/index.json'));
  assert.equal(index.items.find((i) => i.id === ids.vague).q, 'Nous ferons <script>alert("x")</script> & mieux.');
});

test('to be assessed shows what is missing in the summary layer; history shows both entries', () => {
  const en = page(`en/claim/${ids.toEvaluate}/index.html`);
  assert.match(en, /<h2>What is missing<\/h2>\s*<p>The housing register is missing\.<\/p>/);
  assert.match(en, /Updated summary\./);
  assert.equal((en.match(/<li><span>[^<]+<\/span> <span class="verdict" data-v="to_evaluate">To be assessed<\/span>/g) || []).length, 2);
  assert.match(page(`fr/claim/${ids.toEvaluate}/index.html`), /<h2>Ce qui manque<\/h2>/);
});

test('home prints the current year of deadlines and every subject without JavaScript', () => {
  const en = page('en/index.html');
  assert.match(en, /<h3 class="month">December 2026<\/h3>/);
  assert.match(en, new RegExp(`href="\\.\\./en/claim/${ids.pending}/"`));
  assert.doesNotMatch(en, new RegExp(`id="c-${ids.cameTrue}"`)); // due in 2027
  assert.match(en, /href="\.\.\/en\/subject\/1-test-subject\/"><span>Test Subject <span class="muted">· Person · France<\/span><\/span><span class="n">4 items<\/span>/);
  assert.match(page('en/subject/1/index.html'), /url=\.\.\/1-test-subject\//);
});

test('refuses to clear a folder it did not make, and clears its own previous build', () => {
  const foreign = mkdtempSync(join(tmpdir(), 'kv-foreign-'));
  try {
    writeFileSync(join(foreign, 'keep.txt'), 'mine');
    assert.throws(() => buildSite(db, foreign, { today: TODAY }), /not empty/);
    assert.ok(existsSync(join(foreign, 'keep.txt')));
  } finally {
    rmSync(foreign, { recursive: true, force: true });
  }
  const own = mkdtempSync(join(tmpdir(), 'kv-own-'));
  try {
    buildSite(db, own, { today: TODAY });
    mkdirSync(join(own, 'en', 'subject', '9-stale'), { recursive: true });
    writeFileSync(join(own, 'en', 'subject', '9-stale', 'index.html'), 'stale');
    buildSite(db, own, { today: TODAY });
    assert.ok(!existsSync(join(own, 'en', 'subject', '9-stale')));
  } finally {
    rmSync(own, { recursive: true, force: true });
  }
});

// Each of the two blanking rules in readLedger is needed: "the next entry is a withdrawal"
// (fixture 7) and "the claim is currently withdrawn" (fixture 8).
const between = (html, start, end) => {
  const i = html.indexOf(start);
  assert.ok(i >= 0, `no ${start}`);
  return html.slice(i, html.indexOf(end, i) + end.length);
};
const historyOf = (html) => between(html, '<ol class="history">', '</ol>');
const correctionsOf = (html, id) =>
  html.split('<li id="entry-').slice(1).map((li) => li.slice(0, li.indexOf('</li>'))).filter((li) => li.includes(`/claim/${id}/"`));

test('a withdrawn entry shows no verdict even after the item is confirmed again (P, W, P)', () => {
  for (const [lang, came, notCame, withdrawn, published] of [
    ['en', 'Came true', 'Did not come true', 'Withdrawn', 'Published'],
    ['fr', 'Réalisée', 'Non réalisée', 'Retirée', 'Publiée'],
  ]) {
    const html = page(`${lang}/claim/${ids.republished}/index.html`);
    const history = historyOf(html);
    assert.doesNotMatch(history, new RegExp(`>${came}<`), `${lang} history`);
    assert.equal((history.match(/<li>/g) || []).length, 3);
    assert.match(history, new RegExp(`</span> ${published} <span class="muted">`));
    assert.match(history, new RegExp(`</span> ${withdrawn} <a `));
    assert.match(history, new RegExp(`<span class="verdict" data-v="not_came_true">${notCame}</span>`));
    const corr = correctionsOf(page(`${lang}/corrections/index.html`), ids.republished);
    assert.equal(corr.length, 2);
    for (const li of corr) assert.doesNotMatch(li, new RegExp(`>${came}<`), `${lang} corrections`);
  }
});

test('an item withdrawn after a change of verdict shows none of its verdicts (P, P, W)', () => {
  for (const lang of ['en', 'fr']) {
    assert.doesNotMatch(page(`${lang}/claim/${ids.changedThenWithdrawn}/index.html`), /class="verdict"/);
    const corr = correctionsOf(page(`${lang}/corrections/index.html`), ids.changedThenWithdrawn);
    assert.equal(corr.length, 2);
    for (const li of corr) assert.doesNotMatch(li, /class="verdict"/, `${lang} corrections`);
  }
});

test('an address links to its normalised form and shows the text as recorded', () => {
  assert.ok(page(`en/claim/${ids.pending}/index.html`)
    .includes('<a class="mono" href="https://example.org/p2%20path">HTTPS://Example.ORG/p2 path</a>'));
});

/** A stand-in for the database that returns one ledger row with the given snapshot. */
function fakeLedger(snapshot) {
  const row = { id: 1, claim_id: 1, status: 'published', note_fr: null, note_en: null, confirmed_at: '2026-11-22T10:00:00Z', snapshot: JSON.stringify(snapshot), is_current: 1 };
  return { prepare: () => ({ all: () => [row] }) };
}

test('"partly came true" is labelled in both languages and has its own chart pattern', () => {
  const snap = currentSnapshot(ids.cameTrue);
  snap.verdict.verdict = 'partly_came_true';
  const dir = mkdtempSync(join(tmpdir(), 'kv-partly-'));
  try {
    const site = join(dir, 'site');
    buildSite(fakeLedger(snap), site, { today: TODAY });
    const read = (p) => readFileSync(join(site, ...p.split('/')), 'utf8');
    assert.match(read(`en/claim/${snap.claim.id}/index.html`), /<span class="verdict" data-v="partly_came_true">Partly came true<\/span>/);
    assert.match(read(`fr/claim/${snap.claim.id}/index.html`), /<span class="verdict" data-v="partly_came_true">Partiellement réalisée<\/span>/);
    for (const lang of ['en', 'fr']) {
      assert.match(read(`${lang}/subject/1-test-subject/index.html`), /data-verdict="partly_came_true"><span class="legend-l">[^<]+<\/span> <span class="n">1<\/span>/, lang);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // The chart script draws six verdicts, each with a pattern of its own.
  const views = readFileSync(new URL('../src/site-assets/views.js', import.meta.url), 'utf8');
  const order = JSON.parse(views.match(/var ORDER = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(order, ['unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true']);
  const patterns = order.map((v) => (views.match(new RegExp(`^    ${v}: '([^']*)'`, 'm')) || [])[1]);
  assert.ok(patterns.every((p) => p !== undefined), 'every verdict has a pattern');
  assert.equal(new Set(patterns).size, order.length, 'patterns are distinct');
});

function currentSnapshot(id) {
  return JSON.parse(db.prepare('SELECT snapshot FROM current_publications WHERE claim_id = ?').get(id).snapshot);
}

function assertPreviousSiteKept(breakIt, message) {
  const parent = mkdtempSync(join(tmpdir(), 'kv-swap-'));
  const site = join(parent, 'site');
  try {
    buildSite(db, site, { today: TODAY });
    const before = readFileSync(join(site, 'en', 'index.html'), 'utf8');
    assert.throws(breakIt(site), message);
    assert.equal(readFileSync(join(site, 'en', 'index.html'), 'utf8'), before);
    assert.ok(existsSync(join(site, 'en', 'claim', String(ids.cameTrue), 'index.html')));
    assert.deepEqual(readdirSync(parent), ['site']); // no build or old folder left behind
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

test('a code without a label stops the build before anything is replaced', () => {
  const snap = currentSnapshot(ids.cameTrue);
  snap.claim.domain = 'space';
  assertPreviousSiteKept((site) => () => buildSite(fakeLedger(snap), site, { today: TODAY }), /unknown domain "space"/);
  const snap2 = currentSnapshot(ids.cameTrue);
  snap2.evidence[0].kind = 'rumour';
  assertPreviousSiteKept((site) => () => buildSite(fakeLedger(snap2), site, { today: TODAY }), /unknown source kind "rumour"/);
});

test('a page that fails to render leaves the previous site in place', () => {
  const snap = currentSnapshot(ids.cameTrue);
  snap.claim.said_on = null; // passes the label check, breaks rendering
  assertPreviousSiteKept((site) => () => buildSite(fakeLedger(snap), site, { today: TODAY }), TypeError);
});

test('a failed swap keeps the previous site and leaves no build folder behind', () => {
  for (const failOn of [1, 2]) { // moving the old site away, or moving the new one in
    let calls = 0;
    const rename = (from, to) => {
      calls++;
      if (calls === failOn) throw Object.assign(new Error('simulated'), { code: 'EPERM' });
      renameSync(from, to);
    };
    assertPreviousSiteKept((site) => () => buildSite(db, site, { today: TODAY, rename }),
      (error) => error.message.startsWith('Could not replace ') && error.message.endsWith('(EPERM). The previous site was kept.'));
  }
});

// ------------------------------------------------------------------ round 4

const NBSP = String.fromCharCode(160);

/** The person page's groups as printed without JavaScript. */
function groupsOf(html) {
  return html.split('<section class="group" data-group="').slice(1).map((part) => {
    const body = part.slice(0, part.indexOf('</section>'));
    const key = body.slice(0, body.indexOf('"'));
    const counts = {};
    for (const li of body.split('<li data-verdict="').slice(1)) {
      const v = li.slice(0, li.indexOf('"'));
      const n = li.slice(li.indexOf('<span class="n">') + 16);
      counts[v] = Number(n.slice(0, n.indexOf('<')));
    }
    const rows = body.split('<details class="row" id="r-').slice(1).map((r) => {
      const at = r.indexOf('data-v="') + 8;
      return { id: Number(r.slice(0, r.indexOf('"'))), verdict: r.slice(at, r.indexOf('"', at)) };
    });
    const total = Number(body.match(/<p class="muted">(\d+)/)[1]);
    return { key, counts, rows, total, body };
  });
}

test('the person page groups items by where they were said; each group counts exactly its rows', () => {
  for (const lang of ['en', 'fr']) {
    const html = page(`${lang}/subject/4-group-party/index.html`);
    const groups = groupsOf(html);
    const srcOf = (id) => JSON.parse(page(`${lang}/index.json`)).items.find((i) => i.id === id).src;
    // Oldest first: g2 (2019), g1 default role (2020), g1 "Maire" (2022), g3 (2023).
    assert.deepEqual(groups.map((g) => g.rows.map((r) => r.id)), [[ids.g2], [ids.g1b, ids.g1a], [ids.g1other], [ids.early]]);
    assert.equal(groups[1].key, `${srcOf(ids.g1a)}|Candidat à la présidence, 2022`);
    assert.equal(groups[2].key, `${srcOf(ids.g1other)}|Maire`);
    for (const g of groups) {
      assert.equal(g.total, g.rows.length, `${lang} ${g.key} item count`);
      assert.deepEqual(Object.keys(g.counts), ['unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true']);
      for (const [v, n] of Object.entries(g.counts)) {
        assert.equal(n, g.rows.filter((r) => r.verdict === v).length, `${lang} ${g.key} ${v}`);
      }
    }
    // Inside a group a row does not repeat the date said, role and deadline when closed.
    const closedRows = groups[1].body.split('<details class="row"').slice(1).map((r) => r.slice(0, r.indexOf('</summary>')));
    assert.equal(closedRows.length, 2);
    for (const r of closedRows) assert.doesNotMatch(r, /Deadline|Échéance|Candida|2020|2021/);
    // Header: as-of date, coverage sentence over 3 distinct documents, counts-not-score line.
    assert.ok(html.includes(lang === 'en'
      ? 'These 5 items come from 3 documents, listed below with the items taken from each. Anything Group Party said outside these documents is not recorded here.'
      : `Ces 5${NBSP}fiches proviennent de 3${NBSP}documents, présentés ci-dessous avec les fiches tirées de chacun. Les propos de Group Party tenus hors de ces documents ne sont pas enregistrés ici.`));
    assert.ok(html.includes(lang === 'en' ? 'These are counts, not a score.' : 'Ce sont des décomptes, pas une note.'));
    assert.match(html, /<svg id="kv-defs"[^>]*><defs><pattern id="kv-p-unverifiable"/);
  }
});

test('a withdrawn item leaves no trace in groups, counts or index.json', () => {
  const html = page('en/subject/4-group-party/index.html');
  assert.ok(!html.includes(`id="r-${ids.g1withdrawn}"`));
  assert.ok(!html.includes(`/claim/${ids.g1withdrawn}/`));
  for (const lang of ['en', 'fr']) {
    const index = JSON.parse(page(`${lang}/index.json`));
    const withdrawn = [ids.withdrawn, ids.changedThenWithdrawn, ids.g1withdrawn];
    assert.ok(index.items.every((i) => !withdrawn.includes(i.id)));
    // The sources map holds exactly the origins of published items.
    const byNumber = (a, b) => a - b;
    assert.deepEqual(Object.keys(index.sources).map(Number).sort(byNumber), [...new Set(index.items.map((i) => i.src))].sort(byNumber));
  }
});

test('summary lines and what is missing are shown on rows and cards, escaped', () => {
  const en = page('en/subject/4-group-party/index.html');
  // to_evaluate: the closed row shows "What is missing:", the open row adds the summary.
  assert.ok(en.includes('<span class="row-summary"><span class="summary-label">What is missing:</span> Missing &lt;i&gt;the decree&lt;/i&gt;.</span>'));
  assert.ok(en.includes('<div class="row-body"><p>Summary &lt;b&gt;bold&lt;/b&gt; &amp; &quot;quoted&quot;.</p>'));
  assert.ok(en.includes(`<a href="../../../en/claim/${ids.g2}/">Full record, item ${ids.g2}</a>`));
  // Pending has no summary line; vague without evidence says "the wording itself".
  const g1a = en.slice(en.indexOf(`id="r-${ids.g1a}"`));
  assert.ok(!g1a.slice(0, g1a.indexOf('</summary>')).includes('row-summary'));
  assert.ok(en.includes('<li>the wording itself <span class="muted">· vague</span></li>'));
  // The home card (deadline in the current year) carries the same line.
  assert.ok(page('fr/index.html').includes(
    `<p class="card-summary"><span class="summary-label">Ce qui manque${NBSP}:</span> Il manque &lt;i&gt;le décret&lt;/i&gt;.</p>`));
  for (const [path, content] of files) {
    assert.ok(!content.includes('<b>bold') && !content.includes('<i>the decree'), `unescaped summary in ${path}`);
  }
  const index = JSON.parse(page('en/index.json'));
  const item = index.items.find((i) => i.id === ids.g2);
  assert.equal(item.sum_en, 'Summary <b>bold</b> & "quoted".');
  assert.equal(item.oq_en, 'Missing <i>the decree</i>.');
  // oq only for to_evaluate; pending has no summary.
  assert.equal(index.items.find((i) => i.id === ids.g1a).sum_en, null);
  assert.equal(index.items.find((i) => i.id === ids.cameTrue).oq_en, null);
  assert.equal(index.items.find((i) => i.id === ids.g1a).oq_en, null);
  assert.ok(!en.includes('Open question g1a.'));
  assert.match(page(`en/claim/${ids.g1a}/index.html`), /<h2>Open question<\/h2>\s*<p>Open question g1a\.<\/p>/);
});

test('the item page lists its basis as a dated chain', () => {
  const whens = (html) => {
    const start = html.indexOf('<ol class="chain">');
    return html.slice(start, html.indexOf('</ol>', start))
      .split('<span class="when">').slice(1).map((w) => w.slice(0, w.indexOf('</span>')).replace(/<[^>]+>/g, ''));
  };
  const en = page(`en/claim/${ids.early}/index.html`);
  // said → dated evidence → confirmation → deadline after it (early came true) → undated evidence last.
  assert.deepEqual(whens(en), [`1${NBSP}January 2023`, `1${NBSP}January 2025`, longDate(confirmedOn(ids.early), 'en'), `31${NBSP}December 2027`, 'Date not stated']);
  assert.match(en, /<span>Said, in the <a href="#src-\d+">platform, p\. 4<\/a><\/span>/);
  assert.match(en, /<details class="layer" id="src-\d+">/);
  assert.ok(en.includes('Deadline, stated in the promise'));
  assert.ok(en.includes('· law, Légifrance (official database)</span></li>'));
  const fr = page(`fr/claim/${ids.early}/index.html`);
  assert.ok(fr.includes('· texte de loi, Légifrance (base officielle)</span></li>'));
  assert.ok(fr.includes('Date non indiquée'));
  for (const lang of ['en', 'fr']) {
    const ev = JSON.parse(page(`${lang}/index.json`)).items.find((i) => i.id === ids.early).ev;
    assert.deepEqual(ev.map((e) => e.p), [lang === 'en' ? 'Légifrance (official database)' : 'Légifrance (base officielle)', 'Example publisher']);
  }
  // A vague claim without evidence: one undated entry between said and confirmed.
  assert.deepEqual(whens(page(`fr/claim/${ids.vague}/index.html`)), [`17${NBSP}mars 2022`, 'Sans date', longDate(confirmedOn(ids.vague), 'fr')]);
});

test('corrections entries carry their ledger id; the withdrawn page links to its own entry', () => {
  for (const lang of ['en', 'fr']) {
    const html = page(`${lang}/claim/${ids.g1withdrawn}/index.html`);
    const entry = html.match(/corrections\/#entry-(\d+)"/)[1];
    assert.ok(page(`${lang}/corrections/index.html`).includes(`<li id="entry-${entry}">`));
    assert.ok(html.includes(lang === 'en' ? 'Duplicate.' : 'Doublon.'));
  }
});

test('the root page offers both languages without any script', () => {
  const root = page('index.html');
  assert.match(root, /<html lang="fr">/);
  assert.doesNotMatch(root, /<script|http-equiv|cookie/i);
  assert.ok(root.includes('<p lang="en">A chronicle of public promises and predictions</p>'));
  assert.ok(root.includes('<a href="fr/" hreflang="fr" lang="fr">') && root.includes('<a href="en/" hreflang="en" lang="en">'));
});
