import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '../src/ai/fake.js';
import {
  archiveEvidence, judgeClaim, judgeRun, loadEvidenceDoc, searchEvidence, suggestionProblems, urlKey, voteProblems,
} from '../src/jury.js';
import { addSource, freshDb } from './helpers.js';

const CLAIM = {
  key: 'C1', speaker: 'Test Speaker', origin: { title: 'Platform', published_on: '2022-03-17' },
  quote_original: 'les 20% de Français qui la payent encore ne paieront plus rien en 2023', lang: 'fr', quote_en: 'x',
  type: 'promise', verifiability: 'measurable', deadline: '2023-12-31', deadline_basis: 'stated',
  criteria_fr: 'Loi.', criteria_en: 'A law.', speaker_role_en: 'Candidate',
};
// Each document is its own archived file (sha256 differs by id) unless told otherwise.
const doc = (id, kind, publisher = 'Pub', { sha256 = String(id).padStart(64, '0'), published_on = '2025-01-01' } = {}) =>
  ({ meta: { source_id: id, kind, publisher, title: 't', sha256, published_on } });
const UNITS = [{ unit: 1, text: 'Article 16. La taxe d’habitation sur les résidences principales est supprimée.' }];
const okVote = (over = {}) => ({
  verdict: 'came_true', reasoning: 'r', summary_fr: 'f', summary_en: 'e',
  evidence: [{ source_id: 1, excerpt: "La taxe d'habitation sur les résidences principales est supprimée", locator: '§1' }], ...over,
});

test('voteProblems: a well-formed vote on official evidence passes, and excerpts are checked verbatim', () => {
  const texts = new Map([[1, UNITS]]);
  const v = okVote();
  assert.deepEqual(voteProblems(v, CLAIM, [doc(1, 'law')], texts, '2026-11-22'), []);
  assert.equal(v.evidence[0].verbatim, true);
  const bad = okVote({ evidence: [{ source_id: 1, excerpt: 'La taxe est supprimée', locator: '§1' }] });
  assert.match(voteProblems(bad, CLAIM, [doc(1, 'law')], texts, '2026-11-22').join(), /not found verbatim/);
  // No text to compare with: unchecked (null), not failed.
  const unchecked = okVote();
  voteProblems(unchecked, CLAIM, [doc(1, 'law')], new Map([[1, null]]), '2026-11-22');
  assert.equal(unchecked.evidence[0].verbatim, null);
});

test('voteProblems: the evidence rule of publication_checks', () => {
  const texts = new Map([[1, UNITS], [2, UNITS], [3, UNITS]]);
  const two = okVote({ evidence: [1, 2].map((id) => ({ source_id: id, excerpt: 'Article 16', locator: '§1' })) });
  assert.deepEqual(voteProblems(two, CLAIM, [doc(1, 'media', 'A'), doc(2, 'media', 'B')], texts, '2026-11-22'), []);
  assert.match(voteProblems(two, CLAIM, [doc(1, 'media', 'A'), doc(2, 'media', ' a ')], texts, '2026-11-22').join(), /one official document or two/);
  // One normalisation for publisher names (review 3, finding 3): NFKC, case-fold, invisible
  // characters and runs of blanks — the same function the database uses.
  // Invisible characters (zero-width, joiners, soft hyphen, BOM) are removed; other blanks are one space.
  for (const [base, twin] of [['Le Monde', 'ＬＥ　ＭＯＮＤＥ'], ['Lemonde', 'le​monde'], ['Le Monde', 'LE   MONDE'],
    ['Le Monde', '﻿Le Monde '], ['Le monde', 'le⁠­ monde'], ['Straße', 'STRASSE']]) {
    const pair = [doc(1, 'media', base), doc(2, 'media', twin)];
    assert.match(voteProblems(two, CLAIM, pair, texts, '2026-11-22').join(), /one official document or two/, JSON.stringify(twin));
  }
  // The same archived file under two publisher names is one source, not two.
  const sameFile = [doc(1, 'media', 'A', { sha256: 'f'.repeat(64) }), doc(2, 'media', 'B', { sha256: 'f'.repeat(64) })];
  assert.match(voteProblems(two, CLAIM, sameFile, texts, '2026-11-22').join(), /one official document or two/);
  const st = okVote();
  const p = voteProblems(st, CLAIM, [doc(1, 'statement')], texts, '2026-11-22').join();
  assert.match(p, /never evidence/);
  assert.match(p, /one official document or two/);
  // Renunciation: enough for not_came_true on a promise, refused under any other verdict.
  const ren = okVote({ verdict: 'not_came_true', evidence: [{ source_id: 3, excerpt: 'Article 16', locator: '§1' }] });
  assert.deepEqual(voteProblems(ren, { ...CLAIM, deadline: '2027-05-13' }, [doc(3, 'renunciation')], texts, '2026-11-22'), []);
  assert.match(voteProblems(okVote({ evidence: ren.evidence }), CLAIM, [doc(3, 'renunciation')], texts, '2026-11-22').join(), /never the only evidence for came_true/);
  assert.match(voteProblems(ren, { ...CLAIM, type: 'prediction' }, [doc(3, 'renunciation')], texts, '2026-11-22').join(), /renunciation/);
  // A renunciation must come on or after the day the promise was made (review 3, finding 4).
  const future = { ...CLAIM, deadline: '2027-05-13' };
  assert.deepEqual(voteProblems(ren, future, [doc(3, 'renunciation', 'Pub', { published_on: '2022-03-17' })], texts, '2026-11-22'), []);
  for (const published_on of ['2022-03-16', null]) {
    const p = voteProblems(ren, future, [doc(3, 'renunciation', 'Pub', { published_on })], texts, '2026-11-22').join();
    assert.match(p, /published before the promise was made/, String(published_on));
    assert.match(p, /not over/, String(published_on)); // and it no longer lets not_came_true come early
  }
  assert.match(voteProblems(okVote({ evidence: [{ source_id: 9, excerpt: 'x' }] }), CLAIM, [doc(1, 'law')], texts, '2026-11-22').join(), /not given/);
});

test('voteProblems: verdict values, deadlines, open question, summaries, vague claims', () => {
  const texts = new Map([[1, UNITS]]);
  const d = [doc(1, 'law')];
  assert.deepEqual(voteProblems({ verdict: 'kept' }, CLAIM, d, texts, '2026-11-22'), ['verdict is not one of the six']);
  // Before the deadline only came_true may be given early; partly_came_true, not_came_true
  // and to_evaluate wait for the deadline (standard section 5, as amended).
  const early = { ...CLAIM, deadline: '2029-01-20', deadline_basis: 'inferred' };
  assert.deepEqual(voteProblems(okVote(), early, d, texts, '2026-11-22'), []);
  assert.match(voteProblems(okVote({ verdict: 'partly_came_true' }), early, d, texts, '2026-11-22').join(), /not over .*but verdict is partly_came_true/);
  assert.deepEqual(voteProblems(okVote({ verdict: 'partly_came_true' }), CLAIM, d, texts, '2026-11-22'), []);
  // A renunciation is still no evidence of a result for partly_came_true, and never its only evidence (see below).
  const renEarly = okVote({ verdict: 'partly_came_true', evidence: [{ source_id: 3, excerpt: 'Article 16', locator: '§1' }] });
  assert.match(voteProblems(renEarly, early, [doc(3, 'renunciation')], new Map([[3, UNITS]]), '2026-11-22').join(), /never the only evidence for partly_came_true/);
  // Before the deadline, part done is pending: the summary says what has been done so far.
  assert.deepEqual(voteProblems({ verdict: 'pending', reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence: [] }, early, d, texts, '2026-11-22'), []);
  assert.match(voteProblems(okVote({ verdict: 'not_came_true' }), early, d, texts, '2026-11-22').join(), /not reached/);
  const teEarly = { verdict: 'to_evaluate', reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence: [], open_question_fr: 'q', open_question_en: 'q' };
  assert.match(voteProblems(teEarly, early, d, texts, '2026-11-22').join(), /not reached/);
  // partly_came_true is held to the same evidence rule as came_true; a renunciation is no evidence for it.
  assert.match(voteProblems(okVote({ verdict: 'partly_came_true', evidence: [] }), CLAIM, d, texts, '2026-11-22').join(), /one official document/);
  const renOnly = voteProblems(okVote({ verdict: 'partly_came_true', evidence: [{ source_id: 3, excerpt: 'Article 16', locator: '§1' }] }), CLAIM,
    [doc(3, 'renunciation')], new Map([[3, UNITS]]), '2026-11-22').join();
  assert.match(renOnly, /never the only evidence for partly_came_true/);
  assert.match(renOnly, /one official document/);
  assert.deepEqual(voteProblems({ verdict: 'pending', reasoning: 'r', evidence: [] }, early, d, texts, '2026-11-22'), []);
  assert.match(voteProblems({ verdict: 'pending', reasoning: 'r', evidence: [] }, CLAIM, d, texts, '2026-11-22').join(), /passed, but verdict is pending/);
  const te = { verdict: 'to_evaluate', reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence: [], open_question_fr: 'q', open_question_en: '' };
  assert.match(voteProblems(te, CLAIM, d, texts, '2026-11-22').join(), /open question/);
  assert.match(voteProblems(okVote({ summary_en: ' ' }), CLAIM, d, texts, '2026-11-22').join(), /summary missing/);
  // Blank means the project's list (src/rules.js), not only what String.trim removes.
  for (const blank of ['​', '⁠­', '‌‍']) {
    assert.match(voteProblems(okVote({ summary_en: blank }), CLAIM, d, texts, '2026-11-22').join(), /summary missing/, JSON.stringify(blank));
    assert.match(voteProblems(okVote({ reasoning: blank }), CLAIM, d, texts, '2026-11-22').join(), /reasoning is empty/, JSON.stringify(blank));
  }
  assert.match(voteProblems(okVote(), { ...CLAIM, verifiability: 'vague' }, d, texts, '2026-11-22').join(), /must be unverifiable/);
  assert.match(voteProblems({ verdict: 'unverifiable', reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence: [] }, CLAIM, d, texts, '2026-11-22').join(), /one official document/);
});

test('voteProblems: a public renunciation ends the wait, whatever the verdict, when the vote cites it (format 11)', () => {
  const early = { ...CLAIM, deadline: '2029-01-20', deadline_basis: 'inferred' };
  const texts = new Map([[1, UNITS], [3, UNITS]]);
  const LAW = { source_id: 1, excerpt: "La taxe d'habitation sur les résidences principales est supprimée", locator: '§1' };
  const REN = { source_id: 3, excerpt: 'Article 16', locator: '§1' };
  const ren = (published_on) => doc(3, 'renunciation', 'Pub', { published_on });
  const docs = [doc(1, 'law'), ren('2025-06-01')];
  const q = { open_question_fr: 'q', open_question_en: 'q' };
  // Law + renunciation: partly_came_true, to_evaluate, not_came_true and came_true are valid before the deadline,
  // exactly what confirm() accepts (decision 0013; Fable review 2, second re-check, finding 1).
  for (const verdict of ['partly_came_true', 'to_evaluate', 'not_came_true', 'came_true']) {
    assert.deepEqual(voteProblems(okVote({ verdict, ...q, evidence: [LAW, REN] }), early, docs, texts, '2026-11-22'), [], verdict);
  }
  // A renunciation in the pack that the vote does not cite does not end the wait (the ledger could not see it),
  // and the stop names that cause.
  assert.match(voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW] }), early, docs, texts, '2026-11-22').join(),
    /not over .*partly_came_true; source 3 is a renunciation that would end the wait, but this verdict does not cite it; cite it among the evidence, beside/);
  // Without one, it still waits for the deadline.
  assert.match(voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW] }), early, [doc(1, 'law')], texts, '2026-11-22').join(),
    /not over .*partly_came_true; only a public renunciation cited among the evidence ends the wait/);
  // Dated before the promise was made, after today, or not dated: it does not count.
  for (const published_on of ['2022-03-16', '2026-11-23', null]) {
    assert.match(voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW, REN] }), early, [doc(1, 'law'), ren(published_on)], texts, '2026-11-22').join(),
      /not over .*but verdict is partly_came_true/, String(published_on));
  }
  // Never the only evidence of partly_came_true, came_true or to_evaluate.
  assert.match(voteProblems(okVote({ verdict: 'to_evaluate', ...q, evidence: [REN] }), early, docs, texts, '2026-11-22').join(), /never the only evidence for to_evaluate/);
  // The wait is over, so pending no longer fits — cited or not (stricter than the ledger, the safe way).
  const pend = (evidence) => ({ verdict: 'pending', reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence });
  assert.match(voteProblems(pend([]), early, [ren('2025-06-01')], texts, '2026-11-22').join(), /renounced, which ends the wait, but verdict is pending/);
  assert.match(voteProblems(pend([REN]), early, docs, texts, '2026-11-22').join(), /renunciation, which may be cited only/);
  // A renunciation of a prediction is nothing: the wait goes on, and citing it is refused.
  const pred = voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW, REN] }), { ...early, type: 'prediction' }, docs, texts, '2026-11-22').join();
  assert.match(pred, /not over/);
  assert.match(pred, /renunciation, which may be cited only on a promise/);
  // A vague promise stays unverifiable, renounced or not, and the renunciation is not cited under unverifiable.
  assert.match(voteProblems(okVote({ verdict: 'not_came_true', evidence: [REN] }), { ...early, verifiability: 'vague' }, docs, texts, '2026-11-22').join(),
    /vague or hedged claim, verdict must be unverifiable/);
  assert.match(voteProblems(okVote({ verdict: 'unverifiable', evidence: [REN] }), { ...early, verifiability: 'vague' }, docs, texts, '2026-11-22').join(),
    /renunciation, which may be cited only/);
});

test('Fable review 7: unverifiable on a renounced measurable promise; hints never recommend a refused move; undated and future renunciations', () => {
  const early = { ...CLAIM, deadline: '2029-01-20', deadline_basis: 'inferred' };
  const texts = new Map([[1, UNITS], [3, UNITS], [4, UNITS]]);
  const LAW = { source_id: 1, excerpt: "La taxe d'habitation sur les résidences principales est supprimée", locator: '§1' };
  const REN = { source_id: 3, excerpt: 'Article 16', locator: '§1' };
  const ren = (published_on, id = 3) => doc(id, 'renunciation', 'Pub', { published_on });
  const unv = (evidence) => okVote({ verdict: 'unverifiable', evidence });
  // Finding 3: unverifiable on a measurable promise (its condition never arose) may cite the renunciation beside other evidence.
  assert.deepEqual(voteProblems(unv([LAW, REN]), early, [doc(1, 'law'), ren('2025-06-01')], texts, '2026-11-22'), []);
  assert.match(voteProblems(unv([REN]), early, [ren('2025-06-01')], texts, '2026-11-22').join(), /never the only evidence for unverifiable/);
  // Not cited: the hint tells the judge to cite it, which is allowed.
  assert.match(voteProblems(unv([LAW]), early, [doc(1, 'law'), ren('2025-06-01')], texts, '2026-11-22').join(), /does not cite it; cite it among the evidence/);
  // Where citing is refused (a prediction), no hint recommends it.
  const pred = voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW] }), { ...early, type: 'prediction' }, [doc(1, 'law'), ren('2025-06-01')], texts, '2026-11-22');
  assert.match(pred.join(), /not over/);
  assert.doesNotMatch(pred.join(), /cite/);
  // Vague promise: citing a renunciation under unverifiable is still refused.
  assert.match(voteProblems(unv([LAW, REN]), { ...early, verifiability: 'vague' }, [doc(1, 'law'), ren('2025-06-01')], texts, '2026-11-22').join(), /renunciation, which may be cited only/);
  // Finding 4: an undated renunciation in the pack stops pending, by name.
  const pend = { verdict: 'pending', reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence: [] };
  assert.match(voteProblems(pend, early, [doc(1, 'law'), ren(null)], texts, '2026-11-22').join(), /source 3 is a renunciation with no date/);
  assert.deepEqual(voteProblems(pend, { ...early, type: 'prediction' }, [doc(1, 'law'), ren(null)], texts, '2026-11-22'), []);
  // Finding 6: a cited renunciation dated after today is refused, also after the deadline.
  assert.match(voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW, REN] }), CLAIM, [doc(1, 'law'), ren('2026-12-01')], texts, '2026-11-22').join(),
    /dated 2026-12-01, after 2026-11-22; it cannot be cited before it is published/);
  // Every renunciation is considered: a later valid one ends the wait even if the first listed does not.
  const two = [doc(1, 'law'), ren('2026-12-01'), ren('2025-06-01', 4)];
  const REN4 = { source_id: 4, excerpt: 'Article 16', locator: '§1' };
  assert.deepEqual(voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW, REN4] }), early, two, texts, '2026-11-22'), []);
  assert.match(voteProblems(okVote({ verdict: 'partly_came_true', evidence: [LAW] }), early, two, texts, '2026-11-22').join(), /source 4 is a renunciation that would end the wait/);
});

test('voteProblems: the deadline day is inside the deadline (Fable review 1, finding 3)', () => {
  const texts = new Map([[1, UNITS]]);
  const d = [doc(1, 'law')];
  const pending = { verdict: 'pending', reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence: [] };
  // On the deadline day: still pending; outcome verdicts other than came_true wait.
  assert.deepEqual(voteProblems(pending, CLAIM, d, texts, '2023-12-31'), []);
  assert.match(voteProblems(okVote({ verdict: 'not_came_true' }), CLAIM, d, texts, '2023-12-31').join(), /not over/);
  assert.match(voteProblems(okVote({ verdict: 'partly_came_true' }), CLAIM, d, texts, '2023-12-31').join(), /not over/);
  assert.deepEqual(voteProblems(okVote(), CLAIM, d, texts, '2023-12-31'), []);
  // The day after: pending is void, the others are allowed.
  assert.match(voteProblems(pending, CLAIM, d, texts, '2024-01-01').join(), /passed, but verdict is pending/);
  assert.deepEqual(voteProblems(okVote({ verdict: 'not_came_true' }), CLAIM, d, texts, '2024-01-01'), []);
});

test('voteProblems: unverifiable on a measurable claim only after the deadline, with evidence (finding 5)', () => {
  const texts = new Map([[1, UNITS]]);
  const d = [doc(1, 'law')];
  const unv = okVote({ verdict: 'unverifiable' });
  assert.match(voteProblems(unv, CLAIM, d, texts, '2023-06-01').join(), /not over .*but verdict is unverifiable/);
  assert.match(voteProblems(unv, CLAIM, d, texts, '2023-12-31').join(), /not over/);
  assert.deepEqual(voteProblems(unv, CLAIM, d, texts, '2024-01-01'), []);
  // A vague or hedged claim is unverifiable at any date, before the deadline too.
  for (const verifiability of ['vague', 'hedged']) {
    assert.deepEqual(voteProblems({ ...unv, evidence: [] }, { ...CLAIM, verifiability }, d, texts, '2023-06-01'), []);
  }
});

test('voteProblems withinUnit: a quote may not join the end of one unit to the start of the next (finding 9)', () => {
  const units = [{ unit: 1, text: 'Il reste 3 millions de locaux à rendre raccordables.' }, { unit: 2, text: 'Le ralentissement du rythme des déploiements se confirme.' }];
  const joined = okVote({ evidence: [{ source_id: 1, excerpt: 'à rendre raccordables. Le ralentissement du rythme', locator: '§1' }] });
  assert.deepEqual(voteProblems(joined, CLAIM, [doc(1, 'law')], new Map([[1, units]]), '2026-11-22'), []);
  assert.match(voteProblems(joined, CLAIM, [doc(1, 'law')], new Map([[1, units]]), '2026-11-22', { withinUnit: true }).join(), /not found verbatim/);
  const inside = okVote({ evidence: [{ source_id: 1, excerpt: 'Le ralentissement du rythme', locator: '§1' }] });
  assert.deepEqual(voteProblems(inside, CLAIM, [doc(1, 'law')], new Map([[1, units]]), '2026-11-22', { withinUnit: true }), []);
});

test('suggestionProblems: only http(s) URLs that were among the search results, with an evidence kind', () => {
  const seen = new Set([urlKey('https://www.legifrance.gouv.fr/jorf/id/X#a')]);
  const s = { url: 'https://www.legifrance.gouv.fr/jorf/id/X/', kind: 'law', title: 't', publisher: 'p', lang: 'fr', published_on: '2019-12-28' };
  assert.deepEqual(suggestionProblems(s, seen), []);
  assert.match(suggestionProblems({ ...s, url: 'https://www.legifrance.gouv.fr/guessed' }, seen).join(), /not among the search results/);
  assert.match(suggestionProblems({ ...s, kind: 'statement' }, seen).join(), /not an evidence kind/);
  assert.match(suggestionProblems({ ...s, url: 'file:///etc/passwd' }, seen).join(), /http/);
  assert.match(suggestionProblems({ ...s, lang: 'FR', published_on: '2019-13-01' }, seen).join(), /two-letter.*date/);
});

test('searchEvidence: asks with web search and checks each suggestion against the results', async () => {
  const base = createFakeAdapter([JSON.stringify({
    evidence: [
      { url: 'https://www.legifrance.gouv.fr/a', kind: 'law', title: 'Loi', publisher: 'République française', published_on: null, lang: 'fr', why: 'w' },
      { url: 'https://made.up/b', kind: 'official', title: 'B', publisher: 'P', published_on: null, lang: 'fr', why: 'w' },
    ],
    leads: [], gaps: null,
  })]);
  const adapter = {
    ...base, webSearch: true,
    async call(req) {
      const r = await base.call(req);
      return { ...r, webSearch: { requests: 3, results: [{ url: 'https://www.legifrance.gouv.fr/a', title: 'Loi' }], errors: 0 } };
    },
  };
  const r = await searchEvidence(CLAIM, { provider: 'fake', model: 'claude-sonnet-5-5', today: '2026-11-22', askOptions: { adapters: { fake: adapter } } });
  assert.deepEqual(base.calls[0].webSearch, { maxUses: 8 });
  assert.match(base.calls[0].promptVersion, /^evidence-/);
  assert.match(base.calls[0].system, /^# KANVERIFY principles/);
  assert.deepEqual(r.evidence[0].problems, []);
  assert.match(r.evidence[1].problems.join(), /not among the search results/);
  assert.equal(r.call.web_searches, 3);
  assert.equal(r.call.cost_usd_estimate, 0.03);
});

test('archiveEvidence: usable suggestions are archived, failures recorded, problem suggestions skipped', async () => {
  const db = freshDb();
  const run = { claims: [{ search: { evidence: [
    { url: 'https://ok.example/a', kind: 'law', title: 't', publisher: 'p', lang: 'fr', problems: [] },
    { url: 'https://fail.example/b', kind: 'law', title: 't', publisher: 'p', lang: 'fr', problems: [] },
    { url: 'https://made.up/c', kind: 'law', title: 't', publisher: 'p', lang: 'fr', problems: ['url was not among the search results'] },
    { url: 'https://failed.before/d', kind: 'law', title: 't', publisher: 'p', lang: 'fr', problems: [], archive_error: 'HTTP 403' },
  ] } }] };
  const seen = [];
  const archiveImpl = async (d, s) => {
    seen.push(s.url);
    if (s.url.includes('fail')) throw new Error('Download failed: HTTP 403 for https://fail.example/b');
    return { id: addSource(d, s.kind, { url: s.url, media_type: 'text/html' }), url: s.url, redirects: [s.url], sha256: 'a'.repeat(64) };
  };
  await archiveEvidence(db, run, { archiveImpl });
  const [a, b, c] = run.claims[0].search.evidence;
  assert.deepEqual(seen, ['https://ok.example/a', 'https://fail.example/b']);
  assert.equal(a.archived.media_type, 'text/html');
  assert.match(b.archive_error, /403/);
  assert.equal(c.archived, undefined);
  db.close();
});

test('judgeRun: PDFs attached as documents, pages as §N text; votes checked; nothing written to claims, verdicts or votes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-jury-'));
  try {
    const html = Buffer.from('<html><body><p>Article 16. La taxe d’habitation sur les résidences principales est supprimée.</p></body></html>');
    const pdf = Buffer.from('%PDF-1.5\n1 0 obj << /Type /Pages /Count 3 >> endobj', 'latin1');
    const sha = (b) => createHash('sha256').update(b).digest('hex');
    writeFileSync(join(dir, sha(html)), html);
    writeFileSync(join(dir, sha(pdf)), pdf);
    const db = freshDb();
    const h = addSource(db, 'law', { sha256: sha(html), media_type: 'text/html' });
    const p = addSource(db, 'statistic', { sha256: sha(pdf), media_type: 'application/pdf' });
    const vote = (pdfExcerpt) => JSON.stringify({
      verdict: 'came_true', reasoning: 'r', summary_fr: 'f', summary_en: 'e', open_question_fr: null, open_question_en: null,
      evidence: [
        { source_id: h, excerpt: "La taxe d'habitation sur les résidences principales est supprimée", locator: '§1', pdf_page: null },
        { source_id: p, excerpt: pdfExcerpt, locator: 'p. 2', pdf_page: 2 },
      ],
    });
    const fake = createFakeAdapter([
      vote('Tableau 1 : 0 foyer'),
      vote('Tableau 1 : 99 foyers'),
      JSON.stringify({ pages: [{ page: 1, text: 'Titre' }, { page: 2, text: 'Tableau 1 : 0 foyer' }, { page: 3, text: 'Fin' }] }),
    ]);
    const run = { claims: [{ ...CLAIM, search: { evidence: [{ archived: { source_id: h } }, { archived: { source_id: p } }] } }] };
    await judgeRun(db, run, {
      jury: [{ provider: 'fake', model: 'claude-opus-5-5' }, { provider: 'fake', model: 'claude-sonnet-5-5' }],
      today: '2026-11-22', transcribeProvider: 'fake', transcribeModel: 'claude-haiku-5-5', evidenceDir: dir, askOptions: { adapters: { fake } },
    });
    // Two judge calls, then one transcription of the cited PDF page ±1 for the excerpt check.
    assert.equal(fake.calls.length, 3);
    assert.match(fake.calls[2].prompt, /pages 1, 2, 3/);
    const [first, second] = fake.calls;
    assert.equal(first.documents.length, 1);
    assert.ok(Buffer.from(first.documents[0].data).equals(pdf));
    assert.match(first.prompt, /§1 Article 16\./);
    assert.match(first.promptVersion, /^judge-/);
    assert.equal(first.prompt, second.prompt, 'both members get the same input and nothing about each other');
    const c = run.claims[0];
    assert.equal(c.votes[0].valid, true);
    assert.equal(c.votes[1].valid, false);
    assert.match(c.votes[1].problems.join(), new RegExp(`not found verbatim in source ${p}`));
    assert.equal(c.agreement, 'incomplete');
    for (const t of ['claims', 'verdicts', 'jury_votes', 'publications']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n, 0, t);
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadEvidenceDoc: overlong or script-only documents are excluded with a reason, not cut', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-jury-'));
  try {
    const put = (b) => { const s = createHash('sha256').update(b).digest('hex'); writeFileSync(join(dir, s), b); return s; };
    const big = put(Buffer.from('%PDF-1.5 << /Type /Pages /Count 101 >>', 'latin1'));
    const empty = put(Buffer.from('<html><body><script>render()</script></body></html>'));
    const src = (sha256, media_type) => ({ id: 1, kind: 'law', title: 't', publisher: 'p', sha256, media_type });
    assert.match(loadEvidenceDoc(src(big, 'application/pdf'), { evidenceDir: dir }).excluded, /101 pages/);
    assert.match(loadEvidenceDoc(src(empty, 'text/html'), { evidenceDir: dir }).excluded, /no visible text/);
    assert.match(loadEvidenceDoc(src(empty, 'image/png'), { evidenceDir: dir }).excluded, /not handled/);
    const long = put(Buffer.from(`${'x'.repeat(150_000)}\n\n${'y'.repeat(60_000)}`));
    assert.match(loadEvidenceDoc(src(long, 'text/plain'), { evidenceDir: dir }).excluded, /210000 characters/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderReview: per claim the quote, evidence, each vote and a blank line for the founder', async () => {
  const { renderReview } = await import('../src/jury.js');
  const md = renderReview({ claims: [{
    ...CLAIM, spec: '1:100', origin: { title: 'Avec vous', locator: 'p. 12' }, quote_en: 'the 20%… will pay nothing in 2023',
    search: { evidence: [
      { title: 'Loi', publisher: 'JO', kind: 'law', archived: { source_id: 7, url: 'https://x/loi', media_type: 'text/html', sha256: 'b'.repeat(64) } },
      { title: 'Stat', publisher: 'INSEE', kind: 'statistic', url: 'https://y', archive_error: 'Download failed: HTTP 403', problems: [] },
    ] },
    documents: [{ source_id: 7, excluded: null }],
    votes: [
      { model: 'claude-opus-5-5', verdict: 'came_true', valid: true, evidence: [{ source_id: 7, excerpt: 'Article 16', locator: '§1', verbatim: true }], reasoning: 'r', summary_fr: 'f', summary_en: 'e' },
      { model: 'claude-sonnet-5-5', error: 'anthropic: HTTP 529' },
    ],
    agreement: 'incomplete',
  }] });
  assert.match(md, /> les 20% de Français/);
  assert.match(md, /source 7：Loi（JO，法律文本）/);
  assert.match(md, /存证失败.*\n.*\n  原因：Download failed: HTTP 403/);
  assert.match(md, /\*\*claude-opus-5-5\*\*：成真（`came_true`）/);
  assert.match(md, /逐字核对通过/);
  assert.match(md, /claude-sonnet-5-5：调用失败/);
  assert.match(md, /创始人确认：/);
});

test('archiveEvidence warns when the download ends on another host; triedDocuments lists what cannot be used', async () => {
  const { triedDocuments } = await import('../src/jury.js');
  const db = freshDb();
  const claim = { key: 'C1', search: { evidence: [
    { url: 'https://www.federalregister.gov/documents/x', kind: 'gazette', title: 't', publisher: 'p', lang: 'en', problems: [] },
    { url: 'https://www.legifrance.gouv.fr/y', kind: 'law', title: 't', publisher: 'p', lang: 'fr', problems: [] },
    { url: 'https://guess.example/z', kind: 'law', title: 't', publisher: 'p', lang: 'fr', problems: ['url was not among the search results'] },
  ] } };
  const archiveImpl = async (d, s) => {
    if (s.url.includes('legifrance')) throw new Error('Download failed: HTTP 403');
    const final = 'https://unblock.federalregister.gov/';
    return { id: addSource(d, s.kind, { url: final }), url: final, redirects: [s.url, final], sha256: 'a'.repeat(64) };
  };
  await archiveEvidence(db, { claims: [claim] }, { archiveImpl });
  assert.match(claim.search.evidence[0].archived.warning, /www\.federalregister\.gov to unblock\.federalregister\.gov/);
  claim.documents = [{ source_id: claim.search.evidence[0].archived.source_id, excluded: 'the PDF has 331 pages, over the 100-page limit' }];
  assert.deepEqual(triedDocuments(claim).map((t) => t.reason), [
    'the PDF has 331 pages, over the 100-page limit', 'Download failed: HTTP 403', 'url was not among the search results',
  ]);
  db.close();
});
