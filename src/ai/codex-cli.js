// OpenAI through the Codex command-line tool, paid by the founder's ChatGPT subscription instead
// of an API key (docs/decisions/0010-subscription-vs-api.md, founder's change). It sits in the
// AI interface layer like the HTTP adapters, so it gets every ask() guarantee: a prompt version
// on every call, a timeout, the JSON check and retry, and no business code talking to a vendor.
//
// How one call runs (first verified with codex-cli 0.171.0 on 2026-11-22; the judge runs only on the
// versions in VERIFIED_CODEX_VERSIONS, today 0.172.0):
//   codex exec --skip-git-repo-check --ephemeral -s read-only --ignore-user-config --ignore-rules
//     -c web_search=disabled -c model_reasoning_effort=<effort> --disable browser_use
//     --disable computer_use --disable apps --json -m <model> [--output-schema <file>] -o <file> -
// started in a new EMPTY folder, with the system and user prompt on stdin. Codex is an agent
// with its own instructions and tools; the empty folder, the read-only sandbox and the disabled
// tools keep it to reading what it was given. Its read-only sandbox can still read other files on
// this machine (docs/log/2026-11-22-pipeline-0010-output.md), so an injected line in a pack could
// ask it to (Fable review 9, re-check 1). --json makes it print every step as an event on stdout
// (on 0.172.0, founder's smoke runs of 2026-11-24: thread.started, turn.started, item.*, turn.completed); a reply is
// refused unless every event is of RUN_EVENT_TYPES, exactly one turn completed, every item is a
// message, reasoning or an error notice (RUN_ITEM_TYPES), and every error is a known-harmless one
// for the version: a command run, a file change, a tool or a web search voids it. The counts and
// error messages are kept with the reply (raw.run). `codex --version` must be in
// VERIFIED_CODEX_VERSIONS before anything is sent, and is recorded.
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
    '--disable', 'browser_use', '--disable', 'computer_use', '--disable', 'apps', '--json',
    '-m', model,
    ...(schemaFile ? ['--output-schema', schemaFile] : []),
    '-o', outFile, '-',
  ];
}

/**
 * The Codex versions the judge may run on (same ruler as the Claude judge, claude-cli.js):
 *   harmlessErrors  error messages a run may report and still count (transport notices); any other
 *                   error message refuses the reply
 *   actionsBlocked       its own execution policy blocked a command and a file read asked for in the
 *                        prompt (the smoke script's positive control)
 *   inputOverheadTokens  input tokens of the smoke control (Codex's own instructions plus a tiny
 *                        prompt); a run may read at most this + our input's characters / 2.5 +
 *                        INPUT_MARGIN_TOKENS, because a blocked action sends the whole context again
 *                        (about twice the input) even when it leaves only one answer message
 * 0.172.0: installed by the founder on 2026-11-24; its smoke runs (scripts/smoke-codex-judge.mjs) the
 * same day: control (17,085 input tokens), @ mention and plain "copy the contents" probes answered
 * without tools; the positive control was blocked by the execution policy, sent the context again
 * (34,514) and left a second answer message; --json reports no model name. The two notices are what 0.171.0 printed when its WebSocket was
 * refused (2026-11-24, logged out). Adding a version: run the smoke script, add it only if every
 * check passes.
 */
export const VERIFIED_CODEX_VERSIONS = Object.freeze({
  '0.172.0': Object.freeze({
    verified: '2026-11-24',
    harmlessErrors: Object.freeze([/^Reconnecting\.\.\. \d+\/\d+ \(/, /^Falling back from WebSockets to HTTPS transport\./]),
    actionsBlocked: true,
    inputOverheadTokens: 17_085,
  }),
});
const CODEX_VERSION_RE = /(\d+\.\d+\.\d+)/;
// Room above the estimate before a run counts as having read its context twice (Fable review 9, re-check 3, D1).
export const INPUT_MARGIN_TOKENS = 3000;
const CHARS_PER_TOKEN_LOW = 2.5;

/** The most input tokens one answer to `input` can take on a version with a measured overhead, or null. */
export function inputLimit(expected, input) {
  if (!Number.isInteger(expected?.inputOverheadTokens)) return null;
  return expected.inputOverheadTokens + Math.ceil(String(input ?? '').length / CHARS_PER_TOKEN_LOW) + INPUT_MARGIN_TOKENS;
}

// The only event types a judge's run may print with --json, and the only kinds of item in it: its
// answer, its reasoning, and error notices. Anything else (another event type, a command run, a
// file change, a tool, a web search, a todo list, or a kind a new version adds) refuses the reply.
export const RUN_EVENT_TYPES = Object.freeze(['thread.started', 'turn.started', 'turn.completed', 'item.started', 'item.updated', 'item.completed', 'error']);
export const RUN_ITEM_TYPES = Object.freeze(['agent_message', 'reasoning', 'error']);
const MAX_ERRORS_KEPT = 20;

/**
 * What the --json events of one run say: { problems, facts }. problems is empty only when every
 * line is a JSON event of RUN_EVENT_TYPES, exactly one turn completed, every item is of
 * RUN_ITEM_TYPES, exactly one answer message completed, and every error message (error events and
 * error items) matches `harmlessErrors`. facts keeps the event counts, item types, each completed
 * item's type and text length, usage and the error messages (cut to 300 characters).
 */
export function codexRunFacts(stdout, { harmlessErrors = [] } = {}) {
  const events = {};
  const itemTypes = new Set();
  const errors = [];
  const items = [];
  let usage = null;
  let notJson = 0;
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { notJson++; continue; }
    const type = typeof e?.type === 'string' ? e.type : '?';
    events[type] = (events[type] ?? 0) + 1;
    if (type.startsWith('item.')) {
      const kind = typeof e?.item?.type === 'string' ? e.item.type : '?';
      itemTypes.add(kind);
      if (kind === 'error') errors.push(String(e.item.message ?? ''));
      if (type === 'item.completed') items.push({ type: kind, length: typeof e.item?.text === 'string' ? e.item.text.length : null });
    }
    if (type === 'error') errors.push(String(e.message ?? ''));
    if (type === 'turn.completed' && e.usage && typeof e.usage === 'object') usage = e.usage;
  }
  const problems = [];
  if (notJson > 0) problems.push(`the run printed ${notJson} line(s) that are not JSON events`);
  const otherEvents = Object.keys(events).filter((t) => !RUN_EVENT_TYPES.includes(t));
  if (otherEvents.length > 0) problems.push(`the run reports events a judge's run does not have: ${otherEvents.sort().join(', ')}`);
  if (events['turn.completed'] !== 1) problems.push(`the run reports ${events['turn.completed'] ?? 0} completed turns, not exactly one`);
  const otherItems = [...itemTypes].filter((t) => !RUN_ITEM_TYPES.includes(t));
  if (otherItems.length > 0) problems.push(`the run did more than answer: ${otherItems.sort().join(', ')}`);
  // An action the model tried and Codex's execution policy blocked leaves no command item: the
  // context is sent again and a second answer message appears (founder's smoke run, 0.172.0,
  // 2026-11-24). So exactly one completed answer message is required.
  const answers = items.filter((i) => i.type === 'agent_message').length;
  if (answers !== 1) problems.push(`the run did more than answer: ${answers} answer messages, not one (a blocked action leaves a second)`);
  const unknownErrors = errors.filter((m) => !harmlessErrors.some((re) => re.test(m)));
  if (unknownErrors.length > 0) problems.push(`the run reports ${unknownErrors.length} error(s) not known to be harmless: ${unknownErrors[0].slice(0, 200)}`);
  return {
    problems,
    facts: { events, item_types: [...itemTypes].sort(), items, usage, errors: errors.slice(0, MAX_ERRORS_KEPT).map((m) => m.slice(0, 300)) },
  };
}

/** Model and token count from the header and footer Codex prints on stderr. */
export function parseCodexStderr(stderr) {
  const model = /^model:\s*(\S+)\s*$/m.exec(stderr)?.[1] ?? null;
  const tokens = /tokens used\s*\r?\n\s*([\d,]+)/i.exec(stderr)?.[1];
  return { model, totalTokens: tokens ? Number(tokens.replace(/,/g, '')) : null };
}

// npm installs codex as a shim around a Node script. Running that script with this Node avoids a
// shell (no quoting of arguments by cmd.exe on Windows).
// If the script is not beside the shim (another npm layout), the Windows .cmd shim names it:
// "%dp0%\node_modules\@openai\codex\bin\codex.js".
export function findCodexScript(env = process.env) {
  for (const dir of pathDirs(env)) {
    const script = join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (existsSync(script)) return script;
    const shim = join(dir, 'codex.cmd');
    if (!existsSync(shim)) continue;
    let text = '';
    try { text = readFileSync(shim, 'utf8'); } catch { continue; }
    const named = /%~?dp0%?\\([^"%\r\n]+?\.[cm]?js)"/i.exec(text)?.[1];
    if (named && existsSync(join(dir, named))) return join(dir, named);
  }
  return null;
}

/**
 * The folders on PATH: the variable found whatever the case of its name (Windows has "Path"),
 * entries trimmed and taken out of quotes, empty ones dropped.
 */
export function pathDirs(env = process.env) {
  const key = Object.keys(env ?? {}).find((k) => k.toUpperCase() === 'PATH');
  return String(key ? env[key] : '').split(delimiter).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
}

/**
 * A program on PATH that spawn can start without a shell (on Windows: name.exe or name.com only;
 * the extensionless file npm puts beside them is a shell script Node cannot start, Fable review 9
 * F8), or null. Used to tell "the tool is not installed" before any vote is moved aside.
 */
export function findOnPath(name, env = process.env, platform = process.platform) {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.com`] : [name];
  for (const dir of pathDirs(env)) {
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
export function createCodexAdapter({ run = spawnCodex, effort = REASONING_EFFORT, tmpRoot = tmpdir(), missingTool, versions = VERIFIED_CODEX_VERSIONS } = {}) {
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
        const env = childEnv(process.env);
        const v = await run(['--version'], { cwd: work, env, input: '', signal: ctx.signal });
        const cliVersion = v.code === 0 ? CODEX_VERSION_RE.exec(String(v.stdout ?? ''))?.[1] : undefined;
        if (!cliVersion) throw new AiError('bad_response', 'codex: codex --version gave no version', { provider: 'codex' });
        const expected = Object.hasOwn(versions, cliVersion) ? versions[cliVersion] : null;
        if (!expected) {
          throw new AiError('unsupported', `codex: Codex ${cliVersion} is not a verified version (${Object.keys(versions).join(', ') || 'none'}); run node scripts/smoke-codex-judge.mjs to verify it`, { provider: 'codex' });
        }
        const input = req.system ? `${req.system}\n\n---\n\n${req.prompt}` : req.prompt;
        const result = await run(args, { cwd: work, env, input, signal: ctx.signal });
        const info = parseCodexStderr(result.stderr ?? '');
        if (result.code !== 0) {
          const tail = stderrTail(result.stderr, input);
          throw new AiError('bad_response', `codex: exited with code ${result.code}${tail ? `: ${tail}` : ''}`, { provider: 'codex' });
        }
        const run_ = codexRunFacts(result.stdout, { harmlessErrors: expected.harmlessErrors ?? [] });
        if (run_.problems.length > 0) throw new AiError('bad_response', `codex: ${run_.problems.join('; ')}`, { provider: 'codex' });
        const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
        const u = run_.facts.usage ?? {};
        const num = (v) => (Number.isInteger(v) ? v : null);
        const inputTokens = num(u.input_tokens);
        const outputTokens = num(u.output_tokens);
        const total = info.totalTokens ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
        // D1: a blocked action with no second message still reads the context twice.
        const limit = inputLimit(expected, input);
        if (limit !== null && inputTokens === null) throw new AiError('bad_response', 'codex: the run reports no input tokens, so a second reading of the context cannot be ruled out', { provider: 'codex' });
        if (limit !== null && inputTokens > limit) {
          throw new AiError('bad_response', `codex: the run did more than answer: it read ${inputTokens} input tokens, more than the ${limit} one answer to this prompt can take (a blocked action sends the context again)`, { provider: 'codex' });
        }
        return {
          text,
          ...(info.model && { modelVersion: info.model }),
          usage: { inputTokens, outputTokens, totalTokens: total },
          // model_reported: whether the tool named the model that answered. With --json, 0.172.0 does
          // not; then the vote's model is only the one asked for (never copied here as if reported).
          raw: {
            tool: 'codex exec', cli_version: cliVersion, cli_verified: expected.verified ?? null, reasoning_effort: effort,
            model_reported: Boolean(info.model), ...(info.model && { model: info.model }), total_tokens: total, input_limit: limit, run: run_.facts,
          },
        };
      } finally {
        removeFolder(work);
        removeFolder(io);
      }
    },
  };
}

export default createCodexAdapter();
