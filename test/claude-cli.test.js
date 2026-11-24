// The Claude command-line judge (src/ai/claude-cli.js): isolation (empty working folder, no tools,
// environment allowlist), timeout, malformed output, the reply guard. The calls run a real child
// process: a stand-in for claude, run by this Node through the same spawnTool as the real one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask } from '../src/ai/index.js';
import {
  answeringModel, atPathMention, childEnv, claudeArgs, createClaudeAdapter, findClaudeExe, MAX_SYSTEM_CHARS, VERIFIED_CLI_VERSIONS,
} from '../src/ai/claude-cli.js';
import { findOnPath, spawnTool } from '../src/ai/codex-cli.js';
import { ALLOWED_FORMS, refusedForms } from './at-mention-forms.js';

function tempRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.');
const ANSWER = { verdict: 'unverifiable', evidence: [], rules_applied: ['VG-1'], reasoning: 'r', open_question_fr: null, open_question_en: null, summary_fr: 'f', summary_en: 'e' };

// Answers --version, otherwise writes what it saw next to itself (report.json), prints the init
// report of a clean run (stream-json), then answers according to the model it is asked for: ok,
// slow (never answers), notjson (plain text on stdout), error (is_error, exit 1), prose (a result
// that is not JSON), secret (a JWT in the answer), turns (two turns), denied (a permission denial),
// maxturns (subtype not success), nomodel (two models, neither the requested one), nousage (no
// modelUsage), haiku (another model answered), dated (the requested name plus a date). Init-report
// faults: noinit, withtools, mcp, skills, plugin (a plugin that is not built in), apikey, elsewhere
// (another working folder), otherversion.
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
const builtin = ['cc-plugin-agents-md', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'].map((name) => ({ name, path: 'builtin' }));
const init = { type: 'system', subtype: 'init', cwd: process.cwd(), tools: [], mcp_servers: [], skills: [], slash_commands: [], plugins: builtin,
  apiKeySource: 'none', claude_code_version: '2.1.330', permissionMode: 'dontAsk', model };
const faults = {
  withtools: { tools: ['Read'] }, mcp: { mcp_servers: [{ name: 'files', status: 'connected' }] }, skills: { skills: ['pdf'] },
  plugin: { plugins: [...builtin, { name: 'helper', path: 'C:/plugins/helper' }] }, apikey: { apiKeySource: 'ANTHROPIC_API_KEY' },
  elsewhere: { cwd: path.dirname(process.cwd()) }, otherversion: { claude_code_version: '2.1.331' },
  newfield: { account_email: 'x' }, extradir: { additional_directories: [process.cwd(), path.dirname(process.cwd())] },
};
if (model !== 'noinit' && model !== 'notjson') process.stdout.write(JSON.stringify({ ...init, ...(faults[model] ?? {}) }) + '\\n');
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
else if (model === 'haiku') result(answer, { modelUsage: { 'claude-haiku-5-5': {} } });
else if (model === 'dated') result(answer, { modelUsage: { 'dated-20261101': {} } });
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

test('claude: runs from an empty folder, no tools, only allowlisted variables, system text as an argument, prompt on stdin', async (t) => {
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
  assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(a.includes('--verbose'), 'stream-json needs --verbose, which gives the init report');
  assert.equal(a[a.indexOf('--tools') + 1], '', 'no built-in tools');
  assert.equal(a[a.indexOf('--setting-sources') + 1], '', 'no user or project settings');
  assert.deepEqual(JSON.parse(a[a.indexOf('--settings') + 1]), { permissions: { deny: ['Read'] } }, 'the Read deny rule');
  assert.equal(r.raw.deny_read, true);
  assert.ok(!claudeArgs({ model: 'm', denyRead: false }).includes('--settings'));
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
  await assert.rejects(ask({ ...REQ, model: 'notjson' }, opts), (e) => e.code === 'bad_response' && /no result object/.test(e.message));
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
  // Only one plain answer counts, from the requested model (Fable review 9, F4: not another model, even if it is the only one).
  for (const [model, re] of [['turns', /took 2 turns/], ['denied', /permission denials/], ['maxturns', /subtype "error_max_turns"/],
    ['nomodel', /does not report the requested model nomodel .*\(models used: claude-a, claude-b\)/], ['nousage', /does not report the requested model/],
    ['haiku', /does not report the requested model haiku .*\(models used: claude-haiku-5-5\)/]]) {
    await assert.rejects(ask({ ...REQ, model }, opts), (e) => e.code === 'bad_response' && re.test(e.message), model);
  }
  assert.equal((await ask({ ...REQ, model: 'dated' }, opts)).modelVersion, 'dated-20261101');
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
  assert.equal(answeringModel({ 'claude-opus-5-5-20261101': {} }, 'claude-opus-5-5'), 'claude-opus-5-5-20261101');
  assert.equal(answeringModel({ 'claude-opus-5-5-20261101': {} }, 'opus'), null, 'an alias is not the name the tool reports');
  assert.equal(answeringModel({ 'claude-haiku-5-5': {} }, 'claude-opus-5-5'), null);
  assert.equal(answeringModel({ 'claude-opus-5-5-preview': {} }, 'claude-opus-5-5'), null);
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

test('claude (Fable review 9, F1): the tool own init report must show an isolated run on a verified version', async (t) => {
  const { run } = fakeClaude(t);
  const root = tempRoot(t, 'kv-claude-root-');
  const opts = { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root }) } };
  for (const [model, re] of [
    ['noinit', /gave no init report/], ['withtools', /tools loaded: Read/], ['mcp', /mcp_servers loaded: files/], ['skills', /skills loaded: pdf/],
    ['plugin', /plugins are .*helper \(C:\/plugins\/helper\).*not the verified built-in ones/], ['apikey', /key source is "ANTHROPIC_API_KEY", not none/],
    ['elsewhere', /did not run in the empty working folder/], ['otherversion', /init report says version "2\.1\.331", not 2\.1\.330/],
    ['newfield', /fields not seen when this version was verified: account_email/], ['extradir', /1 more folder\(s\) it may read/],
  ]) {
    await assert.rejects(ask({ ...REQ, model }, opts), (e) => e.code === 'bad_response' && /init report does not show an isolated run/.test(e.message) && re.test(e.message), model);
  }
  // A clean run records the tool's own report and the prefix verified for its version.
  const r = await ask(REQ, opts);
  assert.equal(r.raw.system_prefix, VERIFIED_CLI_VERSIONS['2.1.330'].systemPrefix);
  assert.equal(r.raw.cli_verified, '2026-11-23');
  assert.deepEqual(r.raw.init.tools, []);
  assert.equal(r.raw.init.api_key_source, 'none');
  // A version known to read @ files counts only with the deny rule on and shown to stop it.
  const entry = VERIFIED_CLI_VERSIONS['2.1.330'];
  for (const [versions, denyRead] of [[{ '2.1.330': { ...entry, denyBlocksMentions: null } }, true], [VERIFIED_CLI_VERSIONS, false]]) {
    await assert.rejects(ask(REQ, { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root, versions, denyRead }) } }),
      (e) => e.code === 'unsupported' && /reads @-mentioned files and the Read deny rule is not shown to stop it/.test(e.message));
  }
  // A version that does not read them needs no deny rule.
  assert.ok(await ask(REQ, { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root, denyRead: false, versions: { '2.1.330': { ...entry, expandsAtMentions: false } } }) } }));
  // A version not on the list is refused before the prompt is sent.
  let sent = false;
  const newer = async (args) => {
    if (args[0] === '--version') return { code: 0, stdout: '2.2.0 (Claude Code)' };
    sent = true;
    return { code: 0, stdout: '' };
  };
  await assert.rejects(ask(REQ, { env: {}, adapters: { claude: createClaudeAdapter({ run: newer, tmpRoot: root }) } }),
    (e) => e.code === 'unsupported' && /2\.2\.0 is not a verified version \(2\.1\.330\).*smoke-claude-judge/.test(e.message));
  assert.equal(sent, false);
  assert.ok(Object.isFrozen(VERIFIED_CLI_VERSIONS) && Object.isFrozen(VERIFIED_CLI_VERSIONS['2.1.330']));
  assert.deepEqual(readdirSync(root), []);
});

test('claude (Fable review 9, F2): a prompt that mentions a file path with @ is never sent', async (t) => {
  const root = tempRoot(t, 'kv-claude-root-');
  let ran = false;
  const never = async () => { ran = true; return { code: 0, stdout: '' }; };
  const opts = { env: {}, adapters: { claude: createClaudeAdapter({ run: never, tmpRoot: root }) } };
  // As the pack reaches the tool: JSON text, so a backslash path is doubled and a newline is "\n".
  const excerpt = (text) => `Answer in JSON. ${JSON.stringify({ excerpts: [{ text }] })}`;
  // Every form, including the re-check's bypasses (quote or apostrophe inside the run, zero-width and
  // fullwidth characters, brackets, %2e%2e, a no-break space), as plain text and as the pack's JSON.
  const forms = refusedForms();
  assert.ok(forms.length >= 25);
  for (const text of forms) {
    assert.ok(atPathMention(text), `plain: ${text}`);
    await assert.rejects(ask({ ...REQ, prompt: excerpt(text) }, opts), (e) => e.code === 'bad_request' && /@ file mention/.test(e.message), text);
  }
  assert.equal(ran, false);
  assert.deepEqual(readdirSync(root), [], 'refused before any folder is made');
  // Handles, e-mail addresses and names relative to the empty folder are fine.
  for (const text of ALLOWED_FORMS) {
    assert.equal(atPathMention(text), null, text);
    assert.equal(atPathMention(excerpt(text)), null, text);
  }
  // The smoke script's canary probe may switch the refusal off; nothing else does.
  const { run } = fakeClaude(t);
  const r = await ask({ ...REQ, prompt: excerpt('lire @~/x') }, { env: {}, adapters: { claude: createClaudeAdapter({ run, tmpRoot: root, allowAtMentions: true }) } });
  assert.equal(r.json.verdict, 'unverifiable');
});

test('findOnPath (Fable review 9, F8): on Windows only .exe and .com, never the extensionless npm shim', (t) => {
  const bin = tempRoot(t, 'kv-path-');
  writeFileSync(join(bin, 'tool'), '#!/bin/sh\n');
  assert.equal(findOnPath('tool', { PATH: bin }, 'win32'), null);
  assert.equal(findOnPath('tool', { PATH: bin }, 'linux'), join(bin, 'tool'));
  writeFileSync(join(bin, 'tool.exe'), '');
  assert.equal(findOnPath('tool', { PATH: bin }, 'win32'), join(bin, 'tool.exe'));
});

test('Claude L4: what a vote recorded is checked against the verified versions when it is read', async () => {
  const { recordProblems } = await import('../src/ai/index.js');
  const { claudeVoteRaw } = await import('./helpers.js');
  const rec = (over = {}, model = 'claude-opus-5-5', version = '2.1.330') => recordProblems('claude', { version, model, raw: claudeVoteRaw(over) }).join('; ');
  assert.equal(rec(), '');
  assert.match(rec({}, 'claude-opus-5-5', '2.1.329'), /not a verified Claude Code version/);
  assert.match(rec({ system_prefix: 'other' }), /system prefix/);
  assert.match(rec({ deny_read: undefined }), /Read deny rule/);
  // L1: the init report and the model are checked again too.
  assert.match(rec({ init: { ...claudeVoteRaw().init, tools: ['Read'] } }), /does not show tools empty/);
  assert.match(rec({ init: { ...claudeVoteRaw().init, mcp_servers: [{ name: 'x' }] } }), /mcp_servers empty/);
  assert.match(rec({ init: { ...claudeVoteRaw().init, fields: [...claudeVoteRaw().init.fields, 'account'] } }), /fields not seen/);
  assert.match(rec({ init: undefined }), /no init report recorded/);
  assert.match(rec({ model: 'claude-haiku-5-5' }), /recorded model is not the one asked for/);
  assert.equal(rec({ model: 'claude-opus-5-5-20261101' }), '', 'the requested name with a date');
});
