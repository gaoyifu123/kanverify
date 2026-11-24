// F3 (Fable review 4): ask() refuses any reply that carries a secret, for every provider.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask } from '../src/ai/index.js';
import { createCodexAdapter } from '../src/ai/codex-cli.js';
import { CODEX_EVENTS, codexOutFile } from './helpers.js';
import { createFakeAdapter } from '../src/ai/fake.js';
import { findSecret, secretValues } from '../src/ai/secrets.js';

// Built at run time so no token-shaped literal sits in the repository.
const JWT = `eyJ${'hbGciOiJIUzI1NiJ9'}.eyJ${'zdWIiOiIxMjM0NTY3ODkwIn0'}.sig`;
const SK = `sk-${'proj'}-${'A1b2C3d4E5f6G7h8I9j0'}`;
const B64 = `Zm9v${'YmFyQmF6UXV4MTIzNDU2Nzg5MEFiQ2RFZkdo'}`;
const HEX = `${'deadbeef'}${'0123456789abcdef'.repeat(2)}`;

test('findSecret: values from .env anywhere, token-like strings unless quoted from the input or in a URL', () => {
  const secrets = ['piste-client-secret-value'];
  assert.equal(findSecret('the key is piste-client-secret-value.', { secrets }), 'a value from .env');
  assert.equal(findSecret('quoted piste-client-secret-value', { secrets, input: 'piste-client-secret-value' }), 'a value from .env');
  assert.equal(findSecret(`token ${JWT}`), 'a JWT-like token');
  assert.equal(findSecret(`key ${SK}`), 'an sk- key');
  assert.equal(findSecret(`blob ${B64}`), 'a long base64-like string');
  assert.equal(findSecret(`hash ${HEX}`), 'a long hex string');
  // Quoted from the request: an excerpt, not a leak.
  assert.equal(findSecret(`the excerpt says ${HEX}`, { input: `pack text ${HEX} more` }), null);
  // Inside a URL (web search results, citations).
  assert.equal(findSecret(`see https://example.org/doc/${B64}?v=${HEX}`), null);
  // Ordinary text, ids, UUIDs, French with long words.
  for (const ok of [
    'JORFTEXT000047445077 art. 10 : L’âge est porté à soixante-quatre ans.',
    '123e4567-e89b-12d3-a456-426614174000',
    'anticonstitutionnellement et intergouvernementalisation',
    '{"verdict":"came_true","evidence":[{"source_id":38,"locator":"art. 10"}]}',
  ]) assert.equal(findSecret(ok), null, ok);
});

test('secretValues: every .env value and secret-named variable, 8 characters or longer', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-env-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = join(dir, '.env');
  writeFileSync(envFile, 'PISTE_CLIENT_ID=client-id-123456\nSHORT=abc\nANTHROPIC_API_KEY=\n');
  const values = secretValues({ envFile, env: { MY_TOKEN: 'tok-tok-tok-tok', PATH: 'C:\\Windows\\System32' } });
  assert.deepEqual(values.sort(), ['client-id-123456', 'tok-tok-tok-tok']);
  assert.deepEqual(secretValues({ envFile: join(dir, 'missing'), env: {} }), []);
});

const REQ = { provider: 'fake', model: 'm', promptVersion: 'v1', prompt: 'Answer in JSON.', json: true };

test('ask refuses a reply carrying an env secret: secret_in_reply, no retry, the value never in the error', async () => {
  const env = { ANTHROPIC_API_KEY: 'sk-ant-the-real-key-000000000000' };
  const fake = createFakeAdapter([JSON.stringify({ note: `found ${env.ANTHROPIC_API_KEY}` }), '{}']);
  await assert.rejects(ask(REQ, { env, adapters: { fake } }), (e) => {
    assert.equal(e.code, 'secret_in_reply');
    assert.ok(!e.message.includes(env.ANTHROPIC_API_KEY));
    return true;
  });
  assert.equal(fake.calls.length, 1);
});

test('ask refuses token-like strings in the answer and in web search results', async () => {
  const jwt = createFakeAdapter([JSON.stringify({ reasoning: `auth.json says ${JWT}` })]);
  await assert.rejects(ask(REQ, { env: {}, adapters: { fake: jwt } }), (e) => e.code === 'secret_in_reply');

  const base = createFakeAdapter(['{"ok":true}']);
  const searching = { ...base, webSearch: true, async call(req) { return { ...(await base.call(req)), webSearch: { requests: 1, results: [{ url: 'https://x.example', title: `leak ${SK}` }], errors: 0 } }; } };
  await assert.rejects(ask({ ...REQ, webSearch: { maxUses: 1 } }, { env: {}, adapters: { fake: searching } }), (e) => e.code === 'secret_in_reply');

  // The same long string quoted from the prompt is fine.
  const quoting = createFakeAdapter([JSON.stringify({ excerpt: HEX })]);
  const r = await ask({ ...REQ, prompt: `Answer in JSON. Pack excerpt: ${HEX}` }, { env: {}, adapters: { fake: quoting } });
  assert.equal(r.json.excerpt, HEX);
});

test('ask refuses a Codex reply that quotes a secret (the adapter path F3 was about)', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'kv-codex-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = async (args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.172.0\n', stderr: '' };
    writeFileSync(codexOutFile(args), JSON.stringify({ verdict: 'came_true', reasoning: `token: ${JWT}` }));
    return { code: 0, stdout: CODEX_EVENTS, stderr: 'model: gpt-x\n' };
  };
  await assert.rejects(
    ask({ ...REQ, provider: 'codex', model: 'gpt-6.2-sol' }, { env: {}, adapters: { codex: createCodexAdapter({ run, tmpRoot: root }) } }),
    (e) => e.code === 'secret_in_reply' && e.provider === 'codex'
  );
});

// R2: JSON escapes must not hide a secret. The backslash is built at run time.
const BS = String.fromCharCode(92);
const esc = (s) => [...s].map((c) => `${BS}u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');

test('R2: secrets hidden by JSON escapes are found in the parsed value', async () => {
  const QUOTED = 'Zx9/qLm+Rt7"Vb2Kp'; // a value whose JSON form differs from itself
  const PLAIN = 'pisteSecretValue12345';
  const env = { PISTE_CLIENT_SECRET: QUOTED, GEMINI_API_KEY: PLAIN };
  const replies = [
    JSON.stringify({ reason: QUOTED }),
    `{"reason":"${PLAIN.slice(0, 5)}${esc(PLAIN[5])}${PLAIN.slice(6)}"}`,
    `{"reason":"${esc(PLAIN)}"}`,
    `{"reason":"${esc(JWT.slice(0, 20))}${JWT.slice(20)}"}`,
    `{"reason":"s${esc('k')}${SK.slice(2)}"}`,
    `{"${esc(PLAIN)}":1}`,
  ];
  for (const text of replies) {
    const fake = createFakeAdapter([text]);
    await assert.rejects(ask(REQ, { env, adapters: { fake } }), (e) => {
      assert.equal(e.code, 'secret_in_reply', text);
      assert.ok(!e.message.includes(PLAIN) && !e.message.includes(QUOTED));
      return true;
    });
  }
});

test('a sha256 cited in a reasoning passes when it is in the request, and is refused when it is not', async () => {
  const sha = 'ab12'.repeat(16);
  const cite = JSON.stringify({ reasoning: `the archived file ${sha} says so` });
  const ok = await ask({ ...REQ, prompt: `Answer in JSON. Source 38: ${JSON.stringify({ sha256: sha })}` }, { env: {}, adapters: { fake: createFakeAdapter([cite]) } });
  assert.match(ok.json.reasoning, /ab12ab12/);
  await assert.rejects(ask(REQ, { env: {}, adapters: { fake: createFakeAdapter([cite]) } }), (e) => e.code === 'secret_in_reply');
});
