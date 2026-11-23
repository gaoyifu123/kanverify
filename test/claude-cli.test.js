// The Claude command-line judge (src/ai/claude-cli.js): isolation (empty working folder, no tools,
// environment allowlist), timeout, malformed output, the reply guard. The calls run a real child
// process: a stand-in for claude, run by this Node through the same spawnTool as the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask } from '../src/ai/index.js';
import { answeringModel, childEnv, claudeArgs, createClaudeAdapter, findClaudeExe, MAX_SYSTEM_CHARS } from '../src/ai/claude-cli.js';
import { spawnTool } from '../src/ai/codex-cli.js';

function tempRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.');
const ANSWER = { verdict: 'unverifiable', evidence: [], rules_applied: ['VG-1'], reasoning: 'r', open_question_fr: null, open_question_en: null, summary_fr: 'f', summary_en: 'e' };

// Answers --version, otherwise writes what it saw next to itself (report.json), then answers
// according to the model it is asked for: ok, slow (never answers), notjson (plain text on stdout),
// error (is_error, exit 1), prose (a result that is not JSON), secret (a JWT in the answer),
// turns (two turns), denied (a permission denial), maxturns (subtype not success), nomodel (two
// models, neither the requested one), nousage (no modelUsage).
const FAKE_CLAUDE = `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.330 (Claude Code)'); process.exit(0); }
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const model = at('--model');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify({
  cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()), env: process.env, args, stdin, system: at('--system-prompt') ?? null,
}));
const answer = ${JSON.stringify(JSON.stringify(ANSWER))};
const result = (text, extra = {}) => process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: text, session_id: '11111111-2222-3333-4444-555555555555',
  num_turns: 1, permission_denials: [], usage: { input_tokens: 1200, output_tokens: 300 }, modelUsage: { [model]: {} }, ...extra,
}));
if (model === 'slow') setInterval(() => {}, 1000);
else if (model === 'notjson') process.stdout.write('Error: something went wrong');
else if (model === 'error') { result('Not logged in · Please run /login', { is_error: true }); process.exitCode = 1; }
else if (model === 'prose') result('I think the promise was kept.');
else if (model === 'secret') result(answer.replace('"r"', '"token ${JWT}"'));
else if (model === 'turns') result(answer, { num_turns: 2 });
else if (model === 'denied') result(answer, { permission_denials: [{ tool_name: 'Read' }] });
else if (model === 'maxturns') result(answer, { subtype: 'error_max_turns' });
else if (model === 'nomodel') result(answer, { modelUsage: { 'claude-a': {}, 'claude-b': {} } });
else if (model === 'nousage') result(answer, { modelUsage: undefined });
else result(answer);
`;

function fakeClaude(t) {
  const bin = tempRoot(t, 'kv-fake-claude-');
  const script = join(bin, 'fake-claude.cjs');
  writeFileSync(script, FAKE_CLAUDE);
  const run = (args, opts) => spawnTool(process.execPath, [script, ...args], opts);
  return { run, report: () => JSON.parse(readFileSync(join(bin, 'report.json'), 'utf8')) };
}

const REQ = { provider: 'claude', model: 'claude-opus-5-5', promptVersion: 'judge-test', system: 'SYSTEM TEXT: the principles and the judge prompt.', prompt: 'The claim and the pack. Answer in JSON.', json: true };

test('claude: runs from an empty folder, no tools, only allowlisted variables, system text from a file, prompt on stdin', async (t) => {
  const { run, report } = fakeClaude(t);
  const root = tempRoot(t, 'kv-claude-root-');
  const saved = { a: process.env.ANTHROPIC_API_KEY, s: process.env.PISTE_CLIENT_SECRET };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-never-reach-the-child';
  process.env.PISTE_CLIENT_SECRET = 'piste-secret-value';
  let r;
  try {
    r = await ask(REQ, { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root }) } });
  } finally {
    for (const [name, value] of [['ANTHROPIC_API_KEY', saved.a], ['PISTE_CLIENT_SECRET', saved.s]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  assert.deepEqual(r.json, ANSWER);
  assert.equal(r.modelVersion, 'claude-opus-5-5');
  assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });
  assert.equal(r.raw.session_id, '11111111-2222-3333-4444-555555555555');
  assert.equal(r.raw.cli_version, '2.1.330');
  assert.equal(r.raw.system_prefix, "You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  assert.equal(r.raw.num_turns, 1);
  assert.deepEqual(r.raw.permission_denials, []);

  const seen = report();
  assert.deepEqual(seen.cwdFiles, [], 'the working folder is empty');
  assert.ok(seen.cwd.includes('kv-claude-work-') && !seen.cwd.includes('KANVERIFY'));
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'CLAUDE_CONFIG_DIR', 'COMSPEC', 'PATHEXT',
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'DISABLE_AUTOUPDATER']);
  seen.envKeys = Object.keys(seen.env);
  for (const name of ['ANTHROPIC_API_KEY', 'PISTE_CLIENT_SECRET', 'NODE_OPTIONS']) assert.ok(!seen.envKeys.includes(name), name);
  assert.equal(seen.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(seen.env.DISABLE_AUTOUPDATER, '1');
  // Windows and Node add a few of their own to any child (checked with a bare { PATH } env);
  // every other variable is on the allowlist.
  const osAdded = new Set(['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'USERDOMAIN', 'USERNAME', 'WINDIR']);
  assert.ok(seen.envKeys.filter((k) => !k.startsWith('=') && !osAdded.has(k.toUpperCase())).every((k) => allowed.has(k.toUpperCase())), seen.envKeys.join());
  assert.equal(seen.system, REQ.system);
  assert.equal(seen.stdin, REQ.prompt);
  const a = seen.args;
  assert.equal(a[0], '-p');
  assert.equal(a[a.indexOf('--output-format') + 1], 'json');
  assert.equal(a[a.indexOf('--tools') + 1], '', 'no built-in tools');
  assert.equal(a[a.indexOf('--setting-sources') + 1], '', 'no user or project settings');
  for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--safe-mode', '--no-session-persistence']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(a[a.indexOf('--system-prompt') + 1], REQ.system, 'the documented flag, not a file');
  assert.ok(!a.some((x) => /dangerously|bypassPermissions|--add-dir|--allowed-tools|--system-prompt-file/.test(x)));
  assert.deepEqual(readdirSync(root), [], 'both temporary folders are removed');
});

test('claude: a timeout is an AiError, the call settles soon after, nothing is left behind', async (t) => {
  const { run } = fakeClaude(t);
  const root = tempRoot(t, 'kv-claude-root-');
  const started = Date.now();
  await assert.rejects(
    ask({ ...REQ, model: 'slow', timeoutMs: 1500 }, { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root }) } }),
    (e) => e.code === 'timeout' && e.provider === 'claude'
  );
  assert.ok(Date.now() - started < 1500 + 6000, 'settled within the cap after the timeout');
  assert.deepEqual(readdirSync(root), []);
});

test('claude: output that is not the JSON result, a reported error, and an answer that is not JSON are refused', async (t) => {
  const { run } = fakeClaude(t);
  const root = tempRoot(t, 'kv-claude-root-');
  const opts = { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root }) } };
  await assert.rejects(ask({ ...REQ, model: 'notjson' }, opts), (e) => e.code === 'bad_response' && /not the JSON result/.test(e.message));
  await assert.rejects(ask({ ...REQ, model: 'error' }, opts), (e) => {
    assert.equal(e.code, 'bad_response');
    assert.match(e.message, /exited with code 1: Not logged in/);
    assert.ok(!e.message.includes('SYSTEM TEXT') && !e.message.includes('The claim and the pack'));
    return true;
  });
  await assert.rejects(ask({ ...REQ, model: 'prose' }, opts), (e) => e.code === 'bad_json');
  // A run that exits 0 but says is_error is refused too.
  const flagged = async (args) => args[0] === '--version' ? { code: 0, stdout: '2.1.330 (Claude Code)' } : ({ code: 0, stderr: '', stdout: JSON.stringify({ type: 'result', is_error: true, result: 'usage limit reached' }) });
  await assert.rejects(ask(REQ, { env: {}, adapters: { claude: createClaudeAdapter({ run: flagged, tmpRoot: root }) } }),
    (e) => e.code === 'bad_response' && /reported an error: usage limit reached/.test(e.message));
  // F1, F7: only one plain answer counts; F2: the tool must say which model answered.
  for (const [model, re] of [['turns', /took 2 turns/], ['denied', /permission denials/], ['maxturns', /subtype "error_max_turns"/],
    ['nomodel', /does not say which model answered \(models used: claude-a, claude-b\)/], ['nousage', /does not say which model answered/]]) {
    await assert.rejects(ask({ ...REQ, model }, opts), (e) => e.code === 'bad_response' && re.test(e.message), model);
  }
  // No version, no vote.
  const noVersion = async (args) => ({ code: args[0] === '--version' ? 1 : 0, stdout: '', stderr: '' });
  await assert.rejects(ask(REQ, { env: {}, adapters: { claude: createClaudeAdapter({ run: noVersion, tmpRoot: root }) } }), (e) => /gave no version/.test(e.message));
  // F4: a system text too long for the command line is refused before anything runs (quotes count twice).
  let ran = false;
  const never = async () => { ran = true; return { code: 0, stdout: '' }; };
  const long = `${'x'.repeat(MAX_SYSTEM_CHARS - 10)}${'"'.repeat(6)}`;
  await assert.rejects(ask({ ...REQ, system: long }, { env: {}, adapters: { claude: createClaudeAdapter({ run: never, tmpRoot: root }) } }),
    (e) => e.code === 'bad_request' && /too long for the command line/.test(e.message));
  assert.equal(ran, false);
  // The answer schema is a Codex feature; Claude refuses it rather than ignoring it.
  await assert.rejects(ask({ ...REQ, schema: { type: 'object' } }, opts), (e) => e.code === 'unsupported');
  assert.deepEqual(readdirSync(root), []);
});

test('claude: a reply that carries a secret is refused by the reply guard', async (t) => {
  const { run } = fakeClaude(t);
  const root = tempRoot(t, 'kv-claude-root-');
  await assert.rejects(
    ask({ ...REQ, model: 'secret' }, { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root }) } }),
    (e) => e.code === 'secret_in_reply' && e.provider === 'claude'
  );
});

test('claude: arguments, environment allowlist, the answering model, and finding the installed program', (t) => {
  assert.throws(() => claudeArgs({ model: 'opus; rm -rf' }), (e) => e.code === 'bad_request');
  assert.throws(() => claudeArgs({ model: 'm', effort: 'huge' }), (e) => e.code === 'bad_request');
  assert.ok(!claudeArgs({ model: 'm' }).includes('--system-prompt'));
  const env = { Path: 'p', SystemRoot: 'C:\\Windows', USERPROFILE: 'u', HOME: 'h', CLAUDE_CONFIG_DIR: 'c', ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'x', CODEX_HOME: 'c', GITHUB_TOKEN: 'g' };
  assert.deepEqual(Object.keys(childEnv(env)).sort(), ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER', 'HOME', 'Path', 'SystemRoot', 'USERPROFILE']);
  assert.equal(answeringModel({ 'claude-opus-5-5': {}, 'claude-haiku-5-5': {} }, 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(answeringModel({ 'claude-opus-5-5-20261101': {} }, 'opus'), 'claude-opus-5-5-20261101');
  assert.equal(answeringModel({ a: {}, b: {} }, 'c'), null);
  assert.equal(answeringModel(undefined, 'c'), null);

  const bin = tempRoot(t, 'kv-fake-claude-');
  const dir = join(bin, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  mkdirSync(dir, { recursive: true });
  const exe = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
  writeFileSync(exe, '');
  assert.equal(findClaudeExe({ PATH: ['nowhere', bin].join(process.platform === 'win32' ? ';' : ':') }), exe);
  assert.equal(findClaudeExe({ PATH: 'nowhere' }), null);
});
