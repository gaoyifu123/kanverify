// Shared POST helper for the provider adapters. Lives inside src/ai/ only (principle 8).

import { AiError } from './errors.js';

const SNIPPET = 500;
const REASON_RE = /^[A-Za-z_]{1,40}$/;

function isAbort(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

// Masks the key, then cuts. If the cut lands inside a key the masking could not see (a key that
// continues past the cut), the trailing part that matches the start of the key is masked too.
export function snippet(text, key) {
  let s = key ? text.replaceAll(key, '[redacted]') : text;
  if (s.length <= SNIPPET) return s;
  s = s.slice(0, SNIPPET);
  if (key) {
    for (let n = Math.min(key.length - 1, s.length); n > 0; n--) {
      if (s.endsWith(key.slice(0, n))) return `${s.slice(0, -n)}[redacted]`;
    }
  }
  return s;
}

// Every adapter calls this with the provider's stop reason. Only the reason name goes into the
// error (it is a short code, checked against a pattern), never any text from the answer.
export function requireNormalStop(provider, reason, normal) {
  if (normal.includes(reason)) return;
  const shown = typeof reason === 'string' && REASON_RE.test(reason) ? reason : 'missing or unrecognised';
  throw new AiError('bad_response', `${provider}: answer did not finish normally (stop reason: ${shown})`, { provider });
}

export async function postJson(ctx, url, headers, body) {
  const { fetchImpl, signal, provider, key } = ctx;
  // Original errors are never attached as cause: they may carry the request and its headers.
  const networkError = (error) =>
    new AiError('network', `${provider}: request failed (${error?.name ?? 'Error'})`, { provider });
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (error) {
    if (isAbort(error)) throw error;
    throw networkError(error);
  }
  if (!response.ok) {
    throw new AiError('http', `${provider}: HTTP ${response.status}: ${snippet(text, key)}`, {
      provider,
      status: response.status,
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiError('bad_response', `${provider}: response body is not JSON`, { provider });
  }
}
