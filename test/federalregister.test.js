import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import {
  API_BASE, FederalRegisterError, PUBLISHER, archiveDocument, documentUrl, fetchDocument, looksLikeHtml,
  searchDocuments, searchUrl, sourceRowFor,
} from '../src/federalregister.js';

const NUM = '2025-02182';
const PDF_URL = 'https://www.govinfo.gov/content/pkg/FR-2025-02-03/pdf/2025-02182.pdf';
// Shape and values as returned by the live API on 2026-11-22 (fields trimmed).
const DOC = {
  document_number: NUM,
  title: 'The Iron Dome for America',
  type: 'Presidential Document',
  subtype: 'Executive Order',
  publication_date: '2025-02-03',
  executive_order_number: '14186',
  citation: '90 FR 8767',
  pdf_url: PDF_URL,
  html_url: 'https://www.federalregister.gov/documents/2025/02/03/2025-02182/the-iron-dome-for-america',
  signing_date: '2025-01-27',
};
const PDF = '%PDF-1.7 executive order';
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
const sha = (s) => createHash('sha256').update(s).digest('hex');

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

/** Fake fetch: answers by URL prefix; records calls. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    for (const [prefix, fn] of routes) if (url.startsWith(prefix)) return fn(url, init);
    throw new Error(`unexpected URL ${url}`);
  };
  impl.calls = calls;
  return impl;
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'kanverify-fr-'));
  const evidenceDir = join(root, 'evidence');
  mkdirSync(evidenceDir);
  const provenanceFile = join(root, 'prov.jsonl');
  const db = openDatabase(':memory:');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, evidenceDir, provenanceFile };
}

const apiRoute = (doc = DOC) => [`${API_BASE}/documents/${NUM}.json`, () => json(doc)];
const pdfRoute = (body = PDF, headers = { 'content-type': 'application/pdf' }, status = 200) =>
  [PDF_URL, () => new Response(body, { status, headers })];

function opts({ evidenceDir, provenanceFile }, apiFetch, pdfFetch) {
  return {
    http: { fetchImpl: apiFetch },
    archiveOptions: { fetchImpl: pdfFetch, resolver: PUBLIC_DNS, evidenceDir },
    provenanceFile,
    today: '2026-11-22',
  };
}

test('search builds the documented query (term, type, publication_date gte, fields)', async () => {
  const f = fakeFetch([[`${API_BASE}/documents.json?`, () => json({ count: 1, results: [{ ...DOC, extra: 'x' }] })]]);
  const r = await searchDocuments('Iron Dome', { type: 'PRESDOCU', since: '2025-01-01' }, { fetchImpl: f });
  const q = new URL(f.calls[0].url).searchParams;
  assert.equal(q.get('conditions[term]'), 'Iron Dome');
  assert.deepEqual(q.getAll('conditions[type][]'), ['PRESDOCU']);
  assert.equal(q.get('conditions[publication_date][gte]'), '2025-01-01');
  assert.ok(q.getAll('fields[]').includes('pdf_url'));
  assert.equal(f.calls[0].init.redirect, 'manual');
  assert.equal(r.total, 1);
  assert.equal(r.results[0].document_number, NUM);
  assert.equal(r.results[0].extra, undefined);
});

test('search and document input is validated before any request', () => {
  assert.throws(() => searchUrl(''), (e) => e.code === 'bad_input');
  assert.throws(() => searchUrl('x', { type: 'EO' }), (e) => e.code === 'bad_input');
  assert.throws(() => searchUrl('x', { since: '2025-02-30' }), (e) => e.code === 'bad_input');
  for (const bad of ['../x', '2025-02182.json', '2025/02182', '2025-02182?a=1', 'x', '']) {
    assert.throws(() => documentUrl(bad), (e) => e.code === 'bad_input', bad);
  }
  assert.ok(documentUrl('E9-12345').startsWith(`${API_BASE}/documents/E9-12345.json?`));
});

test('a redirect to the bot-check host is refused as bot_check, other redirects as redirect', async () => {
  const to = (location) => fakeFetch([[API_BASE, () => new Response(null, { status: 302, headers: { location } })]]);
  await assert.rejects(fetchDocument(NUM, { fetchImpl: to('https://unblock.federalregister.gov/') }), (e) => e.code === 'bot_check' && e.status === 302);
  await assert.rejects(fetchDocument(NUM, { fetchImpl: to('https://elsewhere.example/') }), (e) => e.code === 'redirect');
});

test('an HTML page where JSON is expected is refused as bot_check, whatever the status or label', async () => {
  const page = '<!DOCTYPE html><html><title>Federal Register :: Request Access</title></html>';
  for (const [status, type] of [[200, 'text/html; charset=utf-8'], [200, 'application/json'], [403, 'text/html']]) {
    const f = fakeFetch([[API_BASE, () => new Response(page, { status, headers: { 'content-type': type } })]]);
    await assert.rejects(fetchDocument(NUM, { fetchImpl: f }), (e) => e.code === 'bot_check', `${status} ${type}`);
  }
  assert.equal(looksLikeHtml('  <html>'), true);
  assert.equal(looksLikeHtml('{"a":1}'), false);
});

test('API errors, wrong document, oversize, timeouts and non-JSON are reported with a code', async () => {
  await assert.rejects(fetchDocument(NUM, { fetchImpl: fakeFetch([[API_BASE, () => json({ errors: {} }, 404)]]) }), (e) => e.code === 'http' && e.status === 404);
  await assert.rejects(fetchDocument(NUM, { fetchImpl: fakeFetch([[API_BASE, () => json({ ...DOC, document_number: '2025-00001' })]]) }), (e) => e.code === 'bad_response');
  await assert.rejects(fetchDocument(NUM, { fetchImpl: fakeFetch([[API_BASE, () => json(DOC)]]), maxBytes: 10 }), (e) => e.code === 'too_large');
  const timeout = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
  await assert.rejects(fetchDocument(NUM, { fetchImpl: timeout }), (e) => e.code === 'timeout');
  const plain = fakeFetch([[API_BASE, () => new Response('{}', { headers: { 'content-type': 'text/plain' } })]]);
  await assert.rejects(fetchDocument(NUM, { fetchImpl: plain }), (e) => e.code === 'not_json');
});

test('sourceRowFor builds a gazette row and refuses an unexpected pdf_url', () => {
  assert.deepEqual(sourceRowFor(DOC, '2026-11-22'), {
    kind: 'gazette', url: PDF_URL, title: 'Executive Order 14186: The Iron Dome for America (90 FR 8767)',
    publisher: PUBLISHER, published_on: '2025-02-03', lang: 'en',
  });
  for (const pdf_url of [
    'http://www.govinfo.gov/content/pkg/FR-2025-02-03/pdf/2025-02182.pdf',
    'https://govinfo.example/content/pkg/FR-2025-02-03/pdf/2025-02182.pdf',
    'https://www.govinfo.gov/content/pkg/FR-2025-02-04/pdf/2025-02182.pdf',
    'https://www.federalregister.gov/documents/2025/02/03/2025-02182.pdf',
  ]) assert.throws(() => sourceRowFor({ ...DOC, pdf_url }, '2026-11-22'), (e) => e.code === 'pdf_refused', pdf_url);
  assert.throws(() => sourceRowFor({ ...DOC, pdf_url: null }, '2026-11-22'), (e) => e.code === 'no_pdf');
  assert.throws(() => sourceRowFor({ ...DOC, publication_date: '2027-01-01' }, '2026-11-22'), (e) => e.code === 'bad_response');
  assert.throws(() => sourceRowFor({ ...DOC, title: 'A‮B' }, '2026-11-22'), (e) => e.code === 'bad_response');
});

test('archiveDocument stores the PDF via archive(), registers a gazette and appends provenance', async (t) => {
  const s = setup(t);
  const api = fakeFetch([apiRoute()]);
  const pdf = fakeFetch([pdfRoute()]);
  const r = await archiveDocument(s.db, NUM, opts(s, api, pdf));
  assert.equal(r.already, false);
  assert.equal(r.sha256, sha(PDF));
  assert.equal(r.size, Buffer.byteLength(PDF));
  assert.equal(pdf.calls[0].init.redirect, 'manual');
  const row = s.db.prepare('SELECT kind, url, publisher, published_on, media_type, lang, sha256 FROM sources WHERE id = ?').get(r.id);
  assert.deepEqual({ ...row }, {
    kind: 'gazette', url: PDF_URL, publisher: PUBLISHER, published_on: '2025-02-03', media_type: 'application/pdf', lang: 'en', sha256: sha(PDF),
  });
  const lines = readFileSync(s.provenanceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].document_number, NUM);
  assert.equal(lines[0].api_url, api.calls[0].url);
  assert.equal(lines[0].pdf_url, PDF_URL);
  assert.equal(lines[0].source_id, r.id);
  assert.equal(lines[0].downloaded, true);
  assert.ok(lines[0].pdf_retrieved_at && lines[0].api_retrieved_at);
});

test('a bot-check page or a redirect where the PDF should be is refused; nothing stored or logged', async (t) => {
  const s = setup(t);
  const cases = [
    pdfRoute('<!DOCTYPE html><title>Request Access</title>', { 'content-type': 'text/html' }),
    pdfRoute('<html>check</html>'), // labelled application/pdf
    pdfRoute(null, { location: 'https://unblock.federalregister.gov/' }, 302),
    pdfRoute('gone', { 'content-type': 'text/plain' }, 404),
  ];
  for (const route of cases) {
    await assert.rejects(archiveDocument(s.db, NUM, opts(s, fakeFetch([apiRoute()]), fakeFetch([route]))), (e) => e.code === 'archive');
  }
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM sources').get().n, 0);
  assert.deepEqual(readdirSync(s.evidenceDir), []);
  assert.throws(() => readFileSync(s.provenanceFile));
});

test('an unexpected pdf_url is refused before any download', async (t) => {
  const s = setup(t);
  const pdf = fakeFetch([pdfRoute()]);
  const api = fakeFetch([apiRoute({ ...DOC, pdf_url: 'https://mirror.example/2025-02182.pdf' })]);
  await assert.rejects(archiveDocument(s.db, NUM, opts(s, api, pdf)), (e) => e.code === 'pdf_refused');
  assert.equal(pdf.calls.length, 0);
});

test('a PDF URL already in sources is not downloaded or inserted again; its file is checked', async (t) => {
  const s = setup(t);
  const first = await archiveDocument(s.db, NUM, opts(s, fakeFetch([apiRoute()]), fakeFetch([pdfRoute()])));
  const pdf = fakeFetch([pdfRoute()]);
  const again = await archiveDocument(s.db, NUM, opts(s, fakeFetch([apiRoute()]), pdf));
  assert.equal(again.already, true);
  assert.equal(again.id, first.id);
  assert.equal(pdf.calls.length, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM sources').get().n, 1);
  const lines = readFileSync(s.provenanceFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[1].downloaded, false);
  assert.equal(lines[1].pdf_retrieved_at, null);

  writeFileSync(first.path, 'tampered');
  await assert.rejects(archiveDocument(s.db, NUM, opts(s, fakeFetch([apiRoute()]), pdf)), (e) => e instanceof FederalRegisterError && e.code === 'store');
});
