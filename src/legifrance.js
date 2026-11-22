// Official French law texts from the Légifrance API (DILA), through the PISTE gateway.
// Part of the fetch role (team/run/fetch.md): find a text in the Journal officiel and archive
// the API's response for it, with a sources row pointing at the public Légifrance page.
//
// Principle 2: the evidence file is the decoded response body of /consult/jorf for the text
// (what fetch hands over after undoing any transfer compression), named by its SHA-256.
// sources.url is the public page of the same text (the API endpoint needs a token and is not
// something a reader can open); the caller records the endpoint and request body in its run
// output, from the `fetched` field returned here.
// Principle 8: built-in fetch, node:util and the shared helpers of src/archive.js only.
// Credentials come from .env (PISTE_CLIENT_ID / PISTE_CLIENT_SECRET). They and the access
// token are never printed, logged or stored. Error messages carry no response text at all,
// only a status and a short code, and a response that contains a credential is refused.
//
// Only JORF texts (cid JORFTEXT…, the text as published in the Journal officiel) are handled.
// Consolidated versions (LEGITEXT…, /consult/legiPart) are not: they change over time and
// need a date, which is a separate decision.

import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_EVIDENCE_DIR, MAX_BYTES, registerSource, storeEvidenceBytes } from './archive.js';
import { loadEnv } from './ai/env.js';
import { openDatabase } from './db.js';
import { htmlToParagraphs } from './extract.js';

export const TOKEN_URL = 'https://oauth.piste.gouv.fr/api/oauth/token';
export const API_BASE = 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app';
export const PUBLIC_BASE = 'https://www.legifrance.gouv.fr';
export const PUBLISHER = 'Légifrance (DILA)';
export const TIMEOUT_MS = 30_000;
// Where the API origin of every archived file is recorded (sources.url is the public page).
// Local working file, never rewritten: one JSON object per line, appended.
export const DEFAULT_PROVENANCE_FILE = resolve(dirname(fileURLToPath(import.meta.url)), '../data/candidates/legifrance-provenance.jsonl');
// Renew the token this long before the server says it expires.
const TOKEN_MARGIN_MS = 60_000;
const CID_RE = /^JORFTEXT\d{12}$/;
// RFC 6750 token characters; anything else is refused before it reaches a header.
const TOKEN_RE = /^[A-Za-z0-9\-._~+/]+=*$/;
const MAX_QUERY = 500;
const MAX_TITLE = 2000;
const DAY_MS = 86_400_000;
// The Journal officiel was founded in 1869; nothing published in it is older.
const EARLIEST_JO = '1869-01-01';
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
// C0 and C1 controls plus bidirectional overrides: never printed to a terminal.
const UNPRINTABLE_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * `code` is one of: bad_input, missing_credentials, network, timeout, http, too_large,
 * not_json, bad_response, credential_in_response, store.
 * Messages never contain text from a response.
 */
export class LegifranceError extends Error {
  constructor(code, message, { status } = {}) {
    super(message);
    this.name = 'LegifranceError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

/** Text safe to print on a terminal: control and direction-override characters removed. */
export function printable(text) {
  return String(text ?? '').replace(UNPRINTABLE_RE, '');
}

/** Read a response body, refusing more than `maxBytes`. */
async function readLimited(response, maxBytes, what) {
  const tooLarge = () => new LegifranceError('too_large', `${what}: response over the ${maxBytes}-byte limit (too_large)`);
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

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The publication date of a JORF text, checked three ways: dateParution is a whole UTC day,
 * it lies between the founding of the JO and today, and it agrees with the issue line
 * (jorfText, e.g. "JORF n°0089 du 15 avril 2023"). Returns YYYY-MM-DD or throws.
 */
export function publicationDate(json, today = localDate()) {
  const bad = (why) => new LegifranceError('bad_response', `Légifrance /consult/jorf: unusable publication date (${why})`);
  const ms = json?.dateParution;
  if (!Number.isSafeInteger(ms)) throw bad('dateParution missing or not an integer');
  if (ms % DAY_MS !== 0) throw bad('dateParution is not a whole UTC day');
  const date = new Date(ms).toISOString().slice(0, 10);
  if (date < EARLIEST_JO || date > today) throw bad('dateParution out of range');
  const m = typeof json.jorfText === 'string'
    ? /\bdu (\d{1,2})(?:er)? ([a-zéû]+) (\d{4})\b/.exec(json.jorfText)
    : null;
  if (!m) throw bad('no issue date in jorfText');
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) throw bad('unknown month in jorfText');
  const issue = `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  if (issue !== date) throw bad('dateParution and jorfText disagree');
  return date;
}

/**
 * A client holding one cached access token. Tests inject `fetchImpl` and `now`.
 * The credentials live only in this closure.
 */
export function createLegifranceClient({
  clientId,
  clientSecret,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = TIMEOUT_MS,
  maxBytes = MAX_BYTES,
} = {}) {
  if (!clientId || !clientSecret) {
    throw new LegifranceError('missing_credentials', 'Missing PISTE_CLIENT_ID or PISTE_CLIENT_SECRET (put them in .env).');
  }
  let cached = null; // { token, expiresAt }

  // One HTTP call. Original errors are never attached: they may carry the request.
  async function call(url, init, what) {
    let response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new LegifranceError('timeout', `${what}: request timed out (timeout)`);
      throw new LegifranceError('network', `${what}: request failed (network)`);
    }
    let bytes;
    try {
      bytes = await readLimited(response, maxBytes, what);
    } catch (error) {
      if (error instanceof LegifranceError) throw error;
      throw new LegifranceError('network', `${what}: reading the response failed (network)`);
    }
    if (response.status !== 200) {
      if (response.status === 401) cached = null;
      throw new LegifranceError('http', `${what}: HTTP ${response.status} (http)`, { status: response.status });
    }
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (mediaType !== 'application/json') throw new LegifranceError('not_json', `${what}: not application/json (not_json)`);
    let json;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new LegifranceError('not_json', `${what}: body is not JSON (not_json)`);
    }
    return { bytes, json, mediaType };
  }

  async function token() {
    if (cached && now() < cached.expiresAt - TOKEN_MARGIN_MS) return cached.token;
    cached = null;
    const { json } = await call(
      TOKEN_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'openid',
        }).toString(),
      },
      'PISTE token'
    );
    const { access_token: accessToken, expires_in: expiresIn } = json ?? {};
    if (typeof accessToken !== 'string' || !TOKEN_RE.test(accessToken)) {
      throw new LegifranceError('bad_response', 'PISTE token: no usable access_token (bad_response)');
    }
    if (typeof expiresIn !== 'number' || !(expiresIn > 0)) {
      throw new LegifranceError('bad_response', 'PISTE token: no usable expires_in (bad_response)');
    }
    cached = { token: accessToken, expiresAt: now() + expiresIn * 1000 };
    return accessToken;
  }

  // A response that echoes a credential is never stored, returned or printed. Checked on the
  // body as received and on the parsed value written back out, which undoes JSON escapes.
  function refuseCredentials(bytes, json, accessToken, what) {
    const parsed = JSON.stringify(json);
    for (const secret of [clientSecret, clientId, accessToken]) {
      if (bytes.includes(secret) || parsed.includes(secret)) {
        throw new LegifranceError('credential_in_response', `${what}: response contains a credential; refused (credential_in_response)`);
      }
    }
  }

  async function post(path, body) {
    const requestBody = JSON.stringify(body);
    const accessToken = await token();
    const what = `Légifrance ${path}`;
    const result = await call(
      `${API_BASE}${path}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${accessToken}` },
        body: requestBody,
      },
      what
    );
    refuseCredentials(result.bytes, result.json, accessToken, what);
    return { ...result, endpoint: `${API_BASE}${path}`, requestBody };
  }

  /** Search JORF texts by title words. Returns the hits, titles stripped of highlight tags. */
  async function searchJorf(query, { pageSize = 10 } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new LegifranceError('bad_input', 'pageSize must be 1 to 100.');
    }
    if (typeof query !== 'string' || !query.trim() || query.length > MAX_QUERY) {
      throw new LegifranceError('bad_input', `Search query must be 1 to ${MAX_QUERY} characters.`);
    }
    const { json } = await post('/search', {
      fond: 'JORF',
      recherche: {
        champs: [{ typeChamp: 'TITLE', criteres: [{ typeRecherche: 'EXACTE', valeur: query.trim(), operateur: 'ET' }], operateur: 'ET' }],
        filtres: [],
        pageNumber: 1,
        pageSize,
        operateur: 'ET',
        sort: 'PERTINENCE',
        typePagination: 'DEFAUT',
      },
    });
    const results = (Array.isArray(json?.results) ? json.results : []).flatMap((r) =>
      (Array.isArray(r?.titles) ? r.titles : []).map((t) => ({
        cid: t?.cid ?? null,
        title: typeof t?.title === 'string' ? t.title.replace(/<[^>]*>/g, '') : null,
        nature: r?.nature ?? null,
        published_on: typeof r?.datePublication === 'string' ? r.datePublication.slice(0, 10) : null,
      }))
    );
    return { total: json?.totalResultNumber ?? null, results };
  }

  /** The official JSON of one JORF text: parsed, plus the decoded body and how it was asked for. */
  async function fetchText(cid) {
    if (typeof cid !== 'string' || !CID_RE.test(cid)) {
      throw new LegifranceError('bad_input', 'Not a JORF text id (expected JORFTEXT followed by 12 digits).');
    }
    const r = await post('/consult/jorf', { textCid: cid });
    if (r.json?.cid !== cid) throw new LegifranceError('bad_response', 'Légifrance /consult/jorf: response is for another text (bad_response)');
    return r;
  }

  return { searchJorf, fetchText };
}

let defaultClient = null;
function clientFromEnv() {
  if (!defaultClient) {
    loadEnv();
    defaultClient = createLegifranceClient({
      clientId: process.env.PISTE_CLIENT_ID,
      clientSecret: process.env.PISTE_CLIENT_SECRET,
    });
  }
  return defaultClient;
}

export function searchJorf(query, { client = clientFromEnv(), ...options } = {}) {
  return client.searchJorf(query, options);
}

export function fetchText(cid, { client = clientFromEnv() } = {}) {
  return client.fetchText(cid);
}

/** True for a source row archived by this module: Légifrance JSON behind a /jorf/id/ page. */
export function isLegifranceSource(source) {
  return source?.media_type === 'application/json'
    && typeof source.url === 'string' && source.url.startsWith(`${PUBLIC_BASE}/jorf/id/`);
}

/**
 * Plain text of a /consult/jorf response, for judges and the verbatim-excerpt check: the
 * title, the issue line with its date, then every article in the order of the text, one unit
 * per paragraph, each labelled with its article number ("art. 10"), HTML stripped.
 * Nothing is reworded; only tags and entities are turned into text.
 * @returns {{unit: number, label: string, text: string}[]}
 */
export function legifranceToUnits(json) {
  const units = [];
  const add = (label, text) => {
    const clean = String(text ?? '').replace(/\s+/gu, ' ').trim();
    if (clean) units.push({ unit: units.length + 1, label, text: clean });
  };
  add('titre', json?.title);
  add('JORF', json?.jorfText);
  const byOrder = (a, b) => (a?.intOrdre ?? 0) - (b?.intOrdre ?? 0);
  // Articles and sections of one level interleave by intOrdre, as in the published text.
  const walk = (node, sectionTitle) => {
    const items = [
      ...(Array.isArray(node?.articles) ? node.articles : []).map((a) => ({ a, intOrdre: a?.intOrdre })),
      ...(Array.isArray(node?.sections) ? node.sections : []).map((s) => ({ s, intOrdre: s?.intOrdre })),
    ].sort(byOrder);
    for (const item of items) {
      if (item.s) { walk(item.s, item.s.title); continue; }
      const num = typeof item.a?.num === 'string' && item.a.num.trim() ? item.a.num.trim() : null;
      const label = num ? `art. ${num}` : String(sectionTitle ?? 'sans numéro').trim();
      for (const paragraph of htmlToParagraphs(item.a?.content ?? '')) add(label, paragraph);
    }
  };
  walk(json, null);
  return units;
}

/** The public page of a JORF text (as published), e.g. https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000047445077 */
export function publicUrl(cid) {
  if (typeof cid !== 'string' || !CID_RE.test(cid)) throw new LegifranceError('bad_input', 'Not a JORF text id.');
  return `${PUBLIC_BASE}/jorf/id/${cid}`;
}

/**
 * Fetch one JORF text and archive the API's response as evidence, with a sources row.
 * Every field of the row is computed and checked before anything is written; any failure is
 * a LegifranceError and leaves no file behind.
 * @returns {Promise<{id: number, url: string, sha256: string, path: string, size: number,
 *   media_type: string, fetched: {method: 'POST', endpoint: string, body: string}}>}
 */
export async function archiveLegifranceText(
  db,
  cid,
  { kind, lang = 'fr' } = {},
  { client = undefined, evidenceDir = DEFAULT_EVIDENCE_DIR, today = localDate() } = {}
) {
  if (kind !== 'law' && kind !== 'gazette') throw new LegifranceError('bad_input', 'kind must be "law" or "gazette".');
  if (typeof lang !== 'string' || !/^[a-z]{2}$/.test(lang)) throw new LegifranceError('bad_input', 'lang must be two lowercase letters.');
  const url = publicUrl(cid);
  const r = await (client ?? clientFromEnv()).fetchText(cid);
  const fetchedAt = new Date().toISOString();

  const title = typeof r.json.title === 'string' ? r.json.title.trim() : '';
  if (!title || title.length > MAX_TITLE || printable(title) !== title) {
    throw new LegifranceError('bad_response', 'Légifrance /consult/jorf: missing, overlong or unprintable title (bad_response)');
  }
  const row = {
    kind, url, title, publisher: PUBLISHER, published_on: publicationDate(r.json, today),
    media_type: r.mediaType, lang,
  };

  let stored;
  try {
    stored = storeEvidenceBytes(evidenceDir, r.bytes);
  } catch {
    throw new LegifranceError('store', 'Could not store the evidence file (store)');
  }
  let id;
  try {
    id = registerSource(db, { ...row, sha256: stored.sha256 }, evidenceDir);
  } catch (error) {
    // We wrote this file a moment ago; remove it unless some row (older or concurrent) uses it.
    const used = db.prepare('SELECT 1 FROM sources WHERE sha256 = ? LIMIT 1').get(stored.sha256);
    if (!used) rmSync(stored.path, { force: true });
    throw new LegifranceError('store', `Could not register the source: ${error?.message ?? 'unknown error'}`);
  }
  return {
    id, url, sha256: stored.sha256, path: stored.path, size: r.bytes.byteLength, media_type: r.mediaType,
    fetched: { method: 'POST', endpoint: r.endpoint, body: r.requestBody, at: fetchedAt },
  };
}

/** The provenance line for one archive result. */
export function provenanceRecord(r) {
  return {
    source_id: r.id, sha256: r.sha256, public_url: r.url,
    method: r.fetched.method, endpoint: r.fetched.endpoint, request_body: r.fetched.body, retrieved_at: r.fetched.at,
  };
}

/** Append one record as a JSON line; the file is only ever appended to. */
export function appendProvenance(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { kind: { type: 'string' }, lang: { type: 'string' } },
  });
  const [command, arg] = positionals;
  if (command === 'search' && positionals.length === 2) {
    const { total, results } = await searchJorf(arg);
    console.log(`${Number.isInteger(total) ? total : '?'} result(s)`);
    for (const h of results) {
      const cid = typeof h.cid === 'string' && CID_RE.test(h.cid) ? h.cid : '(unusable id)';
      const date = /^\d{4}-\d{2}-\d{2}$/.test(h.published_on ?? '') ? h.published_on : '----------';
      console.log(`${cid}  ${date}  ${printable(h.nature)}  ${printable(h.title)}`);
    }
    return;
  }
  if (command === 'archive' && positionals.length === 2 && values.kind) {
    const db = openDatabase();
    try {
      const r = await archiveLegifranceText(db, arg, { kind: values.kind, lang: values.lang ?? 'fr' });
      console.log(`source ${r.id}`);
      console.log(`stored url: ${r.url}`);
      console.log(`bytes from: ${r.fetched.method} ${r.fetched.endpoint} ${r.fetched.body}`);
      console.log(`sha256: ${r.sha256}`);
      console.log(`size: ${r.size} bytes (${r.media_type})`);
      console.log(r.path);
      appendProvenance(DEFAULT_PROVENANCE_FILE, provenanceRecord(r));
      console.log(`provenance appended to ${DEFAULT_PROVENANCE_FILE}`);
    } finally {
      db.close();
    }
    return;
  }
  console.error('Usage:\n  node src/legifrance.js search "<title words>"\n  node src/legifrance.js archive <JORFTEXT…> --kind law|gazette [--lang fr]');
  process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof LegifranceError ? error.message : `Error (${error?.name ?? 'unknown'}${error?.code ? `, ${error.code}` : ''})`);
    process.exitCode = 1;
  });
}
