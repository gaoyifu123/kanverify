// Extraction role (team/run/extract.md): read one archived platform and propose candidate
// claims. Candidates go to a JSON file under data/candidates/ for human review; nothing here
// writes to the claims table (principle 2: a person confirms before anything is recorded).
//
// Verbatim check without a PDF parser (principle 5): the PDF is transcribed page by page by a
// model, once per source (data/candidates/source-<id>-text.json, reused by later runs), and every
// quote is looked up in that text after normalising whitespace, hyphens, dashes and quote marks.
// A web page needs no model for this: its visible text is taken out of the HTML in code.
// All model calls go through ask() (principle 8).
//
// Since decision 0010 the CLI here needs --paid-api: layer-1 agents write the candidates file in
// the same shape instead, and src/pack.js checks it. The functions stay for that check.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ask } from './ai/index.js';
import { DEFAULT_EVIDENCE_DIR, evidencePath } from './archive.js';
import { openDatabase } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..');
export const DEFAULT_OUT_DIR = resolve(ROOT, 'data/candidates');
const PRINCIPLES_PATH = resolve(ROOT, 'PRINCIPLES.md');
const EXTRACT_PROMPT_PATH = resolve(ROOT, 'team/run/extract-prompt.md');
const TRANSCRIBE_PROMPT_PATH = resolve(ROOT, 'team/run/transcribe-prompt.md');

// Same list as the CHECK on claims.domain in db/schema.sql (a test keeps them equal).
export const DOMAINS = Object.freeze([
  'economy', 'tax', 'employment', 'health', 'education', 'environment', 'energy', 'security',
  'defence', 'justice', 'immigration', 'foreign_affairs', 'institutions', 'social', 'housing',
  'transport', 'agriculture', 'digital', 'culture', 'other',
]);
const VERIFIABILITY = ['measurable', 'vague', 'hedged'];
const TYPES = ['promise', 'prediction'];

// USD per million tokens, standard (non-batch, uncached) rates from
// https://docs.anthropic.com/en/docs/about-claude/pricing, read 2026-11-22. Estimates only:
// the bill is what the provider charges. Haiku 5.5 costs more for prompts over 100k tokens.
export const PRICES = Object.freeze({
  checked_on: '2026-11-22',
  source: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  models: {
    'claude-fable-5-2': { input: 8, output: 40 },
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-sonnet-5-5': { input: 2, output: 10 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5, over100k: { input: 0.5, output: 2.5 } },
  },
});

// Each call carries the whole PDF but works on a few pages, so that one answer stays well under
// the output cap and under the five minutes after which Node's fetch stops waiting for headers.
const DEFAULT_PAGES_PER_CALL = 3;
const CALL_TIMEOUT_MS = 280_000;
const EXTRACT_MAX_TOKENS = 32_000;
const TRANSCRIBE_MAX_TOKENS = 24_000;

// ---------------------------------------------------------------- pure helpers

/** Cost of one call in USD, or null for a model without a known price. */
export function estimateCost(model, { inputTokens = 0, outputTokens = 0 } = {}) {
  const price = PRICES.models[model];
  if (!price) return null;
  const rate = price.over100k && inputTokens > 100_000 ? price.over100k : price;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1e6;
}

/** Reads a role prompt file: its "Version: x" line and its text without HTML comments. */
export function loadPrompt(path) {
  const raw = readFileSync(path, 'utf8');
  const version = /^Version:\s*(\S+)\s*$/m.exec(raw)?.[1];
  if (!version) throw new Error(`${path} has no "Version:" line`);
  return { version, text: raw.replace(/<!--[\s\S]*?-->\s*/g, '').trim() };
}

/**
 * Text used for the verbatim comparison. Removes what a transcription or a PDF layout changes
 * without changing the words: all whitespace (line breaks, French spaces before punctuation),
 * soft hyphens and zero-width characters, and every hyphen and dash (so a word hyphenated at a
 * line end matches the whole word). Curly quotes and guillemets become straight quotes.
 * Letters, their case and accents, digits and other punctuation must match exactly.
 */
export function normalizeForMatch(text) {
  return String(text)
    .normalize('NFKC')
    .replace(/[­​-‍⁠﻿]/g, '')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟«»″]/g, '"')
    .replace(/…/g, '...')
    .replace(/[-‐-―−]/g, '')
    .replace(/\s+/gu, '');
}

/**
 * Looks a quote up in the units (pages or paragraphs) of a text. A quote may run across units.
 * @returns {{ verbatim: boolean, verbatim_unit: number|null }} the unit where the match starts.
 */
export function checkVerbatim(quote, units) {
  const needle = normalizeForMatch(quote ?? '');
  if (needle.length === 0) return { verbatim: false, verbatim_unit: null };
  let haystack = '';
  const starts = [];
  for (const unit of units) {
    starts.push({ at: haystack.length, unit: unit.unit });
    haystack += normalizeForMatch(unit.text ?? '');
  }
  const at = haystack.indexOf(needle);
  if (at < 0) return { verbatim: false, verbatim_unit: null };
  let found = starts[0].unit;
  for (const s of starts) if (s.at <= at) found = s.unit;
  return { verbatim: true, verbatim_unit: found };
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', laquo: '«', raquo: '»', ndash: '–', mdash: '—',
  hellip: '…', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç',
  ocirc: 'ô', icirc: 'î', iuml: 'ï', ucirc: 'û', ugrave: 'ù', euml: 'ë', oelig: 'œ', Eacute: 'É',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name] ?? whole;
  });
}

const BLOCK_TAGS = 'p|div|section|article|header|footer|nav|main|aside|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|blockquote|figure|figcaption|form|button|option|label|hr';

/**
 * Visible text of an HTML page, one entry per block of text. Drops comments, the head, scripts,
 * styles and other non-text elements. Does not apply CSS: text hidden by a stylesheet is kept.
 */
export function htmlToParagraphs(html) {
  const text = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(head|script|style|noscript|template|svg|iframe|object|canvas)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    // Line breaks in the source are layout, not paragraphs: only tags make a new paragraph.
    .replace(/\s+/gu, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, 'gi'), '\n')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/gu, ' ').trim())
    .filter((line) => line.length > 0);
}

/** Number of pages of a PDF, read from its page tree, or null if it cannot be seen. */
export function pdfPageCount(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)]
    .map((m) => Number(m[1] ?? m[2]));
  if (counts.length > 0) return Math.max(...counts);
  const leaves = text.match(/\/Type\s*\/Page(?![s\w])/g);
  return leaves ? leaves.length : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function filled(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The rules a candidate must meet before it could become a claims row (db/schema.sql and
 * team/run/extract.md). Returns the broken ones as short English sentences; empty if none.
 */
export function candidateProblems(c, { unitCount } = {}) {
  const problems = [];
  if (!filled(c.quote_original)) problems.push('quote_original is empty');
  if (typeof c.lang !== 'string' || !/^[a-z]{2}$/.test(c.lang)) problems.push('lang is not a two-letter ISO 639-1 code');
  if (!TYPES.includes(c.type)) problems.push('type is not promise or prediction');
  if (!DOMAINS.includes(c.domain)) problems.push('domain is not in the fixed list');
  if (!VERIFIABILITY.includes(c.verifiability)) problems.push('verifiability is not measurable, vague or hedged');
  if (!Number.isInteger(c.unit) || c.unit < 1 || (unitCount && c.unit > unitCount)) problems.push('unit is not a page or paragraph of this source');
  if (!filled(c.locator)) problems.push('locator is empty');
  if (c.deadline !== null && !isDate(c.deadline)) problems.push('deadline is not a YYYY-MM-DD date');
  if ((c.deadline === null) !== (c.deadline_basis === null)) problems.push('deadline and deadline_basis must be given together');
  if (c.deadline_basis !== null && !['stated', 'inferred'].includes(c.deadline_basis)) problems.push('deadline_basis is not stated or inferred');
  if (c.verifiability === 'measurable' && !filled(c.criteria_fr) && !filled(c.criteria_en)) problems.push('measurable but no criteria');
  if (c.verifiability === 'measurable' && c.deadline === null) problems.push('measurable but no deadline');
  if (['vague', 'hedged'].includes(c.verifiability) && (c.criteria_fr !== null || c.criteria_en !== null)) problems.push('vague or hedged but criteria given');
  if (filled(c.criteria_fr) !== filled(c.criteria_en)) problems.push('criteria in one language only');
  if (filled(c.speaker_role_fr) !== filled(c.speaker_role_en)) problems.push('speaker role in one language only');
  for (const lang of ['fr', 'en']) {
    const field = `quote_${lang}`;
    if (c.lang === lang && c[field] !== null) problems.push(`${field} must be null: the quote is in ${lang}`);
    if (c.lang !== lang && !filled(c[field])) problems.push(`${field} translation missing`);
  }
  return problems;
}

const CANDIDATE_FIELDS = [
  'quote_original', 'lang', 'unit', 'locator', 'type', 'domain', 'verifiability', 'deadline',
  'deadline_basis', 'criteria_fr', 'criteria_en', 'speaker_role_fr', 'speaker_role_en',
  'quote_fr', 'quote_en', 'notes',
];

// Keeps the known fields only, in a fixed order; a missing field becomes null so it is visible.
function pickCandidate(raw) {
  const c = {};
  for (const field of CANDIDATE_FIELDS) c[field] = raw && Object.hasOwn(raw, field) ? raw[field] : null;
  return c;
}

// ---------------------------------------------------------------- files

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  renameSync(temp, path);
}

function stamp(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function ranges(count, size) {
  const out = [];
  for (let from = 1; from <= count; from += size) out.push([from, Math.min(count, from + size - 1)]);
  return out;
}

function addUsage(total, usage) {
  total.inputTokens += usage?.inputTokens ?? 0;
  total.outputTokens += usage?.outputTokens ?? 0;
}

function sumCost(calls) {
  let total = 0;
  for (const call of calls) {
    if (call.cost_usd_estimate === null) return null;
    total += call.cost_usd_estimate;
  }
  return Math.round(total * 10_000) / 10_000;
}

function callRecord(purpose, units, reply) {
  const usage = { inputTokens: reply.usage?.inputTokens ?? 0, outputTokens: reply.usage?.outputTokens ?? 0 };
  return { purpose, units, model_version: reply.modelVersion ?? null, ...usage, cost_usd_estimate: estimateCost(reply.model, usage) };
}

// ---------------------------------------------------------------- the text to check against

async function transcribePdf(bytes, pageCount, { provider, model, pagesPerCall, askOptions }) {
  const principles = readFileSync(PRINCIPLES_PATH, 'utf8');
  const prompt = loadPrompt(TRANSCRIBE_PROMPT_PATH);
  const system = `${principles}\n\n${prompt.text}`;
  const pages = new Map();
  const calls = [];
  for (const [from, to] of ranges(pageCount, pagesPerCall)) {
    const reply = await ask({
      provider, model, promptVersion: prompt.version, system, json: true,
      maxTokens: TRANSCRIBE_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS,
      document: { mediaType: 'application/pdf', data: bytes },
      prompt: `Transcribe PDF pages ${from} to ${to} of the attached document (the file has ${pageCount} pages). Answer in JSON as specified.`,
    }, askOptions);
    calls.push(callRecord('transcribe', [from, to], reply));
    for (const entry of Array.isArray(reply.json?.pages) ? reply.json.pages : []) {
      const page = entry?.page;
      if (Number.isInteger(page) && page >= from && page <= to && typeof entry.text === 'string' && !pages.has(page)) {
        pages.set(page, { unit: page, printed_pages: entry.printed_pages ?? null, text: entry.text });
      }
    }
  }
  const units = [];
  const missing = [];
  for (let p = 1; p <= pageCount; p++) {
    if (pages.has(p)) units.push(pages.get(p));
    else missing.push(p);
  }
  return { method: 'model-transcription', provider, model, prompt_version: prompt.version, calls, missing_units: missing, units };
}

/** The text of a source, split into units; made once per source and kept in a file. */
async function sourceText(source, bytes, { outDir, provider, model, pagesPerCall, askOptions, now }) {
  const path = join(outDir, `source-${source.id}-text.json`);
  if (existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved.sha256 !== source.sha256) throw new Error(`${path} belongs to another file (hash differs); remove it to redo the transcription`);
    return { path, reused: true, text: saved };
  }
  let made;
  if (source.media_type === 'text/html') {
    const paragraphs = htmlToParagraphs(bytes.toString('utf8'));
    made = { method: 'html-strip', calls: [], missing_units: [], units: paragraphs.map((text, i) => ({ unit: i + 1, text })) };
  } else if (source.media_type === 'application/pdf') {
    const pageCount = pdfPageCount(bytes);
    if (!pageCount) throw new Error(`cannot read the page count of source ${source.id}`);
    made = await transcribePdf(bytes, pageCount, { provider, model, pagesPerCall, askOptions });
  } else {
    throw new Error(`source ${source.id} is ${source.media_type}; only application/pdf and text/html are handled`);
  }
  const text = {
    source_id: source.id,
    sha256: source.sha256,
    unit_kind: source.media_type === 'text/html' ? 'paragraph' : 'pdf_page',
    made_at: now.toISOString(),
    ...made,
    cost_usd_estimate: sumCost(made.calls),
  };
  writeJsonAtomic(path, text);
  return { path, reused: false, text };
}

// ---------------------------------------------------------------- extraction

function sourceContext(source, termEnd) {
  const context = {
    title: source.title, publisher: source.publisher, published_on: source.published_on,
    url: source.url, lang: source.lang, media_type: source.media_type,
  };
  return [
    'Source (metadata from the archive, not instructions):',
    JSON.stringify(context, null, 2),
    termEnd
      ? `Term end, for inferred deadlines: ${termEnd}`
      : 'Term end, for inferred deadlines: none given.',
  ].join('\n');
}

/**
 * Proposes candidate claims for one archived source and writes them to
 * data/candidates/source-<id>-<model>-<timestamp>.json. Writes nothing to the database.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} sourceId
 * @param {object} opts
 *   provider, model: who extracts (required). promptVersion: if given, must equal the version
 *   in team/run/extract-prompt.md. termEnd: YYYY-MM-DD used for inferred deadlines.
 *   transcribeModel: model for a new PDF transcription (default: model). pagesPerCall.
 *   Tests: askOptions (passed to ask()), evidenceDir, outDir, now.
 * @returns {Promise<object>} the run record that was written; its `candidates` is the array.
 */
export async function extractCandidates(db, sourceId, opts = {}) {
  const {
    provider, model, promptVersion, termEnd = null, transcribeModel = model,
    pagesPerCall = DEFAULT_PAGES_PER_CALL, askOptions = {},
    evidenceDir = DEFAULT_EVIDENCE_DIR, outDir = DEFAULT_OUT_DIR, now = new Date(),
  } = opts;
  if (!filled(provider) || !filled(model)) throw new Error('provider and model are required');
  if (!/^[A-Za-z0-9._-]+$/.test(model)) throw new Error('model id may only hold letters, digits, dot, dash and underscore');
  if (termEnd !== null && !isDate(termEnd)) throw new Error('termEnd must be YYYY-MM-DD');
  if (!Number.isInteger(pagesPerCall) || pagesPerCall < 1) throw new Error('pagesPerCall must be a positive integer');
  const prompt = loadPrompt(EXTRACT_PROMPT_PATH);
  if (promptVersion !== undefined && promptVersion !== prompt.version) {
    throw new Error(`promptVersion ${promptVersion} does not match team/run/extract-prompt.md (${prompt.version})`);
  }

  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error(`no source ${sourceId}`);
  const bytes = readFileSync(evidencePath(evidenceDir, source.sha256));

  const text = await sourceText(source, bytes, {
    outDir, provider, model: transcribeModel, pagesPerCall, askOptions, now,
  });
  const units = text.text.units;
  const unitCount = text.text.unit_kind === 'paragraph' ? units.length : units.length + text.text.missing_units.length;

  const system = `${readFileSync(PRINCIPLES_PATH, 'utf8')}\n\n${prompt.text}`;
  const context = sourceContext(source, termEnd);
  const calls = [];
  const raw = [];
  if (text.text.unit_kind === 'paragraph') {
    const numbered = units.map((u) => `§${u.unit} ${u.text}`).join('\n');
    const reply = await ask({
      provider, model, promptVersion: prompt.version, system, json: true,
      maxTokens: EXTRACT_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS,
      prompt: `${context}\n\nThe visible text of the web page follows, one paragraph per line, numbered §1 to §${units.length}. Extract from all paragraphs. Answer in JSON as specified.\n\n<document>\n${numbered}\n</document>`,
    }, askOptions);
    calls.push(callRecord('extract', [1, units.length], reply));
    raw.push(...(Array.isArray(reply.json?.candidates) ? reply.json.candidates : []));
  } else {
    for (const [from, to] of ranges(unitCount, pagesPerCall)) {
      const reply = await ask({
        provider, model, promptVersion: prompt.version, system, json: true,
        maxTokens: EXTRACT_MAX_TOKENS, timeoutMs: CALL_TIMEOUT_MS,
        document: { mediaType: 'application/pdf', data: bytes },
        prompt: `${context}\n\nThe whole document is attached (${unitCount} PDF pages). Extract only from PDF pages ${from} to ${to}; the other pages are context. Answer in JSON as specified.`,
      }, askOptions);
      calls.push(callRecord('extract', [from, to], reply));
      raw.push(...(Array.isArray(reply.json?.candidates) ? reply.json.candidates : []));
    }
  }

  const seen = new Map();
  const candidates = raw.map((entry, i) => {
    const c = pickCandidate(entry);
    const check = checkVerbatim(c.quote_original, units);
    const key = normalizeForMatch(c.quote_original ?? '');
    const duplicateOf = seen.get(key) ?? null;
    if (duplicateOf === null) seen.set(key, i + 1);
    const problems = candidateProblems(c, { unitCount });
    if (check.verbatim && check.verbatim_unit !== c.unit) problems.push(`quote found on unit ${check.verbatim_unit}, not ${c.unit}`);
    return { index: i + 1, ...c, verbatim: check.verbatim, verbatim_unit: check.verbatim_unit, duplicate_of: duplicateOf, problems };
  });

  const usage = { inputTokens: 0, outputTokens: 0 };
  for (const call of calls) addUsage(usage, call);
  const record = {
    kind: 'kanverify-extraction-candidates',
    note: 'Candidates only. Not reviewed, not recorded, not for publication.',
    made_at: now.toISOString(),
    role: 'extract',
    provider,
    model,
    model_versions: [...new Set(calls.map((c) => c.model_version).filter(Boolean))],
    prompt_version: prompt.version,
    term_end: termEnd,
    source: {
      id: source.id, kind: source.kind, title: source.title, url: source.url, publisher: source.publisher,
      published_on: source.published_on, sha256: source.sha256, media_type: source.media_type, lang: source.lang,
    },
    text: {
      file: text.path,
      reused: text.reused,
      method: text.text.method,
      model: text.text.model ?? null,
      prompt_version: text.text.prompt_version ?? null,
      unit_kind: text.text.unit_kind,
      units: unitCount,
      missing_units: text.text.missing_units,
    },
    calls,
    usage,
    cost_usd_estimate: {
      extraction: sumCost(calls),
      transcription_this_run: text.reused ? 0 : text.text.cost_usd_estimate,
      prices: PRICES,
      note: 'Estimate from token counts and list prices; the provider bill is authoritative.',
    },
    counts: {
      candidates: candidates.length,
      verbatim_ok: candidates.filter((c) => c.verbatim).length,
      verbatim_failed: candidates.filter((c) => !c.verbatim).length,
      with_problems: candidates.filter((c) => c.problems.length > 0).length,
      duplicates: candidates.filter((c) => c.duplicate_of !== null).length,
    },
    candidates,
  };
  const path = join(outDir, `source-${source.id}-${model}-${stamp(now)}.json`);
  writeJsonAtomic(path, record);
  return { ...record, path };
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      model: { type: 'string' },
      provider: { type: 'string', default: 'anthropic' },
      'term-end': { type: 'string' },
      'transcribe-model': { type: 'string' },
      'pages-per-call': { type: 'string' },
      'paid-api': { type: 'boolean', default: false },
    },
  });
  // Decision 0010: extraction is layer-1 work for Claude Code agents under the subscription; they
  // write a candidates file in this module's shape, checked by `node src/pack.js candidates`.
  if (!values['paid-api']) {
    console.error('This sends the whole document to the paid API for every few pages. Extraction is done by agents now (decision 0010; check their file with node src/pack.js candidates <file>). Add --paid-api to run it anyway.');
    process.exitCode = 2;
    return;
  }
  const sourceId = Number(positionals[0]);
  if (positionals.length !== 1 || !Number.isInteger(sourceId) || !values.model) {
    console.error('Usage: node src/extract.js <sourceId> --model <id> [--provider anthropic] [--term-end YYYY-MM-DD] [--transcribe-model <id>] [--pages-per-call N]');
    process.exitCode = 2;
    return;
  }
  const db = openDatabase();
  try {
    const run = await extractCandidates(db, sourceId, {
      provider: values.provider,
      model: values.model,
      termEnd: values['term-end'] ?? null,
      transcribeModel: values['transcribe-model'] ?? values.model,
      pagesPerCall: values['pages-per-call'] ? Number(values['pages-per-call']) : DEFAULT_PAGES_PER_CALL,
    });
    const cost = run.cost_usd_estimate;
    console.log(`source ${sourceId}: ${run.counts.candidates} candidates, ${run.counts.verbatim_ok} verbatim, ${run.counts.with_problems} with problems, ${run.counts.duplicates} duplicates`);
    console.log(`tokens in/out: ${run.usage.inputTokens}/${run.usage.outputTokens}; estimated USD: extraction ${cost.extraction}, transcription ${cost.transcription_this_run}`);
    console.log(run.path);
  } finally {
    db.close();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
