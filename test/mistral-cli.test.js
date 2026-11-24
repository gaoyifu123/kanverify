// The Mistral (Vibe) command-line judge (src/ai/mistral-cli.js): isolation (empty working folder,
// environment allowlist, no tools enabled, one turn), the run facts from export.json, refusals,
// timeout, the reply guard, and the vote file. A real child process runs a stand-in for vibe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask, recordProblems } from '../src/ai/index.js';
import { spawnTool } from '../src/ai/codex-cli.js';
import { childEnv, createVibeAdapter, NO_TOOL, VERIFIED_VIBE_VERSIONS, vibeArgs, vibeRunFacts } from '../src/ai/mistral-cli.js';
import { refusedForms } from './at-mention-forms.js';

function tempRoot(t, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

const JWT = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlc2lnbmF0dXJl'].join('.');
const ANSWER = { verdict: 'unverifiable', evidence: [], rules_applied: ['VG-1'], reasoning: 'r', open_question_fr: null, open_question_en: null, summary_fr: 'f', summary_en: 'e' };
const FIELDS = ['config', 'messages', 'stop_reason', 'usage', 'version', 'warnings'];
const ENTRY = { verified: 'test', exportFields: FIELDS, messagesPath: 'messages', exportNamesModel: true, toolsOff: true, expandsAtMentions: false };
const VERSIONS = { '9.9.9': ENTRY };

// Answers --version; otherwise writes what it saw next to itself, writes export.json into
// --output-dir and prints the answer, according to the model asked for.
const FAKE_VIBE = `
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('vibe 9.9.9'); process.exit(0); }
const at = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const model = at('--model');
const stdin = fs.readFileSync(0, 'utf8');
fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify({
  cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()), env: process.env, args, stdin,
  system: at('--system-prompt-file') ? fs.readFileSync(at('--system-prompt-file'), 'utf8') : null,
}));
const answer = ${JSON.stringify(JSON.stringify(ANSWER))};
const ex = { version: '9.9.9', config: { model }, usage: { prompt_tokens: 1200, completion_tokens: 300 }, stop_reason: 'end_turn', warnings: [],
  messages: [{ role: 'user', content: 'x' }, { role: 'assistant', content: answer }] };
const faults = {
  toolcall: { messages: [{ role: 'user' }, { role: 'assistant', tool_calls: [{ name: 'read_file' }] }, { role: 'tool', content: 'x' }] },
  twomsgs: { messages: [{ role: 'user' }, { role: 'assistant', content: 'a' }, { role: 'assistant', content: 'b' }] },
  warn: { warnings: ['tool call read_file denied'] }, haiku: { config: { model: 'mistral-small-latest' } }, dated: { config: { model: 'dated-4-0' } },
  nomodel: { config: {} }, newfield: { account: 'x' }, otherversion: { version: '9.9.90' },
  fncall: { messages: [{ role: 'user' }, { role: 'assistant', content: [{ type: 'function_call', name: 'read_file' }] }] },
  fnrole: { messages: [{ role: 'user' }, { role: 'function', content: 'x' }, { role: 'assistant', content: 'a' }] },
  toolusekey: { messages: [{ role: 'user' }, { role: 'assistant', content: 'a', tool_use: { name: 'bash' } }] },
  nomsgs: { messages: undefined, transcript: [{ role: 'assistant', content: 'a' }] }, noanswer: { messages: [{ role: 'user', content: 'x' }] },
};
if (model === 'slow') setInterval(() => {}, 1000);
else if (model === 'exit2') { process.stderr.write('Error: not logged in'); process.exitCode = 2; }
else {
  if (model !== 'noexport') fs.writeFileSync(path.join(at('--output-dir'), 'export.json'), JSON.stringify({ ...ex, ...(faults[model] ?? {}) }));
  process.stdout.write(model === 'secret' ? answer.replace('"r"', '"token ${JWT}"') : answer);
}
`;

function fakeVibe(t) {
  const bin = tempRoot(t, 'kv-fake-vibe-');
  const script = join(bin, 'fake-vibe.cjs');
  writeFileSync(script, FAKE_VIBE);
  const run = (args, opts) => spawnTool(process.execPath, [script, ...args], opts);
  return { run, report: () => JSON.parse(readFileSync(join(bin, 'report.json'), 'utf8')) };
}

const REQ = { provider: 'vibe', model: 'mistral-large-4-0', promptVersion: 'judge-test', system: 'SYSTEM TEXT: principles and judge prompt.', prompt: 'The claim and the pack. Answer in JSON.', json: true };

test('vibe: empty folder, allowlisted variables only, no tools enabled, one turn, system text from its file, prompt on stdin', async (t) => {
  const { run, report } = fakeVibe(t);
  const root = tempRoot(t, 'kv-vibe-root-');
  const saved = process.env.MISTRAL_API_KEY;
  process.env.MISTRAL_API_KEY = 'mistral-key-must-not-reach-the-child';
  let r;
  try {
    r = await ask(REQ, { env: {}, adapters: { vibe: createVibeAdapter({ run, tmpRoot: root, versions: VERSIONS }) } });
  } finally {
    if (saved === undefined) delete process.env.MISTRAL_API_KEY; else process.env.MISTRAL_API_KEY = saved;
  }
  assert.deepEqual(r.json, ANSWER);
  assert.equal(r.modelVersion, 'mistral-large-4-0');
  assert.deepEqual(r.usage, { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 });
  assert.equal(r.raw.cli_version, '9.9.9');
  assert.equal(r.raw.model_reported, true);
  assert.deepEqual([r.raw.run.tool_calls, r.raw.run.assistant_messages, r.raw.run.warnings], [0, 1, []]);
  const seen = report();
  assert.deepEqual(seen.cwdFiles, []);
  assert.ok(seen.cwd.includes('kv-vibe-work-'));
  assert.equal(seen.env.MISTRAL_API_KEY, undefined);
  assert.equal(seen.env.PYTHONUTF8, '1');
  assert.equal(seen.system, REQ.system);
  assert.equal(seen.stdin, REQ.prompt);
  const a = seen.args;
  assert.equal(a[0], '-p');
  assert.equal(a[a.indexOf('--max-turns') + 1], '1');
  assert.equal(a[a.indexOf('--enabled-tools') + 1], NO_TOOL);
  assert.ok(!a.some((x) => /--trust|--auto-approve|yolo/i.test(x)));
  assert.deepEqual(readdirSync(root), [], 'both temporary folders are removed');
});

test('vibe: refusals: unverified version, tool calls, two messages, warnings, exit code, no export, other model, unknown export field', async (t) => {
  const { run } = fakeVibe(t);
  const root = tempRoot(t, 'kv-vibe-root-');
  const opts = { env: {}, adapters: { vibe: createVibeAdapter({ run, tmpRoot: root, versions: VERSIONS }) } };
  assert.deepEqual(VERIFIED_VIBE_VERSIONS, {}, 'no version is verified until the founder smoke run');
  await assert.rejects(ask(REQ, { env: {}, adapters: { vibe: createVibeAdapter({ run, tmpRoot: root }) } }),
    (e) => e.code === 'unsupported' && /Vibe 9\.9\.9 is not a verified version \(verified: none yet\).*smoke-mistral-judge/.test(e.message));
  for (const [model, re] of [
    ['toolcall', /did more than answer: 2 sign\(s\) of tool use/], ['twomsgs', /2 assistant messages/], ['warn', /reports warnings/],
    ['exit2', /exited with code 2: Error: not logged in/], ['noexport', /no export\.json/], ['haiku', /names model mistral-small-latest, not the requested haiku/],
    ['newfield', /fields not seen when this version was verified: account/], ['otherversion', /export\.json says version 9\.9\.90, not 9\.9\.9/],
    ['fncall', /sign\(s\) of tool use/], ['fnrole', /sign\(s\) of tool use/], ['toolusekey', /sign\(s\) of tool use/],
    ['nomsgs', /no messages where this version keeps them \(messages\)/], ['noanswer', /0 assistant messages, not exactly one/],
    ['nomodel', /does not name the model, though this version's export does/],
  ]) {
    await assert.rejects(ask({ ...REQ, model }, opts), (e) => e.code === 'bad_response' && re.test(e.message), model);
  }
  // A refused run carries its facts, so a run that used a tool can be told apart (M1).
  await assert.rejects(ask({ ...REQ, model: 'toolcall' }, opts), (e) => e.run?.tool_calls > 0);
  // Where a version's export does not name the model, none named means not reported.
  const quiet = { vibe: createVibeAdapter({ run, tmpRoot: root, versions: { '9.9.9': { ...ENTRY, exportNamesModel: false } } }) };
  const nomodel = await ask({ ...REQ, model: 'nomodel' }, { env: {}, adapters: quiet });
  assert.equal(nomodel.raw.model_reported, false);
  assert.equal(nomodel.modelVersion, undefined);
  await assert.rejects(ask({ ...REQ, model: 'secret' }, opts), (e) => e.code === 'secret_in_reply');
  // Every @ form is refused before anything runs.
  let started = false;
  const never = createVibeAdapter({ run: async () => { started = true; return { code: 0 }; }, tmpRoot: root, versions: VERSIONS });
  for (const text of refusedForms()) {
    await assert.rejects(ask({ ...REQ, prompt: `Answer in JSON. ${JSON.stringify({ text })}` }, { env: {}, adapters: { vibe: never } }), (e) => e.code === 'bad_request', text);
  }
  assert.equal(started, false);
  assert.deepEqual(readdirSync(root), []);
});

test('vibe: a timeout is an AiError and nothing is left behind', async (t) => {
  const { run } = fakeVibe(t);
  const root = tempRoot(t, 'kv-vibe-root-');
  await assert.rejects(ask({ ...REQ, model: 'slow', timeoutMs: 1500 }, { env: {}, adapters: { vibe: createVibeAdapter({ run, tmpRoot: root, versions: VERSIONS }) } }),
    (e) => e.code === 'timeout');
  assert.deepEqual(readdirSync(root), []);
});

test('vibe: arguments, environment, run facts, and what a vote recorded is checked again', () => {
  assert.throws(() => vibeArgs({ model: 'a b', outDir: 'o' }), (e) => e.code === 'bad_request');
  assert.deepEqual(Object.keys(childEnv({ Path: 'p', USERPROFILE: 'u', VIBE_HOME: 'v', MISTRAL_API_KEY: 'k', OPENAI_API_KEY: 'o' })).sort(),
    ['PYTHONIOENCODING', 'PYTHONUTF8', 'Path', 'USERPROFILE', 'VIBE_HOME']);
  assert.match(vibeRunFacts(null, { requested: 'm' }).problems.join(), /no export\.json/);
  const ok = { messages: [{ role: 'assistant', content: 'a' }] };
  assert.deepEqual(vibeRunFacts({ ...ok, config: { model: 'mistral-large-4-0-3' } }, { requested: 'mistral-large-4-0', expected: ENTRY }).problems, []);
  assert.match(vibeRunFacts({ ...ok, config: { model: 'mistral-large-4-1x' } }, { requested: 'mistral-large-4', expected: ENTRY }).problems.join(), /not the requested/);
  const raw = { run: { tool_calls: 0, assistant_messages: 1, warnings: [], fields: FIELDS } };
  assert.match(recordProblems('vibe', { version: '9.9.9', raw }).join(), /not a verified version/, 'the real list is empty');
});

test('vibe: the program writes the Mistral vote with its tool version and run facts', async (t) => {
  const { askVote } = await import('../src/jury.js');
  const { run } = fakeVibe(t);
  const root = tempRoot(t, 'kv-vibe-root-');
  const pack = {
    claim: { key: 'T1', quote_original: 'q', lang: 'fr', type: 'promise', verifiability: 'vague', deadline: null, criteria_en: 'c', criteria_fr: 'c', speaker_role_en: 'r', origin: {} },
    sources: [], excerpts: [],
  };
  const vote = await askVote(pack, 't1.pack.json', '0'.repeat(64), { provider: 'mistral', channel: 'subscription' }, {
    model: 'mistral-large-4-0', today: '2026-11-24', askOptions: { env: {}, adapters: { vibe: createVibeAdapter({ run, tmpRoot: root, versions: VERSIONS }) } },
  });
  assert.deepEqual([vote.provider, vote.channel, vote.via], ['mistral', 'subscription', 'mistral-cli']);
  assert.deepEqual(vote.made_by, { role: 'judge', tool: 'mistral-cli', tool_version: '9.9.9' });
  assert.equal(vote.model, 'mistral-large-4-0');
  assert.equal(vote.model_reported, true);
  assert.deepEqual(vote.raw.run.fields, FIELDS);
  assert.equal(vote.cost_usd_estimate, 0);
});

test('vibe (M1): a version is used only when shown to run without tools and not to read @ files', async (t) => {
  const { versionProblem } = await import('../src/ai/mistral-cli.js');
  assert.equal(versionProblem('9.9.9', ENTRY), null);
  assert.match(versionProblem('9.9.9', { ...ENTRY, toolsOff: null }), /not shown to run without tools/);
  assert.match(versionProblem('9.9.9', { ...ENTRY, toolsOff: false }), /not shown to run without tools/);
  assert.match(versionProblem('9.9.9', { ...ENTRY, expandsAtMentions: true }), /reads @-mentioned files/);
  assert.match(versionProblem('9.9.9', { ...ENTRY, expandsAtMentions: null }), /reads @-mentioned files, or was not shown not to/);
  assert.match(versionProblem('9.9.9', { ...ENTRY, messagesPath: undefined }), /messagesPath/);
  assert.match(versionProblem('9.9.9', { ...ENTRY, exportNamesModel: null }), /exportNamesModel/);
  assert.equal(versionProblem('9.9.9', { candidate: true }), null, 'the smoke script may run a candidate');
  const { run } = fakeVibe(t);
  const root = tempRoot(t, 'kv-vibe-root-');
  await assert.rejects(ask(REQ, { env: {}, adapters: { vibe: createVibeAdapter({ run, tmpRoot: root, versions: { '9.9.9': { ...ENTRY, expandsAtMentions: true } } }) } }),
    (e) => e.code === 'unsupported' && /reads @-mentioned files/.test(e.message));
  // A candidate finds where the messages are.
  const cand = await ask(REQ, { env: {}, adapters: { vibe: createVibeAdapter({ run, tmpRoot: root, versions: { '9.9.9': { candidate: true } } }) } });
  assert.equal(cand.raw.run.messages_path, 'messages');
});

test('vibe: what a vote recorded is checked again as the adapter checked it (M2, M3)', async () => {
  const { recordedRunProblems } = await import('../src/ai/mistral-cli.js');
  const raw = { model_reported: true, model: 'mistral-large-4-0', run: { version: '9.9.9', tool_calls: 0, assistant_messages: 1, warnings: [], fields: FIELDS, messages_path: 'messages' } };
  const rec = (over = {}, run = {}) => recordedRunProblems({ version: '9.9.9', model: 'mistral-large-4-0', raw: { ...raw, ...over, run: { ...raw.run, ...run } } }, VERSIONS);
  assert.deepEqual(rec(), []);
  assert.match(rec({}, { assistant_messages: 0 }).join(), /not exactly one assistant message/);
  assert.match(rec({}, { tool_calls: 1 }).join(), /tool use recorded/);
  assert.match(rec({}, { messages_path: 'transcript' }).join(), /not where this version keeps them/);
  assert.match(rec({ model: 'mistral-small-latest' }).join(), /recorded model is missing or not the one asked for/);
  assert.match(rec({ model_reported: false, model: undefined }).join(), /recorded model is missing/);
  assert.match(recordedRunProblems({ version: '9.9.9', model: 'm', raw }, { '9.9.9': { ...ENTRY, toolsOff: null } }).join(), /not shown to run without tools/);
  assert.match(recordedRunProblems({ version: '9.9.9', model: 'm', raw }, { '9.9.9': { candidate: true } }).join(), /a candidate version/);
});
