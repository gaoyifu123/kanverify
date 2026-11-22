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
import { JUDGE_SCHEMA, packJudgeRequest, runPackVotes, tallyPack, voteFileName } from '../src/jury.js';
import { MAX_PACK_TOKENS, checkCandidatesFile, checkPack, checkVote, sha256Of } from '../src/pack.js';
import { addSource, freshDb } from './helpers.js';

const JUDGE_VERSION = loadPrompt(new URL('../team/run/judge-prompt.md', import.meta.url)).version;
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
  const law = addSource(db, 'gazette', { sha256: store(LAW_HTML), media_type: 'text/html', title: 'BO', publisher: 'Ministère', url: 'https://example.org/bo' });
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
      key: 'C1', spec: '1:27', speaker: 'Test Speaker',
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
    gaps: null,
  };
  return { db, dir, evidenceDir, textDir, packDir, opts: { evidenceDir, textDir }, ids: { origin, law, report, statement }, pack, meta };
}

const clone = (x) => JSON.parse(JSON.stringify(x));

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
});

function voteFor(s, packSha256, over = {}) {
  return {
    kind: 'kanverify-vote', format: 1, claim: 'C1', pack_file: 'c1.pack.json', pack_sha256: packSha256,
    provider: 'anthropic', channel: 'subscription', via: 'claude-code', model: 'claude-opus-5-5', promptVersion: JUDGE_VERSION,
    created_at: '2026-11-22T21:00:00+01:00', verdict: 'partly_came_true',
    evidence: [{ source_id: s.ids.law, excerpt: 'Trente minutes d’activité physique quotidienne sont généralisées', locator: '§2', pdf_page: null }],
    reasoning: 'r', open_question_fr: null, open_question_en: null, summary_fr: 'f', summary_en: 'e', ...over,
  };
}

test('checkVote: a vote may quote only from the pack, about this version of the pack, with the current prompt', (t) => {
  const s = setup(t);
  const checked = checkPack(s.db, s.pack, s.opts);
  const ctx = { packSha256: 'f'.repeat(64), promptVersion: JUDGE_VERSION };
  assert.deepEqual(checkVote(voteFor(s, ctx.packSha256), s.pack, checked, ctx), []);
  // In the archived source but not in the pack: the judge did not see it, so it cannot quote it.
  const outside = voteFor(s, ctx.packSha256, { evidence: [{ source_id: s.ids.law, excerpt: 'Article 2. Fin.', locator: '§3', pdf_page: null }] });
  assert.match(checkVote(outside, s.pack, checked, ctx).join(), /not found verbatim/);
  assert.match(checkVote(voteFor(s, 'a'.repeat(64)), s.pack, checked, ctx).join(), /pack_sha256 does not match/);
  assert.match(checkVote(voteFor(s, ctx.packSha256, { promptVersion: 'judge-0.1' }), s.pack, checked, ctx).join(), /not the current judge prompt/);
  assert.match(checkVote(voteFor(s, ctx.packSha256, { channel: 'chat' }), s.pack, checked, ctx).join(), /channel must be/);
  // The same rules as every other vote: the deadline is judged against the vote's own date.
  assert.match(checkVote(voteFor(s, ctx.packSha256, { verdict: 'pending' }), s.pack, checked, ctx).join(), /passed, but verdict is pending/);
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
