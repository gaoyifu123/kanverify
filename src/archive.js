// Archiving step of the fetch role (team/run/fetch.md): download one file, keep it under
// data/evidence/ named by its SHA-256, and register it in the sources table.
//
// Principle 2: every source row points at a file we hold, identified by its hash, and at the
// URL those bytes actually came from (redirects are followed by hand and recorded).
// Principle 8: node:http/https, node:dns, node:crypto and node:fs only; the file stays on
// this machine. No AI is involved here.
//
// Why node:http and not the built-in fetch: fetch resolves the host name again after our
// address check, so a DNS answer that changes between the two (rebinding) would slip past.
// node:http lets the same check run inside `lookup`, on the address actually connected to.

import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openDatabase } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EVIDENCE_DIR = resolve(here, '../data/evidence');
export const MAX_BYTES = 50 * 1024 * 1024;
export const TIMEOUT_MS = 60_000;
export const MAX_REDIRECTS = 5;
const STALE_TEMP_MS = 60 * 60 * 1000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const USER_AGENT = 'evidence-archiver/1';
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

const SHA_RE = /^[0-9a-f]{64}$/;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

// Addresses a downloaded link must never reach. IPv4-mapped IPv6 (::ffff:a.b.c.d) is matched
// against the IPv4 rules by BlockList itself; ::/96 covers ::, ::1 and IPv4-compatible forms.
const FORBIDDEN = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this network", includes 0.0.0.0
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
]) FORBIDDEN.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 96], // unspecified, loopback, IPv4-compatible
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // old site-local
  ['ff00::', 8], // multicast
  // Prefixes that embed an IPv4 address; refused outright rather than unpacked.
  ['::ffff:0:0:0', 96], // SIIT
  ['64:ff9b::', 96], // NAT64
  ['2001::', 32], // Teredo
  ['2002::', 16], // 6to4
]) FORBIDDEN.addSubnet(net, prefix, 'ipv6');

/** True if `address` (an IP literal) is loopback, private, link-local, multicast or reserved. */
export function isForbiddenAddress(address) {
  const bare = String(address).split('%')[0].toLowerCase();
  const family = isIP(bare);
  if (family === 4) return FORBIDDEN.check(bare, 'ipv4');
  if (family === 6) return FORBIDDEN.check(bare, 'ipv6');
  return true; // not an address at all: refuse
}

/** Resolve a host name (all addresses) and refuse it if any address is forbidden. */
async function resolveChecked(hostname, resolver, allowPrivate) {
  const host = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname;
  let addresses;
  try {
    addresses = await resolver(host, { all: true, verbatim: true });
  } catch (error) {
    throw new Error(`Cannot resolve ${host}: ${error.code ?? error.message}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new Error(`Cannot resolve ${host}.`);
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isForbiddenAddress(address)) {
        throw new Error(`Refusing ${host}: it resolves to ${address}, a local, private or reserved address.`);
      }
    }
  }
  return addresses;
}

/** A minimal fetch over node:http/https whose DNS lookup goes through resolveChecked. */
function guardedFetch(resolver, allowPrivate) {
  const lookup = (hostname, options, callback) => {
    resolveChecked(hostname, resolver, allowPrivate).then(
      (addresses) =>
        options?.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
      (error) => callback(error)
    );
  };
  return (url, { signal }) =>
    new Promise((resolvePromise, reject) => {
      const target = new URL(url);
      const transport = target.protocol === 'https:' ? https : http;
      const request = transport.request(
        target,
        { method: 'GET', agent: false, lookup, signal, headers: { accept: '*/*', 'user-agent': USER_AGENT } },
        (res) => {
          try {
            const encoding = (res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
            if (encoding !== 'identity') throw new Error(`The server sent ${encoding}-encoded bytes; refusing to store them.`);
            const transfer = res.headers['transfer-encoding'];
            if (transfer !== undefined && transfer.trim().toLowerCase() !== 'chunked') {
              throw new Error(`Unsupported Transfer-Encoding "${transfer}"; refusing to store the bytes.`);
            }
            const headers = new Headers();
            for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
            const nullBody = [204, 205, 304].includes(res.statusCode);
            if (nullBody) res.destroy();
            resolvePromise(new Response(nullBody ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
          } catch (error) {
            res.destroy();
            reject(error);
          }
        }
      );
      request.on('error', reject);
      request.end();
    });
}

function parseHttpUrl(text, base) {
  let parsed;
  try {
    parsed = new URL(text, base);
  } catch {
    throw new Error(`Not a valid URL: ${text}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http and https URLs are archived, not ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) throw new Error('URLs with a user name or password are not archived.');
  return parsed;
}

/** Where the file for a given hash lives. Built only from the hash; no extension. */
export function evidencePath(evidenceDir, sha256) {
  if (typeof sha256 !== 'string' || !SHA_RE.test(sha256)) throw new Error('Not a SHA-256 hex digest.');
  return join(resolve(evidenceDir), sha256);
}

/** Remove temp files left by a crashed run (older than an hour, regular files only). */
function sweepStaleTemps(dir, now = Date.now()) {
  for (const name of readdirSync(dir)) {
    if (!name.startsWith('.tmp-')) continue;
    const path = join(dir, name);
    try {
      const stat = lstatSync(path);
      if (stat.isFile() && now - stat.mtimeMs > STALE_TEMP_MS) rmSync(path);
    } catch {
      // Gone already or not ours to remove; the archive itself does not depend on it.
    }
  }
}

function cancelBody(response) {
  response?.body?.cancel().catch(() => {});
}

function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Insert one sources row (retrieved today) for a file already in `evidenceDir`. The caller's
 * word is not taken for anything: the URL must be http(s) without user info, the media type
 * must be well formed, and the file at the path built from `sha256` must exist, be a regular
 * file and hash to `sha256`. If the insert fails and no row uses that hash, the file this
 * function located is removed, so a refused row leaves no orphan behind. Returns the new id.
 */
export function registerSource(db, { kind, url, title, publisher, published_on = null, sha256, media_type, lang }, evidenceDir) {
  const href = parseHttpUrl(url).href;
  if (typeof media_type !== 'string' || !MEDIA_TYPE_RE.test(media_type)) throw new Error('Unusable media type.');
  const path = evidencePath(evidenceDir, sha256);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new Error('No evidence file for this hash.');
  }
  if (!stat.isFile()) throw new Error('The evidence path is not a regular file.');
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) {
    throw new Error('The evidence file does not match its hash.');
  }
  try {
    const result = db
      .prepare(
        `INSERT INTO sources (kind, url, title, publisher, published_on, retrieved_on, sha256, media_type, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(kind, href, title, publisher, published_on, localDate(), sha256, media_type, lang);
    return Number(result.lastInsertRowid);
  } catch (error) {
    const used = db.prepare('SELECT 1 FROM sources WHERE sha256 = ? LIMIT 1').get(sha256);
    if (!used) rmSync(path, { force: true });
    throw error;
  }
}

/**
 * Store bytes already held in memory under the evidence directory, named by their SHA-256,
 * with the same rules as archive(): exclusive temp file, fsync, rename over whatever is there.
 * @returns {{sha256: string, path: string}}
 */
export function storeEvidenceBytes(evidenceDir, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('Refusing to store an empty file.');
  const dir = resolve(evidenceDir);
  mkdirSync(dir, { recursive: true });
  sweepStaleTemps(dir);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const finalPath = evidencePath(dir, sha256);
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  let fd = null;
  try {
    fd = openSync(tempPath, 'wx');
    for (let off = 0; off < bytes.byteLength; ) off += writeSync(fd, bytes, off);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tempPath, finalPath);
    return { sha256, path: finalPath };
  } finally {
    if (fd !== null) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

/**
 * Download `url` (following at most `maxRedirects` redirects by hand), store it by hash,
 * register it as a source with the URL the bytes came from.
 *
 * Tests may inject `resolver` (dns.lookup shape) and `fetchImpl`; `allowPrivate: true` lets
 * them reach a local server. Production callers leave all three alone.
 *
 * @returns {Promise<{id: number, url: string, redirects: string[], sha256: string, path: string}>}
 *   `redirects` is every URL requested, in order; the last one is `url`.
 */
export async function archive(
  db,
  { url, kind, title, publisher, published_on = null, lang },
  {
    fetchImpl,
    resolver = dnsLookup,
    allowPrivate = false,
    evidenceDir = DEFAULT_EVIDENCE_DIR,
    maxBytes = MAX_BYTES,
    timeoutMs = TIMEOUT_MS,
    maxRedirects = MAX_REDIRECTS,
    // When set, anything else is refused before it is registered: a bot-check or error page
    // served with status 200 is not evidence. For application/pdf the bytes must also start
    // with "%PDF-", whatever the Content-Type says.
    expectMediaType = null,
  } = {}
) {
  let current = parseHttpUrl(url);
  const dir = resolve(evidenceDir);
  mkdirSync(dir, { recursive: true });
  sweepStaleTemps(dir);

  const doFetch = fetchImpl ?? guardedFetch(resolver, allowPrivate);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  const redirects = [];
  const tempPath = join(dir, `.tmp-${randomUUID()}`);
  let response = null;
  let fd = null;
  try {
    for (;;) {
      redirects.push(current.href);
      await resolveChecked(current.hostname, resolver, allowPrivate);
      response = await doFetch(current.href, { redirect: 'manual', signal });
      if (!REDIRECT_STATUSES.has(response.status)) break;
      const location = response.headers.get('location');
      cancelBody(response);
      response = null;
      if (!location) throw new Error(`Redirect without a Location header from ${current.href}`);
      if (redirects.length > maxRedirects) throw new Error(`More than ${maxRedirects} redirects; stopped at ${current.href}`);
      current = parseHttpUrl(location, current);
    }

    if (response.status !== 200) throw new Error(`Download failed: HTTP ${response.status} for ${current.href}`);

    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!mediaType) throw new Error('The server sent no Content-Type; refusing to guess.');
    if (!MEDIA_TYPE_RE.test(mediaType)) throw new Error(`Unusable Content-Type: ${mediaType}`);
    if (expectMediaType && mediaType !== expectMediaType) {
      throw new Error(`Expected ${expectMediaType} but the server sent ${mediaType}; refusing to store it.`);
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new Error(`File is ${declared} bytes, over the ${maxBytes}-byte limit.`);
    }

    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    fd = openSync(tempPath, 'wx');
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new Error(`File is over the ${maxBytes}-byte limit.`);
        if (head.length < PDF_MAGIC.length) head = Buffer.concat([head, chunk]).subarray(0, PDF_MAGIC.length);
        hash.update(chunk);
        writeSync(fd, chunk);
      }
    }
    // A cut connection can end the body without an error (a close-delimited response
    // looks complete). Any abort or timeout means the bytes cannot be trusted as whole.
    if (signal.aborted) throw new Error(`Download did not finish (timed out or aborted) for ${current.href}`);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (size === 0) throw new Error('The server sent an empty file.');
    if (expectMediaType === 'application/pdf' && !head.equals(PDF_MAGIC)) {
      throw new Error('The server said application/pdf but the bytes are not a PDF; refusing to store them.');
    }

    // Never trust whatever is already at the final path: the bytes just hashed replace it.
    // A directory there makes the rename fail, which is the right outcome.
    const sha256 = hash.digest('hex');
    const finalPath = evidencePath(dir, sha256);
    renameSync(tempPath, finalPath);

    const id = registerSource(db, {
      kind, url: current.href, title, publisher, published_on, sha256, media_type: mediaType, lang,
    }, dir);
    return { id, url: current.href, redirects, sha256, path: finalPath };
  } finally {
    cancelBody(response);
    controller.abort();
    if (fd !== null) closeSync(fd);
    rmSync(tempPath, { force: true });
  }
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      kind: { type: 'string' },
      title: { type: 'string' },
      publisher: { type: 'string' },
      lang: { type: 'string' },
      'published-on': { type: 'string' },
    },
  });
  if (positionals.length !== 1 || !values.kind || !values.title || !values.publisher || !values.lang) {
    console.error(
      'Usage: node src/archive.js <url> --kind <kind> --title "..." --publisher "..." --lang <xx> [--published-on YYYY-MM-DD]'
    );
    process.exitCode = 2;
    return;
  }
  const db = openDatabase();
  try {
    const result = await archive(db, {
      url: positionals[0],
      kind: values.kind,
      title: values.title,
      publisher: values.publisher,
      published_on: values['published-on'] ?? null,
      lang: values.lang,
    });
    console.log(`source ${result.id}`);
    if (result.redirects.length > 1) {
      console.log('redirects:');
      for (const hop of result.redirects) console.log(`  ${hop}`);
    }
    console.log(`stored url: ${result.url}`);
    console.log(result.path);
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
