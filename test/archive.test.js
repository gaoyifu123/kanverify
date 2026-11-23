import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { archive, evidencePath, isForbiddenAddress } from '../src/archive.js';
import { openDatabase } from '../src/db.js';

const META = { kind: 'platform', title: 'Programme 2027', publisher: 'Parti X', published_on: '2026-01-15', lang: 'fr' };

// Tests never touch real DNS for made-up names: this resolver says every name is public.
const PUBLIC_DNS = async () => [{ address: '93.184.216.34', family: 4 }];
// Opt-in used only by tests that talk to a server on 127.0.0.1.
const LOCAL = { allowPrivate: true };

function fakeFetch(body, headers = { 'content-type': 'application/pdf' }, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return new Response(body, { status, headers });
  };
  impl.calls = calls;
  return impl;
}

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'kanverify-archive-'));
  const dir = join(root, 'evidence');
  mkdirSync(dir);
  const db = openDatabase(':memory:');
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { db, dir };
}

async function startServer(t, handler) {
  const server = http.createServer(handler);
  server.hits = 0;
  server.on('request', () => server.hits++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { server, base: `http://127.0.0.1:${server.address().port}`, port: server.address().port };
}

// A raw TCP server, for responses node:http will not produce (close-delimited, odd encodings).
async function startRawServer(t, onConnection) {
  const server = net.createServer(onConnection);
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const sha = (s) => createHash('sha256').update(s).digest('hex');
const count = (db) => db.prepare('SELECT count(*) AS n FROM sources').get().n;

// --- behaviour kept from the first version (injected fetch, fake DNS) ---

test('stores the file by its hash and registers the source', async (t) => {
  const { db, dir } = setup(t);
  const fetchImpl = fakeFetch('%PDF-1.7 programme');
  const result = await archive(db, { url: 'https://example.org/prog.pdf', ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir });

  const hash = sha('%PDF-1.7 programme');
  assert.deepEqual(readdirSync(dir), [hash]);
  assert.equal(readFileSync(join(dir, hash), 'utf8'), '%PDF-1.7 programme');
  assert.equal(result.path, join(resolve(dir), hash));
  assert.deepEqual(result.redirects, ['https://example.org/prog.pdf']);

  const row = db.prepare('SELECT * FROM sources WHERE id = ?').get(result.id);
  assert.equal(row.sha256, hash);
  assert.equal(row.media_type, 'application/pdf');
  assert.equal(row.url, 'https://example.org/prog.pdf');
  assert.equal(row.kind, 'platform');
  assert.equal(row.published_on, '2026-01-15');
  assert.match(row.retrieved_on, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(Number(row.retrieved_on.slice(0, 4)), new Date().getFullYear());
  assert.equal(fetchImpl.calls[0].init.redirect, 'manual');
  assert.ok(fetchImpl.calls[0].init.signal instanceof AbortSignal);
});

test('media type parameters are stripped', async (t) => {
  const { db, dir } = setup(t);
  const fetchImpl = fakeFetch('<html></html>', { 'content-type': 'Text/HTML; charset=utf-8' });
  const { id } = await archive(db, { url: 'http://example.org/', ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir });
  assert.equal(db.prepare('SELECT media_type FROM sources WHERE id = ?').get(id).media_type, 'text/html');
  assert.deepEqual(readdirSync(dir), [sha('<html></html>')]);
});

test('same content twice keeps one file and adds a second row', async (t) => {
  const { db, dir } = setup(t);
  const opts = { resolver: PUBLIC_DNS, evidenceDir: dir };
  const a = await archive(db, { url: 'https://a.example/x', ...META }, { ...opts, fetchImpl: fakeFetch('same') });
  const b = await archive(db, { url: 'https://b.example/y', ...META }, { ...opts, fetchImpl: fakeFetch('same', { 'content-type': 'text/plain' }) });
  assert.notEqual(a.id, b.id);
  assert.deepEqual(readdirSync(dir), [sha('same')]);
});

test('non-http URLs and URLs with credentials are refused before any request', async (t) => {
  const { db, dir } = setup(t);
  for (const url of ['file:///etc/passwd', 'ftp://example.org/a.pdf', 'data:text/plain,hi', 'not a url', 'https://user:pw@example.org/']) {
    const fetchImpl = fakeFetch('x');
    await assert.rejects(archive(db, { url, ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir }));
    assert.equal(fetchImpl.calls.length, 0);
  }
  assert.equal(count(db), 0);
});

test('oversized body is refused and leaves nothing behind', async (t) => {
  const { db, dir } = setup(t);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(60));
      c.enqueue(new Uint8Array(60));
      c.close();
    },
  });
  const opts = { resolver: PUBLIC_DNS, evidenceDir: dir, maxBytes: 100 };
  await assert.rejects(archive(db, { url: 'https://example.org/big', ...META }, { ...opts, fetchImpl: fakeFetch(stream) }), /limit/);
  await assert.rejects(
    archive(db, { url: 'https://example.org/big', ...META }, {
      ...opts,
      fetchImpl: fakeFetch('x'.repeat(10), { 'content-type': 'application/pdf', 'content-length': '999' }),
    }),
    /limit/
  );
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(count(db), 0);
});

test('missing or empty content-type is refused', async (t) => {
  const { db, dir } = setup(t);
  for (const headers of [{}, { 'content-type': '' }, { 'content-type': '; charset=utf-8' }]) {
    // new Response(string) adds text/plain by default; a Blob without type adds nothing.
    const impl = async () => new Response(new Blob(['body']), { headers });
    await assert.rejects(archive(db, { url: 'https://example.org/', ...META }, { fetchImpl: impl, resolver: PUBLIC_DNS, evidenceDir: dir }), /Content-Type/);
  }
  assert.equal(count(db), 0);
});

test('HTTP errors and empty bodies are refused', async (t) => {
  const { db, dir } = setup(t);
  const opts = { resolver: PUBLIC_DNS, evidenceDir: dir };
  await assert.rejects(archive(db, { url: 'https://example.org/', ...META }, { ...opts, fetchImpl: fakeFetch('gone', undefined, 404) }), /404/);
  await assert.rejects(archive(db, { url: 'https://example.org/', ...META }, { ...opts, fetchImpl: fakeFetch('') }), /empty/);
  assert.deepEqual(readdirSync(dir), []);
});

test('the file never escapes evidenceDir and has no extension', async (t) => {
  const { db, dir } = setup(t);
  const outside = resolve(dir, '..');
  const before = new Set(readdirSync(outside));
  const opts = { resolver: PUBLIC_DNS, evidenceDir: dir };
  for (const [url, type] of [
    ['https://example.org/../../../evil.pdf', 'application/pdf'],
    ['https://example.org/a%2F..%2F..%2Fevil', 'application/x-unknown'],
  ]) {
    await archive(db, { url, ...META }, { ...opts, fetchImpl: fakeFetch(url, { 'content-type': type }) });
  }
  for (const type of ['text/../../evil', 'text/..', '../x']) {
    await assert.rejects(
      archive(db, { url: 'https://example.org/', ...META }, { ...opts, fetchImpl: fakeFetch('y', { 'content-type': type }) }),
      /Content-Type/
    );
  }
  for (const name of readdirSync(dir)) assert.match(name, /^[0-9a-f]{64}$/);
  assert.deepEqual(new Set(readdirSync(outside)), before);
  for (const bad of ['../../etc/passwd', 'A'.repeat(64), `${'a'.repeat(64)}.pdf`, 'a'.repeat(63), undefined]) {
    assert.throws(() => evidencePath(dir, bad));
  }
});

// --- review findings, against a real local server ---

test('a redirect chain is followed by hand and the final URL is stored', async (t) => {
  const { db, dir } = setup(t);
  const { base } = await startServer(t, (req, res) => {
    if (req.url === '/a') res.writeHead(302, { location: '/b' }).end();
    else if (req.url === '/b') res.writeHead(301, { location: `${base}/c` }).end('moved');
    else if (req.url === '/c') res.writeHead(200, { 'content-type': 'application/pdf' }).end('%PDF final');
    else res.writeHead(404).end();
  });
  const result = await archive(db, { url: `${base}/a`, ...META }, { ...LOCAL, evidenceDir: dir });
  assert.deepEqual(result.redirects, [`${base}/a`, `${base}/b`, `${base}/c`]);
  assert.equal(result.url, `${base}/c`);
  assert.equal(db.prepare('SELECT url FROM sources WHERE id = ?').get(result.id).url, `${base}/c`);
  assert.equal(readFileSync(evidencePath(dir, sha('%PDF final')), 'utf8'), '%PDF final');
});

test('more than five redirects are refused', async (t) => {
  const { db, dir } = setup(t);
  const { server, base } = await startServer(t, (req, res) => {
    const n = Number(req.url.slice(1));
    res.writeHead(302, { location: `/${n + 1}` }).end();
  });
  await assert.rejects(archive(db, { url: `${base}/0`, ...META }, { ...LOCAL, evidenceDir: dir }), /redirects/);
  assert.equal(server.hits, 6); // the first request plus five redirects
  assert.equal(count(db), 0);
});

test('a redirect to a private address is refused in production mode', async (t) => {
  const { db, dir } = setup(t);
  const { server, base } = await startServer(t, (req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('secret'));
  // First hop: a public-looking site that redirects to the local server.
  const fetchImpl = fakeFetch(null, { location: `${base}/admin` }, 302);
  const resolver = async (host, opts) => (host === 'public.example' ? PUBLIC_DNS() : (await import('node:dns/promises')).lookup(host, opts));
  await assert.rejects(
    archive(db, { url: 'https://public.example/doc', ...META }, { fetchImpl, resolver, evidenceDir: dir, allowCrossHost: true }),
    /Refusing 127\.0\.0\.1/
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(server.hits, 0);
  assert.equal(count(db), 0);
});

test('private, loopback and numeric-form URLs are refused before any request', async (t) => {
  const { db, dir } = setup(t);
  const { server, port } = await startServer(t, (req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('secret'));
  const urls = [
    `http://127.0.0.1:${port}/`,
    `http://localhost:${port}/`,
    `http://2130706433:${port}/`,
    `http://0x7f.1:${port}/`,
    `http://017700000001:${port}/`,
    `http://[::1]:${port}/`,
    `http://[::ffff:127.0.0.1]:${port}/`,
    `http://[::127.0.0.1]:${port}/`,
    'http://0.0.0.0/',
    'http://[::]/',
    'http://10.1.2.3/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[fe80::1]/',
    'http://[fc00::1]/',
    'http://[fd12:3456::1]/',
    'http://224.0.0.1/',
    'http://[ff02::1]/',
    'http://[::ffff:10.0.0.1]/',
    'http://[::ffff:a9fe:a9fe]/',
  ];
  for (const url of urls) {
    // No injected fetch: this is the production transport. Only literal and localhost names,
    // which the system resolver answers without the network.
    await assert.rejects(archive(db, { url, ...META }, { evidenceDir: dir }), /Refusing/, url);
  }
  // A name whose DNS answer mixes a public and a private address is refused too.
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  const fetchImpl = fakeFetch('x');
  await assert.rejects(archive(db, { url: 'https://evil.example/', ...META }, { fetchImpl, resolver: mixed, evidenceDir: dir }), /10\.0\.0\.5/);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(server.hits, 0);
  assert.equal(count(db), 0);
});

test('a DNS answer that changes after the check is caught at connect time', async (t) => {
  const { db, dir } = setup(t);
  const { server, port } = await startServer(t, (req, res) => res.writeHead(200, { 'content-type': 'text/plain' }).end('secret'));
  let calls = 0;
  const rebinding = async () => (++calls === 1 ? [{ address: '93.184.216.34', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  await assert.rejects(archive(db, { url: `http://rebind.example:${port}/`, ...META }, { resolver: rebinding, evidenceDir: dir }), /Refusing/);
  assert.equal(calls, 2);
  assert.equal(server.hits, 0);
});

test('address classification leaves public addresses alone', () => {
  for (const a of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isForbiddenAddress(a), false, a);
  }
  for (const a of [
    '127.0.0.1', '::1', '::', '0.0.0.0', 'fe80::1%eth0', '::ffff:192.168.0.1', 'not-an-ip',
    '64:ff9b::a00:1', // NAT64
    '2002:a00:1::1', // 6to4
    '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
    '::ffff:0:a00:1', // SIIT
  ]) {
    assert.equal(isForbiddenAddress(a), true, a);
  }
});

test('a tampered file or a directory at the final path is never trusted', async (t) => {
  const { db, dir } = setup(t);
  const body = '%PDF genuine';
  const { base } = await startServer(t, (req, res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end(body));
  const target = evidencePath(dir, sha(body));

  writeFileSync(target, 'tampered bytes');
  await archive(db, { url: `${base}/doc`, ...META }, { ...LOCAL, evidenceDir: dir });
  assert.equal(readFileSync(target, 'utf8'), body);

  rmSync(target);
  mkdirSync(target);
  await assert.rejects(archive(db, { url: `${base}/doc`, ...META }, { ...LOCAL, evidenceDir: dir }));
  assert.ok(statSync(target).isDirectory());
  assert.equal(count(db), 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith('.tmp-')), []);
});

test('only status 200 is accepted', async (t) => {
  const { db, dir } = setup(t);
  const { base } = await startServer(t, (req, res) => {
    const status = Number(req.url.slice(1));
    res.writeHead(status, { 'content-type': 'application/pdf' }).end(status === 204 ? undefined : 'partial');
  });
  for (const status of [206, 203, 204, 404, 500]) {
    await assert.rejects(archive(db, { url: `${base}/${status}`, ...META }, { ...LOCAL, evidenceDir: dir }), new RegExp(`HTTP ${status}`));
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(count(db), 0);
});

test('compressed bytes are refused rather than stored', async (t) => {
  const { db, dir } = setup(t);
  const { base } = await startServer(t, (req, res) =>
    res.writeHead(200, { 'content-type': 'application/pdf', 'content-encoding': 'gzip' }).end('not really gzip')
  );
  await assert.rejects(archive(db, { url: `${base}/`, ...META }, { ...LOCAL, evidenceDir: dir }), /gzip/);
  assert.deepEqual(readdirSync(dir), []);
});

test('a failed insert leaves no file, unless another row uses it', async (t) => {
  const { db, dir } = setup(t);
  const { base } = await startServer(t, (req, res) => res.writeHead(200, { 'content-type': 'application/pdf' }).end('z'));
  await assert.rejects(archive(db, { url: `${base}/`, ...META, kind: 'rumour' }, { ...LOCAL, evidenceDir: dir }));
  await assert.rejects(archive(db, { url: `${base}/`, ...META, lang: 'fra' }, { ...LOCAL, evidenceDir: dir }));
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(count(db), 0);

  await archive(db, { url: `${base}/`, ...META }, { ...LOCAL, evidenceDir: dir });
  await assert.rejects(archive(db, { url: `${base}/`, ...META, kind: 'rumour' }, { ...LOCAL, evidenceDir: dir }));
  assert.deepEqual(readdirSync(dir), [sha('z')]);
  assert.equal(count(db), 1);
});

test('an early refusal closes the connection instead of waiting for the timeout', async (t) => {
  const { db, dir } = setup(t);
  let closed;
  const { base } = await startServer(t, (req, res) => {
    closed = once(res, 'close');
    res.writeHead(206, { 'content-type': 'application/pdf' });
    res.write('first chunk of a body that never ends');
  });
  const started = Date.now();
  await assert.rejects(archive(db, { url: `${base}/`, ...META }, { ...LOCAL, evidenceDir: dir, timeoutMs: 30_000 }), /206/);
  const timer = new Promise((_, reject) => setTimeout(() => reject(new Error('connection still open')), 2000).unref());
  await Promise.race([closed, timer]);
  assert.ok(Date.now() - started < 2000);
});

test('stale temp files are swept, fresh ones are left alone', async (t) => {
  const { db, dir } = setup(t);
  const old = join(dir, '.tmp-old');
  const fresh = join(dir, '.tmp-fresh');
  writeFileSync(old, 'x');
  writeFileSync(fresh, 'y');
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  await archive(db, { url: 'https://example.org/', ...META }, { fetchImpl: fakeFetch('w'), resolver: PUBLIC_DNS, evidenceDir: dir });
  assert.deepEqual(readdirSync(dir).sort(), ['.tmp-fresh', sha('w')].sort());
});

const CRLF = String.fromCharCode(13, 10);

test('a close-delimited body cut by the timeout is not stored', async (t) => {
  const { db, dir } = setup(t);
  const base = await startRawServer(t, (socket) => {
    socket.once('data', () => {
      // No Content-Length, no chunking: the end of the body is the end of the connection.
      socket.write(['HTTP/1.1 200 OK', 'Content-Type: application/pdf', 'Connection: close', '', '%PDF first part'].join(CRLF));
      const timer = setInterval(() => socket.write(' more'), 50);
      socket.on('close', () => clearInterval(timer));
      socket.on('error', () => clearInterval(timer));
    });
  });
  await assert.rejects(archive(db, { url: `${base}/`, ...META }, { ...LOCAL, evidenceDir: dir, timeoutMs: 400 }));
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(count(db), 0);
});

test('only an absent or plain chunked Transfer-Encoding is accepted', async (t) => {
  const { db, dir } = setup(t);
  const base = await startRawServer(t, (socket) => {
    socket.once('data', () => {
      socket.end(
        [
          'HTTP/1.1 200 OK', 'Content-Type: application/pdf', 'Transfer-Encoding: gzip, chunked', 'Connection: close', '',
          '5', 'abcde', '0', '', '',
        ].join(CRLF)
      );
    });
  });
  await assert.rejects(archive(db, { url: `${base}/`, ...META }, { ...LOCAL, evidenceDir: dir }), /Transfer-Encoding/);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(count(db), 0);

  // Plain chunked (what node:http sends by default) still works.
  const { base: ok } = await startServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/pdf' });
    res.write('chunk one ');
    res.end('chunk two');
  });
  await archive(db, { url: `${ok}/`, ...META }, { ...LOCAL, evidenceDir: dir });
  assert.deepEqual(readdirSync(dir), [sha('chunk one chunk two')]);
});

test('registerSource checks the file, URL and media type itself', async (t) => {
  const { db, dir } = setup(t);
  const { registerSource, storeEvidenceBytes } = await import('../src/archive.js');
  const bytes = Buffer.from('%PDF-1.7 test');
  const { sha256, path } = storeEvidenceBytes(dir, bytes);
  const row = { ...META, url: 'https://example.org/a.pdf', sha256, media_type: 'application/pdf' };

  for (const url of ['ftp://example.org/a', 'https://user:pw@example.org/a', 'not a url']) {
    assert.throws(() => registerSource(db, { ...row, url }, dir));
  }
  assert.throws(() => registerSource(db, { ...row, media_type: 'pdf' }, dir), /media type/);
  assert.throws(() => registerSource(db, { ...row, sha256: 'b'.repeat(64) }, dir), /No evidence file/);
  writeFileSync(path, 'tampered');
  assert.throws(() => registerSource(db, row, dir), /does not match/);
  assert.ok(readdirSync(dir).includes(sha256), 'a file it did not verify is never deleted');
  assert.equal(db.prepare('SELECT count(*) AS n FROM sources').get().n, 0);

  writeFileSync(path, bytes);
  const id = registerSource(db, row, dir);
  assert.equal(db.prepare('SELECT sha256 FROM sources WHERE id = ?').get(id).sha256, sha256);
  // A failed insert keeps the file while another row uses its hash.
  assert.throws(() => registerSource(db, { ...row, kind: 'nonsense' }, dir));
  assert.ok(readdirSync(dir).includes(sha256));
});

test('F1: registerSource never deletes; only the call that created a file may remove it', async (t) => {
  const { db, dir } = setup(t);
  const { registerSource, removeIfCreated, storeEvidenceBytes } = await import('../src/archive.js');
  const first = storeEvidenceBytes(dir, Buffer.from('only copy'));
  assert.equal(first.created, true);
  const again = storeEvidenceBytes(dir, Buffer.from('only copy'));
  assert.equal(again.created, false, 'the same bytes already there: not created by this call');
  const bad = { ...META, kind: 'nonsense', url: 'https://example.org/b', sha256: first.sha256, media_type: 'text/plain' };
  assert.throws(() => registerSource(db, bad, dir));
  assert.deepEqual(readdirSync(dir), [first.sha256], 'registerSource left the file alone');
  removeIfCreated(db, again);
  assert.deepEqual(readdirSync(dir), [first.sha256], 'a call that found the file there never removes it');
  removeIfCreated(db, first);
  assert.deepEqual(readdirSync(dir), [], 'the creating call may remove it when no row uses it');
});

test('F1: a file someone else put there survives a failed archive()', async (t) => {
  const { db, dir } = setup(t);
  const body = 'already archived bytes';
  writeFileSync(join(dir, sha(body)), body); // e.g. another database's evidence in the same folder
  db.exec("CREATE TRIGGER no_sources BEFORE INSERT ON sources BEGIN SELECT RAISE(ABORT, 'refused for the test'); END");
  await assert.rejects(archive(db, { url: 'https://example.org/x', ...META }, { fetchImpl: fakeFetch(body), resolver: PUBLIC_DNS, evidenceDir: dir }), /refused for the test/);
  assert.deepEqual(readdirSync(dir), [sha(body)]);
  // The same failure on bytes this call brought in removes them again.
  await assert.rejects(archive(db, { url: 'https://example.org/y', ...META }, { fetchImpl: fakeFetch('new bytes'), resolver: PUBLIC_DNS, evidenceDir: dir }), /refused for the test/);
  assert.deepEqual(readdirSync(dir), [sha(body)]);
});

test('F1: a file with the right name but wrong bytes is repaired, not counted as created', async (t) => {
  const { dir } = setup(t);
  const { storeEvidenceBytes } = await import('../src/archive.js');
  const bytes = Buffer.from('the real bytes');
  writeFileSync(join(dir, sha(bytes)), 'damaged');
  const r = storeEvidenceBytes(dir, bytes);
  assert.equal(r.created, false);
  assert.deepEqual(readFileSync(r.path), bytes);
});

test('F6: a redirect to another host is refused unless allowCrossHost; provenance records every hop', async (t) => {
  const { db, dir } = setup(t);
  const hops = (url) => (url.includes('a.example') ? new Response(null, { status: 302, headers: { location: 'https://b.example/doc' } })
    : url.includes('/start') ? new Response(null, { status: 301, headers: { location: '/moved' } })
      : new Response('document', { status: 200, headers: { 'content-type': 'text/plain' } }));
  const fetchImpl = async (url) => hops(url);
  await assert.rejects(archive(db, { url: 'https://a.example/doc', ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir }), /another host/);
  assert.equal(count(db), 0);
  assert.deepEqual(readdirSync(dir), []);

  const provenanceFile = join(dir, '..', 'candidates', 'archive-provenance.jsonl');
  const cross = await archive(db, { url: 'https://a.example/doc', ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir, allowCrossHost: true, provenanceFile });
  const same = await archive(db, { url: 'https://c.example/start', ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir, provenanceFile });
  assert.equal(same.created, false, 'same bytes as before');
  const lines = readFileSync(provenanceFile, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => [l.source_id, l.requested_url, l.hops, l.final_url, l.sha256]), [
    [cross.id, 'https://a.example/doc', ['https://a.example/doc', 'https://b.example/doc'], 'https://b.example/doc', sha('document')],
    [same.id, 'https://c.example/start', ['https://c.example/start', 'https://c.example/moved'], 'https://c.example/moved', sha('document')],
  ]);
  assert.equal(new Date(lines[0].retrieved_at).toISOString(), lines[0].retrieved_at);
});

test('F6: test folders write no provenance unless asked; 64:ff9b:1::/48 is forbidden', async (t) => {
  const { db, dir } = setup(t);
  await archive(db, { url: 'https://example.org/z', ...META }, { fetchImpl: fakeFetch('z'), resolver: PUBLIC_DNS, evidenceDir: dir });
  assert.deepEqual(readdirSync(join(dir, '..')).sort(), ['evidence']);
  assert.equal(isForbiddenAddress('64:ff9b:1::a00:1'), true);
  assert.equal(isForbiddenAddress('64:ff9b:1:ffff::1'), true);
});

test('F6: orphans are hash-named files with no row; listing deletes nothing', async (t) => {
  const { db, dir } = setup(t);
  const { listOrphans, storeEvidenceBytes } = await import('../src/archive.js');
  const kept = await archive(db, { url: 'https://example.org/k', ...META }, { fetchImpl: fakeFetch('kept'), resolver: PUBLIC_DNS, evidenceDir: dir });
  const orphan = storeEvidenceBytes(dir, Buffer.from('orphan'));
  writeFileSync(join(dir, 'notes.txt'), 'not hash-named');
  assert.deepEqual(listOrphans(db, dir), [orphan.path]);
  assert.ok(readdirSync(dir).includes(kept.sha256) && readdirSync(dir).includes(orphan.sha256));
});

test('F5: an expected PDF without %%EOF in its last 1 KB is refused', async (t) => {
  const { db, dir } = setup(t);
  const opts = (body) => ({ fetchImpl: fakeFetch(body), resolver: PUBLIC_DNS, evidenceDir: dir, expectMediaType: 'application/pdf' });
  await assert.rejects(archive(db, { url: 'https://example.org/cut.pdf', ...META }, opts('%PDF-1.7 cut in the middle')), /%%EOF/);
  await assert.rejects(archive(db, { url: 'https://example.org/far.pdf', ...META }, opts(`%PDF-1.7\n%%EOF\n${'x'.repeat(1100)}`)), /%%EOF/);
  assert.equal(count(db), 0);
  assert.deepEqual(readdirSync(dir), []);
  const ok = await archive(db, { url: 'https://example.org/ok.pdf', ...META }, opts(`%PDF-1.7\n${'y'.repeat(5000)}\n%%EOF\r\n`));
  assert.equal(ok.created, true);
});

test('F6: short writes are looped until every byte is on disk', async (t) => {
  const { db, dir } = setup(t);
  const big = 'b'.repeat(3 * 1024 * 1024);
  const r = await archive(db, { url: 'https://example.org/big', ...META }, { fetchImpl: fakeFetch(big), resolver: PUBLIC_DNS, evidenceDir: dir });
  assert.equal(readFileSync(r.path).length, big.length);
});
// --- expectMediaType: a bot-check or error page served with 200 is refused before registering ---

test('expectMediaType refuses another Content-Type and registers nothing', async (t) => {
  const { db, dir } = setup(t);
  const fetchImpl = fakeFetch('<!DOCTYPE html><title>Request Access</title>', { 'content-type': 'text/html; charset=utf-8' });
  await assert.rejects(
    archive(db, { url: 'https://example.org/doc.pdf', ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir, expectMediaType: 'application/pdf' }),
    /Expected application\/pdf but the server sent text\/html/
  );
  assert.equal(count(db), 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('expectMediaType application/pdf refuses bytes that are not a PDF, even labelled as one', async (t) => {
  const { db, dir } = setup(t);
  const fetchImpl = fakeFetch('<html>bot check</html>');
  await assert.rejects(
    archive(db, { url: 'https://example.org/doc.pdf', ...META }, { fetchImpl, resolver: PUBLIC_DNS, evidenceDir: dir, expectMediaType: 'application/pdf' }),
    /not a PDF/
  );
  assert.equal(count(db), 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('expectMediaType application/pdf accepts a PDF header split across chunks', async (t) => {
  const { db, dir } = setup(t);
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      for (const part of ['%P', 'DF', '-1.7 rest\n%%E', 'OF\n']) c.enqueue(enc.encode(part));
      c.close();
    },
  });
  const r = await archive(db, { url: 'https://example.org/doc.pdf', ...META }, {
    fetchImpl: fakeFetch(body), resolver: PUBLIC_DNS, evidenceDir: dir, expectMediaType: 'application/pdf',
  });
  assert.equal(r.sha256, sha('%PDF-1.7 rest\n%%EOF\n'));
  assert.equal(count(db), 1);
});
