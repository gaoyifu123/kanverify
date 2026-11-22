// Official US Federal Register documents (rules, executive orders, notices), found through the
// Federal Register's public JSON API (no key) and archived as the official PDF on govinfo.gov.
// Part of the fetch role (team/run/fetch.md).
//
// Field and parameter names follow the official OpenAPI description of the API
// (usnationalarchives/federalregister-api-core, data/open_api_v3.yml) and were checked against
// live responses on 2026-11-22.
//
// Principle 2: the evidence file is the PDF itself, downloaded by archive() (same address,
// redirect, size, timeout and hash rules as every other download), and sources.url is the
// govinfo.gov URL the bytes came from. The API call that pointed us there is appended to
// data/candidates/federalregister-provenance.jsonl.
// The federalregister.gov website answers scripts with a bot-check page; that page was once
// stored as a gazette by mistake. Here an HTML answer or a redirect where JSON or a PDF is
// expected is refused, never stored (see team/run/fetch.md).
// Principle 8: built-in fetch for the fixed API host, archive() for the PDF. No key, no vendor.

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_EVIDENCE_DIR, archive, evidencePath } from './archive.js';
import { openDatabase } from './db.js';

export const API_BASE = 'https://www.federalregister.gov/api/v1';
export const PUBLISHER = 'Federal Register (Office of the Federal Register, NARA)';
export const TIMEOUT_MS = 30_000;
export const MAX_JSON_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PROVENANCE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../data/candidates/federalregister-provenance.jsonl');
// From the OpenAPI DocumentType enum.
export const DOCUMENT_TYPES = ['RULE', 'PRORULE', 'NOTICE', 'PRESDOCU'];
// The API covers documents published since 1994.
const EARLIEST = '1994-01-01';
const DOC_NUMBER_RE = /^[A-Za-z0-9]{1,10}(?:-[A-Za-z0-9]{1,10}){1,3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SEARCH_FIELDS = ['document_number', 'title', 'type', 'subtype', 'publication_date', 'executive_order_number', 'citation', 'pdf_url'];
const DOC_FIELDS = [...SEARCH_FIELDS, 'html_url', 'signing_date'];
const MAX_TERM = 500;
const MAX_TITLE = 2000;
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

/**
 * `code` is one of: bad_input, network, timeout, http, redirect, bot_check, too_large,
 * not_json, bad_response, no_pdf, pdf_refused (unexpected pdf_url), archive (archive() refused or
 * failed: wrong format, redirect, size, address), store.
 */
export class FederalRegisterError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'FederalRegisterError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Text safe to print on a terminal: control and direction-override characters removed. */
export function printable(text) {
  return String(text ?? '').replace(UNPRINTABLE_RE, '');
}

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

/** True if `text` looks like an HTML page (a bot check, an error page), not JSON or a PDF. */
export function looksLikeHtml(text) {
  return /^\s*(?:<!doctype html|<html|<head|<body|<!--|<\?xml)/i.test(String(text).slice(0, 1024));
}

async function readLimited(response, maxBytes, what) {
  const tooLarge = () => new FederalRegisterError('too_large', `${what}: response over the ${maxBytes}-byte limit (too_large)`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  const chunks = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        await response.body.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, size);
}

/** GET one API URL and return its parsed JSON. Redirects and HTML are refused. */
async function getJson(url, what, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_JSON_BYTES } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new FederalRegisterError('timeout', `${what}: request timed out (timeout)`);
    throw new FederalRegisterError('network', `${what}: request failed (network)`);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    let host = null;
    try {
      host = new URL(response.headers.get('location') ?? '', url).hostname;
    } catch { /* no usable Location */ }
    if (host && host.startsWith('unblock.')) {
      throw new FederalRegisterError('bot_check', `${what}: redirected to the bot-check page at ${printable(host)}; refused (bot_check)`, { status: response.status });
    }
    throw new FederalRegisterError('redirect', `${what}: unexpected redirect (HTTP ${response.status}) to ${printable(host ?? 'an unusable address')}; refused (redirect)`, { status: response.status });
  }
  let bytes;
  try {
    bytes = await readLimited(response, maxBytes, what);
  } catch (error) {
    if (error instanceof FederalRegisterError) throw error;
    throw new FederalRegisterError('network', `${what}: reading the response failed (network)`);
  }
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  const text = bytes.toString('utf8');
  if (mediaType === 'text/html' || looksLikeHtml(text)) {
    throw new FederalRegisterError('bot_check', `${what}: got an HTML page (HTTP ${response.status}) where JSON was expected; refused (bot_check)`, { status: response.status });
  }
  if (response.status !== 200) {
    throw new FederalRegisterError('http', `${what}: HTTP ${response.status} (http)`, { status: response.status });
  }
  if (mediaType !== 'application/json') throw new FederalRegisterError('not_json', `${what}: not application/json (not_json)`);
  try {
    return JSON.parse(text);
  } catch {
    throw new FederalRegisterError('not_json', `${what}: body is not JSON (not_json)`);
  }
}

/** The API URL of a search, built from the documented parameters. */
export function searchUrl(terms, { type = null, since = null, perPage = 20 } = {}) {
  if (typeof terms !== 'string' || !terms.trim() || terms.length > MAX_TERM) {
    throw new FederalRegisterError('bad_input', `Search terms must be 1 to ${MAX_TERM} characters.`);
  }
  if (type !== null && !DOCUMENT_TYPES.includes(type)) {
    throw new FederalRegisterError('bad_input', `type must be one of ${DOCUMENT_TYPES.join(', ')}.`);
  }
  if (since !== null && !isDate(since)) throw new FederalRegisterError('bad_input', 'since must be a date, YYYY-MM-DD.');
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 1000) throw new FederalRegisterError('bad_input', 'perPage must be 1 to 1000.');
  const q = new URLSearchParams();
  for (const f of SEARCH_FIELDS) q.append('fields[]', f);
  q.append('per_page', String(perPage));
  q.append('order', 'relevance');
  q.append('conditions[term]', terms.trim());
  if (type) q.append('conditions[type][]', type);
  if (since) q.append('conditions[publication_date][gte]', since);
  return `${API_BASE}/documents.json?${q}`;
}

/** The API URL of one document's metadata. */
export function documentUrl(documentNumber) {
  if (typeof documentNumber !== 'string' || !DOC_NUMBER_RE.test(documentNumber)) {
    throw new FederalRegisterError('bad_input', 'Not a Federal Register document number (e.g. 2025-02182).');
  }
  const q = new URLSearchParams();
  for (const f of DOC_FIELDS) q.append('fields[]', f);
  return `${API_BASE}/documents/${documentNumber}.json?${q}`;
}

/** Search documents. Returns the total count and the hits as the API gave them (selected fields). */
export async function searchDocuments(terms, options = {}, http = {}) {
  const url = searchUrl(terms, options);
  const json = await getJson(url, 'Federal Register search', http);
  if (!json || typeof json !== 'object' || (json.results !== undefined && !Array.isArray(json.results))) {
    throw new FederalRegisterError('bad_response', 'Federal Register search: unexpected response shape (bad_response)');
  }
  const results = (json.results ?? []).map((r) => Object.fromEntries(SEARCH_FIELDS.map((f) => [f, r?.[f] ?? null])));
  return { url, total: Number.isInteger(json.count) ? json.count : null, results };
}

/** One document's metadata. The answer must be for the document asked for. */
export async function fetchDocument(documentNumber, http = {}) {
  const url = documentUrl(documentNumber);
  const json = await getJson(url, `Federal Register document ${documentNumber}`, http);
  if (json?.document_number !== documentNumber) {
    throw new FederalRegisterError('bad_response', `Federal Register document ${documentNumber}: response is for another document (bad_response)`);
  }
  return { url, json };
}

/**
 * Check a document's metadata and build the sources row for its PDF. The PDF must be on
 * govinfo.gov at the path the Federal Register uses for this document and date; anything else
 * is refused and reported, not worked around.
 */
export function sourceRowFor(doc, today = localDate()) {
  const bad = (why) => new FederalRegisterError('bad_response', `Federal Register document: ${why} (bad_response)`);
  const n = doc?.document_number;
  if (typeof n !== 'string' || !DOC_NUMBER_RE.test(n)) throw bad('unusable document_number');
  const date = doc.publication_date;
  if (!isDate(date) || date < EARLIEST || date > today) throw bad('unusable publication_date');
  const raw = typeof doc.title === 'string' ? doc.title.replace(/\s+/g, ' ').trim() : '';
  if (!raw || raw.length > MAX_TITLE || printable(raw) !== raw) throw bad('missing, overlong or unprintable title');
  const eo = typeof doc.executive_order_number === 'string' && /^\d{1,6}$/.test(doc.executive_order_number)
    ? doc.executive_order_number
    : Number.isInteger(doc.executive_order_number) ? String(doc.executive_order_number) : null;
  const citation = typeof doc.citation === 'string' && /^\d{1,3} FR \d{1,6}$/.test(doc.citation) ? doc.citation : null;
  const title = `${eo ? `Executive Order ${eo}: ` : ''}${raw}${citation ? ` (${citation})` : ''}`;
  if (doc.pdf_url === null || doc.pdf_url === undefined || doc.pdf_url === '') {
    throw new FederalRegisterError('no_pdf', `Federal Register document ${n}: the API gives no pdf_url (no_pdf)`);
  }
  const expected = `https://www.govinfo.gov/content/pkg/FR-${date}/pdf/${n}.pdf`;
  if (doc.pdf_url !== expected) {
    throw new FederalRegisterError('pdf_refused', `Federal Register document ${n}: pdf_url is not the expected govinfo.gov address ${expected}; refused (pdf_refused)`);
  }
  return { kind: 'gazette', url: expected, title, publisher: PUBLISHER, published_on: date, lang: 'en' };
}

/** Append one record as a JSON line; the file is only ever appended to. */
export function appendProvenance(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

/**
 * Archive the official PDF of one Federal Register document and record where it came from.
 * If a source row already has this PDF URL, nothing is downloaded or inserted: the existing
 * row is returned (`already: true`) after checking its file still matches its hash.
 * `archiveOptions` is passed to archive() (tests inject fetchImpl, resolver, evidenceDir).
 * @returns {Promise<{id, already, document_number, url, sha256, path, size, api_url}>}
 */
export async function archiveDocument(
  db,
  documentNumber,
  { http = {}, archiveOptions = {}, provenanceFile = DEFAULT_PROVENANCE_FILE, today = localDate() } = {}
) {
  const { url: apiUrl, json } = await fetchDocument(documentNumber, http);
  const apiAt = new Date().toISOString();
  const row = sourceRowFor(json, today);
  const evidenceDir = archiveOptions.evidenceDir ?? DEFAULT_EVIDENCE_DIR;

  const existing = db.prepare('SELECT id, sha256 FROM sources WHERE url = ? ORDER BY id LIMIT 1').get(row.url);
  let result;
  if (existing) {
    const path = evidencePath(evidenceDir, existing.sha256);
    let bytes;
    try {
      bytes = readFileSync(path);
    } catch {
      throw new FederalRegisterError('store', `Source ${existing.id} has this PDF URL but its evidence file is missing (store)`);
    }
    if (createHash('sha256').update(bytes).digest('hex') !== existing.sha256) {
      throw new FederalRegisterError('store', `Source ${existing.id} has this PDF URL but its evidence file does not match its hash (store)`);
    }
    result = { id: Number(existing.id), already: true, url: row.url, sha256: existing.sha256, path, size: bytes.byteLength, pdfAt: null };
  } else {
    let r;
    try {
      // No redirect is followed: govinfo serves these PDFs directly, and a redirect elsewhere
      // (a bot check, another host) is reported rather than stored under this publisher.
      r = await archive(db, row, { ...archiveOptions, maxRedirects: 0, expectMediaType: 'application/pdf' });
    } catch (error) {
      throw new FederalRegisterError('archive', `PDF for ${documentNumber} not archived: ${printable(error?.message ?? 'unknown error')}`);
    }
    result = { id: r.id, already: false, url: r.url, sha256: r.sha256, path: r.path, size: statSync(r.path).size, pdfAt: new Date().toISOString() };
  }

  appendProvenance(provenanceFile, {
    document_number: documentNumber,
    api_url: apiUrl,
    api_retrieved_at: apiAt,
    pdf_url: json.pdf_url,
    pdf_retrieved_at: result.pdfAt,
    downloaded: !result.already,
    source_id: result.id,
    sha256: result.sha256,
    size: result.size,
  });
  const { pdfAt, ...out } = result;
  return { ...out, document_number: documentNumber, api_url: apiUrl, title: row.title, published_on: row.published_on };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { type: { type: 'string' }, since: { type: 'string' } },
  });
  const [command, arg] = positionals;
  if (command === 'search' && positionals.length === 2) {
    const { url, total, results } = await searchDocuments(arg, { type: values.type ?? null, since: values.since ?? null });
    console.log(`query: ${url}`);
    console.log(`${Number.isInteger(total) ? total : '?'} result(s)`);
    for (const h of results) {
      const n = typeof h.document_number === 'string' && DOC_NUMBER_RE.test(h.document_number) ? h.document_number : '(unusable number)';
      const date = isDate(h.publication_date) ? h.publication_date : '----------';
      const eo = h.executive_order_number ? `EO ${printable(h.executive_order_number)}  ` : '';
      console.log(`${n}  ${date}  ${printable(h.subtype ?? h.type)}  ${eo}${printable(h.title)}`);
    }
    return;
  }
  if (command === 'archive' && positionals.length === 2) {
    const db = openDatabase();
    try {
      const r = await archiveDocument(db, arg);
      console.log(r.already ? `already archived as source ${r.id}; nothing downloaded or inserted` : `source ${r.id}`);
      console.log(`document: ${r.document_number}  ${printable(r.title)}  published ${r.published_on}`);
      console.log(`metadata: ${r.api_url}`);
      console.log(`stored url: ${r.url}`);
      console.log(`sha256: ${r.sha256}`);
      console.log(`size: ${r.size} bytes (application/pdf)`);
      console.log(r.path);
      console.log(`provenance appended to ${DEFAULT_PROVENANCE_FILE}`);
    } finally {
      db.close();
    }
    return;
  }
  console.error('Usage:\n  node src/federalregister.js search "<terms>" [--type PRESDOCU|RULE|PRORULE|NOTICE] [--since YYYY-MM-DD]\n  node src/federalregister.js archive <document_number>');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof FederalRegisterError ? error.message : `Error (${error?.name ?? 'unknown'}${error?.code ? `, ${error.code}` : ''})`);
    process.exitCode = 1;
  });
}
