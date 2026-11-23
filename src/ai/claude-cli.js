// Claude through the Claude Code command-line tool, paid by the founder's Claude subscription
// instead of an API key (decision 0010; decision 0013, "Claude command line"). It sits in the AI
// interface layer like codex-cli.js, so it gets every ask() guarantee: a prompt version on every
// call, a timeout, the JSON check and retry, the reply guard (secrets.js), and no business code
// talking to a vendor.
//
// How one call runs (flags checked against `claude --help` of 2.1.330 on 2026-11-23, all documented there):
//   claude --version                    (recorded with the vote)
//   claude -p --output-format json --model <model> --effort <effort> --system-prompt <system text>
//     --tools "" --strict-mcp-config --disable-slash-commands --safe-mode --setting-sources ""
//     --no-session-persistence --permission-mode dontAsk --permission-prompts none
// started in a new EMPTY folder, with the user prompt (claim and pack) on stdin. The system text is
// an argument, so it must fit the Windows command-line limit (32,767 characters): it is refused
// above MAX_SYSTEM_CHARS. The judge's system text was 16,561 characters on 2026-11-23; the pack,
// which grows with the claim, goes on stdin and has no such limit. The system text replaces Claude
// Code's own system prompt. No built-in tools (--tools ""), no MCP servers, no skills, no
// CLAUDE.md, hooks or plugins (--safe-mode), no user or project settings, nothing that could wait
// for a permission prompt: the model can only read what it was given and answer. Unlike Codex,
// it has no sandbox that can read other files on this machine, because it has no file tool at all.
// A reply is refused unless it is one plain answer: subtype success, exactly one turn, no
// permission denials (a denial means the model tried to use a tool), and a model the tool names.
//
// No secrets reach it through its environment: an allowlist of variables only (childEnv). That
// also keeps ANTHROPIC_API_KEY out, so the tool uses the subscription login and never bills the API.
// Its replies are checked for secrets by ask() like every other provider's.

import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { removeFolder, spawnTool, stderrTail, sweepStaleFolders } from './codex-cli.js';
import { AiError } from './errors.js';

const MODEL_RE = /^[A-Za-z0-9._-]+$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The same effort Codex is run with (codex-cli.js REASONING_EFFORT).
export const EFFORT = 'high';
const WORK_PREFIX = 'kv-claude-work-';
// The command line holds the system text; keep well under Windows' 32,767 characters.
export const MAX_SYSTEM_CHARS = 24_000;
// The fixed sentence Claude Code 2.1.330 puts directly before our system text (seen in the founder's
// smoke test, 2026-11-23). Recorded with every reply so the vote says what the model saw beyond
// system_sha256; accepted like Codex's own built-in instructions (coordinator's decision).
export const CLI_IDENTITY_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const VERSION_RE = /^(\d+\.\d+\.\d+)\b/;
// What Windows and Node need to start, where its own login lives (the home folder, or
// CLAUDE_CONFIG_DIR), and temp folders. Everything else (.env keys, ANTHROPIC_API_KEY,
// ANTHROPIC_BASE_URL, tokens of other tools) stays out.
const ENV_ALLOWLIST = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'CLAUDE_CONFIG_DIR', 'COMSPEC', 'PATHEXT']);

/** The environment for the child: only the allowlisted variables (names compared ignoring case). */
// Set on top of the allowlist: no telemetry, error reports or update checks from a judge run
// (both names are read by 2.1.330).
const ENV_FIXED = Object.freeze({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });

/** The environment for the child: only the allowlisted variables (names compared ignoring case), plus ENV_FIXED. */
export function childEnv(env = process.env) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => ENV_ALLOWLIST.has(name.toUpperCase()))), ...ENV_FIXED };
}

/** Arguments of `claude -p`; the user prompt goes on stdin. */
export function claudeArgs({ model, effort = EFFORT, system }) {
  if (!MODEL_RE.test(model)) throw new AiError('bad_request', 'claude: model name has characters that are not allowed', { provider: 'claude' });
  if (!EFFORTS.includes(effort)) throw new AiError('bad_request', `claude: effort must be one of ${EFFORTS.join(', ')}`, { provider: 'claude' });
  // Quotes and backslashes may each be escaped on the command line, so they count twice.
  if (system && system.length + (system.match(/["\\]/g)?.length ?? 0) > MAX_SYSTEM_CHARS) {
    throw new AiError('bad_request', `claude: the system text is too long for the command line (over ${MAX_SYSTEM_CHARS} characters)`, { provider: 'claude' });
  }
  return [
    '-p', '--output-format', 'json', '--model', model, '--effort', effort,
    ...(system ? ['--system-prompt', system] : []),
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--safe-mode', '--setting-sources', '',
    '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  ];
}

// npm installs Claude Code as a native program behind a shell shim. Running the program itself
// avoids a shell (no quoting of arguments by cmd.exe on Windows).
export function findClaudeExe(env = process.env) {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir) continue;
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', name);
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** Runs the real claude. Resolves { code, stdout, stderr }; rejects with AbortError on timeout. */
export function spawnClaude(args, { cwd, env, input, signal }) {
  return spawnTool(findClaudeExe(env) ?? 'claude', args, { cwd, env, input, signal });
}

/**
 * The model that answered, as the tool reports it in modelUsage: the requested one if it is
 * listed, else the only one listed, else null (and the reply is refused: a vote never records
 * the requested name as the model that answered).
 */
export function answeringModel(modelUsage, requested) {
  const names = Object.keys(modelUsage ?? {});
  if (names.includes(requested)) return requested;
  return names.length === 1 ? names[0] : null;
}

/**
 * The adapter. `run` replaces spawnClaude in tests. `tmpRoot` is where the empty working folder
 * is made (tests give their own, so they can check nothing is left behind).
 */
export function createClaudeAdapter({ run = spawnClaude, effort = EFFORT, tmpRoot = tmpdir() } = {}) {
  return {
    name: 'claude',
    keyVar: null, // the Claude subscription login of the tool itself; no key in .env
    documentTypes: [],
    jsonSchema: false, // --json-schema exists but is not verified with --tools ""; the program checks every answer anyway
    async call(req, ctx) {
      sweepStaleFolders(tmpRoot, Date.now(), [WORK_PREFIX]);
      const args = claudeArgs({ model: req.model, effort, system: req.system });
      const work = mkdtempSync(join(tmpRoot, WORK_PREFIX));
      const fail = (message) => new AiError('bad_response', `claude: ${message}`, { provider: 'claude' });
      try {
        const env = childEnv(process.env);
        const v = await run(['--version'], { cwd: work, env, input: '', signal: ctx.signal });
        const cliVersion = v.code === 0 ? VERSION_RE.exec(String(v.stdout ?? '').trim())?.[1] : undefined;
        if (!cliVersion) throw fail('claude --version gave no version');
        const input = [req.system ?? '', req.prompt].join('\n');
        const result = await run(args, { cwd: work, env, input: req.prompt, signal: ctx.signal });
        let out = null;
        try {
          out = JSON.parse(String(result.stdout ?? '').trim());
        } catch {
          // Not JSON: reported below.
        }
        if (result.code !== 0 || out?.is_error === true) {
          const said = stderrTail(typeof out?.result === 'string' ? out.result : '', input);
          const tail = stderrTail(result.stderr, input);
          const detail = [said, tail].filter(Boolean).join(' / ');
          throw fail(`${result.code !== 0 ? `exited with code ${result.code}` : 'reported an error'}${detail ? `: ${detail}` : ''}`);
        }
        if (!out || typeof out !== 'object' || out.type !== 'result' || typeof out.result !== 'string') {
          throw fail('the output is not the JSON result object of --output-format json');
        }
        if (out.subtype !== 'success') throw fail(`the run ended with subtype ${JSON.stringify(out.subtype ?? null)}, not success`);
        if (out.num_turns !== 1) throw fail(`the run took ${JSON.stringify(out.num_turns ?? null)} turns; a judge answers in exactly one`);
        if (!Array.isArray(out.permission_denials) || out.permission_denials.length > 0) {
          throw fail('the run reports permission denials (the model tried to use a tool), or does not report them');
        }
        const modelsUsed = Object.keys(out.modelUsage ?? {});
        const model = answeringModel(out.modelUsage, req.model);
        if (!model) throw fail(`the tool does not say which model answered (models used: ${modelsUsed.join(', ') || 'none'})`);
        const inputTokens = Number.isInteger(out.usage?.input_tokens) ? out.usage.input_tokens : null;
        const outputTokens = Number.isInteger(out.usage?.output_tokens) ? out.usage.output_tokens : null;
        return {
          text: out.result,
          modelVersion: model,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null },
          raw: {
            tool: 'claude -p', cli_version: cliVersion, system_prefix: CLI_IDENTITY_PREFIX, effort, model, models_used: modelsUsed,
            session_id: typeof out.session_id === 'string' ? out.session_id : null,
            subtype: out.subtype, num_turns: out.num_turns, permission_denials: out.permission_denials,
          },
        };
      } finally {
        removeFolder(work);
      }
    },
  };
}

export default createClaudeAdapter();
