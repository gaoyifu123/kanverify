// Légifrance JSON as jury evidence, and the provenance log of the archive command.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeAdapter } from '../src/ai/fake.js';
import { judgeClaim, loadEvidenceDoc, voteProblems } from '../src/jury.js';
import { appendProvenance, isLegifranceSource, legifranceToUnits, provenanceRecord } from '../src/legifrance.js';

// A small /consult/jorf response: sections listed out of order (intOrdre decides), HTML content,
// an entity, and an annex article without a number.
const FIXTURE = {
  cid: 'JORFTEXT000047445077',
  title: 'LOI n° 2023-270 du 14 avril 2023 de financement rectificative de la sécurité sociale pour 2023 (1)',
  jorfText: 'JORF n°0089 du 15 avril 2023',
  articles: [{ num: 'liminaire', intOrdre: 1, content: '<p><br/>Pour l&apos;année 2023, les prévisions sont retenues.</p>' }],
  sections: [
    {
      title: 'DEUXIÈME PARTIE', intOrdre: 30, articles: [],
      sections: [{ title: 'Titre IER', intOrdre: 1, sections: [], articles: [
        { num: '10', intOrdre: 1, content: '<p>I.-Le code de la sécurité sociale est ainsi modifié :</p><p>1° L’âge est porté à <b>soixante-quatre</b> ans.</p>' },
      ] }],
    },
    { title: 'Annexe', intOrdre: 40, sections: [], articles: [{ num: null, intOrdre: 1, content: '<table><tr><td>Recettes</td></tr></table>' }] },
    { title: 'PREMIÈRE PARTIE', intOrdre: 20, sections: [], articles: [{ num: '1', intOrdre: 1, content: '<p>Est approuvé le tableau d&#233;quilibre.</p>' }] },
  ],
};

const PUBLIC = 'https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000047445077';
const CLAIM = {
  key: 'C1', speaker: 'Test Speaker', origin: { title: 'Platform', published_on: '2022-03-17' },
  quote_original: 'q', lang: 'fr', quote_en: 'q', type: 'promise', verifiability: 'measurable',
  deadline: '2023-12-31', deadline_basis: 'stated', criteria_fr: 'c', criteria_en: 'c', speaker_role_en: 'Candidate',
};

test('legifranceToUnits: title, issue line, then articles in published order, labelled, HTML stripped', () => {
  assert.deepEqual(legifranceToUnits(FIXTURE), [
    { unit: 1, label: 'titre', text: FIXTURE.title },
    { unit: 2, label: 'JORF', text: 'JORF n°0089 du 15 avril 2023' },
    { unit: 3, label: 'art. liminaire', text: "Pour l'année 2023, les prévisions sont retenues." },
    { unit: 4, label: 'art. 1', text: 'Est approuvé le tableau déquilibre.' },
    { unit: 5, label: 'art. 10', text: 'I.-Le code de la sécurité sociale est ainsi modifié :' },
    { unit: 6, label: 'art. 10', text: '1° L’âge est porté à soixante-quatre ans.' },
    { unit: 7, label: 'Annexe', text: 'Recettes' },
  ]);
  assert.deepEqual(legifranceToUnits({}), []);
});

function withEvidence(t, bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'kv-lfj-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, sha256), bytes);
  return { dir, sha256 };
}

test('loadEvidenceDoc reads Légifrance JSON as labelled units; other JSON stays unhandled', (t) => {
  const { dir, sha256 } = withEvidence(t, Buffer.from(JSON.stringify(FIXTURE)));
  const row = { id: 38, kind: 'law', title: 't', publisher: 'Légifrance (DILA)', sha256, media_type: 'application/json', url: PUBLIC, lang: 'fr' };
  assert.ok(isLegifranceSource(row));
  const d = loadEvidenceDoc(row, { evidenceDir: dir });
  assert.equal(d.excluded, undefined);
  assert.equal(d.units[4].label, 'art. 10');
  assert.match(loadEvidenceDoc({ ...row, url: 'https://example.org/data.json' }, { evidenceDir: dir }).excluded, /not handled/);

  const broken = withEvidence(t, Buffer.from('{"title": "x'));
  assert.match(loadEvidenceDoc({ ...row, sha256: broken.sha256 }, { evidenceDir: broken.dir }).excluded, /not valid JSON/);
});

test('voteProblems: a law excerpt is checked verbatim and its locator must name the article', () => {
  const units = legifranceToUnits(FIXTURE);
  const docs = [{ meta: { source_id: 38, kind: 'law', publisher: 'Légifrance (DILA)', title: 't' } }];
  const texts = new Map([[38, units]]);
  const vote = (excerpt, locator) => ({
    verdict: 'came_true', rules_applied: ['OC-1', 'EV-1'], reasoning: 'r', summary_fr: 'f', summary_en: 'e', evidence: [{ source_id: 38, excerpt, locator }],
  });
  const excerpt = "L'âge est porté à soixante-quatre ans";
  for (const locator of ['art. 10', 'Article 10', 'ART 10']) {
    assert.deepEqual(voteProblems(vote(excerpt, locator), CLAIM, docs, texts, '2026-11-22'), [], locator);
  }
  assert.match(voteProblems(vote(excerpt, 'art. 1'), CLAIM, docs, texts, '2026-11-22').join(), /locator "art. 1" does not match .*art\. 10/);
  assert.match(voteProblems(vote(excerpt, '§6'), CLAIM, docs, texts, '2026-11-22').join(), /does not match/);
  assert.match(voteProblems(vote('L’âge est porté à soixante-deux ans', 'art. 10'), CLAIM, docs, texts, '2026-11-22').join(), /not found verbatim/);
});

test('the judge sees law text as [article] lines and is told to use the article as locator', async () => {
  const fake = createFakeAdapter([JSON.stringify({ verdict: 'pending', reasoning: 'r', evidence: [] })]);
  const doc = { meta: { source_id: 38, kind: 'law', title: 't', publisher: 'Légifrance (DILA)', url: PUBLIC }, units: legifranceToUnits(FIXTURE) };
  await judgeClaim(CLAIM, [doc], { provider: 'fake', model: 'm', today: '2026-11-22', askOptions: { adapters: { fake } } });
  const prompt = fake.calls[0].prompt;
  assert.match(prompt, /\[art\. 10\] 1° L’âge est porté à soixante-quatre ans\./);
  assert.match(prompt, /use that article as the locator/);
  assert.doesNotMatch(prompt, /§5 /);
});

test('provenance: one JSON line per archive, appended, earlier lines kept', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-prov-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'nested', 'legifrance-provenance.jsonl');
  const result = (id) => ({
    id, url: PUBLIC, sha256: 'a'.repeat(64),
    fetched: { method: 'POST', endpoint: 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/consult/jorf', body: '{"textCid":"JORFTEXT000047445077"}', at: '2026-11-22T10:00:00.000Z' },
  });
  appendProvenance(path, provenanceRecord(result(38)));
  appendProvenance(path, provenanceRecord(result(39)));
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.source_id), [38, 39]);
  assert.deepEqual(lines[0], {
    source_id: 38, sha256: 'a'.repeat(64), public_url: PUBLIC, method: 'POST',
    endpoint: 'https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/consult/jorf',
    request_body: '{"textCid":"JORFTEXT000047445077"}', retrieved_at: '2026-11-22T10:00:00.000Z',
  });
});
