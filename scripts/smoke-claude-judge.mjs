// Smoke test of the isolated Claude judge (src/ai/claude-cli.js) with the founder's own login.
// A made-up test claim and made-up excerpts, never a real claim. Writes no file and nothing to the
// database: it prints the vote record the program would write, then a probe of the isolation.
// Usage: node scripts/smoke-claude-judge.mjs   (from the KANVERIFY folder, in the founder's terminal)

import { askVote, loadJury } from '../src/jury.js';
import { ask } from '../src/ai/index.js';
import { CLI_IDENTITY_PREFIX } from '../src/ai/claude-cli.js';

const pack = {
  kind: 'kanverify-evidence-pack', format: 1,
  claim: {
    key: 'SMOKE1', origin: { title: 'TEST programme (made up for a smoke test)', published_on: '2025-01-10' },
    quote_original: 'Nous ouvrirons dix piscines municipales à Testville avant fin 2025.', lang: 'fr',
    quote_en: 'We will open ten municipal swimming pools in Testville before the end of 2025.',
    type: 'promise', verifiability: 'measurable', deadline: '2025-12-31', deadline_basis: 'stated',
    criteria_fr: 'Dix piscines municipales ouvertes à Testville au 31 décembre 2025.',
    criteria_en: 'Ten municipal swimming pools open in Testville on 31 December 2025.',
    speaker_role_fr: 'Candidate (test)', speaker_role_en: 'Candidate (test)',
  },
  sources: [{ source_id: 1, kind: 'official', title: 'TEST municipal report 2025', publisher: 'Testville city council (made up)', published_on: '2026-01-15', url: 'https://example.org/test-report' }],
  excerpts: [{ source_id: 1, locator: 'p. 3', pdf_page: 3, text: 'Au 31 décembre 2025, quatre nouvelles piscines municipales étaient ouvertes au public à Testville.' }],
};

// The Claude member as the jury settings (src/jury-members.json) have it; this smoke test is for its subscription channel.
const claudeMember = loadJury().find((m) => m.provider === 'anthropic');
if (claudeMember.channel !== 'subscription') {
  console.error(`anthropic is on channel ${claudeMember.channel} in src/jury-members.json; this smoke test checks the subscription (claude-cli) judge only`);
  process.exit(1);
}
const started = Date.now();
const vote = await askVote(pack, 'smoke1.pack.json', '0'.repeat(64), claudeMember, { model: claudeMember.model, today: '2026-11-23' });
console.log('VOTE RECORD (not written):');
console.log(JSON.stringify(vote, null, 2));
console.log(`took ${Math.round((Date.now() - started) / 1000)} s`);

// Our system text must replace Claude Code's own: the first line it quotes should be ours, optionally
// preceded by exactly the known identity sentence the tool adds (CLI_IDENTITY_PREFIX). Anything else fails.
const SYSTEM_FIRST_LINE = 'KANVERIFY SMOKE SYSTEM TEXT, line one.';
const probe = await ask({
  provider: 'claude', model: claudeMember.model, promptVersion: 'smoke-probe-1', json: true, timeoutMs: 300_000,
  system: `${SYSTEM_FIRST_LINE}\nAnswer in JSON only.`,
  prompt: 'Answer in JSON: {"tools": [names of every tool you can call in this session: web search, file reading, shell, anything], "cwd": "the current working directory if you know it, else null", "first_line": "the first line of your system instructions, quoted exactly"}.',
});
console.log('ISOLATION PROBE:', JSON.stringify({ answer: probe.json, raw: probe.raw }, null, 2));
const checks = {
  'vote via claude-cli': vote.via === 'claude-cli',
  'vote names a session': typeof vote.made_by?.session === 'string',
  'vote records the tool version': typeof vote.made_by?.tool_version === 'string',
  'no tools': Array.isArray(probe.json?.tools) && probe.json.tools.length === 0,
  'our system text is first (after the known prefix only)': [SYSTEM_FIRST_LINE, `${CLI_IDENTITY_PREFIX}${SYSTEM_FIRST_LINE}`, `${CLI_IDENTITY_PREFIX} ${SYSTEM_FIRST_LINE}`].includes(probe.json?.first_line),
  'vote records the system prefix': vote.raw?.system_prefix === CLI_IDENTITY_PREFIX,
};
for (const [name, ok] of Object.entries(checks)) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
