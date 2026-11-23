// The verdict standard as programs read it (src/standard.js; decision 0014), and the places derived from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STANDARD_PATH, loadStandard, parseRuleList, parseStandard, rulesAppliedProblems } from '../src/standard.js';
import { judgeRulesProblem, judgeRulesVersion } from '../src/jury.js';
import { REVERSAL_TYPES } from '../src/rules.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('the standard: one version, the three standards and every rule, each in English and French', () => {
  const s = loadStandard();
  assert.equal(s.version, '0.8');
  assert.deepEqual([...s.rules.keys()], ['ST-1', 'ST-2', 'ST-3', 'VG-1', 'VG-2', 'VG-3', 'DL-1', 'DL-2', 'DL-3', 'DL-4', 'EA-1', 'RN-1', 'EV-1', 'EV-2', 'EV-3', 'OC-1', 'OC-2', 'OC-3']);
  for (const r of s.rules.values()) assert.ok(r.en.length > 20 && r.fr.length > 20, r.id);
  // Only the two rule tables count: the "where each rule is applied" table names ids too.
  assert.throws(() => parseStandard('Version 0.1\n\n## Rules\n\n| VG-1 | a | b |\n| VG-1 | c | d |\n\n## End\n'), /twice/);
  assert.throws(() => parseStandard('Version 0.1\n\n## Other\n\n| VG-1 | a | b |\n\n## End\n'), /no rules table/);
  assert.throws(() => parseStandard('## Rules\n\n| VG-1 | a | b |\n\n## End\n'), /Version/);
});

test('the judge prompt names the current standard and cites exactly its rule ids', () => {
  const s = loadStandard();
  assert.equal(judgeRulesVersion(), s.version);
  assert.equal(judgeRulesProblem(), null);
  const prompt = read('team/run/judge-prompt.md').replace(/<!--[\s\S]*?-->/g, '');
  const cited = new Set([...prompt.matchAll(/\b([A-Z]{2}-\d+)\b/g)].map((m) => m[1]));
  for (const id of cited) assert.ok(s.rules.has(id), `the judge prompt cites ${id}, which the standard does not have`);
  for (const id of s.rules.keys()) assert.ok(cited.has(id), `the judge prompt never names ${id}`);
});

test('a judge prompt written for another version of the standard voids every vote', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-std-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p = join(dir, 'judge-prompt.md');
  writeFileSync(p, read('team/run/judge-prompt.md').replace('Rules: verdict standard 0.8', 'Rules: verdict standard 0.5'));
  assert.match(judgeRulesProblem(p), /written for verdict standard 0\.5, but the standard is 0\.8/);
  writeFileSync(p, read('team/run/judge-prompt.md').replace(/^Rules: .*$/m, ''));
  assert.match(judgeRulesProblem(p), /\(none named\)/);
});

test('an earlier version is read from its kept copy, never from the current file', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'kv-std-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => loadStandard('0.5', { versionsDir: dir }), /0\.5 is not kept/);
  assert.throws(() => loadStandard('0.5"x', { versionsDir: dir }), /not of the form/);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'verdict-standard-0.5.md'), '# Old\n\nVersion 0.5\n\n## Rules\n\n| id | rule | règle |\n| --- | --- | --- |\n| XX-1 | old rule | ancienne règle |\n\n## End\n');
  assert.deepEqual([...loadStandard('0.5', { versionsDir: dir }).rules.keys()], ['XX-1']);
  writeFileSync(join(dir, 'verdict-standard-0.4.md'), 'Version 0.3\n\n## Rules\n\n| XX-1 | a | b |\n\n## End\n');
  assert.throws(() => loadStandard('0.4', { versionsDir: dir }), /says version 0\.3/);
  assert.equal(loadStandard('0.6').version, '0.6');
});

test('rules_applied: a non-empty list of distinct ids of that version; typed lists are read leniently', () => {
  const s = loadStandard();
  assert.deepEqual(rulesAppliedProblems(['DL-2', 'EV-1'], s), []);
  assert.equal(rulesAppliedProblems([], s).length, 1);
  assert.equal(rulesAppliedProblems(null, s).length, 1);
  assert.match(rulesAppliedProblems(['DL-2', 'DL-2'], s).join(), /twice/);
  assert.match(rulesAppliedProblems(['DL-9'], s).join(), /not a rule/);
  assert.deepEqual(parseRuleList(' dl-2,EV-1;  st-3 '), ['DL-2', 'EV-1', 'ST-3']);
  assert.deepEqual(parseRuleList(''), []);
});

test('RN-1 switch: promises only, written the same in src/rules.js and db/schema.sql (decision 0015)', () => {
  assert.deepEqual([...REVERSAL_TYPES], ['promise']);
  const lists = [...read('db/schema.sql').matchAll(/c\.type IN \(([^)]*)\)/g)].map((m) => m[1].split(',').map((x) => x.trim().replace(/'/g, '')));
  assert.equal(lists.length, 2);
  for (const l of lists) assert.deepEqual(l, [...REVERSAL_TYPES]);
  assert.match(read('docs/methodology/verdict-standard.md'), /\*\*Which claims it applies to: promises only\*\*/);
  assert.ok(STANDARD_PATH.endsWith('verdict-standard.md'));
});

test('VG-3: a candidate prediction with an inferred deadline is refused before it reaches the record', async () => {
  const { candidateProblems } = await import('../src/extract.js');
  const c = {
    quote_original: 'Le chômage sera sous 5 %.', lang: 'fr', quote_fr: null, quote_en: 'Unemployment will be below 5%.', type: 'prediction',
    domain: 'employment', verifiability: 'measurable', unit: 1, locator: '§1', deadline: '2027-05-13', deadline_basis: 'inferred',
    criteria_fr: 'Taux sous 5 %.', criteria_en: 'Rate below 5%.', speaker_role_fr: null, speaker_role_en: null,
  };
  assert.match(candidateProblems(c).join(), /a prediction never has an inferred deadline \(VG-3\)/);
  assert.doesNotMatch(candidateProblems({ ...c, deadline_basis: 'stated' }).join(), /VG-3/);
  assert.doesNotMatch(candidateProblems({ ...c, type: 'promise' }).join(), /VG-3/);
});

test('review 8, finding 3: every version is kept byte for byte, and the live standard is the copy of its own version', () => {
  const live = readFileSync(STANDARD_PATH);
  const { version } = loadStandard();
  const frozen = readFileSync(new URL(`../docs/methodology/versions/verdict-standard-${version}.md`, import.meta.url));
  assert.ok(live.equals(frozen), `docs/methodology/verdict-standard.md differs from versions/verdict-standard-${version}.md: raise the version (and freeze the new one) instead of editing a version in place`);
  // The earlier version stays readable, with its own text.
  const old = loadStandard('0.6');
  assert.equal(old.version, '0.6');
  assert.match(old.rules.get('RN-1').fr, /reniée/, '0.6 keeps its own wording');
  assert.doesNotMatch(loadStandard().rules.get('RN-1').fr, /reniée/);
});

test('review 8: the public lines say "precise", French without blame, « prévision », and ST-3 says to follow the rule', () => {
  const s = loadStandard();
  assert.match(s.rules.get('ST-1').en, /explicit, precise public reversal/);
  assert.match(s.rules.get('ST-1').fr, /explicite et précis/);
  assert.match(s.rules.get('RN-1').en, /explicitly, precisely and publicly reversed/);
  assert.match(s.rules.get('RN-1').fr, /sur laquelle son auteur est explicitement et publiquement revenu, de façon précise/);
  assert.match(s.rules.get('VG-1').fr, /formulée avec réserve/);
  for (const r of s.rules.values()) assert.doesNotMatch(r.fr, /reniée|prédiction|prudente/, r.id);
  assert.match(s.rules.get('ST-3').en, /the rule is followed and the judge says so/);
  assert.match(s.rules.get('DL-2').en, /decides the final verdict/);
  assert.match(s.rules.get('EA-1').en, /provisional and is judged again at the deadline/);
  const text = readFileSync(STANDARD_PATH, 'utf8');
  assert.match(text, /按'看期限那一刻、看最终结果'，判未成真。/);
  assert.match(text, /\| 10 \| promise \| the same promise \*\*made again\*\* after a reversal/);
  assert.doesNotMatch(text, /the summary mentions the reversal|the summary mentions it \||the summary may mention it/);
});
