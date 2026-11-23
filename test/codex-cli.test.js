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
  const run = async () => ({ code: 1, stdout: '', stderr: `${stderr}\nJudge this claim.` });
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
