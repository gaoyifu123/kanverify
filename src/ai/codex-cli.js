// OpenAI through the Codex command-line tool, paid by the founder's ChatGPT subscription instead
// of an API key (docs/decisions/0010-subscription-vs-api.md, founder's change). It sits in the
// AI interface layer like the HTTP adapters, so it gets every ask() guarantee: a prompt version
// on every call, a timeout, the JSON check and retry, and no business code talking to a vendor.
//
// How one call runs (verified with codex-cli 0.171.0 on 2026-11-22):
//   codex exec --skip-git-repo-check --ephemeral -s read-only --ignore-user-config --ignore-rules
//     -c web_search=disabled -c model_reasoning_effort=<effort> --disable browser_use
//     --disable computer_use --disable apps -m <model> [--output-schema <file>] -o <file> -
// started in a new EMPTY folder, with the system and user prompt on stdin. Codex is an agent
// with its own instructions and tools; the empty folder, the read-only sandbox and the disabled
// tools keep it to reading what it was given. Its read-only sandbox can still read other files on
// this machine; that is a known limit (docs/log/2026-11-22-pipeline-0010-output.md).
//
// No secrets reach it through its environment: it gets an allowlist of variables only (childEnv).
// That also stops Codex from billing an API key it might find there instead of the subscription.
// Its replies are checked for secrets by ask() like every other provider's.

import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AiError } from './errors.js';

const MODEL_RE = /^[A-Za-z0-9._-]+$/;
const EFFORTS = ['low', 'medium', 'high'];
export const REASONING_EFFORT = 'high';
const STDERR_TAIL = 300;
const STDERR_LINES = 3;
const WORK_PREFIX = 'kv-codex-work-';
const IO_PREFIX = 'kv-codex-io-';
const STALE_MS = 60 * 60 * 1000;
// Bounds on how long a call may outlive its timeout (R1): pipes after exit, abort without exit,
// and the retried folder removal (linear backoff: 100 + 200 + ... + 600 ms).
const CLOSE_WAIT_MS = 1000;
const ABORT_CAP_MS = 3000;
const RM_RETRIES = 6;
const RM_RETRY_DELAY_MS = 100;
// The only variables Codex gets: what Windows and Node need to start, where its own login lives,
// and temp folders. Everything else (keys in .env, PISTE_CLIENT_ID, tokens of other tools) stays out.
const ENV_ALLOWLIST = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'CODEX_HOME', 'COMSPEC', 'PATHEXT']);

/** The environment for the child: only the allowlisted variables (names compared ignoring case). */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => ENV_ALLOWLIST.has(name.toUpperCase())));
}

/** Arguments of `codex exec`; the prompt itself goes on stdin ("-"). */
export function codexArgs({ model, effort = REASONING_EFFORT, schemaFile, outFile }) {
  if (!MODEL_RE.test(model)) throw new AiError('bad_request', 'codex: model name has characters that are not allowed', { provider: 'codex' });
  if (!EFFORTS.includes(effort)) throw new AiError('bad_request', `codex: reasoning effort must be one of ${EFFORTS.join(', ')}`, { provider: 'codex' });
  return [
    'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--ignore-user-config', '--ignore-rules',
    '-c', 'web_search=disabled', '-c', `model_reasoning_effort=${effort}`,
    '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'apps',
    '-m', model,
    ...(schemaFile ? ['--output-schema', schemaFile] : []),
    '-o', outFile, '-',
  ];
}

/** Model and token count from the header and footer Codex prints on stderr. */
export function parseCodexStderr(stderr) {
  const model = /^model:\s*(\S+)\s*$/m.exec(stderr)?.[1] ?? null;
  const tokens = /tokens used\s*\r?\n\s*([\d,]+)/i.exec(stderr)?.[1];
  return { model, totalTokens: tokens ? Number(tokens.replace(/,/g, '')) : null };
}

// npm installs codex as a shim around a Node script. Running that script with this Node avoids a
// shell (no quoting of arguments by cmd.exe on Windows).
function findCodexScript(env) {
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) return script;
  }
  return null;
}

/**
 * A program on PATH that spawn can start without a shell (on Windows: name, name.exe or name.com),
 * or null. Used to tell "the tool is not installed" before any vote is moved aside.
 */
export function findOnPath(name, env = process.env) {
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.com`, name] : [name];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const at = join(dir, n);
      try {
        if (lstatSync(at).isFile()) return at;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Why the real codex cannot be started from this environment, or null. */
export function codexMissing(env = process.env) {
  return findCodexScript(env) || findOnPath('codex', env) ? null : 'codex: the command-line tool was not found (not installed, or not on PATH)';
}

/**
 * Runs the real codex. Resolves { code, stdout, stderr }; rejects with AbortError on timeout.
 *
 * When it settles (Fable review 4, F2 and R1): after the launcher has exited ('exit'), waiting
 * at most CLOSE_WAIT_MS more for its output pipes to close. 'close' alone is not enough: a
 * descendant that outlives the launcher keeps the pipes open and would hold the call long past
 * its timeout. After an abort the wait is capped at ABORT_CAP_MS even if no 'exit' comes. The
 * pipes are then destroyed so nothing of the child keeps this process waiting.
 */
export function spawnCodex(args, { cwd, env, input, signal }) {
  const script = findCodexScript(env);
  const [command, argv] = script ? [process.execPath, [script, ...args]] : ['codex', args];
  return spawnTool(command, argv, { cwd, env, input, signal });
}

/**
 * Runs a command-line tool without a shell and settles as spawnCodex describes. Shared with the
 * Claude command-line adapter (claude-cli.js), so both judges have the same timeout behaviour.
 */
export function spawnTool(command, argv, { cwd, env, input, signal }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let failure = null;
    let exitCode = null;
    let settled = false;
    const timers = [];
    const finish = () => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      if (failure) reject(failure);
      else resolvePromise({ code: exitCode, stdout, stderr });
    };
    const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => {
      failure ??= error;
      if (child.pid === undefined) finish(); // never started: nothing to wait for
    });
    child.on('exit', (code) => {
      exitCode = code;
      timers.push(setTimeout(finish, CLOSE_WAIT_MS));
    });
    child.on('close', (code) => {
      exitCode ??= code;
      finish();
    });
    signal?.addEventListener('abort', () => {
      timers.push(setTimeout(() => { failure ??= abortError(); finish(); }, ABORT_CAP_MS));
    }, { once: true });
    child.stdin.on('error', () => {}); // the child may exit before reading everything
    child.stdin.end(input);
  });
}

/**
 * Remove a temporary folder, retrying while Windows still holds a handle on it. Never throws:
 * a folder that cannot be removed now is left to sweepStaleFolders on a later call, and the
 * caller's own error (an AbortError, say) is never replaced by a cleanup error.
 */
export function removeFolder(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
  } catch {
    // Left for the next sweep.
  }
}

/** Remove our own temporary folders (named with `prefixes`) left over from earlier calls (older than an hour). */
export function sweepStaleFolders(root, now = Date.now(), prefixes = [WORK_PREFIX, IO_PREFIX]) {
  let names;
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    const dir = join(root, name);
    try {
      const stat = lstatSync(dir);
      if (stat.isDirectory() && now - stat.mtimeMs > STALE_MS) removeFolder(dir);
    } catch {
      // Gone already.
    }
  }
}

/**
 * The last lines of Codex's stderr for an error message, without anything from the prompt:
 * Codex echoes the prompt near the top, so a line that also appears in the input is dropped.
 */
export function stderrTail(stderr, input) {
  const kept = [];
  for (const line of String(stderr ?? '').split(/\r?\n/).reverse()) {
    const text = line.replace(/\s+/g, ' ').trim();
    if (!text || (input && input.includes(text))) continue;
    kept.unshift(text);
    if (kept.length >= STDERR_LINES) break;
  }
  return kept.join(' ').slice(-STDERR_TAIL);
}

/**
 * The adapter. `run` replaces spawnCodex in tests. `tmpRoot` is where the two temporary folders
 * are made (tests give their own, so they can check nothing is left behind).
 * The request's system prompt and prompt are sent together on stdin: codex exec has one input.
 */
export function createCodexAdapter({ run = spawnCodex, effort = REASONING_EFFORT, tmpRoot = tmpdir(), missingTool } = {}) {
  return {
    name: 'codex',
    keyVar: null, // the ChatGPT login of codex itself; no key in .env
    // Asked before a call (ask's unavailable()); a test's own `run` needs no installed tool.
    missingTool: missingTool ?? (run === spawnCodex ? codexMissing : () => null),
    documentTypes: [],
    jsonSchema: true,
    async call(req, ctx) {
      sweepStaleFolders(tmpRoot);
      const work = mkdtempSync(join(tmpRoot, WORK_PREFIX));
      const io = mkdtempSync(join(tmpRoot, IO_PREFIX));
      try {
        const outFile = join(io, 'answer.txt');
        let schemaFile;
        if (req.schema) {
          schemaFile = join(io, 'schema.json');
          writeFileSync(schemaFile, JSON.stringify(req.schema));
        }
        const args = codexArgs({ model: req.model, effort, schemaFile, outFile });
        const input = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
        const result = await run(args, { cwd: work, env: childEnv(process.env), input, signal: ctx.signal });
        const info = parseCodexStderr(result.stderr ?? '');
        if (result.code !== 0) {
          const tail = stderrTail(result.stderr, input);
          throw new AiError('bad_response', `codex: exited with code ${result.code}${tail ? `: ${tail}` : ''}`, { provider: 'codex' });
        }
        const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
        return {
          text,
          ...(info.model && { modelVersion: info.model }),
          usage: { inputTokens: null, outputTokens: null, totalTokens: info.totalTokens },
          raw: { tool: 'codex exec', reasoning_effort: effort, model: info.model, total_tokens: info.totalTokens },
        };
      } finally {
        removeFolder(work);
        removeFolder(io);
      }
    },
  };
}

export default createCodexAdapter();
