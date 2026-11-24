// Shared builders for the tests. Each returns the id of the row it created.

import { openDatabase } from '../src/db.js';
import { loadStandard } from '../src/standard.js';

/** The current verdict standard's version (docs/methodology/verdict-standard.md). */
export const RULES_VERSION = loadStandard().version;

export const SHA = 'a'.repeat(64);

export function freshDb(path = ':memory:') {
  const db = openDatabase(path);
  db.prepare("INSERT INTO subjects (kind, name, country) VALUES ('person', 'Test Subject', 'FR')").run();
  return db;
}

export function addSource(db, kind, overrides = {}) {
  const row = {
    kind,
    url: `https://example.org/${kind}`,
    title: `${kind} document`,
    publisher: 'Example publisher',
    published_on: '2025-01-01',
    retrieved_on: '2026-11-22',
    sha256: SHA,
    media_type: 'application/pdf',
    lang: 'fr',
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO sources (kind, url, title, publisher, published_on, retrieved_on, sha256, media_type, lang)
       VALUES (:kind, :url, :title, :publisher, :published_on, :retrieved_on, :sha256, :media_type, :lang)`
    )
    .run(row);
  return Number(result.lastInsertRowid);
}

export function addClaim(db, sourceId, overrides = {}) {
  const row = {
    subject_id: 1,
    speaker_role_fr: 'Candidat à la présidence, 2022',
    speaker_role_en: 'Candidate for president, 2022',
    type: 'promise',
    domain: 'economy',
    quote_original: 'Nous ferons X avant 2027.',
    lang: 'fr',
    quote_fr: null, // the original is French
    quote_en: 'We will do X before 2027.',
    said_on: '2022-03-17',
    source_id: sourceId,
    source_locator: 'p. 4',
    verifiability: 'measurable',
    deadline: '2027-05-13',
    deadline_basis: 'stated',
    criteria_fr: 'X est en vigueur selon le Journal officiel.',
    criteria_en: 'X is in force according to the official gazette.',
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO claims (subject_id, speaker_role_fr, speaker_role_en, type, domain, quote_original, lang,
                           quote_fr, quote_en, said_on, source_id, source_locator, verifiability,
                           deadline, deadline_basis, criteria_fr, criteria_en)
       VALUES (:subject_id, :speaker_role_fr, :speaker_role_en, :type, :domain, :quote_original, :lang,
               :quote_fr, :quote_en, :said_on, :source_id, :source_locator, :verifiability,
               :deadline, :deadline_basis, :criteria_fr, :criteria_en)`
    )
    .run(row);
  return Number(result.lastInsertRowid);
}

export const VERDICTS = ['unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true'];
/** Verdicts that assert an outcome and so need evidence. */
export const OUTCOMES = ['came_true', 'partly_came_true', 'not_came_true'];

/** Every verdict except 'pending' gets a summary in both languages unless overridden. */
export function addVerdict(db, claimId, verdict, overrides = {}) {
  const outcome = verdict !== 'pending';
  const row = {
    claim_id: claimId,
    verdict,
    summary_fr: outcome ? 'Résumé du résultat.' : null,
    summary_en: outcome ? 'Summary of the outcome.' : null,
    open_question_fr: null,
    open_question_en: null,
    decided_by: 'human',
    // Decision 0014 (format 12): every verdict records the rules it was judged by.
    rules_version: RULES_VERSION,
    rules_applied: JSON.stringify(verdict === 'unverifiable' ? ['VG-1'] : verdict === 'not_came_true' ? ['EV-3', 'RN-1'] : verdict === 'came_true' ? ['EA-1', 'OC-1', 'EV-1'] : ['OC-1', 'EV-1']),
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO verdicts (claim_id, verdict, summary_fr, summary_en, open_question_fr, open_question_en, decided_by, rules_version, rules_applied)
       VALUES (:claim_id, :verdict, :summary_fr, :summary_en, :open_question_fr, :open_question_en, :decided_by, :rules_version, :rules_applied)`
    )
    .run(row);
  return Number(result.lastInsertRowid);
}

/** Sources default to French, so by default there is no French translation and an English one. */
export function addEvidence(db, verdictId, sourceId, excerpt = 'Passage cité.', { excerpt_fr = null, excerpt_en = 'Quoted passage.' } = {}) {
  const result = db
    .prepare(
      "INSERT INTO verdict_evidence (verdict_id, source_id, excerpt, excerpt_fr, excerpt_en, locator) VALUES (?, ?, ?, ?, ?, 'art. 1')"
    )
    .run(verdictId, sourceId, excerpt, excerpt_fr, excerpt_en);
  return Number(result.lastInsertRowid);
}

export function addVote(db, claimId, model, verdict, overrides = {}) {
  const row = {
    claim_id: claimId,
    round: 1,
    provider: 'provider-a',
    model,
    prompt_version: 'judge-0.1',
    verdict,
    reasoning: 'The gazette shows the law in force.',
    open_question: null,
    evidence_json: '[]',
    pack_sha256: 'c'.repeat(64),
    ...overrides,
  };
  const result = db
    .prepare(
      `INSERT INTO jury_votes (claim_id, round, provider, model, prompt_version, verdict, reasoning, open_question, evidence_json, pack_sha256)
       VALUES (:claim_id, :round, :provider, :model, :prompt_version, :verdict, :reasoning, :open_question, :evidence_json, :pack_sha256)`
    )
    .run(row);
  return Number(result.lastInsertRowid);
}

/** A claim from a platform with a 'came_true' verdict resting on one law. Not yet confirmed. */
export function readyClaim(db) {
  const platform = addSource(db, 'platform');
  const law = addSource(db, 'law', { sha256: 'b'.repeat(64) });
  const claim = addClaim(db, platform);
  const verdict = addVerdict(db, claim, 'came_true');
  const evidence = addEvidence(db, verdict, law, 'Article 1 : X entre en vigueur le 1er janvier 2025.', {
    excerpt_fr: null,
    excerpt_en: 'Article 1: X enters into force on 1 January 2025.',
  });
  return { platform, law, claim, verdict, evidence };
}

export function ledger(db, claimId) {
  return db
    .prepare('SELECT id, status, snapshot, note_fr, note_en, confirmed_by, review_seconds FROM publications WHERE claim_id = ? ORDER BY id')
    .all(claimId)
    .map((row) => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
}

export function publicRecord(db, claimId) {
  const row = db.prepare('SELECT status, snapshot FROM current_publications WHERE claim_id = ?').get(claimId);
  return row ? { status: row.status, snapshot: JSON.parse(row.snapshot) } : null;
}

export function publishableSnapshot(db, claimId) {
  const row = db.prepare('SELECT snapshot FROM publishable WHERE claim_id = ?').get(claimId);
  return row ? row.snapshot : null;
}

/** The jury settings tests use (shape of src/jury-members.json), so a change to the real settings does not change a test. */
export const TEST_JURY = Object.freeze({
  kind: 'kanverify-jury-members', format: 1,
  members: {
    openai: { channel: 'subscription', model: 'gpt-6.2-sol' },
    anthropic: { channel: 'subscription', model: 'claude-opus-5-5' },
    gemini: { channel: 'off', model: null },
    mistral: { channel: 'off', model: null },
  },
});

/**
 * The init report line Claude Code 2.1.330 prints first with --output-format stream-json --verbose,
 * as a clean isolated run gives it (src/ai/claude-cli.js checks it). For fake claude runs in tests.
 */
export function claudeInitLine(cwd, over = {}) {
  return JSON.stringify({
    type: 'system', subtype: 'init', cwd, session_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', tools: [], mcp_servers: [],
    model: 'claude-opus-5-5', permissionMode: 'dontAsk', slash_commands: [], apiKeySource: 'none', claude_code_version: '2.1.330',
    skills: [], plugins: ['cc-plugin-agents-md', 'cc-plugin-privacy', 'cc-plugin-plugin-authoring'].map((name) => ({ name, path: 'builtin', source: `${name}@builtin` })),
    ...over,
  });
}

/** The --json events of a clean Codex judge run (codex-cli 0.171.0): a turn with only its answer. For fake codex runs in tests. */
export const CODEX_EVENTS = [
  { type: 'thread.started', thread_id: 't' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'reasoning', text: 'r' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{}' } },
  { type: 'turn.completed', usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100 } },
].map((e) => JSON.stringify(e)).join('\n');

/** What a Codex command-line vote records about its run (src/jury.js re-checks it when the file is read). */
export const CODEX_VOTE_FACTS = Object.freeze({
  made_by: { role: 'judge', tool: 'codex-cli', tool_version: '0.172.0' },
  raw: { tool: 'codex exec', cli_version: '0.172.0', model_reported: false, run: { items: [{ type: 'reasoning', length: 10 }, { type: 'agent_message', length: 400 }] } },
});

/**
 * The answer file a fake codex run writes to: the argument after -o. Throws when there is none (a call
 * such as --version), so a fake can never write a file named after another argument into the folder
 * the tests run from (a stray "--version" file appeared in the project root on 2026-11-24 that way).
 */
export function codexOutFile(args) {
  const at = args.indexOf('-o');
  if (at < 0 || typeof args[at + 1] !== 'string') throw new Error(`fake codex: no -o in ${JSON.stringify(args)}`);
  return args[at + 1];
}
