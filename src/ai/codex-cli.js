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
// No secrets reach it: every variable whose name looks like a key, secret, token or password is
// removed from its environment. That also stops Codex from billing an API key it might find
// there instead of the subscription.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { AiError } from './errors.js';

const MODEL_RE = /^[A-Za-z0-9._-]+$/;
const EFFORTS = ['low', 'medium', 'high'];
export const REASONING_EFFORT = 'high';
const SECRET_NAME_RE = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/i;
const STDERR_TAIL = 300;

/** The environment for the child: the caller's, minus anything that looks like a secret. */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_NAME_RE.test(name)));
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

/** Runs the real codex. Resolves { code, stdout, stderr }; rejects with AbortError on timeout. */
export function spawnCodex(args, { cwd, env, input, signal }) {
  const script = findCodexScript(env);
  const [command, argv] = script ? [process.execPath, [script, ...args]] : ['codex', args];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argv, { cwd, env, signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code, stdout, stderr }));
    child.stdin.on('error', () => {}); // the child may exit before reading everything
    child.stdin.end(input);
  });
}

/**
 * The adapter. `run` replaces spawnCodex in tests (no real codex is ever started by a test).
 * The request's system prompt and prompt are sent together on stdin: codex exec has one input.
 */
export function createCodexAdapter({ run = spawnCodex, effort = REASONING_EFFORT } = {}) {
  return {
    name: 'codex',
    keyVar: null, // the ChatGPT login of codex itself; no key in .env
    documentTypes: [],
    jsonSchema: true,
    async call(req, ctx) {
      const work = mkdtempSync(join(tmpdir(), 'kv-codex-work-'));
      const io = mkdtempSync(join(tmpdir(), 'kv-codex-io-'));
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
          // Only the end of stderr, never the prompt: Codex echoes the prompt near the top.
          const tail = String(result.stderr ?? '').slice(-STDERR_TAIL).replace(/\s+/g, ' ').trim();
          throw new AiError('bad_response', `codex: exited with code ${result.code}: ${tail}`, { provider: 'codex' });
        }
        const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
        return {
          text,
          ...(info.model && { modelVersion: info.model }),
          usage: { inputTokens: null, outputTokens: null, totalTokens: info.totalTokens },
          raw: { tool: 'codex exec', reasoning_effort: effort, model: info.model, total_tokens: info.totalTokens },
        };
      } finally {
        rmSync(work, { recursive: true, force: true });
        rmSync(io, { recursive: true, force: true });
      }
    },
  };
}

export default createCodexAdapter();
