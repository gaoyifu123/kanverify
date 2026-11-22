import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import {
  API_BASE, LegifranceError, TOKEN_URL, archiveLegifranceText, createLegifranceClient, printable, publicationDate,
} from '../src/legifrance.js';

const ID = 'client-id-0123456789abcdef';
const SECRET = 'client-secret-fedcba9876543210';
const CID = 'JORFTEXT000047445077';
const TEXT = {
  executionTime: 4,
  cid: CID,
  title: 'LOI n° 2023-270 du 14 avril 2023 de financement rectificative de la sécurité sociale pour 2023 (1)',
  dateParution: 1681516800000,
  jorfText: 'JORF n°0089 du 15 avril 2023',
  articles: [],
};
const TEXT_BYTES = Buffer.from(JSON.stringify(TEXT), 'utf8');

const json = (body, status = 200, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', ...headers },
  });

/** A fake fetch: `routes` maps a URL to a function returning a Response. Records every call. */
function fakeFetch(routes) {
  const calls = [];
  let tokens = 0;
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (url === TOKEN_URL && !routes[TOKEN_URL]) {
      tokens++;
      return json({ access_token: `tok${tokens}`, token_type: 'Bearer', expires_in: 3600, scope: 'openid' });
    }
    const route = routes[url];
    if (!route) throw new Error(`unexpected URL ${url}`);
    return route(init);
  };
  impl.calls = calls;
  impl.tokenCalls = () => calls.filter((c) => c.url === TOKEN_URL).length;
  return impl;
}

function client(fetchImpl, extra = {}) {
  return createLegifranceClient({ clientId: ID, clientSecret: SECRET, fetchImpl, ...extra });
}

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kanverify-lf-'));
  const db = openDatabase(':memory:');
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, dir };
}

const consult = () => fakeFetch({ [`${API_BASE}/consult/jorf`]: () => new Response(TEXT_BYTES, { headers: { 'content-type': 'application/json' } }) });

test('token request sends client credentials as a form, and the API gets the bearer token', async () => {
  const f = consult();
  await client(f).fetchText(CID);
  const [tok, api] = f.calls;
  assert.equal(tok.init.method, 'POST');
  assert.equal(tok.init.redirect, 'error');
  const form = new URLSearchParams(tok.init.body);
  assert.deepEqual(Object.fromEntries(form), { grant_type: 'client_credentials', client_id: ID, client_secret: SECRET, scope: 'openid' });
  assert.equal(api.init.headers.authorization, 'Bearer tok1');
  assert.equal(api.init.redirect, 'error');
  assert.deepEqual(JSON.parse(api.init.body), { textCid: CID });
});

test('the token is cached until shortly before it expires, then renewed', async () => {
  let clock = 1_000_000;
  const f = consult();
  const c = client(f, { now: () => clock });
  await c.fetchText(CID);
  clock += 30 * 60 * 1000;
  await c.fetchText(CID);
  assert.equal(f.tokenCalls(), 1);
  clock += 29 * 60 * 1000 + 1; // inside the last minute of the hour
  await c.fetchText(CID);
  assert.equal(f.tokenCalls(), 2);
  assert.equal(f.calls.at(-1).init.headers.authorization, 'Bearer tok2');
});

test('a 401 from the API drops the cached token', async () => {
  let fail = true;
  const f = fakeFetch({
    [`${API_BASE}/consult/jorf`]: () => (fail ? json({ error: 'invalid_token' }, 401) : new Response(TEXT_BYTES, { headers: { 'content-type': 'application/json' } })),
  });
  const c = client(f);
  await assert.rejects(c.fetchText(CID), (e) => e instanceof LegifranceError && e.status === 401);
  fail = false;
  await c.fetchText(CID);
  assert.equal(f.tokenCalls(), 2);
});

test('errors carry a status and a short code, never response text or credentials', async () => {
  const echo = `marker-body ${ID} / ${SECRET}`;
  const f1 = fakeFetch({ [TOKEN_URL]: () => json({ error: echo }, 401) });
  await assert.rejects(client(f1).fetchText(CID), (e) => {
    assert.equal(e.code, 'http');
    assert.equal(e.status, 401);
    assert.equal(e.message, 'PISTE token: HTTP 401 (http)');
    return true;
  });

  const f2 = fakeFetch({ [`${API_BASE}/consult/jorf`]: () => json({ error: 'marker-body tok1' }, 500) });
  await assert.rejects(client(f2).fetchText(CID), (e) => e.message === 'Légifrance /consult/jorf: HTTP 500 (http)');

  const f3 = async () => {
    const err = new TypeError(`fetch failed for ${SECRET}`);
    err.cause = { body: SECRET };
    throw err;
  };
  await assert.rejects(client(f3).fetchText(CID), (e) => {
    assert.equal(e.code, 'network');
    assert.ok(!e.message.includes(SECRET));
    assert.equal(e.cause, undefined);
    return true;
  });
});

test('a response containing a credential is refused, also when JSON-escaped, and nothing is stored', async (t) => {
  const { db, dir } = setup(t);
  const escaped = SECRET.replace('c', String.fromCharCode(92) + 'u0063'); // different bytes, same parsed value
  assert.ok(!escaped.includes(SECRET));
  for (const echoed of [`"${SECRET}"`, `"${escaped}"`, '"tok1"', `"${ID}"`]) {
    const body = JSON.stringify(TEXT).replace('"articles":[]', `"articles":[],"x":${echoed}`);
    const f = fakeFetch({ [`${API_BASE}/consult/jorf`]: () => json(body) });
    await assert.rejects(
      archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(f), evidenceDir: dir }),
      (e) => e.code === 'credential_in_response' && !e.message.includes(SECRET)
    );
  }
  const s = fakeFetch({ [`${API_BASE}/search`]: () => json({ totalResultNumber: 1, results: [{ titles: [{ cid: CID, title: SECRET }] }] }) });
  await assert.rejects(client(s).searchJorf('x'), (e) => e.code === 'credential_in_response');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sources').get().n, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('printable removes control and direction-override characters', () => {
  assert.equal(printable('LOI\u001b[31m n°\u202e 1\u0007\r\n'), 'LOI[31m n° 1');
});

test('publication dates are checked against range, whole days and the issue line', () => {
  const ok = { dateParution: 1681516800000, jorfText: 'JORF n°0089 du 15 avril 2023' };
  assert.equal(publicationDate(ok, '2026-11-22'), '2023-04-15');
  assert.equal(publicationDate({ dateParution: Date.UTC(2023, 3, 1), jorfText: 'JORF n°0078 du 1er avril 2023' }, '2026-11-22'), '2023-04-01');
  const bad = [
    {},
    { ...ok, dateParution: '1681516800000' },
    { ...ok, dateParution: 1681516800000 - 7200000 }, // Paris midnight, not a whole UTC day
    { ...ok, jorfText: 'JORF n°0089 du 16 avril 2023' },
    { ...ok, jorfText: null },
    { dateParution: Date.UTC(2030, 0, 1), jorfText: 'JORF n°0001 du 1er janvier 2030' }, // future
    { dateParution: Date.UTC(1800, 0, 1), jorfText: 'JORF du 1er janvier 1800' }, // before the JO
  ];
  for (const b of bad) assert.throws(() => publicationDate(b, '2026-11-22'), (e) => e instanceof LegifranceError && e.code === 'bad_response');
});

test('a bad date or title stops the archive before any byte is written', async (t) => {
  const { db, dir } = setup(t);
  const cases = [
    { ...TEXT, dateParution: Date.UTC(2099, 0, 1), jorfText: 'JORF n°0001 du 1er janvier 2099' },
    { ...TEXT, jorfText: 'JORF n°0089 du 14 avril 2023' },
    { ...TEXT, title: 'LOI\u001b[2J' },
    { ...TEXT, title: '   ' },
  ];
  for (const body of cases) {
    const f = fakeFetch({ [`${API_BASE}/consult/jorf`]: () => json(body) });
    await assert.rejects(archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(f), evidenceDir: dir }), LegifranceError);
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM sources').get().n, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('a refused insert is a LegifranceError and leaves no file', async (t) => {
  const { db, dir } = setup(t);
  db.exec("CREATE TRIGGER no_sources BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
  await assert.rejects(
    archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(consult()), evidenceDir: dir }),
    (e) => e instanceof LegifranceError && e.code === 'store'
  );
  assert.deepEqual(readdirSync(dir), []);
});

test('archive stores the exact response bytes by hash and adds a sources row for the public page', async (t) => {
  const { db, dir } = setup(t);
  const r = await archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(consult()), evidenceDir: dir });
  const sha = createHash('sha256').update(TEXT_BYTES).digest('hex');
  assert.equal(r.sha256, sha);
  assert.equal(r.size, TEXT_BYTES.length);
  assert.deepEqual(readFileSync(join(dir, sha)), TEXT_BYTES);
  assert.equal(new Date(r.fetched.at).toISOString(), r.fetched.at);
  assert.deepEqual(r.fetched, { method: 'POST', endpoint: `${API_BASE}/consult/jorf`, body: JSON.stringify({ textCid: CID }), at: r.fetched.at });
  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(r.id);
  assert.equal(row.url, `https://www.legifrance.gouv.fr/jorf/id/${CID}`);
  assert.equal(row.title, TEXT.title);
  assert.equal(row.publisher, 'Légifrance (DILA)');
  assert.equal(row.published_on, '2023-04-15');
  assert.equal(row.kind, 'law');
  assert.equal(row.lang, 'fr');
  assert.equal(row.media_type, 'application/json');
  assert.equal(row.sha256, sha);
});

test('non-JSON responses are refused and leave nothing behind', async (t) => {
  const { db, dir } = setup(t);
  const html = fakeFetch({ [`${API_BASE}/consult/jorf`]: () => new Response('<html>Just a moment</html>', { headers: { 'content-type': 'text/html' } }) });
  await assert.rejects(archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(html), evidenceDir: dir }), (e) => e.code === 'not_json');
  const broken = fakeFetch({ [`${API_BASE}/consult/jorf`]: () => json('{"cid": "JORF') });
  await assert.rejects(archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(broken), evidenceDir: dir }), (e) => e.code === 'not_json');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sources').get().n, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('oversized responses are refused, declared or streamed', async (t) => {
  const { db, dir } = setup(t);
  const big = Buffer.alloc(2000, 0x20);
  const declared = fakeFetch({ [`${API_BASE}/consult/jorf`]: () => json(big.toString(), 200, { 'content-length': '2000' }) });
  await assert.rejects(
    archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(declared, { maxBytes: 1000 }), evidenceDir: dir }),
    (e) => e.code === 'too_large'
  );
  const streamed = fakeFetch({
    [`${API_BASE}/consult/jorf`]: () => new Response(new ReadableStream({
      start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(500)); c.close(); },
    }), { headers: { 'content-type': 'application/json' } }),
  });
  await assert.rejects(
    archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(streamed, { maxBytes: 1000 }), evidenceDir: dir }),
    (e) => e.code === 'too_large'
  );
  assert.equal(db.prepare('SELECT count(*) AS n FROM sources').get().n, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('bad ids, wrong kinds and a response for another text are refused', async (t) => {
  const { db, dir } = setup(t);
  const f = consult();
  for (const bad of ['LEGITEXT000006070721', `${CID}/../x`, 'JORFTEXT1']) {
    await assert.rejects(archiveLegifranceText(db, bad, { kind: 'law' }, { client: client(f), evidenceDir: dir }), LegifranceError);
  }
  await assert.rejects(archiveLegifranceText(db, CID, { kind: 'statement' }, { client: client(f), evidenceDir: dir }), /kind/);
  assert.equal(f.calls.length, 0);
  const other = fakeFetch({ [`${API_BASE}/consult/jorf`]: () => json({ ...TEXT, cid: 'JORFTEXT000000000001' }) });
  await assert.rejects(archiveLegifranceText(db, CID, { kind: 'law' }, { client: client(other), evidenceDir: dir }), (e) => e.code === 'bad_response');
  assert.deepEqual(readdirSync(dir), []);
});

test('search returns cids and titles without highlight tags', async () => {
  const f = fakeFetch({
    [`${API_BASE}/search`]: () => json({
      totalResultNumber: 1,
      results: [{ nature: 'LOI', datePublication: '2023-04-15T00:00:00.000+0000', titles: [{ cid: CID, title: 'LOI de <mark>financement</mark>' }] }],
    }),
  });
  const r = await client(f).searchJorf('financement');
  assert.deepEqual(r, { total: 1, results: [{ cid: CID, title: 'LOI de financement', nature: 'LOI', published_on: '2023-04-15' }] });
  const body = JSON.parse(f.calls.at(-1).init.body);
  assert.equal(body.fond, 'JORF');
  assert.equal(body.recherche.champs[0].criteres[0].valeur, 'financement');
});

test('a client without credentials is refused', () => {
  assert.throws(() => createLegifranceClient({ clientId: '', clientSecret: SECRET }), /PISTE_CLIENT_ID/);
});
