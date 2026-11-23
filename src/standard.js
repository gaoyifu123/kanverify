// The verdict standard as programs read it: its version and its rule ids (decision 0014).
//
// Why a module of its own (principle 5): three readers need the same parse of
// docs/methodology/verdict-standard.md — the vote checks (src/pack.js: rules_applied ids must exist),
// the desk (records the version, lets the founder correct the ids) and the site (shows the rules of a
// verdict's version in plain words). rules.js stays free of I/O. The ledger does not read it: the
// schema checks the form of the ids (rules_recorded), the desk and the vote checks that they exist.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const STANDARD_PATH = resolve(here, '../docs/methodology/verdict-standard.md');
/** Earlier versions, kept unchanged when the version changes: verdict-standard-<version>.md. */
export const STANDARD_VERSIONS_DIR = resolve(here, '../docs/methodology/versions');

/** A rule id: two capital letters, a hyphen, a number without a leading zero (same form as rules_recorded in db/schema.sql). */
export const RULE_ID = /^[A-Z]{2}-[1-9][0-9]*$/;
const VERSION = /^\d+\.\d+$/;

/**
 * Parses the standard: the "Version X.Y" line and the rows of the "Standards" and "Rules" tables (| id | rule | règle |).
 * @returns {{ version: string, rules: Map<string, { id: string, en: string, fr: string }> }}
 */
export function parseStandard(text) {
  const version = /^Version (\d+\.\d+)\b/m.exec(text)?.[1];
  if (!version) throw new Error('the verdict standard has no "Version X.Y" line');
  const rules = new Map();
  // Only the "## Standards" and "## Rules" sections (decision 0015 standards first): other tables of the
  // file name rule ids too.
  const section = (name) => new RegExp(`^## ${name}\\s*$([\\s\\S]*?)(?=^## )`, 'm').exec(String(text).replace(/\r\n/g, '\n'))?.[1] ?? '';
  for (const line of `${section('Standards')}\n${section('Rules')}`.split('\n')) {
    const m = /^\|\s*([A-Z]{2}-\d+)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*$/.exec(line);
    if (!m) continue;
    if (!RULE_ID.test(m[1])) throw new Error(`the verdict standard has a malformed rule id ${m[1]}`);
    if (rules.has(m[1])) throw new Error(`the verdict standard lists rule ${m[1]} twice`);
    rules.set(m[1], { id: m[1], en: m[2], fr: m[3] });
  }
  if (rules.size === 0) throw new Error('the verdict standard has no rules table');
  return { version, rules };
}

const cache = new Map();
function readParsed(path) {
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = cache.get(path);
  if (hit?.key === key) return hit.value;
  const value = parseStandard(readFileSync(path, 'utf8'));
  cache.set(path, { key, value });
  return value;
}

/**
 * The current standard, or the standard of an earlier `version` (from STANDARD_VERSIONS_DIR).
 * Throws when that version cannot be found: a verdict's rules are never shown from another version.
 */
export function loadStandard(version = null, { path = STANDARD_PATH, versionsDir = STANDARD_VERSIONS_DIR } = {}) {
  const current = readParsed(path);
  if (version === null || version === current.version) return current;
  if (typeof version !== 'string' || !VERSION.test(version)) throw new Error(`rules version ${JSON.stringify(version)} is not of the form X.Y`);
  const old = join(versionsDir, `verdict-standard-${version}.md`);
  if (!existsSync(old)) throw new Error(`the verdict standard ${version} is not kept (${old}); copy it there before changing the version`);
  const parsed = readParsed(old);
  if (parsed.version !== version) throw new Error(`${old} says version ${parsed.version}, not ${version}`);
  return parsed;
}

/**
 * What is wrong with a list of rule ids against a standard: not a non-empty list of distinct ids that
 * exist in it. Returns the problems (empty when none).
 */
export function rulesAppliedProblems(ids, standard) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return [`rules_applied must list the ids of the rules that decided the verdict (verdict standard ${standard.version})`];
  }
  const problems = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !standard.rules.has(id)) problems.push(`rules_applied: ${JSON.stringify(id)} is not a rule of the verdict standard ${standard.version}`);
    else if (seen.has(id)) problems.push(`rules_applied: ${id} is listed twice`);
    seen.add(id);
  }
  return problems;
}

/** "DL-2, EV-1" or "DL-2 EV-1" (as typed at the desk) -> ['DL-2', 'EV-1']; upper-cased, blanks and commas split. */
export function parseRuleList(text) {
  return String(text ?? '').split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
}
