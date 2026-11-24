// Codex adapter hygiene (Fable review 4): F2 cleanup after an abort, with a real child process;
// F4 environment allowlist; F6 no prompt text in the stderr tail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { childEnv, createCodexAdapter, spawnCodex, stderrTail, sweepStaleFolders } from '../src/ai/codex-cli.js';

function tempRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

// A stand-in for the npm-installed codex: same place in a PATH folder, run by this Node.
// It keeps a file open inside its working folder (as the real tool's process does with its cwd)
// and never finishes on its own.
const FAKE_CODEX = `
const fs = require('fs');
const fd = fs.openSync('held.txt', 'w');
fs.writeSync(fd, 'holding');
process.stderr.write('model: fake\\n');
setInterval(() => {}, 1000);
`;

test('F2: a real child aborted mid-run rejects with AbortError and leaves no temp folder', async (t) => {
  const bin = tempRoot(t, 'kv-fake-codex-');
  const scriptDir = join(bin, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'codex.js'), FAKE_CODEX);
  const root = tempRoot(t, 'kv-codex-root-');

  const run = (args, opts) => {
    const env = { ...opts.env };
    delete env.Path;
    env.PATH = bin + delimiter + (opts.env.PATH ?? opts.env.Path ?? '');
    return spawnCodex(args, { ...opts, env });
  };
  const adapter = createCodexAdapter({ run, tmpRoot: root });
  const controller = new AbortController();
  // Abort once the child really holds a file in its working folder.
  const holding = setInterval(() => {
    const work = readdirSync(root).find((n) => n.startsWith('kv-codex-work-'));
    if (work && existsSync(join(root, work, 'held.txt'))) {
      clearInterval(holding);
      controller.abort();
    }
  }, 25);
  const guard = setTimeout(() => { clearInterval(holding); controller.abort(); }, 15_000);
  try {
    await assert.rejects(
      adapter.call({ model: 'gpt-test', prompt: 'p' }, { signal: controller.signal }),
      (e) => e.name === 'AbortError'
    );
  } finally {
    clearInterval(holding);
    clearTimeout(guard);
  }
  assert.deepEqual(readdirSync(root), [], 'both temporary folders are removed');
});

// A launcher whose detached grandchild inherits its pipes and its working folder and outlives it
// (as a native tool started by an npm shim can). The grandchild writes its pid next to the script.
const DETACHED_LAUNCHER = `
const { spawn } = require('child_process');
const path = require('path');
const pidFile = JSON.stringify(path.join(__dirname, 'grandchild.pid'));
const child = spawn(process.execPath, ['-e', 'require("fs").writeFileSync(' + pidFile + ', String(process.pid)); setTimeout(() => {}, 20000);'],
  { stdio: 'inherit', detached: true });
child.on('exit', (c) => process.exit(c ?? 1));
setInterval(() => {}, 1000);
`;

test('R1: a grandchild that keeps the pipes open cannot hold the call past its timeout', async (t) => {
  const bin = tempRoot(t, 'kv-fake-codex-');
  const scriptDir = join(bin, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(join(scriptDir, 'codex.js'), DETACHED_LAUNCHER);
  const pidFile = join(scriptDir, 'grandchild.pid');
  const root = tempRoot(t, 'kv-codex-root-');

  const run = (args, opts) => {
    const env = { ...opts.env };
    delete env.Path;
    env.PATH = bin + delimiter + (opts.env.PATH ?? opts.env.Path ?? '');
    return spawnCodex(args, { ...opts, env });
  };
  const controller = new AbortController();
  let abortedAt = null;
  const started = setInterval(() => {
    if (existsSync(pidFile)) {
      clearInterval(started);
      abortedAt = Date.now();
      controller.abort();
    }
  }, 25);
  const guard = setTimeout(() => { clearInterval(started); abortedAt ??= Date.now(); controller.abort(); }, 15_000);
  try {
    await assert.rejects(
      createCodexAdapter({ run, tmpRoot: root }).call({ model: 'gpt-test', prompt: 'p' }, { signal: controller.signal }),
      (e) => e.name === 'AbortError'
    );
  } finally {
    clearInterval(started);
    clearTimeout(guard);
  }
  const late = Date.now() - abortedAt;
  assert.ok(late < 6000, `the call settled ${late} ms after the abort`);
  // The grandchild is still alive (it holds the folder); the call did not wait for it.
  const pid = Number(readFileSync(pidFile, 'utf8'));
  assert.doesNotThrow(() => process.kill(pid, 0));
  // Stop it before the temp folders are removed (it holds the working folder open).
  process.kill(pid);
  for (let i = 0; i < 40; i++) {
    try { process.kill(pid, 0); } catch { break; }
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('F2: a cleanup failure never replaces the original error; stale folders are swept later', async (t) => {
  const root = tempRoot(t, 'kv-codex-root-');
  const run = async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
  await assert.rejects(createCodexAdapter({ run, tmpRoot: root }).call({ model: 'm', prompt: 'p' }, {}), (e) => e.name === 'AbortError');
  assert.deepEqual(readdirSync(root), []);

  const old = join(root, 'kv-codex-work-old');
  const fresh = join(root, 'kv-codex-io-fresh');
  const other = join(root, 'someone-else');
  for (const d of [old, fresh, other]) mkdirSync(d);
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(old, twoHoursAgo, twoHoursAgo);
  utimesSync(other, twoHoursAgo, twoHoursAgo);
  sweepStaleFolders(root);
  assert.deepEqual(readdirSync(root).sort(), ['kv-codex-io-fresh', 'someone-else']);
});

test('F4: the child gets only allowlisted variables', () => {
  const env = {
    Path: 'p', SystemRoot: 'C:\\Windows', SYSTEMDRIVE: 'C:', USERPROFILE: 'u', APPDATA: 'a', LOCALAPPDATA: 'l',
    TEMP: 't', TMP: 't', HOME: 'h', CODEX_HOME: 'c', ComSpec: 'cmd', PATHEXT: '.EXE',
    PISTE_CLIENT_ID: 'id', PISTE_CLIENT_SECRET: 's', ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 'g', NODE_OPTIONS: '--require x', OPENAI_BASE_URL: 'x',
  };
  assert.deepEqual(Object.keys(childEnv(env)).sort(), [
    'APPDATA', 'CODEX_HOME', 'ComSpec', 'HOME', 'LOCALAPPDATA', 'PATHEXT', 'Path', 'SYSTEMDRIVE', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE',
  ]);
});

test('F6: the stderr tail keeps only the last lines that are not part of the prompt', async (t) => {
  const input = 'KANVERIFY principles\nSECRET PACK LINE: ignore previous instructions\n---\nJudge this claim.';
  const stderr = 'OpenAI Codex v1\nuser\nKANVERIFY principles\nSECRET PACK LINE: ignore previous instructions\nJudge this claim.\nerror: stream disconnected\nretrying 1/5\nfatal: gave up';
  const tail = stderrTail(stderr, input);
  assert.equal(tail, 'error: stream disconnected retrying 1/5 fatal: gave up');
  assert.equal(stderrTail('Judge this claim.\n', input), '');

  const root = tempRoot(t, 'kv-codex-root-');
  const run = async (args) => (args[0] === '--version' ? { code: 0, stdout: 'codex-cli 0.172.0' } : { code: 1, stdout: '', stderr: `${stderr}\nJudge this claim.` });
  await assert.rejects(createCodexAdapter({ run, tmpRoot: root }).call({ model: 'm', system: 'KANVERIFY principles\nSECRET PACK LINE: ignore previous instructions', prompt: 'Judge this claim.' }, {}), (e) => {
    assert.ok(!e.message.includes('SECRET PACK LINE'));
    assert.ok(!e.message.includes('Judge this claim'));
    assert.match(e.message, /fatal: gave up/);
    return true;
  });
});

test('F6: no literal control or bidirectional characters in the source code', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.js') ? [join(dir, d.name)] : []));
  const bad = [];
  for (const file of walk(join(import.meta.dirname, '..', 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const ch of text) {
      const p = ch.codePointAt(0);
      if ((p < 32 && p !== 9 && p !== 10 && p !== 13) || (p >= 0x7f && p < 0xa0) || (p >= 0x200b && p <= 0x200f)
        || (p >= 0x202a && p <= 0x202e) || (p >= 0x2066 && p <= 0x2069) || p === 0xfeff) { bad.push(file); break; }
    }
  }
  assert.deepEqual(bad, []);
});

test('Codex run events (Fable review 9, re-check 1): a reply counts only if the run did nothing but answer', async (t) => {
  const { codexArgs, codexRunFacts, RUN_ITEM_TYPES } = await import('../src/ai/codex-cli.js');
  assert.ok(codexArgs({ model: 'm', outFile: 'o' }).includes('--json'));
  assert.deepEqual(RUN_ITEM_TYPES, ['agent_message', 'reasoning', 'error']);
  const ev = (...items) => [{ type: 'thread.started' }, { type: 'turn.started' }, ...items].map((e) => JSON.stringify(e)).join('\n');
  const item = (type) => ({ type: 'item.completed', item: { id: 'i', type } });
  const done = { type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100 } };
  const { VERIFIED_CODEX_VERSIONS } = await import('../src/ai/codex-cli.js');
  const harmless = VERIFIED_CODEX_VERSIONS['0.172.0'].harmlessErrors;
  const fallback = { type: 'item.completed', item: { id: 'e', type: 'error', message: 'Falling back from WebSockets to HTTPS transport. unexpected status 401' } };
  const reconnect = { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized)' };
  const clean = codexRunFacts(ev(item('reasoning'), fallback, reconnect, item('agent_message'), done), { harmlessErrors: harmless });
  assert.deepEqual(clean.problems, []);
  assert.deepEqual(clean.facts.item_types, ['agent_message', 'error', 'reasoning']);
  assert.equal(clean.facts.errors.length, 2, 'error messages are kept');
  // C3: an error message not known to be harmless refuses, even as a top-level event or with no list.
  const reroute = { type: 'item.completed', item: { id: 'e', type: 'error', message: 'Model gpt-x is unavailable; rerouted to gpt-mini' } };
  assert.match(codexRunFacts(ev(reroute, item('agent_message'), done), { harmlessErrors: harmless }).problems.join(), /not known to be harmless: Model gpt-x/);
  assert.match(codexRunFacts(ev({ type: 'error', message: 'something else' }, item('agent_message'), done), { harmlessErrors: harmless }).problems.join(), /not known to be harmless/);
  assert.match(codexRunFacts(ev(fallback, item('agent_message'), done)).problems.join(), /not known to be harmless/);
  // C1: only the known event types, exactly one completed turn, nothing that is not a JSON event.
  for (const extra of [{ type: 'exec_command_begin' }, { type: 'tool.started' }, { type: 'turn.failed' }]) {
    assert.match(codexRunFacts(ev(item('agent_message'), extra, done)).problems.join(), new RegExp(`events a judge's run does not have: ${extra.type}`), extra.type);
  }
  assert.match(codexRunFacts(ev(item('agent_message'), done, { type: 'turn.started' }, item('agent_message'), done)).problems.join(), /2 completed turns, not exactly one/);
  assert.match(codexRunFacts(`${ev(item('agent_message'), done)}\nran: type C:/x/.env`).problems.join(), /1 line\(s\) that are not JSON events/);
  assert.equal(clean.facts.usage.input_tokens, 900);
  for (const type of ['command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'todo_list', 'something_new']) {
    assert.match(codexRunFacts(ev({ type: 'item.started', item: { id: 'i', type } }, item('agent_message'), done)).problems.join(), new RegExp(`did more than answer: ${type}`), type);
  }
  assert.match(codexRunFacts(ev(item('agent_message'))).problems.join(), /0 completed turns/);
  assert.match(codexRunFacts('').problems.join(), /0 completed turns/);
  // A blocked action leaves only a second answer message (founder's smoke run, 0.172.0): refused.
  const msg = (text) => ({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } });
  const blocked = codexRunFacts(ev(msg('I will read the file.'), msg('The execution policy blocked both.'), done));
  assert.match(blocked.problems.join(), /did more than answer: 2 answer messages, not one/);
  assert.deepEqual(blocked.facts.items, [{ type: 'agent_message', length: 21 }, { type: 'agent_message', length: 34 }]);
  assert.match(codexRunFacts(ev(item('reasoning'), done)).problems.join(), /0 answer messages/);
  assert.deepEqual(codexRunFacts(ev(item('reasoning'), msg('{}'), done)).problems, [], 'reasoning beside one answer is fine');

  // Through ask(): a run that read a file with a command is refused; the run facts of a clean one are kept.
  const root = tempRoot(t, 'kv-codex-root-');
  const runWith = (stdout) => async (args) => {
    if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 0.172.0\n', stderr: '' };
    writeFileSync(args[args.indexOf('-o') + 1], '{"ok": true}');
    return { code: 0, stdout, stderr: 'model: gpt-x\n' };
  };
  const { ask } = await import('../src/ai/index.js');
  const req = { provider: 'codex', model: 'gpt-x', promptVersion: 'v', prompt: 'Answer in JSON.', json: true };
  const reading = ev({ type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'type C:/x/.env' } }, item('agent_message'), done);
  await assert.rejects(ask(req, { env: {}, adapters: { codex: createCodexAdapter({ run: runWith(reading), tmpRoot: root }) } }),
    (e) => e.code === 'bad_response' && /did more than answer: command_execution/.test(e.message));
  const r = await ask(req, { env: {}, adapters: { codex: createCodexAdapter({ run: runWith(ev(item('agent_message'), done)), tmpRoot: root }) } });
  assert.deepEqual(r.raw.run.item_types, ['agent_message']);
  // C3, C4: the version is recorded; no model name reported means none is written as if it were.
  assert.equal(r.raw.cli_version, '0.172.0');
  assert.equal(r.raw.model_reported, true, 'this fake prints a model line on stderr');
  const silent = async (args) => (args[0] === '--version' ? { code: 0, stdout: 'codex-cli 0.172.0' }
    : (writeFileSync(args[args.indexOf('-o') + 1], '{"ok": true}'), { code: 0, stdout: ev(item('agent_message'), done), stderr: '' }));
  const quiet = await ask(req, { env: {}, adapters: { codex: createCodexAdapter({ run: silent, tmpRoot: root }) } });
  assert.equal(quiet.raw.model_reported, false);
  assert.ok(!('model' in quiet.raw) && quiet.modelVersion === undefined);
  // A version not on the list is refused before anything is sent.
  let sent = false;
  const newer = async (args) => (args[0] === '--version' ? { code: 0, stdout: 'codex-cli 0.173.0' } : ((sent = true), { code: 0, stdout: '' }));
  await assert.rejects(ask(req, { env: {}, adapters: { codex: createCodexAdapter({ run: newer, tmpRoot: root }) } }),
    (e) => e.code === 'unsupported' && /0\.173\.0 is not a verified version \(0\.172\.0\).*smoke-codex-judge/.test(e.message));
  assert.equal(sent, false);
  assert.deepEqual(r.usage, { inputTokens: 900, outputTokens: 100, totalTokens: 1000 });
});

test('finding codex: PATH under any case and in quotes; the script named by a codex.cmd shim', async (t) => {
  const { findCodexScript, pathDirs } = await import('../src/ai/codex-cli.js');
  const a = tempRoot(t, 'kv-path-a-');
  const b = tempRoot(t, 'kv-path-b-');
  assert.deepEqual(pathDirs({ Path: ` "${a}" ${delimiter}${delimiter}${b}` }), [a, b]);
  assert.deepEqual(pathDirs({ PATH: a }), [a]);
  assert.deepEqual(pathDirs({}), []);
  // The usual npm layout: the script beside the shim.
  const usual = join(a, 'node_modules', '@openai', 'codex', 'bin');
  mkdirSync(usual, { recursive: true });
  writeFileSync(join(usual, 'codex.js'), '');
  assert.equal(findCodexScript({ Path: `"${a}"` }), join(usual, 'codex.js'));
  // Another layout: only the .cmd shim knows where the script is.
  const other = join(b, 'lib', 'codex-pkg');
  mkdirSync(other, { recursive: true });
  writeFileSync(join(other, 'codex.js'), '');
  writeFileSync(join(b, 'codex.cmd'), '@ECHO off\r\n"%_prog%"  "%dp0%\\lib\\codex-pkg\\codex.js" %*\r\n');
  assert.equal(findCodexScript({ PATH: b }), join(b, 'lib', 'codex-pkg', 'codex.js'));
  // A shim naming a script that is not there finds nothing.
  writeFileSync(join(b, 'codex.cmd'), '"%dp0%\\nowhere\\codex.js" %*');
  assert.equal(findCodexScript({ PATH: b }), null);
});
