// The pack flow of decision 0010: file checks (src/pack.js), the Codex judge through ask()
// (src/ai/codex-cli.js, never the real tool here), and vote -> tally (src/jury.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ask } from '../src/ai/index.js';
import { childEnv, createCodexAdapter, parseCodexStderr } from '../src/ai/codex-cli.js';
import { storeEvidenceBytes } from '../src/archive.js';
import { loadPrompt } from '../src/extract.js';
import {
  JUDGE_SCHEMA, judgeInputHeader, judgeInputText, packJudgeRequest, principlesText, runPackVotes, tallyPack, voteFileName,
} from '../src/jury.js';
import {
  MAX_PACK_TOKENS, boundaryProblems, checkCandidatesFile, checkPack, checkVote, locateSpan, packPromptVersion, sha256Of, sourceUnits, startPack, unitsListing,
} from '../src/pack.js';
import { sameSessionProblem } from '../src/rules.js';
import { addClaim, addSource, freshDb } from './helpers.js';

const PACK_VERSION = packPromptVersion();
const clone = (x) => JSON.parse(JSON.stringify(x));
/** What node src/pack.js start writes (startPack), for a pack built by hand here: header and read for the given sources. */
function started(pack, given, session = 'pack-test-session') {
  pack.header = { written_by: 'node src/pack.js start', started_at: '2026-11-23T08:00:00Z', prompt_version: PACK_VERSION, session, given_sources: given, claim: clone(pack.claim) };
  pack.read = given.map((source_id) => ({ source_id, units: 'all', not_read_why: null }));
  return pack;
}
const JUDGE_VERSION = loadPrompt(new URL('../team/run/judge-prompt.md', import.meta.url)).version;
const SYSTEM_SHA256 = packJudgeRequest({ claim: {} }, '2026-11-22').systemSha256;
const ORIGIN_PAGE_2 = 'Plus de sport : 30 minutes par jour en primaire dès 2022 ; un collège rénové.';
const LAW_HTML = '<html><head><title>x</title></head><body><p>Préambule.</p><p>Article 1. Trente minutes d’activité physique quotidienne sont généralisées dans les écoles à la rentrée 2022.</p><p>Article 2. Fin.</p></body></html>';
const REPORT_PAGES = ['Rapport, page de garde.', 'Seules 42 % des écoles primaires mettent en œuvre le dispositif.'];

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-pack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidenceDir = join(dir, 'evidence');
  const textDir = join(dir, 'text');
  const packDir = join(dir, 'packs');
  for (const d of [textDir, packDir]) mkdirSync(d, { recursive: true });
  const db = freshDb();
  const store = (text) => storeEvidenceBytes(evidenceDir, Buffer.from(text)).sha256;
  const pdfSha = store('%PDF-1.4 platform');
  const origin = addSource(db, 'platform', { sha256: pdfSha, title: 'Programme', published_on: '2022-03-17' });
  const law = addSource(db, 'gazette', { sha256: store(LAW_HTML), media_type: 'text/html', title: 'BO', publisher: 'Ministère', url: 'https://example.org/bo', published_on: '2022-09-01' });
  const reportSha = store('%PDF-1.4 report');
  const report = addSource(db, 'parliament', { sha256: reportSha, title: 'Rapport', publisher: 'Sénat', url: 'https://example.org/r' });
  const statement = addSource(db, 'statement', { sha256: store('<p>Le ministre dit que tout va bien.</p>'), media_type: 'text/html', url: 'https://example.org/s' });
  const transcript = (id, sha, pages) => writeFileSync(join(textDir, `source-${id}-text.json`), JSON.stringify({
    source_id: id, sha256: sha, unit_kind: 'pdf_page', method: 'model-transcription', model: 'm', missing_units: [],
    units: pages.map((text, i) => ({ unit: i + 1, text })),
  }));
  transcript(origin, pdfSha, ['Page de garde.', ORIGIN_PAGE_2]);
  transcript(report, reportSha, REPORT_PAGES);
  const row = (id) => db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  const meta = (id) => { const r = row(id); return { source_id: id, kind: r.kind, title: r.title, publisher: r.publisher, published_on: r.published_on, url: r.url, lang: r.lang }; };
  const pack = {
    kind: 'kanverify-evidence-pack', format: 1, made_at: '2026-11-22T20:00:00Z',
    made_by: { role: 'evidence', channel: 'subscription', provider: 'anthropic', model: 'claude-opus-5-5' },
    claim: {
      key: 'C1', spec: '1:27', speaker: 'Jeanne Testard',
      origin: { source_id: origin, title: 'Programme', published_on: '2022-03-17', locator: 'p. 7' },
      quote_original: '30 minutes par jour en primaire dès 2022', lang: 'fr', quote_fr: null, quote_en: '30 minutes a day in primary school from 2022',
      type: 'promise', domain: 'education', verifiability: 'measurable', deadline: '2022-12-31', deadline_basis: 'stated',
      criteria_fr: 'Trente minutes par jour en primaire.', criteria_en: 'Thirty minutes a day in primary school.',
      speaker_role_fr: 'Candidat', speaker_role_en: 'Candidate',
    },
    sources: [meta(law), meta(report)],
    excerpts: [
      { source_id: law, locator: '§2', pdf_page: null, text: 'Article 1. Trente minutes d’activité physique quotidienne sont généralisées dans les écoles à la rentrée 2022.' },
      { source_id: report, locator: 'p. 2', pdf_page: 2, text: 'Seules 42 % des écoles primaires mettent en œuvre le dispositif.' },
    ],
    considered_not_used: [{ source_id: statement, locator: '§1', text: 'Le ministre dit que tout va bien.', why: 'a statement, never evidence' }],
    before_reading: { met: 'a text making thirty minutes a day general in primary schools from 2022', not_met: 'a lower share of schools, a later date, an exception' },
    transcription_doubts: [],
    gaps: null,
  };
  started(pack, [law, report, statement]);
  return { db, dir, evidenceDir, textDir, packDir, opts: { evidenceDir, textDir }, ids: { origin, law, report, statement }, pack, meta };
}

test('checkPack: a well-formed pack passes; every excerpt is checked against the archived source', (t) => {
  const s = setup(t);
  const ok = checkPack(s.db, s.pack, s.opts);
  assert.deepEqual(ok.problems, []);
  assert.ok(ok.tokens > 0 && ok.tokens < MAX_PACK_TOKENS);
  // An excerpt changed by one word is refused.
  const bad = clone(s.pack);
  bad.excerpts[1].text = 'Seules 45 % des écoles primaires mettent en œuvre le dispositif.';
  assert.match(checkPack(s.db, bad, s.opts).problems.join(), /excerpt 2: excerpt not found verbatim/);
  // The page and paragraph must be where the text is.
  const page = clone(s.pack);
  page.excerpts[1].pdf_page = 1;
  assert.match(checkPack(s.db, page, s.opts).problems.join(), /starts on PDF page 2/);
  const para = clone(s.pack);
  para.excerpts[0].locator = '§1';
  assert.match(checkPack(s.db, para, s.opts).problems.join(), /starts in §2/);
});

test('checkPack: the source rule, the metadata, the not-used list and the claim quote', (t) => {
  const s = setup(t);
  const st = clone(s.pack);
  st.sources.push(s.meta(s.ids.statement));
  st.excerpts.push({ source_id: s.ids.statement, locator: '§1', pdf_page: null, text: 'Le ministre dit que tout va bien.' });
  assert.match(checkPack(s.db, st, s.opts).problems.join(), /is a statement, never evidence/);
  const meta = clone(s.pack);
  meta.sources[0].kind = 'law';
  assert.match(checkPack(s.db, meta, s.opts).problems.join(), /kind differs from the database/);
  const unused = clone(s.pack);
  unused.excerpts.pop();
  assert.match(checkPack(s.db, unused, s.opts).problems.join(), /listed but has no excerpt/);
  const noList = clone(s.pack);
  delete noList.considered_not_used;
  assert.match(checkPack(s.db, noList, s.opts).problems.join(), /considered_not_used must be a list/);
  const notUsedText = clone(s.pack);
  notUsedText.considered_not_used[0].text = 'Le ministre dit autre chose.';
  assert.match(checkPack(s.db, notUsedText, s.opts).problems.join(), /considered_not_used 1: excerpt not found verbatim/);
  const quote = clone(s.pack);
  quote.claim.quote_original = '45 minutes par jour en primaire dès 2022';
  assert.match(checkPack(s.db, quote, s.opts).problems.join(), /claim quote not found verbatim/);
  const none = clone(s.pack);
  none.excerpts = [];
  none.sources = [];
  assert.match(checkPack(s.db, none, s.opts).problems.join(), /1 to 12 excerpts/);
});

test('checkPack: a PDF without a saved transcription cannot be checked, and a pack over the size cap is refused', (t) => {
  const s = setup(t);
  rmSync(join(s.textDir, `source-${s.ids.report}-text.json`));
  assert.match(checkPack(s.db, s.pack, s.opts).problems.join(), /without a saved transcription/);
  const s2 = setup(t);
  const big = clone(s2.pack);
  big.claim.criteria_en = 'x'.repeat(MAX_PACK_TOKENS * 4);
  assert.match(checkPack(s2.db, big, s2.opts).problems.join(), /over 5000/);
});

test('checkCandidatesFile: the program recomputes verbatim and problems, whatever the file says', (t) => {
  const s = setup(t);
  const base = {
    quote_original: '30 minutes par jour en primaire dès 2022', lang: 'fr', unit: 2, locator: 'p. 7', type: 'promise', domain: 'education',
    verifiability: 'measurable', deadline: '2022-12-31', deadline_basis: 'stated', criteria_fr: 'c', criteria_en: 'c',
    speaker_role_fr: null, speaker_role_en: null, quote_fr: null, quote_en: 'q', notes: null,
  };
  const record = {
    kind: 'kanverify-extraction-candidates', provider: 'anthropic', model: 'claude-opus-5-5', channel: 'subscription', prompt_version: 'extract-0.3',
    subject_id: 1,
    source: { id: s.ids.origin, sha256: s.db.prepare('SELECT sha256 FROM sources WHERE id = ?').get(s.ids.origin).sha256 },
    candidates: [
      { ...base },
      // Claims to be verbatim and clean; it is neither.
      { ...base, quote_original: '40 minutes par jour', verbatim: true, problems: [] },
      { ...base },
    ],
  };
  const { problems, record: checked } = checkCandidatesFile(s.db, record, s.opts);
  assert.deepEqual(problems, []);
  assert.equal(checked.candidates[0].verbatim, true);
  assert.equal(checked.candidates[0].verbatim_unit, 2);
  assert.equal(checked.candidates[1].verbatim, false);
  assert.equal(checked.candidates[2].duplicate_of, 1);
  assert.equal(checked.counts.verbatim_ok, 2);
  const wrong = checkCandidatesFile(s.db, { ...record, source: { id: s.ids.law, sha256: 'x' } }, s.opts);
  assert.match(wrong.problems.join(), /not the speaker's own words/);
  // The speaker is required at file level, and must exist.
  const { subject_id: _s, ...noSubject } = record;
  assert.match(checkCandidatesFile(s.db, noSubject, s.opts).problems.join(), /subject_id is missing/);
  assert.match(checkCandidatesFile(s.db, { ...record, subject_id: 99 }, s.opts).problems.join(), /subject 99 is not in the database/);
});

function voteFor(s, packSha256, over = {}) {
  return {
    kind: 'kanverify-vote', format: 1, claim: 'C1', pack_file: 'c1.pack.json', pack_sha256: packSha256,
    provider: 'anthropic', channel: 'subscription', via: 'claude-code', model: 'claude-opus-5-5', promptVersion: JUDGE_VERSION,
    system_sha256: SYSTEM_SHA256, verdict: 'partly_came_true',
    evidence: [{ source_id: s.ids.law, excerpt: 'Trente minutes d’activité physique quotidienne sont généralisées', locator: '§2', pdf_page: null }],
    reasoning: 'r', open_question_fr: null, open_question_en: null, summary_fr: 'f', summary_en: 'e', ...over,
  };
}

test('checkVote: a vote may quote only from the pack, about this version of the pack, with the current prompt', (t) => {
  const s = setup(t);
  const checked = checkPack(s.db, s.pack, s.opts);
  const ctx = { packSha256: 'f'.repeat(64), promptVersion: JUDGE_VERSION, systemSha256: SYSTEM_SHA256, today: '2026-11-22' };
  assert.deepEqual(checkVote(voteFor(s, ctx.packSha256), s.pack, checked, ctx), []);
  // In the archived source but not in the pack: the judge did not see it, so it cannot quote it.
  const outside = voteFor(s, ctx.packSha256, { evidence: [{ source_id: s.ids.law, excerpt: 'Article 2. Fin.', locator: '§3', pdf_page: null }] });
  assert.match(checkVote(outside, s.pack, checked, ctx).join(), /not found verbatim/);
  assert.match(checkVote(voteFor(s, 'a'.repeat(64)), s.pack, checked, ctx).join(), /pack_sha256 does not match/);
  assert.match(checkVote(voteFor(s, ctx.packSha256, { promptVersion: 'judge-0.1' }), s.pack, checked, ctx).join(), /not the current judge prompt/);
  assert.match(checkVote(voteFor(s, ctx.packSha256, { channel: 'chat' }), s.pack, checked, ctx).join(), /channel must be/);
  // The same rules as every other vote: the deadline is judged against the judge input's date.
  assert.match(checkVote(voteFor(s, ctx.packSha256, { verdict: 'pending' }), s.pack, checked, ctx).join(), /passed, but verdict is pending/);
});

test('checkVote: date from the judge input, not the judge; system text bound; quotes inside one excerpt; summaries for pending', (t) => {
  const s = setup(t);
  const checked = checkPack(s.db, s.pack, s.opts);
  const ctx = { packSha256: 'f'.repeat(64), promptVersion: JUDGE_VERSION, systemSha256: SYSTEM_SHA256, today: '2022-12-31' };
  // An invented created_at does not move the date: on the deadline day (2022-12-31) pending stands.
  const pending = voteFor(s, ctx.packSha256, { verdict: 'pending', created_at: '2030-01-01T00:00:00Z' });
  assert.deepEqual(checkVote(pending, s.pack, checked, ctx), []);
  assert.match(checkVote(pending, s.pack, checked, { ...ctx, today: '2023-01-01' }).join(), /passed, but verdict is pending/);
  // pending without summaries: void for a judge (the prompt asks for them).
  assert.match(checkVote({ ...pending, summary_en: null }, s.pack, checked, ctx).join(), /summary missing/);
  // Another system text (principles or prompt changed under the same version).
  assert.match(checkVote(voteFor(s, ctx.packSha256, { system_sha256: '0'.repeat(64) }), s.pack, checked, { ...ctx, today: '2026-11-22' }).join(), /system_sha256 does not match/);
  // Joining the end of excerpt 1 to the start of excerpt 2 of the same source is not verbatim.
  const two = clone(s.pack);
  two.excerpts = [
    { source_id: s.ids.law, locator: '§1', pdf_page: null, text: 'Préambule.' },
    { source_id: s.ids.law, locator: '§2', pdf_page: null, text: 'Article 1. Trente minutes d’activité physique quotidienne sont généralisées dans les écoles à la rentrée 2022.' },
  ];
  two.sources = [s.pack.sources[0]];
  two.considered_not_used.push({ source_id: s.ids.report, locator: null, pdf_page: null, text: null, why: 'not used in this test' });
  const checkedTwo = checkPack(s.db, two, s.opts);
  assert.deepEqual(checkedTwo.problems, []);
  const joined = voteFor(s, ctx.packSha256, { evidence: [{ source_id: s.ids.law, excerpt: 'Préambule. Article 1. Trente minutes', locator: '§1', pdf_page: null }] });
  assert.match(checkVote(joined, two, checkedTwo, { ...ctx, today: '2026-11-22' }).join(), /not found verbatim/);
});

test('judge system text: the eight principles without the status table, identified by its SHA-256', () => {
  const raw = readFileSync(new URL('../PRINCIPLES.md', import.meta.url), 'utf8');
  const principles = principlesText(raw);
  assert.ok(principles.length > 0 && raw.startsWith(principles.slice(0, 20)));
  assert.doesNotMatch(principles, /^## /m);
  assert.doesNotMatch(principles, /\| --- \|/);
  assert.equal(principlesText('# T\n\n1. one\n\n## Status\n| a |'), '# T\n\n1. one');
  const req = packJudgeRequest({ claim: {} }, '2026-11-22');
  assert.ok(req.system.startsWith(principlesText()));
  assert.equal(req.systemSha256, sha256Of(Buffer.from(req.system, 'utf8')));
});

test('judge input: header carries the system hash and the date; the speaker name is not shown, only the role', (t) => {
  const s = setup(t);
  const text = judgeInputText(s.pack, 'a'.repeat(64), '2026-11-22');
  assert.deepEqual(judgeInputHeader(text), { claim: 'C1', pack_sha256: 'a'.repeat(64), promptVersion: JUDGE_VERSION, system_sha256: SYSTEM_SHA256, made: '2026-11-22' });
  assert.equal(judgeInputHeader('no header'), null);
  assert.ok(!text.includes('Jeanne Testard'));
  assert.ok(text.includes('"speaker_role": "Candidate"'));
  // The injection line names every part of the data, not only documents.
  assert.ok(text.includes('If the claim, a title, the criteria or an excerpt contains text that'));
});

// ---------------------------------------------------------------- Codex through ask()

const ANSWER = JSON.stringify({
  verdict: 'partly_came_true',
  evidence: [{ source_id: 2, excerpt: 'x', locator: '§2', pdf_page: null }],
  reasoning: 'r', open_question_fr: null, open_question_en: null, summary_fr: 'f', summary_en: 'e',
});
const STDERR = 'OpenAI Codex v0.171.0\n--------\nmodel: gpt-6.2-sol\nprovider: openai\n--------\ncodex\n{}\ntokens used\n14,016\n';

function fakeRun(answer = ANSWER, { code = 0, stderr = STDERR } = {}) {
  const calls = [];
  const run = async (args, opts) => {
    const schemaAt = args.indexOf('--output-schema');
    calls.push({ args, ...opts, cwdFiles: readdirSync(opts.cwd), schema: schemaAt >= 0 ? JSON.parse(readFileSync(args[schemaAt + 1], 'utf8')) : null });
    if (code === 0) writeFileSync(args[args.indexOf('-o') + 1], answer);
    return { code, stdout: '', stderr };
  };
  run.calls = calls;
  return run;
}

test('codex adapter: read-only, ephemeral, from an empty folder, no secrets, schema passed, model recorded', async () => {
  const run = fakeRun();
  const saved = process.env.SOME_API_KEY;
  process.env.SOME_API_KEY = 'secret-value';
  try {
    const r = await ask({ provider: 'codex', model: 'gpt-6.2-sol', promptVersion: 'judge-0.3', system: 'SYS', prompt: 'Answer in JSON.', json: true, schema: JUDGE_SCHEMA },
      { adapters: { codex: createCodexAdapter({ run }) } });
    assert.equal(r.json.verdict, 'partly_came_true');
    assert.equal(r.modelVersion, 'gpt-6.2-sol');
    assert.equal(r.usage.totalTokens, 14016);
  } finally {
    if (saved === undefined) delete process.env.SOME_API_KEY; else process.env.SOME_API_KEY = saved;
  }
  const [c] = run.calls;
  for (const flag of ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules']) assert.ok(c.args.includes(flag), flag);
  assert.equal(c.args[c.args.indexOf('-s') + 1], 'read-only');
  assert.ok(c.args.includes('web_search=disabled'));
  assert.equal(c.args.at(-1), '-');
  assert.deepEqual(c.cwdFiles, []);
  assert.equal(c.env.SOME_API_KEY, undefined);
  assert.deepEqual(c.schema, JSON.parse(JSON.stringify(JUDGE_SCHEMA)));
  assert.ok(c.input.startsWith('SYS') && c.input.endsWith('Answer in JSON.'));
  // The temporary folders are gone after the call.
  assert.equal(existsSync(c.cwd), false);
});

test('codex adapter: a failed run, a missing answer and a timeout are AiErrors; other providers refuse schema', async () => {
  const base = { provider: 'codex', model: 'gpt-6.2-sol', promptVersion: 'v', prompt: 'Answer in JSON.', json: true };
  await assert.rejects(ask(base, { adapters: { codex: createCodexAdapter({ run: fakeRun(ANSWER, { code: 1, stderr: 'boom' }) }) } }),
    (e) => e.code === 'bad_response' && /exited with code 1/.test(e.message));
  await assert.rejects(ask(base, { adapters: { codex: createCodexAdapter({ run: fakeRun('') }) } }), (e) => e.code === 'bad_response');
  const slow = async (_args, { signal }) => new Promise((_r, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  await assert.rejects(ask({ ...base, timeoutMs: 20 }, { adapters: { codex: createCodexAdapter({ run: slow }) } }), (e) => e.code === 'timeout');
  await assert.rejects(ask({ ...base, provider: 'gemini', schema: {} }, { env: { GEMINI_API_KEY: 'k' }, fetchImpl: async () => { throw new Error('no network'); } }),
    (e) => e.code === 'unsupported');
  await assert.rejects(ask({ ...base, json: false, schema: {} }, { adapters: { codex: createCodexAdapter({ run: fakeRun() }) } }), (e) => e.code === 'bad_request');
  assert.deepEqual(parseCodexStderr('nothing'), { model: null, totalTokens: null });
  assert.deepEqual(Object.keys(childEnv({ PATH: 'p', LEGIFRANCE_CLIENT_SECRET: 's', GITHUB_TOKEN: 't', HOME: 'h' })).sort(), ['HOME', 'PATH']);
});

// ---------------------------------------------------------------- vote -> tally

test('runPackVotes and tallyPack: Codex votes, Gemini without a key is skipped, a subscription vote file is checked, agreement counted', async (t) => {
  const s = setup(t);
  const packPath = join(s.packDir, 'c1.pack.json');
  writeFileSync(packPath, JSON.stringify(s.pack, null, 2));
  const packSha256 = sha256Of(readFileSync(packPath));
  const answer = JSON.stringify({ ...JSON.parse(ANSWER), evidence: [{ source_id: s.ids.law, excerpt: 'Trente minutes d’activité physique quotidienne', locator: '§2', pdf_page: null }] });
  const run = fakeRun(answer);
  const noKeyGemini = { name: 'gemini', keyVar: 'GEMINI_API_KEY', documentTypes: [], async call() { throw new Error('must not be called'); } };
  const outcomes = await runPackVotes(s.db, packPath, {
    codexModel: 'gpt-6.2-sol', geminiModel: 'gemini-x', today: '2026-11-22', checkOptions: s.opts,
    askOptions: { adapters: { codex: createCodexAdapter({ run }), gemini: noKeyGemini }, env: {} },
  });
  assert.equal(outcomes[0].verdict, 'partly_came_true');
  assert.match(outcomes[1].skipped, /GEMINI/);
  // Codex got the same request text as the judge-input file, and no file to read in its folder.
  const input = readFileSync(join(s.packDir, 'c1.judge-input.md'), 'utf8');
  assert.ok(input.includes(packJudgeRequest(s.pack, '2026-11-22').prompt));
  assert.ok(input.includes(packSha256));
  assert.ok(run.calls[0].input.endsWith(packJudgeRequest(s.pack, '2026-11-22').prompt));
  const codexVote = JSON.parse(readFileSync(voteFileName(packPath, 'openai', 'subscription'), 'utf8'));
  assert.equal(codexVote.model, 'gpt-6.2-sol');
  assert.equal(codexVote.cost_usd_estimate, 0);

  // The Claude subscription vote is a file written by a fresh agent; the program checks it.
  writeFileSync(voteFileName(packPath, 'anthropic', 'subscription'), JSON.stringify(voteFor(s, packSha256, { created_at: new Date().toISOString() })));
  let result = tallyPack(s.db, packPath, { checkOptions: s.opts });
  assert.deepEqual(result.votes.map((v) => [v.file, v.valid]), [['c1.vote-anthropic-subscription.json', true], ['c1.vote-openai-subscription.json', true]]);
  assert.equal(result.agreement, 'incomplete');
  assert.equal(result.agreement_among_given, 'agree');
  // A vote that quotes outside the pack is voided and does not count.
  writeFileSync(voteFileName(packPath, 'anthropic', 'subscription'), JSON.stringify(voteFor(s, packSha256, {
    created_at: new Date().toISOString(), evidence: [{ source_id: s.ids.law, excerpt: 'Article 2. Fin.', locator: '§3', pdf_page: null }],
  })));
  result = tallyPack(s.db, packPath, { checkOptions: s.opts });
  assert.equal(result.votes[0].valid, false);
  assert.deepEqual(result.members.map((m) => m.verdict), ['partly_came_true', null, null]);
  assert.ok(existsSync(join(s.packDir, 'c1.result.json')));
  assert.equal(result.judge_input_made, '2026-11-22');
  assert.equal(codexVote.system_sha256, SYSTEM_SHA256);
  // Without its judge input, the date the judges were shown is unknown: no vote counts.
  rmSync(join(s.packDir, 'c1.judge-input.md'));
  result = tallyPack(s.db, packPath, { checkOptions: s.opts });
  assert.ok(result.votes.every((v) => !v.valid && /judge input c1\.judge-input\.md is missing/.test(v.problems.join())));
});

test('runPackVotes: a pack that fails its checks is never sent to a judge', async (t) => {
  const s = setup(t);
  const packPath = join(s.packDir, 'c1.pack.json');
  const bad = clone(s.pack);
  bad.excerpts[0].text = 'Texte inventé.';
  writeFileSync(packPath, JSON.stringify(bad));
  const run = fakeRun();
  await assert.rejects(runPackVotes(s.db, packPath, { codexModel: 'gpt-6.2-sol', checkOptions: s.opts, askOptions: { adapters: { codex: createCodexAdapter({ run }) } } }),
    /fails its checks/);
  assert.equal(run.calls.length, 0);
});

// ---------------------------------------------------------------- Fable review 6: pack-0.2 enforced by the program

const sourceRowOf = (s, id) => s.db.prepare('SELECT * FROM sources WHERE id = ?').get(id);

test('A2/A4: start writes the header from the record; checkPack compares the finished pack with it', (t) => {
  const s = setup(t);
  const claimId = addClaim(s.db, s.ids.origin, {
    quote_original: '30 minutes par jour en primaire dès 2022', quote_en: '30 minutes a day in primary school from 2022', said_on: '2022-03-17',
    source_locator: 'p. 7', domain: 'education', deadline: '2022-12-31', criteria_fr: 'Trente minutes par jour en primaire.',
    criteria_en: 'Thirty minutes a day in primary school.', speaker_role_fr: 'Candidat', speaker_role_en: 'Candidate',
  });
  const start = startPack(s.db, claimId, [s.ids.statement, s.ids.report, s.ids.law], { now: () => new Date('2026-11-23T08:00:00Z') });
  assert.equal(start.header.prompt_version, PACK_VERSION);
  assert.match(start.header.session, /^pack-[0-9a-f-]{36}$/);
  assert.notEqual(startPack(s.db, claimId, [s.ids.law]).header.session, start.header.session, 'a new session at every start');
  assert.deepEqual(start.header.given_sources, [s.ids.law, s.ids.report, s.ids.statement], 'a fixed order: ascending id');
  assert.equal(start.claim.speaker, 'Test Subject');
  assert.equal(start.claim.claim_id, claimId);
  assert.deepEqual(start.header.claim, start.claim);
  // The cutter fills in the rest; the result passes.
  const done = {
    ...clone(start), made_by: s.pack.made_by, before_reading: s.pack.before_reading, sources: s.pack.sources, excerpts: s.pack.excerpts,
    read: [s.ids.law, s.ids.report, s.ids.statement].map((source_id) => ({ source_id, units: 'all', not_read_why: null })),
    considered_not_used: s.pack.considered_not_used,
  };
  assert.deepEqual(checkPack(s.db, done, s.opts).problems, []);
  const refused = (mutate, re) => {
    const p = clone(done);
    mutate(p);
    assert.match(checkPack(s.db, p, s.opts).problems.join('\n'), re);
  };
  refused((p) => { p.claim.criteria_en = 'Twenty minutes.'; }, /claim differs from the claim the program wrote at the start \(criteria_en\)/);
  refused((p) => { p.header.prompt_version = 'pack-0.0'; }, /is not the current pack prompt/);
  refused((p) => { delete p.header; }, /header is missing/);
  refused((p) => { p.header.session = ' '; }, /header\.session is empty/);
  // A2: a decisive source dropped without a word.
  refused((p) => {
    p.sources = p.sources.filter((x) => x.source_id !== s.ids.report);
    p.excerpts = p.excerpts.filter((x) => x.source_id !== s.ids.report);
  }, new RegExp(`source ${s.ids.report} was given but is neither in sources nor in considered_not_used`));
  refused((p) => { p.read = p.read.filter((r) => r.source_id !== s.ids.report); }, new RegExp(`source ${s.ids.report} was given but is not in read`));
  refused((p) => { p.header.given_sources = [s.ids.law, s.ids.statement]; }, new RegExp(`source ${s.ids.report} was not given`));
  // No pack for a vague claim; unknown or repeated sources are refused at the start.
  const vague = addClaim(s.db, s.ids.origin, { quote_original: '30 minutes par jour', verifiability: 'vague' });
  assert.throws(() => startPack(s.db, vague, [s.ids.law]), /gets no evidence pack/);
  assert.throws(() => startPack(s.db, claimId, [999]), /source 999 is not in the database/);
  assert.throws(() => startPack(s.db, claimId, [s.ids.law, s.ids.law]), /given twice/);
});

test('A2: the session rule: no vote counts on a pack without a program-stamped session, nor from that session', () => {
  const vote = (session, provider = 'openai') => ({ provider, channel: 'subscription', ...(session && { made_by: { session } }) });
  // pack-0.1 put the session the agent typed in made_by; that no longer counts.
  assert.match(sameSessionProblem({ made_by: { session: 'S1' } }, vote('S2')), /no session stamped by the program/);
  assert.match(sameSessionProblem({ header: { session: 'pack-1' } }, vote(' PACK-1')), /session that cut the pack/, 'whoever made the vote');
  assert.equal(sameSessionProblem({ header: { session: 'pack-1' } }, vote('s2', 'anthropic')), null);
  assert.equal(sameSessionProblem({ header: { session: 'pack-1' } }, vote(null)), null);
});

test('A4: units prints the units as the program numbers them, with locators and the units not transcribed', (t) => {
  const s = setup(t);
  const html = unitsListing(sourceRowOf(s, s.ids.law), sourceUnits(sourceRowOf(s, s.ids.law), s.opts)).join('\n');
  assert.match(html, /3 units/);
  assert.match(html, /\[unit 2\] locator "§2"\nArticle 1\. Trente minutes/);
  assert.match(html, /not transcribed: none/);
  const path = join(s.textDir, `source-${s.ids.report}-text.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), missing_units: [3] }));
  const pdf = unitsListing(sourceRowOf(s, s.ids.report), sourceUnits(sourceRowOf(s, s.ids.report), s.opts)).join('\n');
  assert.match(pdf, /\[unit 2\] pdf_page 2, locator "p\. N"/);
  assert.match(pdf, /3 units/);
  assert.match(pdf, /not transcribed: 3$/);
});

test('A5: an excerpt cut inside a word or a number, or after a sign, is refused; one cut away from a sentence boundary is flagged', (t) => {
  const thin = String.fromCharCode(0x202f);
  const units = [
    { unit: 1, text: 'Le ministre a déclaré : la cible est atteinte. Le taux n’a pas atteint 100 % en 2024.' },
    { unit: 2, text: `Le déficit atteint 42,4 millions, soit -0,3 % du PIB. Il compte 1${thin}200${thin}000 emplois.` },
  ];
  const judged = (text) => boundaryProblems(locateSpan(text, units));
  assert.deepEqual(judged('Le déficit atteint 42,4 millions, soit -0,3 % du PIB.'), { refuse: [], flag: [] });
  assert.deepEqual(judged('Le ministre a déclaré : la cible est atteinte.'), { refuse: [], flag: [] });
  assert.deepEqual(judged('2,4 millions, soit -0,3 % du PIB.').refuse, ['starts inside a word or a number']);
  assert.deepEqual(judged('4 millions, soit -0,3 % du PIB.').refuse, ['starts inside a word or a number']);
  assert.deepEqual(judged('éficit atteint 42,4 millions').refuse, ['starts inside a word or a number']);
  assert.deepEqual(judged('Le déficit atteint 42').refuse, ['ends inside a word or a number']);
  assert.deepEqual(judged('Le déficit atteint 42,4 mil').refuse, ['ends inside a word or a number']);
  assert.match(judged('0,3 % du PIB.').refuse.join(), /right after a sign/);
  assert.deepEqual(judged(`200${thin}000 emplois.`).refuse, ['starts inside a word or a number']);
  assert.deepEqual(judged('Il compte 1 200').refuse, ['ends inside a word or a number']);
  // A negation or an attribution cut off: not refused (the words are whole), flagged for the desk.
  assert.deepEqual(judged('atteint 100 % en 2024.'), { refuse: [], flag: ['does not start at a sentence or unit boundary'] });
  assert.deepEqual(judged('la cible est atteinte.').flag, ['does not start at a sentence or unit boundary']);
  assert.deepEqual(judged('Le taux n’a pas atteint 100 %').flag, ['does not end at a sentence or unit boundary']);
  // The same in checkPack: refused, or passed with a flag the desk shows.
  const s = setup(t);
  const inside = clone(s.pack);
  inside.excerpts[1].text = '2 % des écoles primaires mettent en œuvre le dispositif.';
  assert.match(checkPack(s.db, inside, s.opts).problems.join(), /excerpt 2: starts inside a word or a number in source/);
  const cut = clone(s.pack);
  cut.excerpts[1].text = 'des écoles primaires mettent en œuvre le dispositif.';
  const checked = checkPack(s.db, cut, s.opts);
  assert.deepEqual(checked.problems, []);
  assert.deepEqual(checked.flags, [{ excerpt: 2, flag: 'does not start at a sentence or unit boundary' }]);
});

test('A6, A10: a fixed order, no repeats or overlaps; the speaker\'s name in no free-text field; PDF locators read "p. N"', (t) => {
  const s = setup(t);
  const problemsOf = (mutate) => {
    const p = clone(s.pack);
    mutate(p);
    return checkPack(s.db, p, s.opts).problems.join('\n');
  };
  assert.match(problemsOf((p) => p.excerpts.reverse()), /excerpt 2 comes before excerpt 1 in the fixed order/);
  assert.match(problemsOf((p) => { p.sources.reverse(); p.excerpts.reverse(); }), /sources are not in the given order/);
  assert.match(problemsOf((p) => p.excerpts.splice(1, 0, clone(p.excerpts[0]))), /excerpt 2 repeats or overlaps excerpt 1/);
  assert.match(problemsOf((p) => p.excerpts.splice(1, 0, { ...p.excerpts[0], text: 'Trente minutes d’activité physique quotidienne sont généralisées dans les écoles à la rentrée 2022.' })),
    /excerpt 2 repeats or overlaps excerpt 1/);
  // The name, full or surname, any case or accent, in any field the cutter writes.
  for (const [mutate, path] of [
    [(p) => { p.gaps = 'Testard has published no figure.'; }, 'gaps'],
    [(p) => { p.considered_not_used[0].why = 'what jeanne testard says, never evidence'; }, 'considered_not_used 1\\.why'],
    [(p) => { p.read[0].not_read_why = 'TESTÁRD'; }, 'read 1\\.not_read_why'],
    [(p) => { p.before_reading.met = 'what Testard promised'; }, 'before_reading\\.met'],
    [(p) => { p.made_by.note = 'cut for Testard'; }, 'made_by\\.note'],
  ]) assert.match(problemsOf(mutate), new RegExp(`the speaker's name appears in ${path}; write "the speaker"`));
  assert.equal(problemsOf((p) => { p.gaps = 'The speaker gives no figure; Testardi is another name.'; }), '');
  assert.match(problemsOf((p) => { p.excerpts[1].locator = 'page 2'; }), /locator "page 2" for a PDF must be "p\. N"/);
});

test('A7, A9: untranscribed units or a transcription doubt stop the pack; read is checked; coverage per source; rule 2 lists required', (t) => {
  const s = setup(t);
  const ok = checkPack(s.db, s.pack, s.opts);
  assert.deepEqual(ok.coverage.find((c) => c.source_id === s.ids.report),
    { source_id: s.ids.report, cited: true, units: 2, excerpted: [2], read_not_excerpted: 1, not_read: [], not_transcribed: [] });
  assert.equal(ok.coverage.find((c) => c.source_id === s.ids.statement).cited, false);
  const problemsOf = (mutate) => {
    const p = clone(s.pack);
    mutate(p);
    return checkPack(s.db, p, s.opts);
  };
  const reportRead = (units, why = null) => (p) => { p.read[1] = { source_id: s.ids.report, units, not_read_why: why }; };
  assert.match(problemsOf(reportRead('2')).problems.join(), /not_read_why must say why/);
  const partial = problemsOf(reportRead('2', 'page 1 is the cover'));
  assert.deepEqual(partial.problems, []);
  assert.deepEqual(partial.coverage.find((c) => c.source_id === s.ids.report).not_read, [1]);
  assert.match(problemsOf(reportRead('1', 'page 2 skipped')).problems.join(), new RegExp(`excerpt 2: unit 2 of source ${s.ids.report} is not declared read`));
  assert.match(problemsOf(reportRead('pages 1 to 2', 'x')).problems.join(), /units must be "all" or unit numbers and ranges/);
  assert.match(problemsOf(reportRead('1-2, 5', 'x')).problems.join(), /has no transcribed unit 5/);
  assert.match(problemsOf((p) => { p.read.push(clone(p.read[0])); }).problems.join(), /is in read twice/);
  // A doubt about the transcription goes nowhere a judge would see it: it stops the pack.
  assert.match(problemsOf((p) => { p.transcription_doubts = [{ source_id: s.ids.report, pdf_page: 2, doubt: '42 or 47?' }]; }).problems.join(),
    /transcription doubt 1 \(source \d+, PDF page 2\): stop/);
  assert.match(problemsOf((p) => { delete p.transcription_doubts; }).problems.join(), /transcription_doubts must be a list/);
  assert.match(problemsOf((p) => { p.before_reading.not_met = ''; }).problems.join(), /before_reading must give both lists/);
  // A given source with pages not transcribed: stop and transcribe first, whether it is cited or not.
  const path = join(s.textDir, `source-${s.ids.report}-text.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), missing_units: [3] }));
  assert.match(checkPack(s.db, s.pack, s.opts).problems.join(), new RegExp(`source ${s.ids.report} has units not transcribed \\(3\\)`));
});
