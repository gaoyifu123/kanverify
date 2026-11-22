// The AI interface layer. Business code calls ask() and nothing else; no other file in src/
// may talk to an AI vendor (principle 8). Which model each role uses is the caller's
// configuration, not something hard-coded here (docs/decisions/0006-models.md).
//
// Deliberately absent (principle 5), to add only when a real need shows up: retries other than
// the single JSON retry, caching, streaming, rate limiting.

import anthropic from './anthropic.js';
import codex from './codex-cli.js';
import { loadEnv } from './env.js';
import { AiError } from './errors.js';
import gemini from './gemini.js';
import mistral from './mistral.js';
import openai from './openai.js';

export { AiError } from './errors.js';

// The registry stays private: exporting adapter objects would let business code call a vendor
// without ask() (docs/log/2026-11-22-step-back-ai-guard.md). Only names are public.
// codex runs the Codex command-line tool under the founder's ChatGPT subscription (decision 0010).
const ADAPTERS = Object.freeze({ anthropic, gemini, openai, mistral, codex });
// The providers paid through an API key in .env. codex needs no key and is not listed.
export const PROVIDERS = Object.freeze(
  Object.values(ADAPTERS).filter(({ keyVar }) => keyVar).map(({ name, keyVar }) => Object.freeze({ name, keyVar })),
);
// Thinking tokens count against this limit on Anthropic, OpenAI and Gemini; a small cap can
// leave no visible text, which ask() reports as bad_response.
const DEFAULT_MAX_TOKENS = 16000;
const MAX_TOKENS_LIMIT = 64_000;
const DEFAULT_TIMEOUT_MS = 120_000;
// temperature is deliberately absent: current Anthropic and OpenAI flagship models reject it, and
// one setting for all four providers keeps the jury uniform (principles 3 and 5).
const REQUEST_KEYS = new Set(['provider', 'model', 'promptVersion', 'prompt', 'system', 'json', 'maxTokens', 'timeoutMs', 'document', 'documents', 'webSearch', 'schema']);
const DOCUMENT_KEYS = new Set(['mediaType', 'data']);
const MAX_DOCUMENTS = 10;
const WEB_SEARCH_KEYS = new Set(['maxUses']);
const MAX_WEB_SEARCHES = 20;
const MEDIA_TYPE_RE = /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/;
const OPTION_KEYS = new Set(['fetchImpl', 'env', 'adapters']);

// A typo must not silently fall back to a default.
function rejectUnknownKeys(object, allowed, what) {
  for (const name of Object.keys(object ?? {})) {
    if (!allowed.has(name)) throw new AiError('bad_request', `unknown ${what}: ${name}`);
  }
}

let envLoaded = false;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validate(request, adapters) {
  if (request === null || typeof request !== 'object') throw new AiError('bad_request', 'request must be an object');
  rejectUnknownKeys(request, REQUEST_KEYS, 'request field');
  const { provider, model, prompt, promptVersion, system, json = false } = request ?? {};
  const { maxTokens = DEFAULT_MAX_TOKENS, timeoutMs = DEFAULT_TIMEOUT_MS } = request ?? {};
  if (!nonEmpty(provider)) throw new AiError('bad_request', 'provider is required');
  if (!Object.hasOwn(adapters, provider)) throw new AiError('unknown_provider', `unknown provider: ${provider}`);
  if (!nonEmpty(model)) throw new AiError('bad_request', 'model is required');
  if (!nonEmpty(prompt)) throw new AiError('bad_request', 'prompt is required');
  // Every vote must say which prompt produced it (jury_votes.prompt_version, team/README.md rule 7).
  if (!nonEmpty(promptVersion)) throw new AiError('bad_request', 'promptVersion is required');
  if (system !== undefined && typeof system !== 'string') throw new AiError('bad_request', 'system must be a string');
  if (typeof json !== 'boolean') throw new AiError('bad_request', 'json must be true or false');
  // The layer adds no text of its own: prompts come only from the reviewed role prompts in team/run/.
  // OpenAI's JSON mode refuses messages that never mention JSON, so the prompt itself must ask for it.
  if (json && !/json/i.test(system ?? '') && !/json/i.test(prompt)) {
    throw new AiError('bad_request', 'json is true but the prompt never asks for JSON: the system or user prompt must say "JSON"');
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_TOKENS_LIMIT) {
    throw new AiError('bad_request', `maxTokens must be an integer from 1 to ${MAX_TOKENS_LIMIT}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new AiError('bad_request', 'timeoutMs must be a positive integer');
  const adapter = adapters[provider];
  if (request.document !== undefined && request.documents !== undefined) throw new AiError('bad_request', 'give document or documents, not both');
  let documents;
  if (request.document !== undefined) documents = [validateDocument(request.document, adapter)];
  if (request.documents !== undefined) {
    if (!Array.isArray(request.documents) || request.documents.length === 0 || request.documents.length > MAX_DOCUMENTS) {
      throw new AiError('bad_request', `documents must be a list of 1 to ${MAX_DOCUMENTS} documents`);
    }
    documents = request.documents.map((d) => validateDocument(d, adapter));
  }
  const webSearch = validateWebSearch(request.webSearch, adapter);
  // Optional JSON Schema for the answer, for an adapter that can enforce one (today: codex).
  // Elsewhere it is refused rather than ignored; the program checks every answer anyway.
  const { schema } = request;
  if (schema !== undefined) {
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new AiError('bad_request', 'schema must be a JSON Schema object');
    if (!json) throw new AiError('bad_request', 'schema needs json: true');
    if (!adapter.jsonSchema) throw new AiError('unsupported', `${adapter.name}: an answer schema is not supported`, { provider: adapter.name });
  }
  return {
    provider, model, prompt, promptVersion, system, json, maxTokens, timeoutMs,
    // document (single) stays visible as given; adapters read documents.
    ...(request.document !== undefined && { document: documents[0] }),
    ...(documents && { documents }),
    ...(webSearch && { webSearch }),
    ...(schema !== undefined && { schema }),
  };
}

// Optional server-side web search, { maxUses }. Only an adapter that declares webSearch accepts
// it (today: anthropic); the others refuse before any request is sent. maxUses is required so
// the number of paid searches is always the caller's decision.
function validateWebSearch(webSearch, adapter) {
  if (webSearch === undefined) return undefined;
  if (webSearch === null || typeof webSearch !== 'object' || Array.isArray(webSearch)) throw new AiError('bad_request', 'webSearch must be an object');
  rejectUnknownKeys(webSearch, WEB_SEARCH_KEYS, 'webSearch field');
  const { maxUses } = webSearch;
  if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > MAX_WEB_SEARCHES) {
    throw new AiError('bad_request', `webSearch.maxUses must be an integer from 1 to ${MAX_WEB_SEARCHES}`);
  }
  if (!adapter.webSearch) throw new AiError('unsupported', `${adapter.name}: web search is not supported`, { provider: adapter.name });
  return { maxUses };
}

// An optional file sent alongside the prompt (e.g. a PDF to read). Only adapters that declare the
// media type in documentTypes accept it; the others refuse before any request is sent.
function validateDocument(document, adapter) {
  if (document === undefined || document === null || typeof document !== 'object') throw new AiError('bad_request', 'document must be an object');
  rejectUnknownKeys(document, DOCUMENT_KEYS, 'document field');
  const { mediaType, data } = document;
  if (typeof mediaType !== 'string' || !MEDIA_TYPE_RE.test(mediaType)) throw new AiError('bad_request', 'document.mediaType must be a media type such as application/pdf');
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new AiError('bad_request', 'document.data must be a non-empty Buffer or Uint8Array');
  if (!adapter.documentTypes?.includes(mediaType)) {
    throw new AiError('unsupported', `${adapter.name}: document input of type ${mediaType} is not supported`, { provider: adapter.name });
  }
  return { mediaType, data };
}

function readKey(adapter, env) {
  if (!adapter.keyVar) return undefined;
  if (env === process.env && !envLoaded) {
    loadEnv();
    envLoaded = true;
  }
  const key = env[adapter.keyVar];
  // Name the variable, never the value.
  if (!nonEmpty(key)) throw new AiError('missing_key', `${adapter.keyVar} is not set (add it to .env)`, { provider: adapter.name });
  return key.trim();
}

function redact(error, key) {
  if (!key || !(error instanceof Error)) return error;
  for (const field of ['message', 'stack']) {
    if (typeof error[field] === 'string' && error[field].includes(key)) {
      error[field] = error[field].replaceAll(key, '[redacted]');
    }
  }
  return error;
}

// Accepts plain JSON, or JSON wrapped in one Markdown code fence (a common model habit).
function parseJsonText(text) {
  const trimmed = text.trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i.exec(trimmed);
    if (fenced) {
      try {
        return { ok: true, value: JSON.parse(fenced[1]) };
      } catch { /* fall through */ }
    }
    return { ok: false };
  }
}

async function callOnce(adapter, req, key, fetchImpl) {
  const signal = AbortSignal.timeout(req.timeoutMs);
  try {
    return await adapter.call(req, { fetchImpl, signal, key, provider: adapter.name });
  } catch (error) {
    if (error?.name === 'TimeoutError' || (error?.name === 'AbortError' && signal.aborted)) {
      throw new AiError('timeout', `${adapter.name}: no answer within ${req.timeoutMs} ms`, { provider: adapter.name });
    }
    throw redact(error, key);
  }
}

/**
 * ask({ provider, model, promptVersion, prompt, system?, json?, maxTokens?, timeoutMs?, document?, documents?, webSearch?, schema? },
 *     { fetchImpl?, env?, adapters? })
 * → { text, json?, provider, model, modelVersion?, promptVersion, usage?, webSearch?, raw }
 *
 * document is { mediaType, data: Buffer }; documents is a list of 1 to 10 of them (not both).
 * anthropic and gemini accept application/pdf, the others refuse with code unsupported before
 * sending anything.
 *
 * webSearch is { maxUses: 1..20 }: the provider searches the web on its own servers while
 * answering. Only anthropic supports it; the others refuse with code unsupported. text is the
 * final answer only (the text after the last search); the reply's webSearch is
 * { requests, results: [{ url, title }], errors }, every result the provider returned.
 * The same stop-reason, JSON and key-masking rules apply.
 *
 * provider 'codex' runs the Codex command-line tool (src/ai/codex-cli.js) under the ChatGPT
 * subscription: no key, no documents, no web search; maxTokens is not enforced by the tool.
 * schema (a JSON Schema object, json: true only) is passed to it as --output-schema; any other
 * provider refuses schema with code unsupported.
 *
 * Options exist for tests: fetchImpl replaces global fetch, env replaces process.env (and then
 * .env is not read), adapters replaces the registry (tests: { fake: createFakeAdapter([...]) } from ./fake.js).
 */
export async function ask(request, options = {}) {
  rejectUnknownKeys(options, OPTION_KEYS, 'option');
  const { fetchImpl = globalThis.fetch, env = process.env, adapters = ADAPTERS } = options;
  const req = validate(request, adapters);
  const adapter = adapters[req.provider];
  const key = readKey(adapter, env);

  const attempts = req.json ? 2 : 1;
  for (let attempt = 1; ; attempt++) {
    const reply = await callOnce(adapter, req, key, fetchImpl);
    if (typeof reply?.text !== 'string' || reply.text.trim() === '') {
      throw new AiError('bad_response', `${adapter.name}: empty answer`, { provider: adapter.name });
    }
    const result = {
      text: reply.text,
      provider: req.provider,
      model: req.model,
      promptVersion: req.promptVersion,
      raw: reply.raw,
    };
    if (reply.modelVersion) result.modelVersion = reply.modelVersion;
    if (reply.usage) result.usage = reply.usage;
    if (reply.webSearch) result.webSearch = reply.webSearch;
    if (!req.json) return result;
    const parsed = parseJsonText(reply.text);
    if (parsed.ok) return { ...result, json: parsed.value };
    if (attempt >= attempts) {
      throw new AiError('bad_json', `${adapter.name}: answer is not valid JSON after ${attempts} attempts`, { provider: adapter.name });
    }
  }
}
