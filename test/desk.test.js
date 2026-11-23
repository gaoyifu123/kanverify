// The review desk (src/desk.js): auto-import, queue A, queue B, undo, the confirmation window,
// and the local server's refusals. Scratch databases and temporary folders only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evidencePath, storeEvidenceBytes } from '../src/archive.js';
import { autoImport, candidateKey, claimQuoteSha, createDesk, hasFigures, readActions, startDeskServer } from '../src/desk.js';
import { renderCandidatePage } from '../src/desk-view.js';
import { closeRound, judgeInputText, voteContext } from '../src/jury.js';
import { withdraw } from '../src/ledger.js';
import { sha256Of } from '../src/pack.js';
import { sameSessionProblem } from '../src/rules.js';
import { addClaim, addSource, freshDb } from './helpers.js';

const ORIGIN_HTML = '<html><body><p>Préambule.</p><p>Nous ferons X avant 2027. Nous baisserons Y.</p><p>Nous continuerons Z.</p></body></html>';
const LAW_HTML = '<html><body><p>Article 1.</p><p>X est en vigueur depuis 2025.</p></body></html>';

const base = {
  lang: 'fr', type: 'promise', domain: 'economy', verifiability: 'measurable', deadline: '2022-12-31', deadline_basis: 'stated',
  criteria_fr: 'X est en vigueur.', criteria_en: 'X is in force.', speaker_role_fr: 'Candidat', speaker_role_en: 'Candidate',
  quote_fr: null, notes: null,
};
const CANDIDATES = [
  { ...base, quote_original: 'Nous ferons X avant 2027.', quote_en: 'We will do X before 2027.', unit: 2, locator: '§2' },
  { ...base, quote_original: 'Nous baisserons Y.', quote_en: 'We will lower Y.', unit: 2, locator: '§2' },
  { ...base, quote_original: 'Nous continuerons Z.', quote_en: 'We will continue Z.', unit: 3, locator: '§3' },
  { ...base, quote_original: 'Nous inventerons W.', quote_en: 'We will invent W.', unit: 3, locator: '§3' },
];

function setup(t, { subjectInFile = true, pdfLaw = false, lawKind = 'law' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-desk-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const evidenceDir = join(dir, 'evidence');
  const textDir = join(dir, 'text');
  const candDir = join(dir, 'candidates');
  const packDir = join(dir, 'packs');
  for (const d of [textDir, candDir, packDir]) mkdirSync(d, { recursive: true });
  const db = freshDb();
  t.after(() => db.close());
  const store = (text) => storeEvidenceBytes(evidenceDir, Buffer.from(text)).sha256;
  const originSha = store(ORIGIN_HTML);
  const origin = addSource(db, 'platform', { sha256: originSha, media_type: 'text/html', title: 'Programme', published_on: '2022-03-17', url: 'https://example.org/p' });
  // The evidence: a web page by default; a PDF with its saved transcription when pdfLaw is set.
  const lawSha = store(pdfLaw ? '%PDF-1.4 loi' : LAW_HTML);
  const law = addSource(db, lawKind, { sha256: lawSha, media_type: pdfLaw ? 'application/pdf' : 'text/html', title: 'Loi', publisher: 'JO', url: 'https://example.org/l' });
  if (pdfLaw) {
    writeFileSync(join(textDir, `source-${law}-text.json`), JSON.stringify({
      source_id: law, sha256: lawSha, unit_kind: 'pdf_page', method: 'model-transcription', model: 'm', missing_units: [],
      units: [{ unit: 1, text: 'Article 1.' }, { unit: 2, text: 'X est en vigueur depuis 2025.' }],
    }));
  }
  const candName = 'source-1-test.json';
  const candPath = join(candDir, candName);
  writeFileSync(candPath, JSON.stringify({
    kind: 'kanverify-extraction-candidates', provider: 'anthropic', model: 'm', prompt_version: 'extract-0.3',
    ...(subjectInFile && { subject_id: 1 }), source: { id: origin, sha256: originSha }, candidates: CANDIDATES,
  }));
  const entry = (i, over = {}) => ({
    id: `s${origin}-${i}`, source_id: origin, source_file: candName, index: i, locator: CANDIDATES[i - 1].locator,
    quote_original: CANDIDATES[i - 1].quote_original, lang: 'fr', status: 'unique', duplicate_of: [], possible_duplicate_of: [],
    proposed_fixes: [], flags: [], needs_founder: false, ...over,
  });
  const reviewPath = join(candDir, 'review-test.json');
  writeFileSync(reviewPath, JSON.stringify({
    kind: 'kanverify-candidate-review', inputs: [candName],
    candidates: [
      entry(1, { flags: [{ kind: 'consistency_note', reason: 'info only' }] }),
      entry(2, { flags: [{ kind: 'not_a_promise', severity: 'high', reason: 'Lowering what? <b>no</b>' }] }),
      entry(3, { proposed_fixes: [{ field: 'domain', from: 'economy', to: 'tax', reason: 'Z is a tax.', needs_founder: false }] }),
      entry(4),
    ],
  }));
  const logPath = join(dir, 'desk', 'actions.jsonl');
  let clock = Date.parse('2026-11-22T10:00:00Z');
  const now = () => new Date(clock);
  const advance = (ms) => { clock += ms; };
  const opts = { evidenceDir, textDir, logPath, reviewPath, now };
  const desk = createDesk({ db, packDirs: [packDir], ...opts });
  const key = (i) => candidateKey(candName, CANDIDATES[i - 1].quote_original);
  return { db, dir, desk, opts, origin, law, candPath, candName, reviewPath, logPath, packDir, advance, store, key, evidenceDir };
}

/** A pack for workspace claim `claimId` (candidate 1) and its votes; then the jury step closes the round, as tally does (close: false leaves it open). */
function writePack(s, verdicts = ['came_true', 'came_true'], { claim: claimOver = {}, cutSession = null, sessions = [], close = true } = {}) {
  const c = CANDIDATES[0];
  const law = s.db.prepare('SELECT * FROM sources WHERE id = ?').get(s.law);
  const where = law.media_type === 'application/pdf' ? { locator: 'p. 2', pdf_page: 2 } : { locator: '§2', pdf_page: null };
  const pack = {
    kind: 'kanverify-evidence-pack', format: 1, made_by: { role: 'evidence', channel: 'subscription', provider: 'anthropic', model: 'claude-opus-5-5', ...(cutSession && { session: cutSession }) },
    claim: {
      key: 'C1', speaker: 'Test Subject', origin: { source_id: s.origin, title: 'Programme', published_on: '2022-03-17', locator: '§2' },
      ...Object.fromEntries(['quote_original', 'lang', 'quote_fr', 'quote_en', 'type', 'domain', 'verifiability', 'deadline', 'deadline_basis', 'criteria_fr', 'criteria_en', 'speaker_role_fr', 'speaker_role_en'].map((f) => [f, c[f]])),
      ...claimOver,
    },
    sources: [{ source_id: s.law, kind: law.kind, title: 'Loi', publisher: 'JO', published_on: '2025-01-01', url: 'https://example.org/l', lang: 'fr' }],
    excerpts: [{ source_id: s.law, locator: where.locator, pdf_page: where.pdf_page, text: 'X est en vigueur depuis 2025.', text_en: 'X has been in force since 2025.' }],
    considered_not_used: [], gaps: null,
  };
  const bytes = Buffer.from(JSON.stringify(pack));
  const packPath = join(s.packDir, 'c1.pack.json');
  writeFileSync(packPath, bytes);
  writeFileSync(join(s.packDir, 'c1.judge-input.md'), judgeInputText(pack, sha256Of(bytes), '2026-11-22'));
  const ctx = voteContext(packPath, sha256Of(bytes));
  const members = [['anthropic', 'subscription'], ['openai', 'subscription'], ['gemini', 'api']];
  verdicts.forEach((verdict, i) => {
    const [provider, channel] = members[i];
    writeFileSync(join(s.packDir, `c1.vote-${provider}-${channel}.json`), JSON.stringify({
      kind: 'kanverify-vote', format: 1, claim: 'C1', pack_file: 'c1.pack.json', pack_sha256: sha256Of(bytes), provider, channel,
      model: `model-${provider}`, promptVersion: ctx.promptVersion, system_sha256: ctx.systemSha256, verdict,
      evidence: [{ source_id: s.law, excerpt: 'X est en vigueur depuis 2025.', locator: where.locator, pdf_page: where.pdf_page }],
      ...(sessions[i] && { made_by: { session: sessions[i] } }),
      reasoning: `reasoning ${i + 1}`, open_question_fr: null, open_question_en: null,
      summary_fr: `X est en vigueur (vote ${i + 1}).`, summary_en: `X is in force (vote ${i + 1}).`,
    }));
  });
  if (close) closeRound(packPath, { now: () => new Date(Date.now()) });
  return packPath;
}
const packPathOf = (s) => join(s.packDir, 'c1.pack.json');

const claims = (db) => db.prepare('SELECT * FROM claims ORDER BY id').all();
/** The round the page shows for this item: adopt, edit and confirm must carry it. */
const roundOf = (s, id) => s.desk.verdictView(id).round;
const importOne = (s) => autoImport(s.db, s.candPath, s.opts);

test('auto-import: only unflagged candidates that pass the verbatim check, logged as the program, once', (t) => {
  const s = setup(t);
  const r = importOne(s);
  assert.deepEqual(r.imported.map((x) => x.id), [`s${s.origin}-1`]);
  assert.deepEqual(r.flagged, [`s${s.origin}-2`, `s${s.origin}-3`]);
  assert.deepEqual(r.failed, [`s${s.origin}-4`]);
  const [row] = claims(s.db);
  assert.equal(row.subject_id, 1);
  assert.equal(row.said_on, '2022-03-17');
  assert.equal(row.source_locator, '§2');
  const log = readActions(s.logPath);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'auto_accept');
  assert.equal(log[0].by, 'program');
  assert.equal(log[0].claim_id, row.id);
  // Running again inserts nothing.
  assert.equal(importOne(s).imported.length, 0);
  assert.equal(claims(s.db).length, 1);
});

test('auto-import: the speaker comes from the file or --subject, never two different ones; the file must have been reviewed', (t) => {
  const s = setup(t, { subjectInFile: false });
  assert.throws(() => importOne(s), /no speaker/);
  assert.throws(() => autoImport(s.db, s.candPath, { ...s.opts, subject: 99 }), /subject 99 is not in the database/);
  autoImport(s.db, s.candPath, { ...s.opts, subject: 1 });
  assert.equal(JSON.parse(readFileSync(s.candPath, 'utf8')).subject_id, 1, 'the speaker is written into the file');
  assert.throws(() => autoImport(s.db, s.candPath, { ...s.opts, subject: 2 }), /refusing/);
  writeFileSync(s.reviewPath, JSON.stringify({ kind: 'kanverify-candidate-review', inputs: ['other.json'], candidates: [] }));
  assert.throws(() => importOne(s), /has not been reviewed/);
});

test('queue A: flagged and failing candidates; accept writes the claim, undo takes it back', (t) => {
  const s = setup(t);
  importOne(s);
  const ids = s.desk.candidateQueue().items.map((x) => x.label);
  assert.deepEqual(ids, [`s${s.origin}-2`, `s${s.origin}-3`, `s${s.origin}-4`], 'a consistency note alone does not queue s1-1');
  s.desk.candidateAction({ item: s.key(2), action: 'accept', seconds: 7 });
  const accepted = claims(s.db).find((c) => c.quote_original === 'Nous baisserons Y.');
  assert.equal(accepted.subject_id, 1);
  const entry = readActions(s.logPath).at(-1);
  assert.equal(entry.action, 'accept');
  assert.equal(entry.seconds, 7);
  assert.equal(entry.claim_id, accepted.id);
  assert.ok(!s.desk.candidateQueue().items.some((x) => x.id === s.key(2)));
  s.desk.undo();
  assert.ok(!claims(s.db).some((c) => c.quote_original === 'Nous baisserons Y.'));
  assert.equal(readActions(s.logPath).at(-1).undoes, entry.id);
  assert.ok(s.desk.candidateQueue().items.some((x) => x.id === s.key(2)), 'back in the queue');
});

test('queue A: undo refuses to delete a claim changed since it was accepted', (t) => {
  const s = setup(t);
  s.desk.candidateAction({ item: s.key(2), action: 'accept', seconds: 1 });
  s.db.prepare("UPDATE claims SET criteria_en = 'changed' WHERE quote_original = 'Nous baisserons Y.'").run();
  assert.throws(() => s.desk.undo(), /later changes/);
  assert.ok(claims(s.db).some((c) => c.quote_original === 'Nous baisserons Y.'));
});

test('queue A: a quote not in the source cannot be accepted, only edited; fixes are applied; reject and skip only log', (t) => {
  const s = setup(t);
  const bad = s.key(4);
  assert.equal(s.desk.candidateView(bad).canAccept, false);
  assert.throws(() => s.desk.candidateAction({ item: bad, action: 'accept', seconds: 1 }), /cannot accept/);
  assert.throws(() => s.desk.candidateAction({ item: bad, action: 'accept_edited', fields: { quote_original: 'Nous inventerons Z.' } }), /word for word/);
  assert.equal(claims(s.db).length, 0);
  s.desk.candidateAction({ item: bad, action: 'accept_edited', fields: { quote_original: 'Nous continuerons Z.', quote_en: 'We will continue Z.' }, seconds: 3 });
  assert.deepEqual(readActions(s.logPath).at(-1).edited, ['quote_original', 'quote_en']);
  assert.equal(claims(s.db)[0].quote_original, 'Nous continuerons Z.');

  const fixed = s.key(3);
  // The same quote is now in the workspace, so s-3 has left the queue; take the edited one back first.
  s.desk.undo();
  s.desk.candidateAction({ item: fixed, action: 'accept_with_fixes', seconds: 2 });
  assert.equal(claims(s.db)[0].domain, 'tax');
  assert.deepEqual(readActions(s.logPath).at(-1).fixes, ['domain']);

  const before = claims(s.db).length;
  s.desk.candidateAction({ item: s.key(2), action: 'skip', seconds: 1 });
  assert.equal(s.desk.candidateQueue().items.at(-1).id, s.key(2), 'skipped goes last');
  assert.throws(() => s.desk.candidateAction({ item: s.key(2), action: 'reject', reason: 4, note: '' }), /needs a sentence/);
  s.desk.candidateAction({ item: s.key(2), action: 'reject', reason: 2, seconds: 4 });
  assert.equal(claims(s.db).length, before, 'reject writes nothing to the database');
  assert.ok(!s.desk.candidateQueue().items.some((x) => x.id === s.key(2)));
  s.desk.undo();
  assert.ok(s.desk.candidateQueue().items.some((x) => x.id === s.key(2)), 'undo of a reject puts it back');
});

test('queue A: a candidates file without a speaker disables its candidates', (t) => {
  const s = setup(t, { subjectInFile: false });
  const v = s.desk.candidateView(s.key(2));
  assert.equal(v.canAccept, false);
  assert.equal(v.canEdit, false);
  assert.throws(() => s.desk.candidateAction({ item: s.key(2), action: 'accept' }), /subject_id is missing/);
});

test('queue B: confirm waits for the window, records review_seconds, and Z within it writes nothing', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const [item] = s.desk.verdictQueue().items;
  assert.equal(item.preselect, 1, 'unanimous votes pre-select');
  assert.equal(item.canConfirm, true);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdicts').get().n, 0, 'pre-selection writes nothing');
  const html = s.desk.verdictPage(item.id);
  assert.match(html, /2 : 0 agree/);
  assert.match(html, /vote 1 pre-selected/);
  assert.match(html, /all checks pass/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdicts').get().n, 0, 'rendering writes nothing');

  // Cancel within the window: nothing written.
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'confirm', seconds: 81 });
  assert.equal(s.desk.verdictQueue().items.length, 0, 'the pending item leaves the queue');
  s.desk.undo();
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdicts').get().n, 0);

  // Confirm again; committing before 5 s is refused.
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'confirm', seconds: 81 });
  const id = s.desk.pending.id;
  const during = s.desk.verdictPage();
  assert.ok(!during.includes(id), 'no page carries the pending id: only the page that pressed C can commit');
  assert.doesNotMatch(during, /will be written|in its 5-second window|Cancelled/, 'the committing view shows its own countdown; the page adds no stale toast');
  s.advance(4_000);
  assert.throws(() => s.desk.commit(id), /window is not over/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
  s.advance(1_500);
  const r = s.desk.commit(id);
  const pub = s.db.prepare('SELECT * FROM publications WHERE id = ?').get(r.publicationId);
  assert.equal(pub.review_seconds, 81);
  assert.equal(pub.confirmed_by, 'founder');
  const snap = JSON.parse(pub.snapshot);
  assert.equal(snap.verdict.decided_by, 'jury');
  assert.equal(snap.jury.length, 2, 'the valid votes are frozen into the ledger');
  assert.equal(snap.evidence[0].excerpt_en, 'X has been in force since 2025.');
  assert.throws(() => s.desk.undo(), /only be withdrawn/);
  assert.equal(s.desk.verdictQueue().items.length, 0, 'nothing left to confirm');
});

test('queue B: a confirmation that waited too long, or whose claim changed, writes nothing', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'confirm', seconds: 5 });
  const id1 = s.desk.pending.id;
  // The page was closed: nobody commits within 2 s after the window; a later commit is refused.
  s.advance(7_500);
  assert.match(s.desk.verdictPage(), /Cancelled: item #\d+ was not written/, 'a page loaded after the window says it was cancelled');
  assert.match(s.desk.candidatePage(), /Cancelled: item #\d+ was not written/, 'and saying so changes nothing');
  assert.equal(s.desk.verdictQueue().items.length, 1, 'the item is back in the queue');
  assert.throws(() => s.desk.commit(id1), /abandoned/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'confirm', seconds: 5 });
  s.db.prepare("UPDATE claims SET criteria_en = 'X is in force, really.'").run();
  s.advance(6_000);
  assert.throws(() => s.desk.commit(s.desk.pending.id), /changed during the window/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdicts').get().n, 0, 'the pre-selected vote was not written either');
});

test('queue B: on a split nothing is pre-selected; adopt and edit set decided_by; undo restores', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'partly_came_true']);
  let [item] = s.desk.verdictQueue().items;
  assert.equal(item.preselect, null);
  assert.equal(item.canConfirm, false);
  assert.throws(() => s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'confirm' }), /cannot confirm/);
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'adopt', vote: 2, seconds: 10 });
  const v = () => s.db.prepare('SELECT * FROM verdicts').get();
  assert.equal(v().verdict, 'partly_came_true');
  assert.equal(v().decided_by, 'jury');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdict_evidence').get().n, 1);
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.adopted, 2);
  assert.equal(item.canConfirm, true);
  // Text only: still the jury's.
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'edit', fields: { verdict: 'partly_came_true', summary_fr: 'Autre.', summary_en: 'Other.' } });
  assert.equal(v().decided_by, 'jury');
  // A different verdict: the founder's.
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'edit', fields: { verdict: 'came_true', summary_fr: 'Autre.', summary_en: 'Other.' } });
  assert.equal(v().decided_by, 'human');
  s.desk.undo();
  assert.equal(v().verdict, 'partly_came_true');
  assert.equal(v().decided_by, 'jury');
  s.desk.undo();
  s.desk.undo();
  assert.equal(v(), undefined, 'back to no verdict');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes').get().n, 2, 'undo never removes votes: round 1 stays');
});

test('queue B: reject the claim saves everything first, undo restores it; published claims are refused', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  let [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'adopt', vote: 1 });
  [item] = s.desk.verdictQueue().items;
  assert.throws(() => s.desk.verdictAction({ item: item.id, action: 'reject_claim', reason: 3 }), /needs a sentence/);
  s.desk.verdictAction({ item: item.id, action: 'reject_claim', reason: 1, seconds: 9 });
  assert.equal(claims(s.db).length, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes').get().n, 0);
  const entry = readActions(s.logPath).at(-1);
  assert.equal(entry.action, 'reject_claim');
  assert.equal(entry.removed.claim.quote_original, 'Nous ferons X avant 2027.');
  assert.equal(entry.removed.jury.length, 2);
  assert.equal(entry.removed.evidence.length, 1);
  s.desk.undo();
  const [back] = claims(s.db);
  assert.equal(back.quote_original, 'Nous ferons X avant 2027.');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes WHERE claim_id = ?').get(back.id).n, 2);
  assert.equal(s.db.prepare('SELECT verdict FROM verdicts WHERE claim_id = ?').get(back.id).verdict, 'came_true');

  // Published once (even if withdrawn since): refused.
  [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'confirm', seconds: 1 });
  s.advance(5_000);
  s.desk.commit(s.desk.pending.id);
  withdraw(s.db, back.id, 'founder', { noteFr: 'Retiré.', noteEn: 'Withdrawn.' });
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.published, 2, 'published, then withdrawn');
  assert.throws(() => s.desk.verdictAction({ item: item.id, action: 'reject_claim', reason: 1 }), /only be withdrawn/);
  assert.equal(claims(s.db).length, 1);
});

test('queue B: send back hides the item until its votes change', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const [item] = s.desk.verdictQueue().items;
  assert.throws(() => s.desk.verdictAction({ item: item.id, action: 'send_back', reason: 1, note: ' ' }), /needs a sentence/);
  s.desk.verdictAction({ item: item.id, action: 'send_back', reason: 1, note: 'Need the decree.', seconds: 30 });
  assert.equal(s.desk.verdictQueue().items.length, 0);
  writePack(s, ['came_true', 'came_true', 'came_true']);
  assert.equal(s.desk.verdictQueue().items.length, 1);
  const today = s.desk.today();
  assert.equal(today.sentBack, 1);
  assert.equal(today.autoAccepted, 1);
});

test('view: text from files is escaped', (t) => {
  const s = setup(t);
  const html = s.desk.candidatePage(s.key(2));
  assert.ok(html.includes('Lowering what? &lt;b&gt;no&lt;/b&gt;'));
  assert.ok(!html.includes('<b>no</b>'));
  assert.equal(typeof renderCandidatePage, 'function');
});

// ---------------------------------------------------------------- the server

function call(port, { method = 'GET', path = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('server: 127.0.0.1 only; writes need the exact Host, Origin and token; no CORS', async (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const { server, origin, token, url } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.opts.evidenceDir });
  t.after(() => server.close());
  assert.equal(server.address().address, '127.0.0.1');
  assert.ok(url.includes(token));
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const json = (o) => JSON.stringify(o);
  const good = { Host: host, Origin: origin, 'X-Desk-Token': token, 'Content-Type': 'application/json' };
  const skip = json({ queue: 'verdict', item: s.desk.verdictQueue().items[0].id, action: 'skip', seconds: 1 });
  const post = (headers, body = skip) => call(port, { method: 'POST', path: '/api/action', headers, body });
  const logged = () => readActions(s.logPath).length;
  const n = logged();

  const page = await call(port, { path: '/verdicts', headers: { Host: host } });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['access-control-allow-origin'], undefined);
  assert.ok(!page.body.includes(token), 'the token is never in a page');
  // DNS rebinding: a foreign Host is refused even for reading.
  assert.equal((await call(port, { path: '/verdicts', headers: { Host: `evil.example:${port}` } })).status, 421);

  const { 'X-Desk-Token': _t, ...noToken } = good;
  assert.equal((await post(noToken)).status, 403);
  assert.equal((await post({ ...good, 'X-Desk-Token': 'x'.repeat(64) })).status, 403);
  const { Origin: _o, ...noOrigin } = good;
  assert.equal((await post(noOrigin)).status, 403);
  assert.equal((await post({ ...good, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ ...good, Origin: `http://localhost:${port}` })).status, 403);
  assert.equal((await post({ ...good, Host: `localhost:${port}` })).status, 421);
  assert.equal((await post({ ...good, 'Content-Type': 'text/plain' })).status, 415);
  const preflight = await call(port, { method: 'OPTIONS', path: '/api/action', headers: { Host: host, Origin: 'https://evil.example' } });
  assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  assert.equal(logged(), n, 'no refused request wrote anything');

  const ok = await post(good);
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).ok, true);
  assert.equal(logged(), n + 1);
});

test('server: a refused confirmation through HTTP leaves the ledger empty until the window is over', async (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const { server, origin, token } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.opts.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const headers = { Host: `127.0.0.1:${port}`, Origin: origin, 'X-Desk-Token': token, 'Content-Type': 'application/json' };
  const item = s.desk.verdictQueue().items[0].id;
  const r = await call(port, { method: 'POST', path: '/api/action', headers, body: JSON.stringify({ queue: 'verdict', item, round: 1, action: 'confirm', seconds: 12 }) });
  assert.equal(r.status, 200);
  const early = await call(port, { method: 'POST', path: '/api/commit', headers, body: JSON.stringify({ id: s.desk.pending.id }) });
  assert.equal(early.status, 409);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
});

test('server: an archived web page is served sandboxed, so it cannot reach the desk', async (t) => {
  const s = setup(t);
  const { server } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.opts.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const r = await call(port, { path: `/original/${s.origin}`, headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-security-policy'], /^sandbox/);
  assert.equal(r.body, ORIGIN_HTML);
});

// ---------------------------------------------------------------- after the first security review

test('review 1: a confirmation whose page went away is never written, even by a page that loads later', async (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const { server, origin, token } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.opts.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const headers = { Host: `127.0.0.1:${port}`, Origin: origin, 'X-Desk-Token': token, 'Content-Type': 'application/json' };
  const item = s.desk.verdictQueue().items[0].id;
  const r = JSON.parse((await call(port, { method: 'POST', path: '/api/action', headers, body: JSON.stringify({ queue: 'verdict', item, round: 1, action: 'confirm', seconds: 3 }) })).body);
  assert.ok(r.pending?.id, 'only the response to C carries the pending id');
  // The page is closed. A new page loads after the window: it learns nothing it could commit with.
  s.advance(8_000);
  const page = await call(port, { path: '/verdicts', headers: { Host: `127.0.0.1:${port}` } });
  assert.ok(!page.body.includes(r.pending.id));
  assert.match(page.body, /Cancelled: item #\d+ was not written/);
  const late = await call(port, { method: 'POST', path: '/api/commit', headers, body: JSON.stringify({ id: r.pending.id }) });
  assert.equal(late.status, 409);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
  // Within the window plus 2 s, the page that pressed C can commit.
  const r2 = JSON.parse((await call(port, { method: 'POST', path: '/api/action', headers, body: JSON.stringify({ queue: 'verdict', item, round: 1, action: 'confirm', seconds: 3 }) })).body);
  s.advance(6_500);
  const ok = await call(port, { method: 'POST', path: '/api/commit', headers, body: JSON.stringify({ id: r2.pending.id }) });
  assert.equal(ok.status, 200);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 1);
});

test('review 2: the token travels in the URL fragment; / is served directly, without a redirect', async (t) => {
  const s = setup(t);
  const { server, origin, token, url } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.opts.evidenceDir });
  t.after(() => server.close());
  assert.equal(url, `${origin}/#token=${token}`);
  const port = server.address().port;
  const root = await call(port, { path: '/', headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(root.status, 200);
  assert.equal(root.headers.location, undefined);
  assert.match(root.body, /KANVERIFY review desk/);
  // A token in the query string counts for nothing.
  const q = await call(port, { method: 'POST', path: `/api/undo?token=${token}`, headers: { Host: `127.0.0.1:${port}`, Origin: origin, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(q.status, 403);
});

test('review 3: the founder\'s verdict meets the judges\' rules, and every path to a verdict records the votes', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'partly_came_true']);
  const [item] = s.desk.verdictQueue().items;
  // Split, nothing adopted: an outcome verdict without evidence is refused, nothing is written.
  assert.throws(() => s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'edit', fields: { verdict: 'came_true', summary_fr: 'Fait.', summary_en: 'Done.' } }), /official document/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdicts').get().n, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes').get().n, 2, 'votes are recorded on first sight, before any decision (decision 9)');
  // Summary in one language only: refused as for a judge.
  assert.throws(() => s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'edit', fields: { verdict: 'to_evaluate', summary_fr: 'Manque.', open_question_fr: 'Quoi ?', open_question_en: 'What?' } }), /summary missing/);
  // A verdict that passes: written, and both valid votes are recorded although none was adopted.
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'edit', fields: { verdict: 'to_evaluate', summary_fr: 'Manque.', summary_en: 'Missing.', open_question_fr: 'Quoi ?', open_question_en: 'What?' } });
  assert.equal(s.db.prepare('SELECT decided_by FROM verdicts').get().decided_by, 'human');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes WHERE round = 1').get().n, 2);
  // Before the deadline only came_true may be given: partly_came_true is refused even with evidence.
  s.db.prepare("UPDATE claims SET deadline = '2030-01-01'").run();
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'adopt', vote: 1 });
  assert.throws(() => s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'edit', fields: { verdict: 'partly_came_true', summary_fr: 'En partie.', summary_en: 'In part.' } }), /not reached/);
  // A verdict that breaks the rules outside the desk blocks C.
  s.db.prepare("UPDATE verdicts SET verdict = 'partly_came_true'").run();
  const again = s.desk.verdictQueue().items[0];
  assert.equal(again.canConfirm, false);
  assert.match(again.stops.join(), /rules every judge's vote must meet/);
});

test('review 4: decisions are keyed by file and quote, so reordering a candidates file keeps them', (t) => {
  const s = setup(t);
  s.desk.candidateAction({ item: s.key(2), action: 'reject', reason: 2, seconds: 1 });
  const record = JSON.parse(readFileSync(s.candPath, 'utf8'));
  record.candidates.reverse();
  writeFileSync(s.candPath, JSON.stringify(record));
  const q = s.desk.candidateQueue().items;
  assert.ok(!q.some((x) => x.candidate.quote_original === 'Nous baisserons Y.'), 'the rejection still applies');
  assert.ok(q.some((x) => x.candidate.quote_original === 'Nous continuerons Z.'));
  assert.equal(readActions(s.logPath).at(-1).item, s.key(2));
});

test('review 5: a duplicate vote of the same model is set aside; jury rounds are appended, never deleted', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const vote = JSON.parse(readFileSync(join(s.packDir, 'c1.vote-anthropic-subscription.json'), 'utf8'));
  writeFileSync(join(s.packDir, 'c1.vote-anthropic-api.json'), JSON.stringify({ ...vote, channel: 'api', model: '  MODEL-ANTHROPIC ', verdict: 'not_came_true' }));
  closeRound(packPathOf(s));
  let [item] = s.desk.verdictQueue().items;
  assert.equal(item.valid.length, 1, 'both votes of the duplicated model are set aside; file order picks nothing');
  for (const f of ['anthropic-api.json', 'anthropic-subscription.json']) {
    assert.match(item.p.votes.find((v) => v.file.endsWith(f)).problems.join(), /same provider and model as vote/);
  }
  assert.equal(item.canConfirm, false);
  assert.match(s.desk.verdictPage(item.id), /same provider and model/, 'the page shows it, and does not crash');
  rmSync(join(s.packDir, 'c1.vote-anthropic-api.json'));
  closeRound(packPathOf(s));
  [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'adopt', vote: 1 });
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'adopt', vote: 2 });
  // Round 1 (one valid vote, the duplicates set aside) and round 2 (closed after the duplicate went); adopting adds none.
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes').get().n, 3, 'adopting twice adds no round');
  // A new vote arrives: a new round is added, the old one stays.
  writePack(s, ['came_true', 'came_true', 'came_true']);
  [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: roundOf(s, item.id), action: 'adopt', vote: 1 });
  const rounds = s.db.prepare('SELECT round, count(*) AS n FROM jury_votes GROUP BY round ORDER BY round').all().map((r) => [r.round, r.n]);
  assert.deepEqual(rounds, [[1, 1], [2, 2], [3, 3]]);
});

test('review 6: a language code from a file cannot break out of its attribute', (t) => {
  const s = setup(t);
  const record = JSON.parse(readFileSync(s.candPath, 'utf8'));
  record.candidates.push({ ...CANDIDATES[0], quote_original: 'Nous ferons X avant 2027.', lang: 'fr"><script>alert(1)</script>', unit: 2, locator: '§2 bis' });
  writeFileSync(s.candPath, JSON.stringify(record));
  const evil = s.desk.candidateQueue().items.find((x) => String(x.candidate.lang).includes('script'));
  const html = s.desk.candidatePage(evil.id);
  assert.ok(!html.includes('<script>alert'), 'escaped');
  assert.ok(html.includes('lang="fr&quot;&gt;&lt;script&gt;'));
});

test('review 7: an archived PDF is downloaded, never shown on the desk origin', async (t) => {
  const s = setup(t);
  const sha = s.store('%PDF-1.4 test');
  const pdf = addSource(s.db, 'platform', { sha256: sha, media_type: 'application/pdf', url: 'https://example.org/pdf' });
  const { server } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const r = await call(port, { path: `/original/${pdf}`, headers: { Host: `127.0.0.1:${port}` } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-disposition'], `attachment; filename="source-${pdf}.pdf"`);
  assert.match(r.headers['content-security-policy'], /^sandbox/);
});

test('review 8: reading a page changes nothing; the toast stays until the next write', (t) => {
  const s = setup(t);
  s.desk.setToast('Rejected s1-2. Z to undo', 'candidate');
  const before = readActions(s.logPath).length;
  assert.match(s.desk.candidatePage(), /Rejected s1-2/);
  assert.match(s.desk.candidatePage(), /Rejected s1-2/, 'still there on the second load');
  assert.equal(readActions(s.logPath).length, before);
  s.desk.beginWrite();
  assert.doesNotMatch(s.desk.candidatePage(), /Rejected s1-2/);
});

// ---------------------------------------------------------------- after the browser test

test('browser test: a page load from anywhere but the committing view cancels the window at once', async (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const { server, origin, token } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.opts.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const headers = { Host: host, Origin: origin, 'X-Desk-Token': token, 'Content-Type': 'application/json' };
  const item = s.desk.verdictQueue().items[0].id;
  const confirmC = async () => JSON.parse((await call(port, { method: 'POST', path: '/api/action', headers, body: JSON.stringify({ queue: 'verdict', item, round: 1, action: 'confirm', seconds: 2 }) })).body).pending.id;

  // The committing view fetches the next page with its view id: the window stays open, no stale toast.
  let id = await confirmC();
  const own = await call(port, { path: '/verdicts', headers: { Host: host, 'X-Desk-View': id } });
  assert.doesNotMatch(own.body, /will be written|Cancelled/);
  // Another site's request (an image, say) does not end it.
  await call(port, { path: '/verdicts', headers: { Host: host, 'Sec-Fetch-Site': 'cross-site' } });
  s.advance(5_200);
  assert.equal((await call(port, { method: 'POST', path: '/api/commit', headers, body: JSON.stringify({ id }) })).status, 200);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 1);

  // A reload during the window: "Cancelled" at once, and the old view can no longer commit.
  s.db.prepare("UPDATE verdicts SET summary_en = 'X is in force (vote 1), corrected.'").run();
  id = await confirmC();
  const reload = await call(port, { path: '/verdicts', headers: { Host: host } });
  assert.match(reload.body, /Cancelled: item #\d+ was not written/);
  assert.doesNotMatch(reload.body, /will be written/);
  s.advance(5_200);
  assert.equal((await call(port, { method: 'POST', path: '/api/commit', headers, body: JSON.stringify({ id }) })).status, 409);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 1);
});

test('browser test: a toast belongs to its queue', (t) => {
  const s = setup(t);
  s.desk.setToast('Rejected s1-2. Z to undo', 'candidate');
  assert.match(s.desk.candidatePage(), /Rejected s1-2/);
  assert.doesNotMatch(s.desk.verdictPage(), /Rejected s1-2/);
});

test('browser test: --db and --log start the desk on another database and log', async (t) => {
  const s = setup(t);
  const dbPath = join(s.dir, 'other.db');
  const logPath = join(s.dir, 'other-log', 'actions.jsonl');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/desk.js', import.meta.url)), '--db', dbPath, '--log', logPath, '--review', s.reviewPath, '--packs', s.packDir, '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let out = '';
  let timer;
  try {
    await Promise.race([
      new Promise((resolve) => child.stdout.on('data', (d) => { out += d; if (/Ctrl\+C/.test(out)) resolve(); })),
      exited.then((code) => { throw new Error(`desk exited with ${code}: ${out}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no start line: ${out}`)), 10_000); }),
    ]);
  } finally {
    clearTimeout(timer);
    // Stop the desk and wait, so the database file is released before the temp folder is removed.
    child.kill();
    await exited;
  }
  assert.match(out, /http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}/);
  assert.ok(out.includes(dbPath), 'the given database is used');
  assert.ok(out.includes(logPath), 'the given log is used');
  assert.ok(existsSync(dbPath), 'the database was created there, not under data/');
});

// ---------------------------------------------------------------- coordinator decision 9 (after Fable review 2)

const roundsOf = (db) => db.prepare('SELECT round, count(*) AS n FROM jury_votes GROUP BY round ORDER BY round').all().map((r) => [r.round, r.n]);

test('decision 9: after a second jury round the newest votes are shown, pre-selected and published, never the old decision', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'partly_came_true']);
  let [item] = s.desk.verdictQueue().items;
  assert.equal(item.round, 1);
  s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 1 });
  s.desk.verdictAction({ item: item.id, action: 'send_back', reason: 2, note: 'Judge again.' });
  assert.equal(s.desk.verdictQueue().items.length, 0);
  writePack(s, ['not_came_true', 'not_came_true', 'not_came_true']);
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.round, 2, 'the new vote set is round 2');
  assert.equal(item.stale, true);
  assert.match(item.recheck, /New votes since your last decision/);
  assert.equal(item.preselect, 1);
  assert.equal(item.after.state.verdict.verdict, 'not_came_true', 'what C would publish is the new round');
  const html = s.desk.verdictPage(item.id);
  assert.match(html, /New votes since your last decision/);
  assert.match(html, /vote 1 pre-selected/);
  assert.match(html, /data-round="2"/);
  // The page's round goes with every adopt, edit and confirm.
  assert.throws(() => s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 2 }), /new votes arrived/);
  assert.throws(() => s.desk.verdictAction({ item: item.id, action: 'confirm' }), /new votes arrived/);
  s.desk.verdictAction({ item: item.id, round: 2, action: 'confirm', seconds: 4 });
  s.advance(5_200);
  const { publicationId } = s.desk.commit(s.desk.pending.id);
  const snap = JSON.parse(s.db.prepare('SELECT snapshot FROM publications WHERE id = ?').get(publicationId).snapshot);
  assert.equal(snap.verdict.verdict, 'not_came_true');
  assert.deepEqual(snap.jury.filter((j) => j.round === 2).map((j) => j.verdict), ['not_came_true', 'not_came_true', 'not_came_true']);
  assert.deepEqual(roundsOf(s.db), [[1, 2], [2, 3]]);
});

test('decision 9: new votes during the 5-second window stop the commit, even without a pre-selected vote', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'came_true']);
  let [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 1 });
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.preselect, null, 'adopted, so nothing is pre-selected');
  s.desk.verdictAction({ item: item.id, round: 1, action: 'confirm', seconds: 3 });
  writePack(s, ['not_came_true', 'not_came_true']);
  s.advance(5_200);
  assert.throws(() => s.desk.commit(s.desk.pending.id), /new votes arrived during the window/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
});

test('decision 9: a published item comes back when a new round arrives, labelled as a re-check', (t) => {
  const s = setup(t);
  importOne(s);
  s.db.prepare("UPDATE claims SET deadline = '2027-12-31'").run();
  const claim = { deadline: '2027-12-31' };
  writePack(s, ['pending', 'pending'], { claim });
  let [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: 1, action: 'confirm', seconds: 2 });
  s.advance(5_200);
  s.desk.commit(s.desk.pending.id);
  assert.equal(s.desk.verdictQueue().items.length, 0, 'published, nothing new: not in the queue');
  writePack(s, ['came_true', 'came_true'], { claim });
  [item] = s.desk.verdictQueue().items;
  assert.ok(item, 'back in queue B');
  assert.match(item.recheck, /Re-check of a published item/);
  assert.match(s.desk.verdictPage(item.id), /Re-check of a published item/);
  assert.equal(item.canConfirm, true);
  s.desk.verdictAction({ item: item.id, round: 2, action: 'confirm', seconds: 2 });
  s.advance(5_200);
  s.desk.commit(s.desk.pending.id);
  const verdicts = s.db.prepare('SELECT snapshot FROM publications ORDER BY id').all().map((r) => JSON.parse(r.snapshot).verdict.verdict);
  assert.deepEqual(verdicts, ['pending', 'came_true'], 'a new ledger entry, as usual');
});

test('decision 9: undo puts the verdict back and never removes a round', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'partly_came_true']);
  let [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 2 });
  writePack(s, ['came_true', 'came_true', 'came_true']);
  [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: 2, action: 'adopt', vote: 1 });
  assert.deepEqual(roundsOf(s.db), [[1, 2], [2, 3]]);
  s.desk.undo();
  assert.equal(s.db.prepare('SELECT verdict FROM verdicts').get().verdict, 'partly_came_true');
  assert.deepEqual(roundsOf(s.db), [[1, 2], [2, 3]], 'both rounds are still there');
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.stale, true, 'the restored verdict is from round 1, so it is stale again');
  s.desk.undo();
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdicts').get().n, 0);
  assert.deepEqual(roundsOf(s.db), [[1, 2], [2, 3]]);
});

test('decision 9: rounds are written once, as soon as the desk sees them, and logged with the quote hash', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  s.desk.verdictQueue();
  s.desk.verdictQueue();
  s.desk.verdictPage();
  assert.deepEqual(roundsOf(s.db), [[1, 2]], 'seen three times, written once');
  const ingested = readActions(s.logPath).filter((e) => e.action === 'round_ingested');
  assert.equal(ingested.length, 1);
  const claim = claims(s.db)[0];
  assert.equal(ingested[0].quote_sha256, claimQuoteSha(claim));
  const [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 1 });
  assert.equal(readActions(s.logPath).at(-1).quote_sha256, claimQuoteSha(claim));
  assert.equal(readActions(s.logPath).at(-1).round, 1);
});

test('decision 9: text that only looks blank counts as missing', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'partly_came_true']);
  const [item] = s.desk.verdictQueue().items;
  for (const blank of ['⠀', '᠎', 'ᅟ', 'ㅤ', ' ​­ ']) {
    assert.throws(() => s.desk.verdictAction({
      item: item.id, round: 1, action: 'edit',
      fields: { verdict: 'to_evaluate', summary_fr: 'Manque.', summary_en: blank, open_question_fr: 'Quoi ?', open_question_en: 'What?' },
    }), /summary missing/, JSON.stringify(blank));
  }
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM verdicts').get().n, 0);
});

// ---------------------------------------------------------------- record format 10 and decision 0012 (section A)

test('format 10: rounds live in jury_votes.pack_sha256 and verdicts.based_on_round; losing the desk log changes nothing', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'partly_came_true']);
  let [item] = s.desk.verdictQueue().items;
  const sha = item.p.packSha256;
  assert.deepEqual(s.db.prepare('SELECT DISTINCT pack_sha256 FROM jury_votes').all().map((r) => r.pack_sha256), [sha]);
  s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 2 });
  assert.equal(s.db.prepare('SELECT based_on_round FROM verdicts').get().based_on_round, 1);
  // The log is an audit trail only: without it the rounds and the verdict's round are still known.
  rmSync(s.logPath);
  const again = createDesk({ db: s.db, packDirs: [s.packDir], ...s.opts });
  [item] = again.verdictQueue().items;
  assert.equal(item.round, 1, 'no new round');
  assert.equal(item.stale, false);
  assert.equal(item.adopted, 2);
  assert.deepEqual(roundsOf(s.db), [[1, 2]]);
});

test('format 10: the deadline rule of confirm() is shown as a reason C is off', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  let [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 1 });
  // Outside the desk: a partly_came_true before the deadline.
  s.db.prepare("UPDATE claims SET deadline = '2030-01-01'").run();
  s.db.prepare("UPDATE verdicts SET verdict = 'partly_came_true'").run();
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.canConfirm, false);
  assert.match(item.stops.join('\n'), /deadline 2030-01-01 not over/);
  assert.match(s.desk.verdictPage(item.id), /deadline 2030-01-01 not over/);
});

test('0012 A2: a Claude subscription vote from the session that cut the pack is refused', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true', 'came_true'], { cutSession: 'session-7', sessions: ['session-7'] });
  let [item] = s.desk.verdictQueue().items;
  const claude = item.p.votes.find((v) => v.vote.provider === 'anthropic');
  assert.equal(claude.valid, false);
  assert.match(claude.problems.join(), /session that cut the pack/);
  assert.equal(item.valid.length, 1);
  writePack(s, ['came_true', 'came_true'], { cutSession: 'session-7', sessions: ['session-8'] });
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.valid.length, 2, 'a fresh session counts');
  // Not recorded: counted, but the page says the program could not check it.
  writePack(s, ['came_true', 'came_true']);
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.p.votes.find((v) => v.vote.provider === 'anthropic').sessionUnrecorded, true);
  assert.match(s.desk.verdictPage(item.id), /does not name its session/);
});

test('0012 A3: figures from a PDF keep C off until the original was opened from this item page', async (t) => {
  const s = setup(t, { pdfLaw: true });
  importOne(s);
  writePack(s);
  let [item] = s.desk.verdictQueue().items;
  assert.equal(item.valid.length, 2, 'the PDF fixture passes the vote checks');
  assert.equal(item.canConfirm, false);
  assert.match(item.stops.join(), /open the original first \(O\)/);
  const { server } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  // Without the page's nonce, or from another site, serving the file proves nothing.
  await call(port, { path: `/original/${s.law}`, headers: { Host: host } });
  await call(port, { path: `/original/${s.law}?view=${'0'.repeat(32)}`, headers: { Host: host } });
  const html = (await call(port, { path: '/verdicts', headers: { Host: host } })).body;
  const nonce = new RegExp(`/original/${s.law}\\?view=([0-9a-f]{32})`).exec(html)[1];
  await call(port, { path: `/original/${s.law}?view=${nonce}`, headers: { Host: host, 'Sec-Fetch-Site': 'cross-site' } });
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.canConfirm, false, 'still off');
  const r = await call(port, { path: `/original/${s.law}?view=${nonce}`, headers: { Host: host } });
  assert.equal(r.headers['content-disposition'], `attachment; filename="source-${s.law}.pdf"`);
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.canConfirm, true);
  assert.equal(readActions(s.logPath).filter((e) => e.action === 'opened_original').length, 1);
});

test('0012 A4: kind and publisher beside each excerpt; one key sends back "wrong kind"; an official publisher needs a tick once', (t) => {
  const s = setup(t, { lawKind: 'official' });
  importOne(s);
  writePack(s);
  let [item] = s.desk.verdictQueue().items;
  const html = s.desk.verdictPage(item.id);
  assert.match(html, /<b>Official document<\/b> · publisher <b lang="fr">JO<\/b>/);
  assert.equal(item.canConfirm, false);
  assert.match(item.stops.join(), /first use of the official publisher “JO”/);
  s.desk.verdictAction({ item: item.id, action: 'tick_publisher', seconds: 2 });
  const tick = readActions(s.logPath).at(-1);
  assert.equal(tick.action, 'tick_publisher');
  assert.equal(tick.publisher_key, 'jo');
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.canConfirm, true);
  // Kept across a restart (from the log); undo takes the tick back.
  assert.equal(createDesk({ db: s.db, packDirs: [s.packDir], ...s.opts }).verdictQueue().items[0].canConfirm, true);
  s.desk.undo();
  assert.equal(s.desk.verdictQueue().items[0].canConfirm, false);
  // Wrong kind: one action, the source named, the item leaves until the pack changes.
  assert.throws(() => s.desk.verdictAction({ item: item.id, action: 'wrong_kind', source: 999 }), /one of the sources/);
  s.desk.verdictAction({ item: item.id, action: 'wrong_kind', source: s.law, seconds: 1 });
  const back = readActions(s.logPath).at(-1);
  assert.equal(back.action, 'send_back');
  assert.equal(back.reason, 1);
  assert.equal(back.wrong_kind_source, s.law);
  assert.match(back.note, /labelled official/);
  assert.equal(s.desk.verdictQueue().items.length, 0);
});

test('0012 A5: a vague claim goes to queue B without pack or jury; the founder writes the summary and confirms unverifiable', (t) => {
  const s = setup(t);
  const claimId = addClaim(s.db, s.origin, {
    quote_original: 'Nous baisserons Y.', quote_en: 'We will lower Y.', source_locator: '§2', verifiability: 'vague',
    criteria_fr: null, criteria_en: null, deadline: null, deadline_basis: null, said_on: '2022-03-17',
  });
  let [item] = s.desk.verdictQueue().items;
  assert.equal(item.claimId, claimId);
  assert.equal(item.direct, true);
  assert.equal(item.canConfirm, false);
  assert.match(item.stops.join(), /write the summary/);
  assert.match(s.desk.verdictPage(item.id), /no evidence pack, no jury/);
  assert.throws(() => s.desk.verdictAction({ item: item.id, action: 'edit', fields: { summary_fr: 'Trop vague.', summary_en: '⠀' } }), /summary missing/);
  // Whatever verdict is sent, a vague item gets "unverifiable".
  s.desk.verdictAction({ item: item.id, action: 'edit', fields: { verdict: 'came_true', summary_fr: 'Rien de mesurable.', summary_en: 'Nothing measurable.' } });
  const v = s.db.prepare('SELECT * FROM verdicts').get();
  assert.deepEqual([v.verdict, v.decided_by, v.based_on_round], ['unverifiable', 'human', null]);
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.canConfirm, true);
  s.desk.verdictAction({ item: item.id, action: 'confirm', seconds: 6 });
  s.advance(5_200);
  const { publicationId } = s.desk.commit(s.desk.pending.id);
  assert.equal(JSON.parse(s.db.prepare('SELECT snapshot FROM publications WHERE id = ?').get(publicationId).snapshot).verdict.verdict, 'unverifiable');
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes').get().n, 0);
  assert.equal(s.desk.verdictQueue().items.length, 0, 'done');
});

// ---------------------------------------------------------------- re-check after decision 9: closed rounds (step-back 2026-11-23)

test('re-check A: votes arriving one by one make no round until the jury step closes it; the ledger lists each vote once', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s, ['came_true'], { close: false });
  assert.match(closeRound(packPathOf(s)).problem, /no vote on this pack yet from openai \(subscription\)/, 'tally does not close an incomplete round');
  let [item] = s.desk.verdictQueue().items;
  assert.match(item.stops.join(), /no jury round has been closed/);
  assert.equal(item.p.votes.length, 0, 'loose vote files are not read');
  writePack(s, ['came_true', 'came_true'], { close: false });
  s.desk.verdictPage();
  writePack(s, ['came_true', 'came_true', 'not_came_true'], { close: false });
  s.desk.verdictQueue();
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM jury_votes').get().n, 0, 'no round while the votes arrive');
  const r = closeRound(packPathOf(s));
  assert.deepEqual([r.closed.round, r.closed.votes.length], [1, 3]);
  assert.equal(closeRound(packPathOf(s)).already, true, 'closing again with the same files adds nothing');
  assert.equal(readFileSync(join(s.packDir, 'c1.rounds.jsonl'), 'utf8').trim().split('\n').length, 1);
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.round, 1);
  assert.deepEqual(roundsOf(s.db), [[1, 3]]);
  s.desk.verdictAction({ item: item.id, round: 1, action: 'adopt', vote: 1 });
  s.desk.verdictAction({ item: item.id, round: 1, action: 'confirm', seconds: 3 });
  s.advance(5_200);
  const { publicationId } = s.desk.commit(s.desk.pending.id);
  const snap = JSON.parse(s.db.prepare('SELECT snapshot FROM publications WHERE id = ?').get(publicationId).snapshot);
  assert.deepEqual(snap.jury.map((j) => [j.round, j.provider]), [[1, 'anthropic'], [1, 'gemini'], [1, 'openai']], 'three rows for three votes');
});

test('re-check B: a stray vote file neither adds a round nor removes the item; a changed file of the closed round stops C and says so', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  let [item] = s.desk.verdictQueue().items;
  assert.equal(item.round, 1);
  const stray = join(s.packDir, 'c1.vote-anthropic-api.json');
  writeFileSync(stray, readFileSync(join(s.packDir, 'c1.vote-anthropic-subscription.json')));
  [item] = s.desk.verdictQueue().items;
  assert.deepEqual([item.round, item.valid.length], [1, 2], 'the stray file is not in the closed round');
  rmSync(stray);
  const q = s.desk.verdictQueue();
  assert.equal(q.items.length, 1, 'removing it changes nothing');
  assert.deepEqual(q.unlinked, []);
  assert.deepEqual(roundsOf(s.db), [[1, 2]]);
  // The votes stop counting (here: the judge input is gone): the item stays and says why.
  const input = join(s.packDir, 'c1.judge-input.md');
  const inputText = readFileSync(input, 'utf8');
  rmSync(input);
  [item] = s.desk.verdictQueue().items;
  assert.ok(item, 'still in queue B');
  assert.match(item.stops.join(), /only 0 vote\(s\) pass/);
  writeFileSync(input, inputText);
  // A file of the closed round changes during the 5-second window: nothing is written.
  [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, round: 1, action: 'confirm', seconds: 2 });
  const openai = join(s.packDir, 'c1.vote-openai-subscription.json');
  writeFileSync(openai, JSON.stringify({ ...JSON.parse(readFileSync(openai, 'utf8')), reasoning: 'rewritten' }));
  s.advance(5_200);
  assert.throws(() => s.desk.commit(s.desk.pending.id), /files of the jury round changed during the window/);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM publications').get().n, 0);
  [item] = s.desk.verdictQueue().items;
  assert.equal(item.canConfirm, false);
  assert.match(item.stops.join(), /round 1 of the jury cannot be confirmed: vote file c1\.vote-openai-subscription\.json changed after round 1 was closed/);
  rmSync(openai);
  [item] = s.desk.verdictQueue().items;
  assert.match(item.stops.join(), /c1\.vote-openai-subscription\.json was removed after round 1 was closed/);
  assert.match(s.desk.verdictPage(item.id), /was removed after round 1 was closed/);
  assert.throws(() => s.desk.verdictAction({ item: item.id, round: 1, action: 'confirm' }), /cannot confirm/);
});

test('re-check C: a vague item sent back returns once the item changes (a translation, a summary)', (t) => {
  const s = setup(t);
  addClaim(s.db, s.origin, {
    quote_original: 'Nous baisserons Y.', quote_en: 'We will lower Y.', source_locator: '§2', verifiability: 'vague',
    criteria_fr: null, criteria_en: null, deadline: null, deadline_basis: null, said_on: '2022-03-17',
  });
  let [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, action: 'edit', fields: { summary_fr: 'Rien de mesurable.', summary_en: 'Nothing measurable.' } });
  s.desk.verdictAction({ item: item.id, action: 'send_back', reason: 3, note: 'The English quote is wrong.' });
  assert.equal(s.desk.verdictQueue().items.length, 0);
  s.db.prepare("UPDATE claims SET quote_en = 'We shall lower Y.'").run();
  [item] = s.desk.verdictQueue().items;
  assert.ok(item, 'back after the translation was corrected');
  s.desk.verdictAction({ item: item.id, action: 'send_back', reason: 4, note: 'Summary to redo.' });
  assert.equal(s.desk.verdictQueue().items.length, 0);
  s.db.prepare("UPDATE verdicts SET summary_en = 'Nothing that can be measured.'").run();
  assert.equal(s.desk.verdictQueue().items.length, 1, 'back after the summary changed');
});

test('re-check D: a corrected person row is seen without a restart, and C goes through', (t) => {
  const s = setup(t);
  importOne(s);
  writePack(s);
  const [item] = s.desk.verdictQueue().items;
  s.desk.verdictPage(item.id);
  s.db.prepare("UPDATE subjects SET name = 'Corrected Name'").run();
  s.desk.verdictAction({ item: item.id, round: 1, action: 'confirm', seconds: 2 });
  s.advance(5_200);
  const { publicationId } = s.desk.commit(s.desk.pending.id);
  assert.equal(JSON.parse(s.db.prepare('SELECT snapshot FROM publications WHERE id = ?').get(publicationId).snapshot).subject.name, 'Corrected Name');
});

test('re-check E: the PDF is marked opened only when it was actually served', async (t) => {
  const s = setup(t, { pdfLaw: true });
  importOne(s);
  writePack(s);
  const { server } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const html = (await call(port, { path: '/verdicts', headers: { Host: host } })).body;
  const nonce = new RegExp(`/original/${s.law}\\?view=([0-9a-f]{32})`).exec(html)[1];
  const file = evidencePath(s.evidenceDir, s.db.prepare('SELECT sha256 FROM sources WHERE id = ?').get(s.law).sha256);
  renameSync(file, `${file}.away`);
  assert.equal((await call(port, { path: `/original/${s.law}?view=${nonce}`, headers: { Host: host } })).status, 404);
  renameSync(`${file}.away`, file);
  let [item] = s.desk.verdictQueue().items;
  assert.deepEqual(item.toOpen, [s.law], 'not opened: nothing was served');
  assert.equal(readActions(s.logPath).filter((e) => e.action === 'opened_original').length, 0);
  assert.equal((await call(port, { path: `/original/${s.law}?view=${nonce}`, headers: { Host: host } })).status, 200);
  [item] = s.desk.verdictQueue().items;
  assert.deepEqual(item.toOpen, []);
});

test('re-check F: no link nonce for another site\'s page load; an old PDF link does not bring a sent-back item back', async (t) => {
  const s = setup(t, { pdfLaw: true });
  importOne(s);
  writePack(s);
  const { server } = await startDeskServer(s.desk, { port: 0, evidenceDir: s.evidenceDir });
  t.after(() => server.close());
  const port = server.address().port;
  const host = `127.0.0.1:${port}`;
  const html = (await call(port, { path: '/verdicts', headers: { Host: host } })).body;
  const nonce = new RegExp(`/original/${s.law}\\?view=([0-9a-f]{32})`).exec(html)[1];
  const foreign = (await call(port, { path: '/verdicts', headers: { Host: host, 'Sec-Fetch-Site': 'cross-site' } })).body;
  assert.doesNotMatch(foreign, /view=[0-9a-f]{32}/, 'a page another site loads gets no nonce, so it cannot push the founder\'s out');
  const [item] = s.desk.verdictQueue().items;
  s.desk.verdictAction({ item: item.id, action: 'send_back', reason: 1, note: 'Excerpt too short.' });
  await call(port, { path: `/original/${s.law}?view=${nonce}`, headers: { Host: host } });
  assert.equal(readActions(s.logPath).at(-1).action, 'opened_original');
  assert.equal(s.desk.verdictQueue().items.length, 0, 'still sent back');
});

test('re-check F: sessions compared without case; figures written in words count', () => {
  const pack = { made_by: { session: 'S1' } };
  assert.match(sameSessionProblem(pack, { provider: 'anthropic', channel: 'subscription', made_by: { session: ' s1' } }), /session that cut the pack/);
  for (const text of ['deux millions d’euros', 'two hundred schools', 'cinquante pour cent', '٣', '12', '50 %']) assert.equal(hasFigures(text), true, text);
  for (const text of ['une baisse', 'one plan', 'Article premier', null]) assert.equal(hasFigures(text), false, String(text));
});
