import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeAdapter } from '../src/ai/fake.js';
import {
  DOMAINS, candidateProblems, checkVerbatim, estimateCost, extractCandidates, htmlToParagraphs,
  loadPrompt, normalizeForMatch, pdfPageCount,
} from '../src/extract.js';
import { addSource, freshDb } from './helpers.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '../..');

test('normalizeForMatch: layout differences vanish, words and letters do not', () => {
  const n = normalizeForMatch;
  assert.equal(n('la réfor-\nme des retraites'), n('la réforme des retraites'));
  assert.equal(n('Nous baisserons l’impôt !'), n("Nous baisserons l'impôt !"));
  assert.equal(n('« plein emploi »'), n('"plein emploi"'));
  assert.equal(n('peut-être'), n('peut-\nêtre'));
  assert.equal(n('soft­hyphen'), n('softhyphen'));
  assert.notEqual(n('65 ans'), n('64 ans'));
  assert.notEqual(n('Retraite'), n('retraite'));
  assert.notEqual(n('réforme'), n('reforme'));
  // A minus or dash before a digit is a sign or a range, not layout (Fable review 1, finding 9).
  assert.notEqual(n('croissance de -0,3 %'), n('croissance de 0,3 %'));
  assert.notEqual(n('une baisse de − 42 %'), n('une baisse de 42 %'));
  assert.equal(n('croissance de −0,3 %'), n('croissance de -0,3 %'));
  assert.equal(n('2022 – 2023'), n('2022-2023'));
});

test('checkVerbatim: finds a quote inside one unit or across two, refuses a paraphrase', () => {
  const units = [
    { unit: 1, text: 'Titre\nNous porterons l’âge légal\nde départ à 65 ans.' },
    { unit: 2, text: 'Nous créerons 100 000 places\nen crèche.' },
  ];
  assert.deepEqual(checkVerbatim("Nous porterons l'âge légal de départ à 65 ans", units), { verbatim: true, verbatim_unit: 1 });
  assert.deepEqual(checkVerbatim('65 ans. Nous créerons', units), { verbatim: true, verbatim_unit: 1 });
  assert.deepEqual(checkVerbatim('Nous créerons 100 000 places en crèche', units), { verbatim: true, verbatim_unit: 2 });
  assert.equal(checkVerbatim('Nous créerons 100 000 places de crèche', units).verbatim, false);
  assert.equal(checkVerbatim('Nous porterons […] 65 ans', units).verbatim, false);
  assert.equal(checkVerbatim('', units).verbatim, false);
  assert.equal(checkVerbatim(null, units).verbatim, false);
});

test('htmlToParagraphs: visible text only, entities decoded, source line breaks are not paragraphs', () => {
  const html = `<!DOCTYPE html><html><head><title>T</title><style>p{color:red}</style></head>
    <body><!-- hidden --><script>var x = "<p>no</p>";</script>
    <nav><a href="/">Home</a></nav>
    <h4>CORE&nbsp;PROMISE</h4><div><span>1</span></div>
    <p>Seal the border
       and stop the &ldquo;invasion&rdquo; &amp; more&#33; &#x2014; ok</p>
    <ul><li>One</li><li>Two<br>lines</li></ul><svg><text>svgtext</text></svg></body></html>`;
  assert.deepEqual(htmlToParagraphs(html), [
    'Home', 'CORE PROMISE', '1', 'Seal the border and stop the “invasion” & more! — ok', 'One', 'Two', 'lines',
  ].map((s) => s.replace(/ /g, ' ')));
});

test('pdfPageCount reads the page tree; null when nothing is visible', () => {
  const pdf = Buffer.from('%PDF-1.5\n1 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n'
    + '2 0 obj << /Count 13 /Type /Pages /Kids [] >> endobj\n3 0 obj << /Type /Page >> endobj', 'latin1');
  assert.equal(pdfPageCount(pdf), 13);
  assert.equal(pdfPageCount(Buffer.from('%PDF-1.4 << /Type /Page >> << /Type /Page /Parent 1 0 R >>')), 2);
  assert.equal(pdfPageCount(Buffer.from('%PDF-1.5 compressed')), null);
});

test('DOMAINS is exactly the rows of claim_domains in db/schema.sql, in order (format 13)', () => {
  const db = freshDb();
  const rows = db.prepare('SELECT code FROM claim_domains ORDER BY rowid').all().map((r) => r.code);
  db.close();
  assert.deepEqual(rows, [...DOMAINS]);
});

test('estimateCost uses list prices per million tokens; unknown model gives null', () => {
  assert.equal(estimateCost('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 }), 3);
  assert.equal(estimateCost('claude-opus-5-5', { inputTokens: 500_000, outputTokens: 0 }), 2);
  assert.equal(estimateCost('claude-haiku-5-5', { inputTokens: 200_000, outputTokens: 0 }), 0.1);
  assert.equal(estimateCost('some-other-model', { inputTokens: 1, outputTokens: 1 }), null);
});

test('the role prompts carry a version and ask for JSON', () => {
  for (const [file, prefix] of [['extract-prompt.md', 'extract-'], ['transcribe-prompt.md', 'transcribe-']]) {
    const p = loadPrompt(join(ROOT, 'team/run', file));
    assert.ok(p.version.startsWith(prefix), file);
    assert.match(p.text, /JSON/);
    assert.doesNotMatch(p.text, /<!--/);
  }
  const extract = loadPrompt(join(ROOT, 'team/run/extract-prompt.md')).text;
  for (const domain of DOMAINS) assert.ok(extract.includes(`\`${domain}\``), domain);
});

const GOOD = {
  quote_original: 'Nous porterons l’âge légal de départ à 65 ans', lang: 'fr', unit: 1, locator: 'p. 2',
  type: 'promise', domain: 'social', verifiability: 'measurable', deadline: '2027-05-13', deadline_basis: 'inferred',
  criteria_fr: 'Une loi fixe l’âge à 65 ans.', criteria_en: 'A law sets the age at 65.',
  speaker_role_fr: 'Candidat', speaker_role_en: 'Candidate', quote_fr: null, quote_en: 'We will raise the age to 65', notes: null,
};

test('candidateProblems: a good candidate has none; each broken rule is named', () => {
  assert.deepEqual(candidateProblems(GOOD, { unitCount: 2 }), []);
  const cases = [
    [{ domain: 'pensions' }, 'domain is not in the fixed list'],
    [{ lang: 'FR' }, 'lang is not a two-letter ISO 639-1 code'],
    [{ unit: 3 }, 'unit is not a page or paragraph of this source'],
    [{ deadline: '2027-02-30' }, 'deadline is not a YYYY-MM-DD date'],
    [{ deadline_basis: null }, 'deadline and deadline_basis must be given together'],
    [{ criteria_fr: null, criteria_en: null }, 'measurable but no criteria'],
    [{ verifiability: 'vague' }, 'vague or hedged but criteria given'],
    [{ quote_fr: 'x' }, 'quote_fr must be null: the quote is in fr'],
    [{ quote_en: null }, 'quote_en translation missing'],
    [{ criteria_en: '' }, 'criteria in one language only'],
  ];
  for (const [change, problem] of cases) {
    assert.ok(candidateProblems({ ...GOOD, ...change }, { unitCount: 2 }).includes(problem), problem);
  }
});

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-extract-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidenceDir = join(dir, 'evidence');
  const outDir = join(dir, 'candidates');
  mkdirSync(evidenceDir);
  const db = freshDb();
  t.after(() => db.close());
  return { evidenceDir, outDir, db };
}

function saveEvidence(evidenceDir, bytes) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(evidenceDir, sha256), bytes);
  return sha256;
}

const NOW = new Date(2026, 10, 22, 14, 5, 9);

test('PDF: transcribes once, extracts by page range, checks quotes, writes a file and no claim', async (t) => {
  const { evidenceDir, outDir, db } = workspace(t);
  const pdf = Buffer.from('%PDF-1.5 << /Type /Pages /Count 2 >> fake');
  const sha256 = saveEvidence(evidenceDir, pdf);
  const sourceId = addSource(db, 'platform', { sha256, media_type: 'application/pdf', lang: 'fr' });

  const transcription = JSON.stringify({ pages: [
    { page: 1, printed_pages: '2-3', text: 'Nous porterons l’âge légal\nde départ à 65 ans.' },
    { page: 2, printed_pages: null, text: 'Nous agirons pour la planète.' },
  ] });
  const paraphrase = { ...GOOD, quote_original: 'Nous relèverons l’âge de départ', unit: 1 };
  const misplaced = { ...GOOD, quote_original: 'Nous agirons pour la planète', unit: 1, verifiability: 'vague', criteria_fr: null, criteria_en: null, deadline: null, deadline_basis: null };
  const fake = createFakeAdapter([
    transcription,
    JSON.stringify({ candidates: [GOOD, paraphrase, misplaced, { ...GOOD, extra: 'dropped' }] }),
    JSON.stringify({ candidates: [GOOD] }),
  ]);
  const opts = { provider: 'fake', model: 'fake-model', termEnd: '2027-05-13', askOptions: { adapters: { fake } }, evidenceDir, outDir, now: NOW };

  const run = await extractCandidates(db, sourceId, opts);
  assert.equal(fake.calls.length, 2);
  const [transcribeCall, extractCall] = fake.calls;
  assert.match(transcribeCall.promptVersion, /^transcribe-/);
  assert.match(extractCall.promptVersion, /^extract-/);
  for (const call of fake.calls) {
    assert.equal(call.document.mediaType, 'application/pdf');
    assert.ok(Buffer.from(call.document.data).equals(pdf));
    assert.ok(call.system.startsWith(readFileSync(join(ROOT, 'PRINCIPLES.md'), 'utf8')));
    assert.equal(call.json, true);
  }
  assert.match(extractCall.prompt, /Extract only from PDF pages 1 to 2/);
  assert.match(extractCall.prompt, /Term end, for inferred deadlines: 2027-05-13/);

  assert.deepEqual(run.counts, { candidates: 4, verbatim_ok: 3, verbatim_failed: 1, with_problems: 1, duplicates: 1 });
  assert.deepEqual(run.candidates.map((c) => c.verbatim), [true, false, true, true]);
  assert.deepEqual(run.candidates[2].problems, ['quote found on unit 2, not 1']);
  assert.equal(run.candidates[3].duplicate_of, 1);
  assert.equal(Object.hasOwn(run.candidates[3], 'extra'), false);
  assert.equal(run.text.method, 'model-transcription');
  assert.equal(run.text.reused, false);

  const file = join(outDir, 'source-1-fake-model-20261122T140509.json');
  assert.equal(run.path, file);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(saved.prompt_version, run.prompt_version);
  assert.deepEqual(saved.candidates, run.candidates);
  assert.ok(Object.hasOwn(saved.cost_usd_estimate, 'extraction'));
  assert.ok(existsSync(join(outDir, 'source-1-text.json')));
  assert.equal(db.prepare('SELECT count(*) AS n FROM claims').get().n, 0);

  // A second run reuses the transcription: one call only, the extraction.
  const again = await extractCandidates(db, sourceId, { ...opts, now: new Date(2026, 10, 22, 15, 0, 0) });
  assert.equal(fake.calls.length, 3);
  assert.match(fake.calls[2].promptVersion, /^extract-/);
  assert.equal(again.text.reused, true);
  assert.equal(again.cost_usd_estimate.transcription_this_run, 0);
  assert.equal(readdirSync(outDir).length, 3);
});

test('HTML: no model for the text, paragraphs numbered in the prompt, no document sent', async (t) => {
  const { evidenceDir, outDir, db } = workspace(t);
  const html = Buffer.from('<html><head><title>x</title></head><body><h4>CORE PROMISE</h4><p>Seal the border\n and stop it</p></body></html>');
  const sha256 = saveEvidence(evidenceDir, html);
  const sourceId = addSource(db, 'platform', { sha256, media_type: 'text/html', lang: 'en' });
  const candidate = {
    ...GOOD, quote_original: 'Seal the border and stop it', lang: 'en', unit: 2, locator: '§2 (CORE PROMISE)',
    verifiability: 'vague', criteria_fr: null, criteria_en: null, quote_fr: 'Fermer la frontière', quote_en: null,
  };
  const fake = createFakeAdapter([JSON.stringify({ candidates: [candidate] })]);
  const run = await extractCandidates(db, sourceId, {
    provider: 'fake', model: 'fake-model', termEnd: '2029-01-20', askOptions: { adapters: { fake } }, evidenceDir, outDir, now: NOW,
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].document, undefined);
  assert.match(fake.calls[0].prompt, /§1 CORE PROMISE\n§2 Seal the border and stop it/);
  assert.equal(run.text.method, 'html-strip');
  assert.deepEqual(run.counts, { candidates: 1, verbatim_ok: 1, verbatim_failed: 0, with_problems: 0, duplicates: 0 });
  assert.equal(db.prepare('SELECT count(*) AS n FROM claims').get().n, 0);
});

test('extractCandidates refuses a wrong prompt version, a bad model id and a missing source', async (t) => {
  const { evidenceDir, outDir, db } = workspace(t);
  const fake = createFakeAdapter([]);
  const base = { provider: 'fake', model: 'fake-model', askOptions: { adapters: { fake } }, evidenceDir, outDir };
  await assert.rejects(extractCandidates(db, 1, { ...base, promptVersion: 'extract-9.9' }), /does not match/);
  await assert.rejects(extractCandidates(db, 1, { ...base, model: '../x' }), /model id/);
  await assert.rejects(extractCandidates(db, 99, base), /no source 99/);
  assert.equal(fake.calls.length, 0);
});
