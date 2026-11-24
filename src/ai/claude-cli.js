// Claude through the Claude Code command-line tool, paid by the founder's Claude subscription
// instead of an API key (decision 0010; decision 0013, "Claude command line"). It sits in the AI
// interface layer like codex-cli.js, so it gets every ask() guarantee: a prompt version on every
// call, a timeout, the JSON check and retry, the reply guard (secrets.js), and no business code
// talking to a vendor.
//
// How one call runs (flags checked against `claude --help` of 2.1.330, all documented there):
//   claude --version                    must be a version in VERIFIED_CLI_VERSIONS, else no call
//   claude -p --output-format stream-json --verbose --model <model> --effort <effort>
//     --system-prompt <system text> --tools "" --strict-mcp-config --disable-slash-commands
//     --safe-mode --setting-sources "" --settings <DENY_SETTINGS> --no-session-persistence
//     --permission-mode dontAsk --permission-prompts none
// started in a new EMPTY folder, with the user prompt (claim and pack) on stdin. The system text is
// an argument, so it must fit the Windows command-line limit (32,767 characters): it is refused
// above MAX_SYSTEM_CHARS (the judge's was 16,561 characters on 2026-11-23); the pack goes on stdin.
//
// What the flags give: no built-in tools, no MCP servers, no skills or slash commands, no user or
// project settings, no permission prompts. --safe-mode turns off CLAUDE.md, the user's hooks and
// installed plugins; it does NOT turn off admin-managed settings, the hooks of managed plugins, or
// Claude Code's built-in plugins. So the program does not rely on the flags alone: it reads the
// tool's own init report (the first line of stream-json) and refuses the reply unless the tool says
// it ran in our working folder with no tools, no MCP servers, no skills, no slash commands, only the
// built-in plugins and the key source verified for this version. And the reply must be one plain
// answer: subtype success, exactly one turn, no permission denials, and the requested model.
//
// File mentions with "@" (Fable review 9, F2). Claude Code itself reads a file mentioned as "@path"
// into the prompt, whatever --tools and --safe-mode say: the founder's smoke run of 2026-11-24 on
// 2.1.330 showed both canary files read (input 13,907 tokens against 790). Two layers:
//   1. atPathMention refuses, before anything runs, any prompt with an "@" whose run could point
//      outside the empty working folder (rules at atPathMention). Refusing rather than rewriting
//      keeps the pack text exactly as cut, so quotes from it stay verbatim (principle 2).
//   2. A Read deny rule passed with --settings (DENY_SETTINGS), in case the tool honours it for
//      mentions; whether it does is a fact per version, checked by the smoke script.
//
// No secrets reach it through its environment: an allowlist of variables only (childEnv). That
// also keeps ANTHROPIC_API_KEY out, so the tool uses the subscription login and never bills the API.
// Its replies are checked for secrets by ask() like every other provider's.
//
// Adding a Claude Code version (the founder's tool updates itself): run
// `node scripts/smoke-claude-judge.mjs` in the founder's terminal. On a version not listed it runs
// in candidate mode, prints what it observed and a ready entry; only when every check passes does a
// person add that entry to VERIFIED_CLI_VERSIONS (with the date), then run the smoke test again.

import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOnPath, pathDirs, removeFolder, spawnTool, stderrTail, sweepStaleFolders } from './codex-cli.js';
import { AiError } from './errors.js';

const MODEL_RE = /^[A-Za-z0-9._-]+$/;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// The same effort Codex is run with (codex-cli.js REASONING_EFFORT).
export const EFFORT = 'high';
const WORK_PREFIX = 'kv-claude-work-';
// The command line holds the system text; keep well under Windows' 32,767 characters.
export const MAX_SYSTEM_CHARS = 24_000;
const VERSION_RE = /^(\d+\.\d+\.\d+)\b/;

/**
 * The Claude Code versions the judge may run on, each with what the smoke test saw on it:
 *   systemPrefix       the sentence the tool puts directly before our system text (recorded with every vote)
 *   plugins            the built-in plugins its init report lists (any other plugin is refused)
 *   apiKeySource       its init report's key source on the founder's subscription login
 *   initFields         every field name its init report has; a field not in the list is refused
 *   expandsAtMentions  whether it reads "@path" files into the prompt (refusal off, no deny rule)
 *   denyBlocksMentions whether the Read deny rule stops that (null: not yet probed)
 * 2.1.330: prefix from the founder's smoke run of 2026-11-23; plugins, key source and permission
 * mode confirmed by the founder's logged-in smoke run of 2026-11-24. Its second smoke run the same
 * day (all checks PASS) confirmed initFields with the real login and showed: @ mentions read when
 * nothing stops it (13,894 input tokens against 789), and the Read deny rule stops that (784).
 */
export const VERIFIED_CLI_VERSIONS = Object.freeze({
  '2.1.330': Object.freeze({
    verified: '2026-11-23',
    systemPrefix: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    plugins: Object.freeze(['cc-plugin-agents-md', 'cc-plugin-plugin-authoring', 'cc-plugin-privacy']),
    apiKeySource: 'none',
    initFields: Object.freeze([
      'additional_directories', 'agents', 'analytics_disabled', 'apiKeySource', 'capabilities', 'claude_code_version', 'cwd',
      'fast_mode_disabled_reason', 'fast_mode_state', 'mcp_servers', 'messaging_socket_path', 'model', 'original_cwd', 'output_style',
      'per_turn_effort_active', 'permissionMode', 'plugins', 'powershell_path', 'product_feedback_disabled', 'served_by_anthropic',
      'session_id', 'skills', 'slash_commands', 'subtype', 'tools', 'type', 'ultrathink_available', 'ultrathink_typed_raises', 'uuid',
      'view_mode',
    ]),
    expandsAtMentions: true,
    denyBlocksMentions: true,
  }),
});

// Layer 2: deny the Read tool to everything, mentions included if the tool applies it to them.
// A bare tool name is the simplest valid rule; an invalid --settings would be ignored silently.
export const DENY_SETTINGS = JSON.stringify({ permissions: { deny: ['Read'] } });

const FORMAT_CHARS_RE = /\p{Cf}/gu;
// Runs end only at ASCII whitespace: a no-break or ideographic space may not end a path for the tool.
const ASCII_SPACE_RE = /[ \t\n\r\f\v]/;
const LEADING_RE = /^["'`([{<\s]+/u;

/** The text after an "@" at `start`: to the next ASCII whitespace, and for @"..." or @'...' also to the closing quote. */
function atRuns(s, start) {
  let end = start;
  while (end < s.length && !ASCII_SPACE_RE.test(s[end])) end++;
  const runs = [s.slice(start, end)];
  const q = s[start];
  if (q === '"' || q === "'") {
    const close = s.indexOf(q, start + 1);
    runs.push(s.slice(start, close < 0 ? s.length : close + 1));
  }
  return runs;
}

/** %xx escapes decoded (a few rounds, for double encoding); invalid ones are left as they are. */
function percentDecoded(run) {
  let v = run;
  for (let i = 0; i < 3; i++) {
    const next = v.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
    if (next === v) break;
    v = next;
  }
  return v;
}

function pathLike(run) {
  for (const v of [run, percentDecoded(run)]) {
    const start = v.replace(LEADING_RE, '');
    if (/^[~/\\.$%]/.test(start) || /^[A-Za-z]:/.test(start)) return true;
    if (v.includes('..') || /:[/\\]/.test(v)) return true;
  }
  return false;
}

/**
 * A short description of the first "@" mention in `text` that could point outside the empty
 * working folder, or null. The text is read twice: with Unicode format characters (zero-width
 * spaces, joiners, bidi marks) removed, and that again NFKC-normalised (fullwidth @ ~ / and the
 * like become plain ones). For every "@", its run (to the next ASCII whitespace, and for @"..."
 * to the closing quote) is refused when, after leading quotes, brackets or blanks, it starts with
 * ~ / \ . $ % or a drive letter, or when it contains ".." anywhere or ":/" (a scheme such as
 * file:/), also after %xx decoding. A handle ("@ElyseeFR") or an e-mail address passes; a plain
 * relative name can only point inside the empty folder. Over-refusing is accepted: a refused
 * prompt is reported, never sent.
 */
export function atPathMention(text) {
  const stripped = String(text ?? '').replace(FORMAT_CHARS_RE, '');
  for (const form of [stripped, stripped.normalize('NFKC').replace(FORMAT_CHARS_RE, '')]) {
    for (let i = form.indexOf('@'); i >= 0; i = form.indexOf('@', i + 1)) {
      if (atRuns(form, i + 1).some(pathLike)) return `an @ file mention at character ${i}`;
    }
  }
  return null;
}

// What Windows and Node need to start, where its own login lives (the home folder, or
// CLAUDE_CONFIG_DIR), and temp folders. Everything else (.env keys, ANTHROPIC_API_KEY,
// ANTHROPIC_BASE_URL, tokens of other tools) stays out.
const ENV_ALLOWLIST = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'CLAUDE_CONFIG_DIR', 'COMSPEC', 'PATHEXT']);
// Set on top of the allowlist: no telemetry, error reports or update checks from a judge run
// (both names are read by 2.1.330).
const ENV_FIXED = Object.freeze({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' });

/** The environment for the child: only the allowlisted variables (names compared ignoring case), plus ENV_FIXED. */
export function childEnv(env = process.env) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => ENV_ALLOWLIST.has(name.toUpperCase()))), ...ENV_FIXED };
}

/** Arguments of `claude -p`; the user prompt goes on stdin. */
export function claudeArgs({ model, effort = EFFORT, system, denyRead = true }) {
  if (!MODEL_RE.test(model)) throw new AiError('bad_request', 'claude: model name has characters that are not allowed', { provider: 'claude' });
  if (!EFFORTS.includes(effort)) throw new AiError('bad_request', `claude: effort must be one of ${EFFORTS.join(', ')}`, { provider: 'claude' });
  // Quotes and backslashes may each be escaped on the command line, so they count twice.
  if (system && system.length + (system.match(/["\\]/g)?.length ?? 0) > MAX_SYSTEM_CHARS) {
    throw new AiError('bad_request', `claude: the system text is too long for the command line (over ${MAX_SYSTEM_CHARS} characters)`, { provider: 'claude' });
  }
  return [
    '-p', '--output-format', 'stream-json', '--verbose', '--model', model, '--effort', effort,
    ...(system ? ['--system-prompt', system] : []),
    '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--safe-mode', '--setting-sources', '',
    ...(denyRead ? ['--settings', DENY_SETTINGS] : []),
    '--no-session-persistence', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
  ];
}

// npm installs Claude Code as a native program behind a shell shim. Running the program itself
// avoids a shell (no quoting of arguments by cmd.exe on Windows).
export function findClaudeExe(env = process.env) {
  const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of pathDirs(env)) {
    const exe = join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', name);
    if (existsSync(exe)) return exe;
  }
  return null;
}

/** Why the real claude cannot be started from this environment, or null. */
export function claudeMissing(env = process.env) {
  return findClaudeExe(env) || findOnPath('claude', env) ? null : 'claude: the command-line tool was not found (not installed, or not on PATH)';
}

/** Runs the real claude. Resolves { code, stdout, stderr }; rejects with AbortError on timeout. */
export function spawnClaude(args, { cwd, env, input, signal }) {
  return spawnTool(findClaudeExe(env) ?? 'claude', args, { cwd, env, input, signal });
}

/**
 * The model that answered, as the tool reports it in modelUsage: the requested name, or the
 * requested name plus a date suffix ("-20261101") when that is the only model listed. Anything
 * else is null, and the reply is refused (Fable review 9, F4): a vote never records a model that
 * was not asked for, nor the requested name for a model the tool did not name.
 */
export function answeringModel(modelUsage, requested) {
  const names = Object.keys(modelUsage ?? {});
  if (names.includes(requested)) return requested;
  if (names.length === 1 && names[0].startsWith(`${requested}-`) && /^\d{8}$/.test(names[0].slice(requested.length + 1))) return names[0];
  return null;
}

/** The lines of stream-json output, parsed; a line that is not JSON is skipped. */
function jsonLines(stdout) {
  const out = [];
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // not a JSON line
    }
  }
  return out;
}

function samePath(a, b) {
  const norm = (p) => {
    let r = String(p ?? '');
    try { r = realpathSync.native(r); } catch { /* keep as given */ }
    return r.replace(/[\\/]+$/, '');
  };
  const [x, y] = [norm(a), norm(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/**
 * What is wrong with the tool's init report for this version, or null. `expected` fields that are
 * null are not checked (candidate mode of the smoke script only).
 */
export function initProblems(init, { cwd, version, expected }) {
  if (!init) return ['the tool gave no init report'];
  const problems = [];
  const list = (name) => (Array.isArray(init[name]) ? init[name] : null);
  for (const name of ['tools', 'mcp_servers', 'skills', 'slash_commands']) {
    const v = list(name);
    if (!v) problems.push(`the init report has no ${name} list`);
    else if (v.length > 0) problems.push(`${name} loaded: ${v.map((x) => (typeof x === 'string' ? x : x?.name ?? '?')).join(', ')}`);
  }
  const plugins = list('plugins');
  if (!plugins) problems.push('the init report has no plugins list');
  else if (expected.plugins) {
    const names = plugins.map((p) => `${p?.name}${p?.path === 'builtin' ? '' : ` (${p?.path ?? 'no path'})`}`).sort();
    if (JSON.stringify(names) !== JSON.stringify([...expected.plugins].sort())) problems.push(`plugins are ${names.join(', ') || 'none'}, not the verified built-in ones`);
  }
  if (expected.apiKeySource && init.apiKeySource !== expected.apiKeySource) problems.push(`key source is ${JSON.stringify(init.apiKeySource ?? null)}, not ${expected.apiKeySource}`);
  if (init.claude_code_version !== version) problems.push(`the init report says version ${JSON.stringify(init.claude_code_version ?? null)}, not ${version}`);
  if (init.permissionMode !== 'dontAsk') problems.push(`permission mode is ${JSON.stringify(init.permissionMode ?? null)}`);
  if (!samePath(init.cwd, cwd)) problems.push('the tool did not run in the empty working folder');
  const extraDirs = (Array.isArray(init.additional_directories) ? init.additional_directories : []).filter((d) => !samePath(d, cwd));
  if (extraDirs.length > 0) problems.push(`the tool has ${extraDirs.length} more folder(s) it may read`);
  if (expected.initFields) {
    const unknown = Object.keys(init).filter((k) => !expected.initFields.includes(k));
    if (unknown.length > 0) problems.push(`the init report has fields not seen when this version was verified: ${unknown.join(', ')}`);
  }
  return problems;
}

/**
 * The adapter. `run` replaces spawnClaude in tests. `tmpRoot` is where the empty working folder
 * is made (tests give their own, so they can check nothing is left behind). `versions` replaces
 * VERIFIED_CLI_VERSIONS (tests, and the smoke script's candidate mode). `denyRead: false` drops the
 * Read deny rule (the smoke script's probe of what the tool does without it). `allowAtMentions` lets
 * the smoke script's canary probe send an @path mention; nothing else sets it.
 */
export function createClaudeAdapter({
  run = spawnClaude, effort = EFFORT, tmpRoot = tmpdir(), missingTool, versions = VERIFIED_CLI_VERSIONS, allowAtMentions = false, denyRead = true,
} = {}) {
  return {
    name: 'claude',
    keyVar: null, // the Claude subscription login of the tool itself; no key in .env
    // Asked before a call (ask's unavailable()); a test's own `run` needs no installed tool.
    missingTool: missingTool ?? (run === spawnClaude ? claudeMissing : () => null),
    documentTypes: [],
    jsonSchema: false, // --json-schema exists but is not verified with --tools ""; the program checks every answer anyway
    async call(req, ctx) {
      const args = claudeArgs({ model: req.model, effort, system: req.system, denyRead });
      const mention = allowAtMentions ? null : atPathMention(req.prompt) ?? atPathMention(req.system);
      if (mention) {
        throw new AiError('bad_request', `claude: the prompt has ${mention}; Claude Code could read that file into the prompt, so it is not sent`, { provider: 'claude' });
      }
      sweepStaleFolders(tmpRoot, Date.now(), [WORK_PREFIX]);
      const work = mkdtempSync(join(tmpRoot, WORK_PREFIX));
      const fail = (message) => new AiError('bad_response', `claude: ${message}`, { provider: 'claude' });
      try {
        const env = childEnv(process.env);
        const v = await run(['--version'], { cwd: work, env, input: '', signal: ctx.signal });
        const cliVersion = v.code === 0 ? VERSION_RE.exec(String(v.stdout ?? '').trim())?.[1] : undefined;
        if (!cliVersion) throw fail('claude --version gave no version');
        const expected = Object.hasOwn(versions, cliVersion) ? versions[cliVersion] : null;
        if (!expected) {
          throw new AiError('unsupported', `claude: Claude Code ${cliVersion} is not a verified version (${Object.keys(versions).join(', ') || 'none'}); run node scripts/smoke-claude-judge.mjs to verify it`, { provider: 'claude' });
        }
        // A version that reads @ files counts only when the deny rule was shown to stop it, and the rule is on.
        if (expected.expandsAtMentions === true && !(expected.denyBlocksMentions === true && denyRead)) {
          throw new AiError('unsupported', `claude: Claude Code ${cliVersion} reads @-mentioned files and the Read deny rule is not shown to stop it here`, { provider: 'claude' });
        }
        const input = [req.system ?? '', req.prompt].join('\n');
        const result = await run(args, { cwd: work, env, input: req.prompt, signal: ctx.signal });
        const lines = jsonLines(result.stdout);
        const init = lines.find((l) => l?.type === 'system' && l?.subtype === 'init') ?? null;
        const out = lines.findLast((l) => l?.type === 'result') ?? null;
        if (result.code !== 0 || out?.is_error === true) {
          const said = stderrTail(typeof out?.result === 'string' ? out.result : '', input);
          const tail = stderrTail(result.stderr, input);
          const detail = [said, tail].filter(Boolean).join(' / ');
          throw fail(`${result.code !== 0 ? `exited with code ${result.code}` : 'reported an error'}${detail ? `: ${detail}` : ''}`);
        }
        if (!out || typeof out.result !== 'string') throw fail('the output has no result object (stream-json)');
        const setup = initProblems(init, { cwd: work, version: cliVersion, expected });
        if (setup.length > 0) throw fail(`the tool's own init report does not show an isolated run: ${setup.join('; ')}`);
        if (out.subtype !== 'success') throw fail(`the run ended with subtype ${JSON.stringify(out.subtype ?? null)}, not success`);
        if (out.num_turns !== 1) throw fail(`the run took ${JSON.stringify(out.num_turns ?? null)} turns; a judge answers in exactly one`);
        if (!Array.isArray(out.permission_denials) || out.permission_denials.length > 0) {
          throw fail('the run reports permission denials (the model tried to use a tool), or does not report them');
        }
        const modelsUsed = Object.keys(out.modelUsage ?? {});
        const model = answeringModel(out.modelUsage, req.model);
        if (!model) throw fail(`the tool does not report the requested model ${req.model} as the one that answered (models used: ${modelsUsed.join(', ') || 'none'})`);
        const inputTokens = Number.isInteger(out.usage?.input_tokens) ? out.usage.input_tokens : null;
        // Everything the model read, cached parts included (the smoke script compares it between probes).
        const inputAll = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
          .reduce((sum, k) => (Number.isInteger(out.usage?.[k]) ? sum + out.usage[k] : sum), 0);
        const outputTokens = Number.isInteger(out.usage?.output_tokens) ? out.usage.output_tokens : null;
        return {
          text: out.result,
          modelVersion: model,
          usage: { inputTokens, outputTokens, totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null },
          raw: {
            tool: 'claude -p', deny_read: denyRead, cli_version: cliVersion, cli_verified: expected.verified ?? null,
            // What the model saw before our system text on this version (null: not yet known, candidate mode).
            system_prefix: expected.systemPrefix ?? null,
            effort, model, models_used: modelsUsed,
            session_id: typeof out.session_id === 'string' ? out.session_id : null,
            subtype: out.subtype, num_turns: out.num_turns, permission_denials: out.permission_denials, input_tokens_all: inputAll,
            // The tool's own report of its setup for this run.
            init: {
              tools: init.tools, mcp_servers: init.mcp_servers, skills: init.skills, slash_commands: init.slash_commands,
              plugins: init.plugins.map((p) => p?.name ?? null), api_key_source: init.apiKeySource ?? null,
              permission_mode: init.permissionMode, cwd_checked: true, fields: Object.keys(init).sort(),
            },
          },
        };
      } finally {
        removeFolder(work);
      }
    },
  };
}

export default createClaudeAdapter();
