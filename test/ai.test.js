import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as layer from '../src/ai/index.js';
import { AiError, PROVIDERS, ask } from '../src/ai/index.js';
import { loadEnv } from '../src/ai/env.js';
import { createFakeAdapter } from '../src/ai/fake.js';
import { snippet } from '../src/ai/http.js';

// Made-up keys. No test reads the real .env (env is always injected) or reaches the network
// (fetch is always injected).
const KEY = 'test-key-DO-NOT-LEAK-0001';
const ENV = {
  ANTHROPIC_API_KEY: KEY, GEMINI_API_KEY: KEY, OPENAI_API_KEY: KEY, MISTRAL_API_KEY: KEY,
};
const BASE = { model: 'some-model', promptVersion: 'judge-0.3', system: 'SYS', prompt: 'PROMPT' };
// A prompt that asks for JSON itself, as the role prompts in team/run/ do.
const JSON_PROMPT = 'Answer in json.';

function fakeFetch(...replies) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = replies.length > 1 ? replies.shift() : replies[0];
    const { status = 200, json } = next;
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  };
  impl.calls = calls;
  return impl;
}

const noFetch = async () => { throw new Error('network must not be reached'); };

const REPLIES = {
  anthropic: (text, stop = 'end_turn') => ({
    json: { model: 'claude-x-2026', stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 11, output_tokens: 7 } },
  }),
  openai: (text, stop = 'stop') => ({
    json: { model: 'gpt-x-2026', choices: [{ finish_reason: stop, message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
  }),
  mistral: (text, stop = 'stop') => ({
    json: { model: 'mistral-x', choices: [{ finish_reason: stop, message: { role: 'assistant', content: text } }], usage: { prompt_tokens: 11, completion_tokens: 7 } },
  }),
  gemini: (text, stop = 'STOP') => ({
    json: {
      modelVersion: 'gemini-x-001',
      candidates: [{ finishReason: stop, content: { role: 'model', parts: [{ text: 'hidden', thought: true }, { text }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 5 },
    },
  }),
};

const ENDPOINTS = {
  openai: 'https://api.openai.com/v1/chat/completions',
  mistral: 'https://api.mistral.ai/v1/chat/completions',
};

test('anthropic: request shape and parsed answer', async () => {
  const f = fakeFetch(REPLIES.anthropic('hello'));
  const r = await ask({ ...BASE, provider: 'anthropic', maxTokens: 100 }, { fetchImpl: f, env: ENV });
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['x-api-key'], KEY);
  assert.equal(init.headers['anthropic-version'], '2023-06-01');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(body, {
    model: 'some-model', max_tokens: 100, system: 'SYS',
    messages: [{ role: 'user', content: 'PROMPT' }],
  });
  assert.equal(r.text, 'hello');
  assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 7 });
  assert.equal(r.modelVersion, 'claude-x-2026');
});

for (const provider of ['openai', 'mistral']) {
  test(`${provider}: request shape, JSON mode and parsed answer`, async () => {
    const f = fakeFetch(REPLIES[provider]('{"verdict":"pending"}'));
    const r = await ask({ ...BASE, provider, json: true, maxTokens: 50, prompt: JSON_PROMPT }, { fetchImpl: f, env: ENV });
    const { url, init, body } = f.calls[0];
    assert.equal(url, ENDPOINTS[provider]);
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    const tokensField = provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
    assert.deepEqual(body, {
      model: 'some-model',
      messages: [{ role: 'system', content: 'SYS' }, { role: 'user', content: JSON_PROMPT }],
      [tokensField]: 50,
      response_format: { type: 'json_object' },
    });
    assert.deepEqual(r.json, { verdict: 'pending' });
    assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 7 });
  });
}

test('gemini: request shape, key in header not URL, thought parts skipped', async () => {
  const f = fakeFetch(REPLIES.gemini('[1,2]'));
  const r = await ask({ ...BASE, provider: 'gemini', json: true, system: 'Reply as JSON.' }, { fetchImpl: f, env: ENV });
  const { url, init, body } = f.calls[0];
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/some-model:generateContent');
  assert.ok(!url.includes(KEY));
  assert.equal(init.headers['x-goog-api-key'], KEY);
  assert.deepEqual(body, {
    contents: [{ role: 'user', parts: [{ text: 'PROMPT' }] }],
    systemInstruction: { parts: [{ text: 'Reply as JSON.' }] },
    generationConfig: { maxOutputTokens: 16000, responseMimeType: 'application/json' },
  });
  assert.equal(r.text, '[1,2]');
  assert.deepEqual(r.json, [1, 2]);
  assert.equal(r.modelVersion, 'gemini-x-001');
  assert.deepEqual(r.usage, { inputTokens: 11, outputTokens: 12 });
});

test('gemini: a model name that would change the URL path is refused before any request', async () => {
  await assert.rejects(
    ask({ ...BASE, provider: 'gemini', model: '../files' }, { fetchImpl: noFetch, env: ENV }),
    (e) => e instanceof AiError && e.code === 'bad_request',
  );
});

test('every call returns provider, model and promptVersion for jury_votes', async () => {
  for (const { name: provider } of PROVIDERS) {
    const r = await ask({ ...BASE, provider }, { fetchImpl: fakeFetch(REPLIES[provider]('ok')), env: ENV });
    assert.equal(r.provider, provider);
    assert.equal(r.model, 'some-model');
    assert.equal(r.promptVersion, 'judge-0.3');
  }
});

test('provider, model, prompt and promptVersion are required; unknown provider refused', async () => {
  for (const missing of ['promptVersion', 'model', 'prompt', 'provider']) {
    const req = { ...BASE, provider: 'fake', [missing]: '  ' };
    await assert.rejects(ask(req, { adapters: { fake: createFakeAdapter(['x']) } }), (e) => e.code === 'bad_request');
  }
  await assert.rejects(ask({ ...BASE, provider: 'nope' }, { env: ENV, fetchImpl: noFetch }), (e) => e.code === 'unknown_provider');
});

test('temperature is refused, and no adapter sends it', async () => {
  await assert.rejects(ask({ ...BASE, provider: 'openai', temperature: 0 }, { fetchImpl: noFetch, env: ENV }), (e) => e.code === 'bad_request');
  for (const { name: provider } of PROVIDERS) {
    const f = fakeFetch(REPLIES[provider]('ok'));
    await ask({ ...BASE, provider }, { fetchImpl: f, env: ENV });
    assert.ok(!f.calls[0].init.body.includes('temperature'), provider);
  }
});

test('missing key: error names the variable, no request is sent', async () => {
  for (const { name: provider, keyVar } of PROVIDERS) {
    await assert.rejects(ask({ ...BASE, provider }, { fetchImpl: noFetch, env: {} }), (e) => {
      assert.equal(e.code, 'missing_key');
      assert.ok(e.message.includes(keyVar));
      return true;
    });
  }
});

test('HTTP error: status in the error, key redacted even if the body echoes it', async () => {
  const f = fakeFetch({ status: 401, json: { error: `invalid key ${KEY}` } });
  await assert.rejects(ask({ ...BASE, provider: 'openai' }, { fetchImpl: f, env: ENV }), (e) => {
    assert.equal(e.code, 'http');
    assert.equal(e.status, 401);
    assert.ok(!e.message.includes(KEY));
    assert.ok(!String(e.stack).includes(KEY));
    assert.ok(e.message.includes('[redacted]'));
    return true;
  });
});

test('network failure becomes AiError without the original error (which may hold headers)', async () => {
  const failing = async () => { throw new TypeError(`fetch failed ${KEY}`); };
  await assert.rejects(ask({ ...BASE, provider: 'mistral' }, { fetchImpl: failing, env: ENV }), (e) => {
    assert.equal(e.code, 'network');
    assert.equal(e.cause, undefined);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('timeout gives AiError code timeout', async () => {
  const hanging = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  await assert.rejects(
    ask({ ...BASE, provider: 'anthropic', timeoutMs: 20 }, { fetchImpl: hanging, env: ENV }),
    (e) => e instanceof AiError && e.code === 'timeout',
  );
});

test('malformed or empty provider response is a bad_response error', async () => {
  const f = fakeFetch({ json: { choices: [] } });
  await assert.rejects(ask({ ...BASE, provider: 'openai' }, { fetchImpl: f, env: ENV }), (e) => e.code === 'bad_response');
  // Token cap reached during thinking: only thought parts, no visible text.
  const thoughtsOnly = fakeFetch({ json: { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'hmm', thought: true }] } }] } });
  await assert.rejects(ask({ ...BASE, provider: 'gemini' }, { fetchImpl: thoughtsOnly, env: ENV }), (e) => e.code === 'bad_response');
  const emptyChat = fakeFetch(REPLIES.openai(''));
  await assert.rejects(ask({ ...BASE, provider: 'openai' }, { fetchImpl: emptyChat, env: ENV }), (e) => e.code === 'bad_response');
  const empty = fakeFetch(REPLIES.anthropic('   '));
  await assert.rejects(ask({ ...BASE, provider: 'anthropic' }, { fetchImpl: empty, env: ENV }), (e) => e.code === 'bad_response');
});

test('JSON: one retry after an invalid answer, then success', async () => {
  const fake = createFakeAdapter(['not json', '{"a":1}']);
  const r = await ask({ ...BASE, provider: 'fake', json: true, prompt: JSON_PROMPT }, { adapters: { fake } });
  assert.deepEqual(r.json, { a: 1 });
  assert.equal(fake.calls.length, 2);
});

test('JSON: two invalid answers throw bad_json, no third call', async () => {
  const fake = createFakeAdapter(['nope', '{"a":', '{"never":"used"}']);
  await assert.rejects(ask({ ...BASE, provider: 'fake', json: true, prompt: JSON_PROMPT }, { adapters: { fake } }), (e) => e.code === 'bad_json');
  assert.equal(fake.calls.length, 2);
});

test('JSON on: a prompt that never mentions JSON is refused before any call, and nothing is added to it', async () => {
  const fake = createFakeAdapter(['{"a":1}']);
  await assert.rejects(ask({ ...BASE, provider: 'fake', json: true }, { adapters: { fake } }), (e) => {
    assert.equal(e.code, 'bad_request');
    assert.match(e.message, /must say "JSON"/);
    return true;
  });
  assert.equal(fake.calls.length, 0);
  await assert.rejects(ask({ ...BASE, provider: 'openai', json: true }, { fetchImpl: noFetch, env: ENV }), (e) => e.code === 'bad_request');
  const ok = await ask({ ...BASE, provider: 'fake', json: true, prompt: JSON_PROMPT }, { adapters: { fake } });
  assert.equal(fake.calls[0].system, 'SYS');
  assert.equal(fake.calls[0].prompt, JSON_PROMPT);
  assert.deepEqual(ok.json, { a: 1 });
});

test('JSON off: text is returned as is, system prompt untouched, no retry', async () => {
  const fake = createFakeAdapter(['plain text']);
  const r = await ask({ ...BASE, provider: 'fake' }, { adapters: { fake } });
  assert.equal(r.text, 'plain text');
  assert.equal(r.json, undefined);
  assert.equal(fake.calls[0].system, 'SYS');
});

test('JSON answers: a fenced block and padding are accepted, prose is not', async () => {
  const fence = '`'.repeat(3);
  const ok = async (text) => {
    const fake = createFakeAdapter([text]);
    return (await ask({ ...BASE, provider: 'fake', json: true, prompt: JSON_PROMPT }, { adapters: { fake } })).json;
  };
  assert.deepEqual(await ok(`${fence}json\n{"a":1}\n${fence}`), { a: 1 });
  assert.deepEqual(await ok('  {"a":1}  '), { a: 1 });
  const prose = createFakeAdapter(['Here it is: {"a":1}', 'Here it is: {"a":1}']);
  await assert.rejects(
    ask({ ...BASE, provider: 'fake', json: true, prompt: JSON_PROMPT }, { adapters: { fake: prose } }),
    (e) => e.code === 'bad_json',
  );
});

test('index.js exports only ask, AiError and provider names: no adapter object is reachable', () => {
  assert.deepEqual(Object.keys(layer).sort(), ['AiError', 'PROVIDERS', 'ask', 'recordProblems', 'textRefusal', 'unavailable']);
  assert.ok(Object.isFrozen(PROVIDERS));
  for (const entry of PROVIDERS) {
    assert.ok(Object.isFrozen(entry));
    assert.deepEqual(Object.keys(entry).sort(), ['keyVar', 'name']);
    assert.equal(typeof entry.name, 'string');
    assert.equal(typeof entry.keyVar, 'string');
  }
  // Nothing exported carries a call() method, the shape every adapter has.
  for (const value of Object.values(layer)) {
    assert.equal(typeof value?.call === 'function' && value !== layer.ask && value !== layer.AiError && value !== layer.unavailable && value !== layer.textRefusal && value !== layer.recordProblems, false);
  }
});

test('loadEnv sets missing variables only, returns names, ignores a missing file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  writeFileSync(file, '# comment\nOPENAI_API_KEY=from-file\nMISTRAL_API_KEY="quoted"\nGEMINI_API_KEY=\n');
  const env = { OPENAI_API_KEY: 'already-set' };
  const set = loadEnv(file, env);
  assert.deepEqual(set.sort(), ['GEMINI_API_KEY', 'MISTRAL_API_KEY']);
  assert.equal(env.OPENAI_API_KEY, 'already-set');
  assert.equal(env.MISTRAL_API_KEY, 'quoted');
  assert.deepEqual(loadEnv(join(dir, 'absent.env'), {}), []);
});

// Top-level folder of a path relative to src/: only src/ai/ itself is exempt (not src/aiport.js).
function insideAi(rel) {
  return rel.split(/[\\/]/)[0] === 'ai';
}
const VENDOR_RE = /api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.openai\.com|api\.mistral\.ai|_API_KEY/;
// Business code goes through ask(): importing an adapter or helper file directly is refused.
const INTERNAL_IMPORT_RE = /['"][^'"]*\bai\/(anthropic|openai|gemini|mistral|http|chat-completions|fake|codex-cli|claude-cli|mistral-cli)\.js['"]/;

test('principle 8 guard: its own checks catch what they should', () => {
  assert.equal(insideAi('ai/index.js'), true);
  assert.equal(insideAi('ai\\gemini.js'), true);
  assert.equal(insideAi('aiport.js'), false);
  assert.equal(insideAi('ai-tools/x.js'), false);
  assert.ok(INTERNAL_IMPORT_RE.test("import x from './ai/openai.js';"));
  assert.ok(INTERNAL_IMPORT_RE.test('const m = await import("../src/ai/fake.js");'));
  assert.ok(INTERNAL_IMPORT_RE.test("import codex from './ai/codex-cli.js';"));
  assert.ok(!INTERNAL_IMPORT_RE.test("import { ask } from './ai/index.js';"));
});

test('principle 8: outside src/ai/, no vendor endpoint or key name, and no import of adapter files', () => {
  const src = resolve(fileURLToPath(import.meta.url), '../../src');
  const walk = (dir) => readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const outside = walk(src).filter((p) => !insideAi(relative(src, p)));
  assert.ok(outside.length > 0);
  const offenders = outside.filter((p) => {
    const text = readFileSync(p, 'utf8');
    return VENDOR_RE.test(text) || INTERNAL_IMPORT_RE.test(text);
  });
  assert.deepEqual(offenders, []);
});

test('HTTP error body: key masked before the cut, and a key cut in half at the limit is masked too', async () => {
  // The key starts at character 495, so a plain 500-character cut would keep its first 5 characters.
  const body = 'x'.repeat(495) + KEY + 'tail';
  const s = snippet(body, KEY);
  assert.equal(s.length, 500);
  assert.ok(!s.includes(KEY.slice(0, 2)));
  assert.equal(snippet('a' + KEY + 'b', KEY), 'a[redacted]b');
  // Only the start of a key sits at the cut (e.g. echoed truncated): that start is masked too.
  const partial = snippet('x'.repeat(495) + KEY.slice(0, 8) + 'zzz', KEY);
  assert.equal(partial, 'x'.repeat(495) + '[redacted]');
  // The same through ask(), as an HTTP error from a provider.
  const f = async () => new Response(body, { status: 500 });
  await assert.rejects(ask({ ...BASE, provider: 'anthropic' }, { fetchImpl: f, env: ENV }), (e) => {
    assert.equal(e.code, 'http');
    assert.ok(!e.message.includes(KEY.slice(0, 5)));
    return true;
  });
});

test('error reading the response body becomes AiError network with no cause', async () => {
  const f = async () => ({
    ok: true, status: 200, text: async () => { throw new TypeError(`socket closed ${KEY}`); },
  });
  await assert.rejects(ask({ ...BASE, provider: 'openai' }, { fetchImpl: f, env: ENV }), (e) => {
    assert.equal(e.code, 'network');
    assert.equal(e.cause, undefined);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test('truncated, filtered or unexplained finishes are bad_response with the reason, never the text', async () => {
  const cases = {
    anthropic: ['max_tokens', 'refusal', 'pause_turn'],
    openai: ['length', 'content_filter', 'tool_calls'],
    mistral: ['length', 'model_length', 'error'],
    gemini: ['MAX_TOKENS', 'SAFETY', 'RECITATION'],
  };
  for (const [provider, reasons] of Object.entries(cases)) {
    for (const reason of reasons) {
      const f = fakeFetch(REPLIES[provider]('{"verdict":"came_true"} SECRET-ANSWER', reason));
      await assert.rejects(ask({ ...BASE, provider }, { fetchImpl: f, env: ENV }), (e) => {
        assert.equal(e.code, 'bad_response', `${provider} ${reason}`);
        assert.ok(e.message.includes(reason));
        assert.ok(!e.message.includes('SECRET-ANSWER'));
        return true;
      });
    }
    const noReason = fakeFetch(REPLIES[provider]('ok', null));
    await assert.rejects(
      ask({ ...BASE, provider }, { fetchImpl: noReason, env: ENV }),
      (e) => e.code === 'bad_response' && /missing or unrecognised/.test(e.message),
    );
  }
});

test('mistral: content as chunks keeps text chunks only, thinking dropped', async () => {
  const f = fakeFetch({
    json: {
      choices: [{
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: [{ type: 'text', text: 'private' }] },
            { type: 'text', text: '{"a"' },
            { type: 'text', text: ':1}' },
          ],
        },
      }],
    },
  });
  const r = await ask({ ...BASE, provider: 'mistral', json: true, prompt: JSON_PROMPT }, { fetchImpl: f, env: ENV });
  assert.equal(r.text, '{"a":1}');
  assert.deepEqual(r.json, { a: 1 });
});

test('unknown request fields and options, and maxTokens above 64000, are refused before any call', async () => {
  const opts = { fetchImpl: noFetch, env: ENV };
  for (const extra of [{ maxToken: 100 }, { promptversion: 'x' }, { temperature: 0 }, { maxTokens: 64001 }]) {
    await assert.rejects(ask({ ...BASE, provider: 'openai', ...extra }, opts), (e) => e.code === 'bad_request', JSON.stringify(extra));
  }
  await assert.rejects(ask({ ...BASE, provider: 'openai' }, { ...opts, fetch: noFetch }), (e) => e.code === 'bad_request');
  const f = fakeFetch(REPLIES.openai('ok'));
  await ask({ ...BASE, provider: 'openai', maxTokens: 64000 }, { fetchImpl: f, env: ENV });
  assert.equal(f.calls[0].body.max_completion_tokens, 64000);
});

test('the fake adapter is not exported by the layer; ask() only knows the four providers', async () => {
  assert.equal(layer.createFakeAdapter, undefined);
  assert.deepEqual(PROVIDERS.map((p) => p.name).sort(), ['anthropic', 'gemini', 'mistral', 'openai']);
  await assert.rejects(ask({ ...BASE, provider: 'fake' }), (e) => e.code === 'unknown_provider');
});

// Optional document input (a PDF to read). Only anthropic and gemini accept it.
const PDF = Buffer.from('%PDF-1.7 fake bytes');

test('anthropic: a document goes first as a base64 document block, then the prompt as text', async () => {
  const f = fakeFetch(REPLIES.anthropic('ok'));
  await ask({ ...BASE, provider: 'anthropic', document: { mediaType: 'application/pdf', data: PDF } }, { fetchImpl: f, env: ENV });
  assert.deepEqual(f.calls[0].body.messages, [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') } },
      { type: 'text', text: 'PROMPT' },
    ],
  }]);
  assert.equal(f.calls[0].body.system, 'SYS');
});

test('gemini: a document goes first as inline_data, then the prompt as text', async () => {
  const f = fakeFetch(REPLIES.gemini('ok'));
  await ask({ ...BASE, provider: 'gemini', document: { mediaType: 'application/pdf', data: new Uint8Array(PDF) } }, { fetchImpl: f, env: ENV });
  assert.deepEqual(f.calls[0].body.contents, [{
    role: 'user',
    parts: [{ inline_data: { mime_type: 'application/pdf', data: PDF.toString('base64') } }, { text: 'PROMPT' }],
  }]);
});

test('document: openai and mistral refuse with code unsupported before any request', async () => {
  for (const provider of ['openai', 'mistral']) {
    await assert.rejects(
      ask({ ...BASE, provider, document: { mediaType: 'application/pdf', data: PDF } }, { fetchImpl: noFetch, env: ENV }),
      (e) => e instanceof AiError && e.code === 'unsupported' && e.provider === provider,
    );
  }
  // A media type the adapter does not declare is refused too.
  await assert.rejects(
    ask({ ...BASE, provider: 'anthropic', document: { mediaType: 'image/png', data: PDF } }, { fetchImpl: noFetch, env: ENV }),
    (e) => e.code === 'unsupported',
  );
});

test('document: malformed values are bad_request before any request; the key never appears', async () => {
  const bad = [
    null, 'a.pdf', {}, { mediaType: 'application/pdf' }, { mediaType: 'application/pdf', data: Buffer.alloc(0) },
    { mediaType: 'application/pdf', data: 'base64-string' }, { mediaType: 'PDF', data: PDF },
    { mediaType: 'application/pdf', data: PDF, name: 'x.pdf' },
  ];
  for (const document of bad) {
    await assert.rejects(
      ask({ ...BASE, provider: 'anthropic', document }, { fetchImpl: noFetch, env: ENV }),
      (e) => e.code === 'bad_request' && !e.message.includes(KEY),
      JSON.stringify(document),
    );
  }
});

test('document: stop-reason and JSON guarantees still hold with a document', async () => {
  const f = fakeFetch(REPLIES.anthropic('{"a":1}', 'max_tokens'));
  await assert.rejects(
    ask({ ...BASE, provider: 'anthropic', document: { mediaType: 'application/pdf', data: PDF } }, { fetchImpl: f, env: ENV }),
    (e) => e.code === 'bad_response',
  );
  const ok = fakeFetch(REPLIES.anthropic('{"a":1}'));
  const r = await ask({ ...BASE, provider: 'anthropic', json: true, prompt: JSON_PROMPT, document: { mediaType: 'application/pdf', data: PDF } }, { fetchImpl: ok, env: ENV });
  assert.deepEqual(r.json, { a: 1 });
});

// Several documents in one request (the jury attaches every PDF of evidence for one claim).
test('documents: several go first, in order; document and documents together, empty or too many are refused', async () => {
  const PDF2 = Buffer.from('%PDF-1.7 second');
  const f = fakeFetch(REPLIES.anthropic('ok'));
  const docs = [{ mediaType: 'application/pdf', data: PDF }, { mediaType: 'application/pdf', data: PDF2 }];
  await ask({ ...BASE, provider: 'anthropic', documents: docs }, { fetchImpl: f, env: ENV });
  assert.deepEqual(f.calls[0].body.messages[0].content.map((b) => b.source?.data ?? b.text), [PDF.toString('base64'), PDF2.toString('base64'), 'PROMPT']);
  const g = fakeFetch(REPLIES.gemini('ok'));
  await ask({ ...BASE, provider: 'gemini', documents: docs }, { fetchImpl: g, env: ENV });
  assert.deepEqual(g.calls[0].body.contents[0].parts.map((p) => p.inline_data?.data ?? p.text), [PDF.toString('base64'), PDF2.toString('base64'), 'PROMPT']);
  const opts = { fetchImpl: noFetch, env: ENV };
  for (const bad of [
    { document: docs[0], documents: docs }, { documents: [] }, { documents: docs[0] },
    { documents: Array(11).fill(docs[0]) }, { documents: [docs[0], undefined] }, { documents: [docs[0], { mediaType: 'application/pdf' }] },
  ]) {
    await assert.rejects(ask({ ...BASE, provider: 'anthropic', ...bad }, opts), (e) => e.code === 'bad_request', Object.keys(bad).join());
  }
  await assert.rejects(ask({ ...BASE, provider: 'openai', documents: docs }, opts), (e) => e.code === 'unsupported');
});

// Server-side web search (anthropic only).
const SEARCH_CONTENT = [
  { type: 'text', text: "I'll search for that." },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'q' } },
  {
    type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1',
    content: [{ type: 'web_search_result', url: 'https://www.legifrance.gouv.fr/x', title: 'Loi', encrypted_content: 'E' }],
  },
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'q2' } },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } },
  { type: 'text', text: '{"a"' },
  { type: 'text', text: ':1}', citations: [] },
];
const searchReply = (content, stop = 'end_turn', n = 2) => ({
  json: { model: 'claude-x', stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: n } } },
});

test('webSearch: tool sent with max_uses; only the final text counts; results, errors and searches reported', async () => {
  const f = fakeFetch(searchReply(SEARCH_CONTENT));
  const r = await ask({ ...BASE, provider: 'anthropic', json: true, prompt: JSON_PROMPT, webSearch: { maxUses: 4 } }, { fetchImpl: f, env: ENV });
  assert.deepEqual(f.calls[0].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }]);
  assert.equal(r.text, '{"a":1}');
  assert.deepEqual(r.json, { a: 1 });
  assert.deepEqual(r.webSearch, { requests: 2, results: [{ url: 'https://www.legifrance.gouv.fr/x', title: 'Loi' }], errors: 1 });
  assert.deepEqual(r.usage, { inputTokens: 100, outputTokens: 10 });
  // Without webSearch no tools are sent and the reply has no webSearch field.
  const g = fakeFetch(REPLIES.anthropic('ok'));
  const plain = await ask({ ...BASE, provider: 'anthropic' }, { fetchImpl: g, env: ENV });
  assert.equal(g.calls[0].body.tools, undefined);
  assert.equal(plain.webSearch, undefined);
});

test('webSearch: pause_turn is continued with the paused content sent back, a bounded number of times', async () => {
  const first = SEARCH_CONTENT.slice(0, 3);
  const f = fakeFetch(searchReply(first, 'pause_turn', 1), searchReply(SEARCH_CONTENT.slice(3), 'end_turn', 1));
  const r = await ask({ ...BASE, provider: 'anthropic', webSearch: { maxUses: 4 } }, { fetchImpl: f, env: ENV });
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1].body.messages, [{ role: 'user', content: 'PROMPT' }, { role: 'assistant', content: first }]);
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.webSearch.requests, 2);
  assert.deepEqual(r.usage, { inputTokens: 200, outputTokens: 20 });
  // Four pauses in a row: three continuations, then an error naming the stop reason only.
  const paused = fakeFetch(searchReply(first, 'pause_turn', 1));
  await assert.rejects(
    ask({ ...BASE, provider: 'anthropic', webSearch: { maxUses: 4 } }, { fetchImpl: paused, env: ENV }),
    (e) => e.code === 'bad_response' && /pause_turn/.test(e.message) && !e.message.includes('search for that'),
  );
  assert.equal(paused.calls.length, 4);
  // Without webSearch, pause_turn is not continued.
  const once = fakeFetch(searchReply(first, 'pause_turn', 0));
  await assert.rejects(ask({ ...BASE, provider: 'anthropic' }, { fetchImpl: once, env: ENV }), (e) => e.code === 'bad_response');
  assert.equal(once.calls.length, 1);
});

test('webSearch: other providers refuse it, malformed values are bad_request, all before any request', async () => {
  const opts = { fetchImpl: noFetch, env: ENV };
  for (const provider of ['openai', 'mistral', 'gemini']) {
    await assert.rejects(ask({ ...BASE, provider, webSearch: { maxUses: 2 } }, opts), (e) => e.code === 'unsupported' && e.provider === provider);
  }
  for (const webSearch of [null, true, {}, { maxUses: 0 }, { maxUses: 21 }, { maxUses: 1.5 }, { maxUses: 2, allowedDomains: ['x'] }, []]) {
    await assert.rejects(ask({ ...BASE, provider: 'anthropic', webSearch }, opts), (e) => e.code === 'bad_request', JSON.stringify(webSearch));
  }
});

test('webSearch: an HTTP error during a continuation still masks the key', async () => {
  const f = fakeFetch(searchReply(SEARCH_CONTENT.slice(0, 3), 'pause_turn', 1), { status: 500, json: { error: `bad key ${KEY}` } });
  await assert.rejects(
    ask({ ...BASE, provider: 'anthropic', webSearch: { maxUses: 2 } }, { fetchImpl: f, env: ENV }),
    (e) => e.code === 'http' && !e.message.includes(KEY) && e.message.includes('[redacted]'),
  );
});
