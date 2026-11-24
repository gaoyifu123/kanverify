// Mistral through its Vibe command-line tool, under the founder's Mistral subscription login instead
// of an API key (decision 0010, founder 2026-11-24 "mistral-now"). Same pattern and same ruler as
// claude-cli.js and codex-cli.js: an empty working folder, an environment allowlist, a verified-
// versions list, the run's own facts checked and recorded, the reply guard of ask(), and an honest
// model_reported.
//
// How one call runs. NOT YET CHECKED against the real tool: the developer's shell cannot see the
// founder's Vibe install, so these flags come from Mistral's documentation and are verified by
// scripts/smoke-mistral-judge.mjs in the founder's terminal before any vote counts:
//   vibe --version                                  must be in VERIFIED_VIBE_VERSIONS, else no call
//   vibe -p --model <model> --max-turns 1 --system-prompt-file <io>/system.txt
//     --enabled-tools <NO_TOOL> --output-dir <io>/export
// started in a new EMPTY folder (Vibe still reads AGENTS.md and project context from its folder),
// with the user prompt on stdin (-p with no text). Its answer is stdout (default text output);
// export.json in the output folder holds the version, the effective config (model), usage, the stop
// reason, warnings (e.g. denied tool calls) and the messages. --system-prompt-file replaces Vibe's
// own instructions. --enabled-tools allows only the tools listed; there is no documented "no tools"
// flag, so it lists a name that matches no tool (NO_TOOL). --trust is never passed, and nothing is
// added to ~/.vibe/trusted_folders.toml.
//
// A version is used only when its smoke run showed (review of the Mistral judge, M1):
//   toolsOff: true            the positive control (told to read a canary and run echo) made no tool
//                             call at all: with --enabled-tools NO_TOOL the model has no tools;
//   expandsAtMentions: false  -p does not read "@path" files into the prompt. A version that does is
//                             refused outright: unlike Claude Code there is no second layer to stop it.
// A refused run that already ran a tool has acted on the founder's machine; refusing the vote does
// not undo that, which is why toolsOff must be shown before any vote, not checked after.
//
// A reply is refused unless: the exit code is 0; export.json exists and its messages are where the
// version keeps them (messagesPath); there is exactly one assistant message; no tool use in any shape
// (tool_calls, tool_call, function_call, tool_use, a function_call/tool_use/tool_result item, a
// message of role tool or function); no warnings; the export's version is exactly --version; no
// export field not seen when the version was verified; and, where the version's export names the
// model (exportNamesModel), it names the one asked for (or that name with a version suffix).
//
// Prompts with an "@" path mention are refused as for Claude (claude-cli.js atPathMention).
//
// Credentials: the environment allowlist keeps MISTRAL_API_KEY out of the child, but Vibe may also
// read a key stored in its own folder (~/.vibe/.env, reachable through USERPROFILE or VIBE_HOME).
// Whether a run used the subscription login or a stored key is UNVERIFIED: the smoke script prints
// what it can see of the credential source. Do not assume it never bills the API.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { atPathMention } from './claude-cli.js';
import { findOnPath, removeFolder, spawnTool, stderrTail, sweepStaleFolders } from './codex-cli.js';
import { AiError } from './errors.js';

const MODEL_RE = /^[A-Za-z0-9._-]+$/;
const WORK_PREFIX = 'kv-vibe-work-';
const IO_PREFIX = 'kv-vibe-io-';
const VERSION_RE = /(\d+\.\d+\.\d+)/;
// A tool name no Vibe tool has, so --enabled-tools allows nothing.
export const NO_TOOL = 'kv-no-tool';

/**
 * The Vibe versions the judge may run on, each with what the smoke script saw on it:
 *   exportFields       every top-level field of its export.json; another field is refused
 *   messagesPath       the top-level field of export.json that holds the messages
 *   exportNamesModel   whether its export names the model; if so it is required on every run
 *   toolsOff           must be true: the positive control made no tool call
 *   expandsAtMentions  must be false: -p does not read "@path" files
 * Empty until the founder's first smoke run: until then every Mistral vote is refused, by design.
 * The smoke script's candidate mode passes an entry with `candidate: true`; no real entry has it.
 */
export const VERIFIED_VIBE_VERSIONS = Object.freeze({});

// What Windows and Python need to start, where its own login lives (home, VIBE_HOME), temp folders.
const ENV_ALLOWLIST = new Set(['PATH', 'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'VIBE_HOME', 'COMSPEC', 'PATHEXT']);
// Vibe is a Python program: on Windows it would read stdin in the locale's code page, not UTF-8.
const ENV_FIXED = Object.freeze({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });

/** The environment for the child: only the allowlisted variables (names compared ignoring case), plus ENV_FIXED. */
export function childEnv(env = process.env) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => ENV_ALLOWLIST.has(name.toUpperCase()))), ...ENV_FIXED };
}

/** Arguments of `vibe -p`; the user prompt goes on stdin. */
export function vibeArgs({ model, systemFile, outDir }) {
  if (!MODEL_RE.test(model)) throw new AiError('bad_request', 'vibe: model name has characters that are not allowed', { provider: 'vibe' });
  return [
    '-p', '--model', model, '--max-turns', '1',
    ...(systemFile ? ['--system-prompt-file', systemFile] : []),
    '--enabled-tools', NO_TOOL, '--output-dir', outDir,
  ];
}

/** The installed vibe program: on PATH (vibe.exe on Windows), or where `uv tool install` puts it. */
export function findVibe(env = process.env) {
  const onPath = findOnPath('vibe', env);
  if (onPath) return onPath;
  const home = env.USERPROFILE ?? env.HOME ?? homedir();
  const uv = join(home, '.local', 'bin', process.platform === 'win32' ? 'vibe.exe' : 'vibe');
  return existsSync(uv) ? uv : null;
}

export function vibeMissing(env = process.env) {
  return findVibe(env) ? null : 'vibe: the Mistral Vibe command-line tool was not found (not installed, or not on PATH)';
}

export function spawnVibe(args, { cwd, env, input, signal }) {
  return spawnTool(findVibe(env) ?? 'vibe', args, { cwd, env, input, signal });
}

/** Whether the version entry may be used for votes (M1); a candidate entry (smoke script) may run. */
export function versionProblem(version, expected) {
  if (!expected) return `Vibe ${version} is not a verified version`;
  if (expected.candidate === true) return null;
  if (expected.toolsOff !== true) return `Vibe ${version} was not shown to run without tools (toolsOff)`;
  if (expected.expandsAtMentions !== false) return `Vibe ${version} reads @-mentioned files, or was not shown not to (expandsAtMentions)`;
  if (typeof expected.messagesPath !== 'string') return `Vibe ${version} has no recorded place for its messages (messagesPath)`;
  if (typeof expected.exportNamesModel !== 'boolean') return `Vibe ${version} does not record whether its export names the model (exportNamesModel)`;
  return null;
}

const TOOL_KEYS = new Set(['tool_calls', 'tool_call', 'function_call', 'tool_use', 'tool_result', 'function_call_output']);
const TOOL_TYPES = new Set(['function_call', 'function', 'tool_call', 'tool_use', 'tool_result', 'function_call_output']);
const TOOL_ROLES = new Set(['tool', 'function']);
const nonEmpty = (v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' ? Object.keys(v).length > 0 : v !== null && v !== undefined && v !== false && v !== '');

/** How many signs of tool use `value` holds, in any shape, anywhere. */
export function toolUseCount(value) {
  let n = 0;
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (TOOL_KEYS.has(k) && nonEmpty(x)) n++;
      if (k === 'type' && TOOL_TYPES.has(x)) n++;
      if (k === 'role' && TOOL_ROLES.has(x)) n++;
      walk(x);
    }
  };
  walk(value);
  return n;
}

/** The first top-level field of `ex` holding an array of objects with a `role` (candidate mode). */
export function findMessagesPath(ex) {
  for (const [k, v] of Object.entries(ex ?? {})) {
    if (Array.isArray(v) && v.some((m) => m && typeof m === 'object' && typeof m.role === 'string')) return k;
  }
  return null;
}

const modelMatches = (model, requested) => model === requested || new RegExp(`^${requested.replace(/[.]/g, '\\.')}-[0-9][0-9.-]*$`).test(model);

/**
 * What export.json says about one run: { problems, facts }. `expected` is the version's entry; in a
 * candidate entry the per-version fields are found, not compared.
 */
export function vibeRunFacts(ex, { requested, version, expected = {} } = {}) {
  if (!ex || typeof ex !== 'object' || Array.isArray(ex)) return { problems: ['no export.json, or not a JSON object'], facts: null };
  const problems = [];
  const fields = Object.keys(ex).sort();
  const messagesPath = expected.candidate ? findMessagesPath(ex) : expected.messagesPath;
  const messages = messagesPath && Array.isArray(ex[messagesPath]) ? ex[messagesPath] : null;
  const assistant = messages ? messages.filter((m) => m?.role === 'assistant').length : null;
  const toolUse = toolUseCount(ex);
  const warnings = Array.isArray(ex.warnings) ? ex.warnings : ex.warnings == null ? [] : [ex.warnings];
  const config = ex.config ?? ex.effective_config ?? ex.effectiveConfig ?? null;
  const model = typeof config?.model === 'string' ? config.model : typeof config?.active_model === 'string' ? config.active_model : null;
  const exportVersion = typeof ex.version === 'string' ? (VERSION_RE.exec(ex.version)?.[1] ?? ex.version) : null;
  if (!messages) problems.push(`the export has no messages where this version keeps them (${messagesPath ?? 'not found'})`);
  else if (assistant !== 1) problems.push(`the run did more than answer: ${assistant} assistant messages, not exactly one`);
  if (toolUse > 0) problems.push(`the run did more than answer: ${toolUse} sign(s) of tool use recorded`);
  if (warnings.length > 0) problems.push(`the run reports warnings: ${JSON.stringify(warnings).slice(0, 200)}`);
  if (exportVersion !== null && exportVersion !== version) problems.push(`export.json says version ${exportVersion}, not ${version}`);
  if (expected.exportNamesModel === true && model === null) problems.push('the export does not name the model, though this version\'s export does');
  if (model !== null && !modelMatches(model, requested)) problems.push(`the export names model ${model}, not the requested ${requested}`);
  if (Array.isArray(expected.exportFields)) {
    const unknown = fields.filter((f) => !expected.exportFields.includes(f));
    if (unknown.length > 0) problems.push(`export.json has fields not seen when this version was verified: ${unknown.join(', ')}`);
  }
  const usage = ex.usage && typeof ex.usage === 'object' ? ex.usage : null;
  return {
    problems,
    facts: {
      version: exportVersion, model, fields, messages_path: messagesPath, tool_calls: toolUse, assistant_messages: assistant, warnings,
      stop_reason: ex.stop_reason ?? ex.stopReason ?? null, usage,
    },
  };
}

const num = (v) => (Number.isInteger(v) ? v : null);

/**
 * The adapter. `run` replaces spawnVibe in tests; `versions` replaces VERIFIED_VIBE_VERSIONS (tests,
 * the smoke script's candidate mode); `allowAtMentions` only for the smoke script's @ probe.
 * A refused run's error carries `run` (its facts, when there were any), so the smoke script can tell
 * a refused run that used a tool from one refused for another reason.
 */
export function createVibeAdapter({ run = spawnVibe, tmpRoot = tmpdir(), missingTool, versions = VERIFIED_VIBE_VERSIONS, allowAtMentions = false } = {}) {
  return {
    name: 'vibe',
    keyVar: null, // the Mistral login of the tool itself; no key in .env
    missingTool: missingTool ?? (run === spawnVibe ? vibeMissing : () => null),
    documentTypes: [],
    jsonSchema: false,
    async call(req, ctx) {
      const mention = allowAtMentions ? null : atPathMention(req.prompt) ?? atPathMention(req.system);
      if (mention) throw new AiError('bad_request', `vibe: the prompt has ${mention}; it is not sent`, { provider: 'vibe' });
      sweepStaleFolders(tmpRoot, Date.now(), [WORK_PREFIX, IO_PREFIX]);
      const work = mkdtempSync(join(tmpRoot, WORK_PREFIX));
      const io = mkdtempSync(join(tmpRoot, IO_PREFIX));
      const fail = (message, runFacts) => Object.assign(new AiError('bad_response', `vibe: ${message}`, { provider: 'vibe' }), runFacts ? { run: runFacts } : {});
      try {
        const env = childEnv(process.env);
        const v = await run(['--version'], { cwd: work, env, input: '', signal: ctx.signal });
        const cliVersion = v.code === 0 ? VERSION_RE.exec(String(v.stdout ?? ''))?.[1] : undefined;
        if (!cliVersion) throw fail('vibe --version gave no version');
        const expected = Object.hasOwn(versions, cliVersion) ? versions[cliVersion] : null;
        const notUsable = versionProblem(cliVersion, expected);
        if (notUsable) {
          throw new AiError('unsupported', `vibe: ${notUsable} (verified: ${Object.keys(versions).join(', ') || 'none yet'}); run node scripts/smoke-mistral-judge.mjs`, { provider: 'vibe' });
        }
        let systemFile;
        if (req.system) {
          systemFile = join(io, 'system.txt');
          writeFileSync(systemFile, req.system);
        }
        const outDir = join(io, 'export');
        mkdirSync(outDir);
        const args = vibeArgs({ model: req.model, systemFile, outDir });
        // Everything we sent, only to keep it out of error messages (stderrTail).
        const sentText = [req.system ?? '', req.prompt].join('\n');
        const result = await run(args, { cwd: work, env, input: req.prompt, signal: ctx.signal });
        let ex = null;
        try {
          ex = JSON.parse(readFileSync(join(outDir, 'export.json'), 'utf8'));
        } catch {
          // Reported by vibeRunFacts.
        }
        const { problems, facts } = vibeRunFacts(ex, { requested: req.model, version: cliVersion, expected });
        if (result.code !== 0) {
          const tail = stderrTail(result.stderr, sentText);
          throw fail(`exited with code ${result.code}${tail ? `: ${tail}` : ''}`, facts);
        }
        if (problems.length > 0) throw fail(problems.join('; '), facts);
        const text = String(result.stdout ?? '');
        const u = facts.usage ?? {};
        const inputTokens = num(u.prompt_tokens) ?? num(u.input_tokens);
        const outputTokens = num(u.completion_tokens) ?? num(u.output_tokens);
        return {
          text,
          ...(facts.model && { modelVersion: facts.model }),
          usage: { inputTokens, outputTokens, totalTokens: num(u.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null) },
          raw: {
            tool: 'vibe -p', cli_version: cliVersion, cli_verified: expected.verified ?? null, model_reported: Boolean(facts.model),
            ...(facts.model && { model: facts.model }), run: facts,
          },
        };
      } finally {
        removeFolder(work);
        removeFolder(io);
      }
    },
  };
}

/**
 * What a Mistral vote file recorded about its run, checked again when the vote is read (src/jury.js,
 * through ask's index), as the adapter checked it.
 */
export function recordedRunProblems({ version, model, raw }, versions = VERIFIED_VIBE_VERSIONS) {
  const expected = typeof version === 'string' && Object.hasOwn(versions, version) ? versions[version] : null;
  const problems = [];
  const notUsable = expected?.candidate ? 'a candidate version' : versionProblem(version, expected);
  if (notUsable) problems.push(`${notUsable} (verified: ${Object.keys(versions).join(', ') || 'none yet'})`);
  const run = raw?.run;
  if (!run || typeof run !== 'object') return [...problems, 'no run facts recorded (raw.run)'];
  if (run.tool_calls !== 0) problems.push('tool use recorded (raw.run.tool_calls)');
  if (run.assistant_messages !== 1) problems.push('not exactly one assistant message recorded (raw.run.assistant_messages)');
  if (!Array.isArray(run.warnings) || run.warnings.length > 0) problems.push('warnings recorded (raw.run.warnings)');
  if (expected && run.version !== null && run.version !== version) problems.push('the recorded export version is not the tool version (raw.run.version)');
  if (expected && run.messages_path !== expected.messagesPath) problems.push('the messages were not where this version keeps them (raw.run.messages_path)');
  if (Array.isArray(expected?.exportFields) && (!Array.isArray(run.fields) || run.fields.some((f) => !expected.exportFields.includes(f)))) problems.push('export fields not seen when this version was verified (raw.run.fields)');
  if (expected?.exportNamesModel === true) {
    if (raw.model_reported !== true || typeof raw.model !== 'string' || !modelMatches(raw.model, String(model))) problems.push('the recorded model is missing or not the one asked for (raw.model, model_requested)');
  }
  return problems;
}

export default createVibeAdapter();
