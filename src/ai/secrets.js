// Reply guard (Fable review 4, F3). A model can be steered by text it reads (an injected line in
// a pack excerpt) into quoting a secret it can see, e.g. Codex reading .env or its own login file
// through its read-only sandbox. ask() runs every reply through findSecret() before anything is
// returned, so a reply that carries a secret is refused and never stored.
//
// What counts:
//   - any value from .env (and any variable whose name looks secret), 8 characters or longer,
//     anywhere in the reply;
//   - token-like strings: JWTs (eyJ…), sk-… keys, and long runs (32+) of base64 with mixed
//     case and digits, or of hex with letters and digits. Such a run is allowed when it also
//     appears in the request itself (a quoted excerpt of the input) or sits inside a URL.
// The guard only says what kind of thing it found, never the thing itself.
//
// Known limits (for the founder's decision on residual risk): a secret that is short, split
// across words, re-encoded by the model, or hidden inside a URL as a plain run is not caught.

import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { DEFAULT_ENV_FILE } from './env.js';

const MIN_SECRET_LENGTH = 8;
const SECRET_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/i;
const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}/;
const SK_RE = /\bsk-[A-Za-z0-9_-]{16,}/;
const BASE64_RUN_RE = /[A-Za-z0-9+/_-]{32,}/g;
const HEX_RUN_RE = /[0-9a-fA-F]{32,}/g;
const URL_RE = /\bhttps?:\/\/[^\s"'<>\\)\]]+/gi;

/**
 * The values a reply must never contain: everything in the .env file (when readEnvFile) and
 * every variable of `env` whose name looks like a key, secret, token or password.
 */
export function secretValues({ env = process.env, envFile = DEFAULT_ENV_FILE, readEnvFile = true } = {}) {
  const values = new Set();
  const add = (value) => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v.length >= MIN_SECRET_LENGTH) values.add(v);
  };
  if (readEnvFile) {
    let content = null;
    try {
      content = readFileSync(envFile, 'utf8');
    } catch {
      // No .env file: nothing to add from it.
    }
    if (content !== null) for (const value of Object.values(parseEnv(content))) add(value);
  }
  for (const [name, value] of Object.entries(env ?? {})) if (SECRET_NAME_RE.test(name)) add(value);
  return [...values];
}

function urlSpans(text) {
  return [...text.matchAll(URL_RE)].map((m) => [m.index, m.index + m[0].length]);
}

function insideAny(spans, start, end) {
  return spans.some(([a, b]) => start >= a && end <= b);
}

/**
 * What secret-like thing `text` contains, as a short description, or null.
 * `secrets`: values from secretValues(). `input`: the request text (system + prompt); a
 * token-like string that is also in the input is a quote, not a leak. Values from .env are
 * refused even then.
 */
export function findSecret(text, { secrets = [], input = '' } = {}) {
  const s = String(text ?? '');
  for (const secret of secrets) if (s.includes(secret)) return 'a value from .env';
  const quoted = (m) => input.includes(m);
  const jwt = JWT_RE.exec(s);
  if (jwt && !quoted(jwt[0])) return 'a JWT-like token';
  const sk = SK_RE.exec(s);
  if (sk && !quoted(sk[0])) return 'an sk- key';
  const spans = urlSpans(s);
  for (const m of s.matchAll(BASE64_RUN_RE)) {
    const run = m[0];
    if (!(/[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run))) continue;
    if (insideAny(spans, m.index, m.index + run.length) || quoted(run)) continue;
    return 'a long base64-like string';
  }
  for (const m of s.matchAll(HEX_RUN_RE)) {
    const run = m[0];
    if (!(/[a-fA-F]/.test(run) && /[0-9]/.test(run))) continue;
    if (insideAny(spans, m.index, m.index + run.length) || quoted(run)) continue;
    return 'a long hex string';
  }
  return null;
}
