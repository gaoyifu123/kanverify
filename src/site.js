// Static site generator: writes the French and English sites from the ledger.
//
// Input is the ledger alone (decision 0005): every page is built from `publications`,
// read through `current_publications` for what is current. The workspace tables are never
// read. Output follows design/ia.md section 2 exactly.
//
// What must never be published is removed in the one query that reads the ledger
// (readLedger), before any page is built:
//   - a withdrawal's snapshot (it repeats the withdrawn content);
//   - the snapshot of the entry a withdrawal took down (it is the same content);
//   - every snapshot of a claim whose current entry is a withdrawal (its page shows only
//     the notice; ia.md: "Nothing from any snapshot");
//   - confirmed_by and review_seconds (internal).
// Pages only ever see what that query returns.
//
// Usage: npm run site            builds into dist/ from data/kanverify.db
//        node src/site.js <dir>  builds into <dir>

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './db.js';
import { loadStandard } from './standard.js';

const here = dirname(fileURLToPath(import.meta.url));
const MOCKUPS = resolve(here, '../design/mockups');
const ASSETS = resolve(here, 'site-assets');
const MARKER = '.kanverify-site';

// Founder, 2026-11-22: the corrections address for now.
export const CORRECTIONS_EMAIL = 'kanverify@gmail.com';

const LANGS = ['fr', 'en'];
const VERDICTS = ['unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true'];
// Schema order (db/schema.sql). The "Topics" link opens the first one.
const DOMAINS = ['economy', 'tax', 'employment', 'health', 'education', 'environment', 'energy', 'security',
  'defence', 'justice', 'immigration', 'foreign_affairs', 'institutions', 'social', 'housing', 'transport',
  'agriculture', 'digital', 'culture', 'other'];
const NB = String.fromCharCode(160); // no-break space

const T = {
  en: {
    v: { unverifiable: 'Unverifiable', pending: 'Pending', to_evaluate: 'To be assessed', came_true: 'Came true', partly_came_true: 'Partly came true', not_came_true: 'Did not come true' },
    ty: { promise: 'Promise', prediction: 'Prediction' },
    d: { economy: 'Economy', tax: 'Tax', employment: 'Employment and work', health: 'Health', education: 'Education and research', environment: 'Environment', energy: 'Energy', defence: 'Defence', security: 'Internal security', justice: 'Justice', immigration: 'Immigration and asylum', foreign_affairs: 'Foreign and European affairs', institutions: 'Institutions and public life', social: 'Social protection', housing: 'Housing', transport: 'Transport', agriculture: 'Agriculture and fisheries', digital: 'Digital', culture: 'Culture, media and sport', other: 'Other topics' },
    kind: { platform: 'Platform', statement: 'Statement', renunciation: 'Public reversal by the speaker', law: 'Law', gazette: 'Official gazette', statistic: 'Official statistics', budget: 'Budget document', parliament: 'Parliamentary record', court: 'Court decision', audit: 'Public audit report', official: 'Official document', media: 'News report', dataset_study: 'Study with published data' },
    sk: { person: 'Person', party: 'Party', government: 'Government', institution: 'Institution' },
    verif: { measurable: 'Measurable', vague: 'Vague', hedged: 'Hedged' },
    m: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
    items: (n) => (n === 1 ? '1 item' : `${n} items`),
    deadline: 'Deadline', inferred: 'inferred: end of term', stated: 'stated', as: 'as', due: 'due', transl: 'Translation',
    none: 'No items in this period.', nothing: 'Nothing has been published yet.',
    main: 'Main', topics: 'Topics', method: 'Method', timeline: 'Timeline', corrections: 'Corrections',
    requestCorrection: 'Request a correction', darkTheme: 'Dark theme',
    footerLine: 'Every verdict rests on original documents and is confirmed by a person before publication.', how: 'How',
    homeTitle: 'KANVERIFY — a chronicle of public promises',
    homeH1: 'A chronicle of public promises and predictions',
    tagline: 'A chronicle of what was promised or predicted in public, and what became of it.',
    people: 'People and parties on record',
    prevYear: 'Previous year', nextYear: 'Next year', fallingDue: 'Promises falling due',
    changePeriod: 'Change the period or the dates used', placePromises: 'Place promises by', placeItems: 'Place items by',
    byDeadline: 'their deadline', bySaid: 'the date they were made', show: 'Show', both: 'both', promises: 'promises', predictions: 'predictions',
    from: 'From', to: 'To', thisYear: 'This year', allYears: 'All years', period: 'Period',
    verdicts: 'Verdicts', tapVerdict: 'Tap a verdict to list its items.', verdictsMean: 'What the verdicts mean',
    itemsH: 'Items', showAll: 'Show all', everyone: 'Everyone',
    topic: 'Topic', country: 'Country', allCountries: 'All countries', order: 'Order', byName: 'by name', byItems: 'by number of items',
    key: 'Key', oneScale: 'One scale for everyone: one unit of bar is one item.', noneTopic: 'No items on this topic: ',
    sameAsTable: 'The same counts as a table', allFive: 'All six verdicts, zeros included',
    itemNo: (id) => `Item ${id}`, by: (type, name, date) => `${type} by ${name}, ${date}`,
    translFrom: (name) => `Translation from ${name}`,
    original: (name) => `Original (${name})`,
    missing: 'What is missing', openQuestion: 'Open question',
    basedOn: 'Based on', and: 'and', wording: 'the wording itself', noDeadline: 'No deadline',
    confirmedOn: (d) => `Confirmed by a person on ${d}`,
    fullRecord: 'Full record', evidence: (n) => `Evidence ${n}`,
    // Decision 0014: the rules a verdict was judged by, under it (one muted line; for the designer to refine).
    // Decision 0014; design/components.md "Rules applied and the rules page".
    rulesApplied: (v) => `Rules applied, version ${v}`, rulesTitle: (v) => `Verdict rules, version ${v}`,
    rulesIntro: (v) => `Each verdict on this site names the rules it was judged by. These are the rules of version ${v}, in plain words. A rule is never changed in place: a changed rule gets a new id, in a new version.`,
    rulesNewer: (link) => `A newer version exists: ${link}. Each verdict keeps the version it was judged under.`,
    rulesVersion: (v) => `version ${v}`, rulesStandards: 'Standards', rulesRules: 'Rules',
    document: 'Document', location: 'Location', address: 'Original address', retrieved: 'Retrieved on', fingerprint: 'Fingerprint (SHA-256)',
    whereSaid: 'Where it was said', who: 'Who', publishedBy: 'Published by',
    copies: 'We keep a copy of each file; copies are not published. The fingerprint lets anyone check that a copy they hold is the same file.',
    criteria: 'Criteria',
    basisStated: (type) => `The deadline is stated in the ${type === 'prediction' ? 'prediction' : 'promise'}.`,
    basisInferred: (d) => `The promise gives no date. The deadline is the end of the term sought, ${d}.`, // promises only (VG-3)
    howDecided: 'How this was decided', confirmedShort: 'Confirmed by a person',
    jurySummary: (n, unanimous) => `AI jury: ${n === 1 ? '1 vote' : `${n} votes`}${unanimous ? '' : ', not unanimous'}`,
    decidedHuman: 'Verdict written by a person.', decidedJury: 'Verdict proposed by the AI jury.',
    juryListed: 'The AI jury’s first assessments are listed as recorded.', howJury: 'How the jury works',
    company: 'Company', model: 'Model', instructions: 'Instructions', vote: 'Vote',
    history: 'History', firstPublished: (d) => `First published ${d}`, updated: (n, d) => `Updated ${n === 1 ? 'once' : `${n} times`} since ${d}`,
    firstPub: 'first published', seeChange: 'see the change', withdrawnLabel: 'Withdrawn', publishedLabel: 'Published',
    mailSubject: (id) => `Item ${id}`,
    withdrawnH1: 'This item was withdrawn', withdrawnOn: (d) => `Withdrawn on ${d}.`,
    histPublished: 'published', histWithdrawn: 'withdrawn', listedOn: 'listed on',
    correctionsIntro: 'Every change to a published item, newest first. The first publication of an item is not listed.',
    noCorrections: 'No corrections yet.', correctionsAsk: (a) => `To ask for a correction, write to ${a}. Please give the item number.`,
    subjectPage: 'Subject page', redirectNote: 'This page has moved:',
    chooseLang: 'Choose a language',
    rootLine: 'A chronicle of public promises and predictions',
    colon: ': ',
    // Round 4
    missingColon: 'What is missing:',
    chainH: 'Based on, in date order',
    saidIn: (kind, link) => `Said, in the ${link}`,
    kindLower: { platform: 'platform', statement: 'statement' },
    chainDeadline: (basis, type) => (basis === 'inferred' ? 'Deadline, inferred: end of term' : `Deadline, stated in the ${type === 'prediction' ? 'prediction' : 'promise'}`),
    noDate: 'No date', dateNotStated: 'Date not stated',
    wordingChain: (verif, noDeadline) => `The wording itself · ${verif}${noDeadline ? ' · no deadline' : ''}`,
    fullRecordItem: (id) => `Full record, item ${id}`,
    asOf: (t) => `verdicts as of ${t}`,
    coverage: (n, m, name) =>
      `${n === 1 ? 'This item comes' : `These ${n} items come`} from ${m === 1 ? '1 document' : `${m} documents`}, listed below with the items taken from ${m === 1 ? 'it' : 'each'}. Anything ${name} said outside ${m === 1 ? 'this document' : 'these documents'} is not recorded here.`,
    notScore: 'These are counts, not a score.',
    itemsBySource: 'Items, by where they were said',
    legifrance: 'Légifrance (official database)',
  },
  fr: {
    v: { unverifiable: 'Invérifiable', pending: 'En attente', to_evaluate: 'À évaluer', came_true: 'Réalisée', partly_came_true: 'Partiellement réalisée', not_came_true: 'Non réalisée' },
    ty: { promise: 'Promesse', prediction: 'Prévision' },
    d: { economy: 'Économie', tax: 'Fiscalité', employment: 'Emploi et travail', health: 'Santé', education: 'Éducation et recherche', environment: 'Environnement', energy: 'Énergie', defence: 'Défense', security: 'Sécurité intérieure', justice: 'Justice', immigration: 'Immigration et asile', foreign_affairs: 'Affaires étrangères et européennes', institutions: 'Institutions et vie publique', social: 'Protection sociale', housing: 'Logement', transport: 'Transports', agriculture: 'Agriculture et pêche', digital: 'Numérique', culture: 'Culture, médias et sport', other: 'Autres sujets' },
    kind: { platform: 'Programme', statement: 'Déclaration', renunciation: 'Revirement public de l’auteur', law: 'Texte de loi', gazette: 'Journal officiel', statistic: 'Statistique officielle', budget: 'Document budgétaire', parliament: 'Document parlementaire', court: 'Décision de justice', audit: 'Rapport d’audit public', official: 'Document officiel', media: 'Article de presse', dataset_study: 'Étude avec données publiées' },
    sk: { person: 'Personne', party: 'Parti', government: 'Gouvernement', institution: 'Institution' },
    verif: { measurable: 'Mesurable', vague: 'Imprécise', hedged: 'Assortie de réserves' },
    m: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    items: (n) => (n === 1 ? '1 fiche' : `${n} fiches`),
    deadline: 'Échéance', inferred: `déduite${NB}: fin du mandat`, stated: 'fixée dans la promesse', as: 'en tant que', due: 'échéance', transl: 'Traduction',
    none: 'Aucune fiche sur cette période.', nothing: 'Rien n’a encore été publié.',
    main: 'Menu principal', topics: 'Thèmes', method: 'Méthode', timeline: 'Frise', corrections: 'Corrections',
    requestCorrection: 'Demander une correction', darkTheme: 'Thème sombre',
    footerLine: 'Chaque verdict repose sur des documents d’origine et est confirmé par une personne avant publication.', how: 'Comment',
    homeTitle: 'KANVERIFY — chronique des promesses publiques',
    homeH1: 'Chronique des promesses et prévisions publiques',
    tagline: 'Chronique de ce qui a été promis ou prédit publiquement, et de ce qu’il en est advenu.',
    people: 'Personnes et partis enregistrés',
    prevYear: 'Année précédente', nextYear: 'Année suivante', fallingDue: 'Promesses arrivant à échéance',
    changePeriod: 'Changer la période ou les dates utilisées', placePromises: 'Placer les promesses selon', placeItems: 'Placer les fiches selon',
    byDeadline: 'leur échéance', bySaid: 'la date où elles ont été formulées', show: 'Afficher', both: 'les deux', promises: 'les promesses', predictions: 'les prévisions',
    from: 'Du', to: 'Au', thisYear: 'Cette année', allYears: 'Toutes les années', period: 'Période',
    verdicts: 'Verdicts', tapVerdict: 'Touchez un verdict pour afficher ses fiches.', verdictsMean: 'Ce que signifient les verdicts',
    itemsH: 'Fiches', showAll: 'Tout afficher', everyone: 'Tout le monde',
    topic: 'Thème', country: 'Pays', allCountries: 'Tous les pays', order: 'Ordre', byName: 'par nom', byItems: 'par nombre de fiches',
    key: 'Légende', oneScale: `Une seule échelle pour tous${NB}: une unité de barre correspond à une fiche.`, noneTopic: `Aucune fiche sur ce thème${NB}: `,
    sameAsTable: 'Les mêmes nombres en tableau', allFive: 'Les six verdicts, zéros compris',
    itemNo: (id) => `Fiche n°${NB}${id}`, by: (type, name, date) => `${type} de ${name}, ${date}`,
    translFrom: (name) => `Traduction ${/^[aeiouéèêâîôûy]/i.test(name) ? 'de l’' : 'du '}${name}`,
    original: (name) => `Original (${name})`,
    missing: 'Ce qui manque', openQuestion: 'Question en suspens',
    basedOn: 'Fondé sur', and: 'et', wording: 'la formulation elle-même', noDeadline: 'Pas d’échéance',
    confirmedOn: (d) => `Confirmé par une personne le ${d}`,
    fullRecord: 'Dossier complet', evidence: (n) => `Preuve ${n}`,
    rulesApplied: (v) => `Règles appliquées, version ${v}`, rulesTitle: (v) => `Règles de verdict, version ${v}`,
    rulesIntro: (v) => `Chaque verdict de ce site indique les règles selon lesquelles il a été rendu. Voici les règles de la version ${v}, en mots simples. Une règle n’est jamais modifiée sur place${NB}: une règle changée reçoit un nouvel identifiant, dans une nouvelle version.`,
    rulesNewer: (link) => `Une version plus récente existe${NB}: ${link}. Chaque verdict garde la version selon laquelle il a été rendu.`,
    rulesVersion: (v) => `version ${v}`, rulesStandards: 'Principes de jugement', rulesRules: 'Règles',
    document: 'Document', location: 'Emplacement', address: 'Adresse d’origine', retrieved: 'Date de collecte', fingerprint: 'Empreinte (SHA-256)',
    whereSaid: 'Source de la promesse', who: 'Qui', publishedBy: 'Publié par',
    copies: `Nous conservons une copie de chaque fichier${NB}; les copies ne sont pas publiées. L’empreinte permet à chacun de vérifier qu’une copie en sa possession est bien le même fichier.`,
    criteria: 'Critères',
    basisStated: (type) => `L’échéance est fixée dans la ${type === 'prediction' ? 'prévision' : 'promesse'}.`,
    basisInferred: (d) => `La promesse ne donne pas de date. L’échéance est la fin du mandat brigué, le ${d}.`,
    howDecided: 'Comment le verdict a été établi', confirmedShort: 'Confirmé par une personne',
    jurySummary: (n, unanimous) => `jury d’IA${NB}: ${n === 1 ? '1 vote' : `${n} votes`}${unanimous ? '' : ', non unanimes'}`,
    decidedHuman: 'Verdict rédigé par une personne.', decidedJury: 'Verdict proposé par le jury d’IA.',
    juryListed: 'Les premières évaluations du jury d’IA sont indiquées telles qu’enregistrées.', howJury: 'Fonctionnement du jury',
    company: 'Société', model: 'Modèle', instructions: 'Instructions', vote: 'Vote',
    history: 'Historique', firstPublished: (d) => `Première publication le ${d}`, updated: (n, d) => `Mise à jour ${n === 1 ? 'une fois' : `${n} fois`} depuis le ${d}`,
    firstPub: 'première publication', seeChange: 'voir la modification', withdrawnLabel: 'Retirée', publishedLabel: 'Publiée',
    mailSubject: (id) => `Fiche ${id}`,
    withdrawnH1: 'Cette fiche a été retirée', withdrawnOn: (d) => `Retirée le ${d}.`,
    histPublished: 'publiée le', histWithdrawn: 'retirée le', listedOn: 'répertoriée sur la page',
    correctionsIntro: 'Toutes les modifications des fiches publiées, de la plus récente à la plus ancienne. La première publication d’une fiche n’est pas listée.',
    noCorrections: 'Aucune correction pour l’instant.', correctionsAsk: (a) => `Pour demander une correction, écrivez à ${a}. Merci d’indiquer le numéro de la fiche.`,
    subjectPage: 'Page de la personne', redirectNote: 'Cette page a changé d’adresse :',
    chooseLang: 'Choisir une langue',
    rootLine: 'Une chronique des promesses et prévisions publiques',
    colon: `${NB}: `,
    // Round 4
    missingColon: `Ce qui manque${NB}:`,
    chainH: 'Fondé sur, dans l’ordre des dates',
    saidIn: (kind, link) => `Formulée dans ${kind === 'statement' ? 'la' : 'le'} ${link}`,
    kindLower: { platform: 'programme', statement: 'déclaration' },
    chainDeadline: (basis, type) => (basis === 'inferred' ? `Échéance déduite${NB}: fin du mandat` : `Échéance fixée dans la ${type === 'prediction' ? 'prévision' : 'promesse'}`),
    noDate: 'Sans date', dateNotStated: 'Date non indiquée',
    wordingChain: (verif, noDeadline) => `La formulation elle-même · ${verif}${noDeadline ? ' · pas d’échéance' : ''}`,
    fullRecordItem: (id) => `Dossier complet, fiche n°${NB}${id}`,
    asOf: (t) => `verdicts au ${t}`,
    coverage: (n, m, name) =>
      `${n === 1 ? 'Cette fiche provient' : `Ces ${n}${NB}fiches proviennent`} ${m === 1 ? 'd’un document, présenté' : `de ${m}${NB}documents, présentés`} ci-dessous avec les fiches tirées de ${m === 1 ? 'celui-ci' : 'chacun'}. Les propos ${/^[aeiouyhàâéèêîôû]/i.test(name) ? 'd’' : 'de '}${name} tenus hors de ${m === 1 ? 'ce document' : 'ces documents'} ne sont pas enregistrés ici.`,
    notScore: 'Ce sont des décomptes, pas une note.',
    itemsBySource: 'Fiches, selon l’endroit où elles ont été formulées',
    legifrance: 'Légifrance (base officielle)',
  },
};

// ------------------------------------------------------------------ helpers

// The same characters the schema treats as blank (db/schema.sql, "Not blank").
const BLANK_CHARS = [32, 9, 10, 11, 12, 13, 133, 160, 173, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200,
  8201, 8202, 8203, 8204, 8205, 8232, 8233, 8239, 8287, 8288, 12288, 65279];
const present = (s) => typeof s === 'string' && [...s].some((ch) => !BLANK_CHARS.includes(ch.codePointAt(0)));

/** Escapes text for HTML element content and quoted attribute values. */
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Only http(s) addresses become links. */
export function safeUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

function urlCell(url) {
  const href = safeUrl(url);
  if (!href) return esc(url ?? '');
  // Link to the normalised address; show the address exactly as recorded.
  return `<a class="mono" href="${esc(href)}">${esc(url)}</a>`;
}

/**
 * A text archived from the Légifrance API: its JSON behind a public /jorf/id/ page. Same test as
 * isLegifranceSource in src/legifrance.js, repeated here so the generator does not load the
 * fetch and AI modules. The site says where it comes from (source-rule.md, Légifrance section).
 */
function isLegifrance(source) {
  return source?.media_type === 'application/json'
    && typeof source.url === 'string' && source.url.startsWith('https://www.legifrance.gouv.fr/jorf/id/');
}

/** Publisher as shown: the Légifrance label for its texts, the recorded publisher otherwise. */
function publisherOf(source, lang) {
  return isLegifrance(source) ? T[lang].legifrance : source.publisher;
}

/** The verdict chip: one style for all six, its pattern as the icon (CSS, from data-v). */
function chip(verdict, lang) {
  return `<span class="verdict" data-v="${verdict}">${esc(T[lang].v[verdict])}</span>`;
}

// The six chart patterns (design/mockups/stats.js), printed once per page that shows swatches
// without JavaScript. The scripts reuse it (same id).
const PAT = {
  unverifiable: '<path d="M0,4 h8"/>',
  pending: '',
  to_evaluate: '<circle cx="4" cy="4" r="1.4" class="pat-dot"/>',
  came_true: '<path d="M-1,1 l2,-2 M0,8 l8,-8 M7,9 l2,-2"/>',
  partly_came_true: '<path d="M4,0 v8"/>',
  not_came_true: '<path d="M-1,7 l2,2 M0,0 l8,8 M7,-1 l2,2"/>',
};
function patternDefs() {
  return `<svg id="kv-defs" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute"><defs>${VERDICTS.map(
    (v) => `<pattern id="kv-p-${v}" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" class="pat-bg pat-bg-${v}"/><g class="pat-ink">${PAT[v]}</g></pattern>`
  ).join('')}</defs></svg>`;
}
function swatch(v) {
  return `<svg class="swatch" viewBox="0 0 18 18" aria-hidden="true"><rect x="0.5" y="0.5" width="17" height="17" fill="url(#kv-p-${v})" class="seg"/></svg>`;
}

/** Our own text in two languages: shown only when both exist, so both sites say the same (principle 3). */
function pair(obj, key, lang) {
  return present(obj[`${key}_fr`]) && present(obj[`${key}_en`]) ? obj[`${key}_${lang}`] : null;
}

/** A translation of quoted text into the page language; none when the original is already in it. */
function translationOf(obj, originalLang, key, lang) {
  if (originalLang === lang) return null;
  const t = obj[`${key}_${lang}`];
  return present(t) ? t : null;
}

function fmt(d, lang) {
  const [y, m, day] = d.slice(0, 10).split('-').map(Number);
  return `${lang === 'fr' && day === 1 ? '1er' : day}${NB}${T[lang].m[m - 1]} ${y}`;
}

function monthLong(d, lang) {
  const [y, m] = d.split('-').map(Number);
  const s = `${T[lang].m[m - 1]} ${y}`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function lowerFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function countryName(code, lang) {
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(code) || code;
  } catch {
    return code;
  }
}

function languageName(code, lang) {
  try {
    return new Intl.DisplayNames([lang], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

/** ia.md: name lower-cased, accents removed, non-letters → "-". */
export function slugify(name) {
  const s = String(name)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return s || 'subject';
}

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const byLabel = (lang) => (a, b) => a.localeCompare(b, lang);

// ------------------------------------------------------------------ reading the ledger

/**
 * Every ledger entry, oldest first, with everything that must not be published already
 * removed by the query. `snapshot` is null whenever it must not be shown.
 */
export function readLedger(db) {
  const rows = db
    .prepare(
      `SELECT p.id, p.claim_id, p.status, p.confirmed_at,
              CASE WHEN p.status = 'withdrawn' THEN p.note_fr END AS note_fr,
              CASE WHEN p.status = 'withdrawn' THEN p.note_en END AS note_en,
              CASE WHEN p.status = 'published'
                    AND (SELECT c.status FROM current_publications c WHERE c.claim_id = p.claim_id) = 'published'
                    AND NOT EXISTS (
                      SELECT 1 FROM publications n
                      WHERE n.claim_id = p.claim_id AND n.status = 'withdrawn'
                        AND n.id = (SELECT min(m.id) FROM publications m WHERE m.claim_id = p.claim_id AND m.id > p.id))
                   THEN p.snapshot END AS snapshot,
              (p.id = (SELECT c.id FROM current_publications c WHERE c.claim_id = p.claim_id)) AS is_current
       FROM publications p
       ORDER BY p.id`
    )
    .all();
  return rows.map((r) => ({
    id: Number(r.id),
    claimId: Number(r.claim_id),
    status: r.status,
    note: r.status === 'withdrawn' ? { fr: r.note_fr, en: r.note_en } : null,
    date: r.confirmed_at.slice(0, 10),
    isCurrent: Boolean(r.is_current),
    snap: r.snapshot === null ? null : JSON.parse(r.snapshot),
  }));
}

/** Codes are never shown raw (ia.md): a code without a label in both languages stops the build. */
function checkLabels(s, entryId) {
  const need = [
    ['d', 'domain', s.claim.domain], ['ty', 'type', s.claim.type], ['verif', 'verifiability', s.claim.verifiability],
    ['v', 'verdict', s.verdict.verdict], ['sk', 'subject kind', s.subject.kind], ['kind', 'source kind', s.origin.kind],
    ...(s.evidence || []).map((e) => ['kind', 'source kind', e.kind]),
    ...(s.jury || []).map((j) => ['v', 'verdict', j.verdict]),
  ];
  for (const [table, what, code] of need) {
    for (const lang of LANGS) {
      if (!Object.hasOwn(T[lang][table], code)) {
        throw new Error(`Ledger entry ${entryId}: unknown ${what} "${code}" has no ${lang} label. Nothing was written.`);
      }
    }
  }
  if (s.claim.deadline_basis !== null && !['stated', 'inferred'].includes(s.claim.deadline_basis)) {
    throw new Error(`Ledger entry ${entryId}: unknown deadline basis "${s.claim.deadline_basis}". Nothing was written.`);
  }
}

/** The current published set and every claim's history, from the ledger. */
function model(db) {
  const entries = readLedger(db);
  const claims = new Map(); // claim id → { id, entries, current }
  for (const e of entries) {
    if (!claims.has(e.claimId)) claims.set(e.claimId, { id: e.claimId, entries: [] });
    const c = claims.get(e.claimId);
    c.entries.push(e);
    if (e.isCurrent) c.current = e;
  }
  const items = [];
  const subjectSource = new Map(); // subject id → [entry id, subject] of its newest current entry
  const originSource = new Map(); // origin.id → [entry id, origin] of its newest current entry
  for (const c of claims.values()) {
    if (c.current.status !== 'published') continue;
    const s = c.current.snap;
    const it = {
      id: s.claim.id,
      snap: s,
      entryId: c.current.id,
      confirmed: c.current.date,
      s: s.subject.id,
      type: s.claim.type,
      domain: s.claim.domain,
      said: s.claim.said_on,
      deadline: s.claim.deadline,
      basis: s.claim.deadline_basis,
      verif: s.claim.verifiability,
      verdict: s.verdict.verdict,
      lang: s.claim.lang,
      q: s.claim.quote_original,
      fr: translationOf(s.claim, s.claim.lang, 'quote', 'fr'),
      en: translationOf(s.claim, s.claim.lang, 'quote', 'en'),
      role_fr: pair(s.claim, 'speaker_role', 'fr'),
      role_en: pair(s.claim, 'speaker_role', 'en'),
      sum_fr: pair(s.verdict, 'summary', 'fr'),
      sum_en: pair(s.verdict, 'summary', 'en'),
      // "What is missing" travels with the item only for "to_evaluate" (ia.md, index.json).
      oq_fr: s.verdict.verdict === 'to_evaluate' ? pair(s.verdict, 'open_question', 'fr') : null,
      oq_en: s.verdict.verdict === 'to_evaluate' ? pair(s.verdict, 'open_question', 'en') : null,
      src: s.origin.id,
      evidence: s.evidence || [],
    };
    items.push(it);
    const prev = subjectSource.get(it.s);
    if (!prev || prev[0] < c.current.id) subjectSource.set(it.s, [c.current.id, s.subject]);
    const prevSrc = originSource.get(it.src);
    if (!prevSrc || prevSrc[0] < c.current.id) originSource.set(it.src, [c.current.id, s.origin]);
  }
  const sources = new Map(); // origin.id → the origin as in its newest current entry
  for (const [id, [, o]] of originSource) sources.set(id, o);
  for (const c of claims.values()) for (const e of c.entries) if (e.snap) checkLabels(e.snap, e.id);
  items.sort((a, b) => a.id - b.id);
  const subjects = new Map();
  for (const [id, [, s]] of subjectSource) {
    subjects.set(id, { id, name: s.name, kind: s.kind, country: s.country, slug: slugify(s.name), wikidata_id: s.wikidata_id });
  }
  return { claims, items, subjects, sources };
}

function counts(list) {
  const c = { total: list.length };
  for (const v of VERDICTS) c[v] = 0;
  for (const it of list) c[it.verdict]++;
  return c;
}

// ------------------------------------------------------------------ page parts

const subjectDir = (s) => `${s.id}-${s.slug}`;

function shell({ lang, path, title, body, view = null, attrs = '', current = null, home = false }) {
  const L = T[lang];
  const up = '../'.repeat(path.length);
  const other = lang === 'fr' ? 'en' : 'fr';
  const otherPath = [other, ...path.slice(1)].join('/') + '/';
  const here = path.join('/') + '/';
  const langLink = (l) =>
    l === lang
      ? `<li><a href="${up}${here}" aria-current="true">${l.toUpperCase()}</a></li>`
      : `<li><a href="${up}${otherPath}" hreflang="${l}" lang="${l}">${l.toUpperCase()}</a></li>`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${up}assets/kanverify.css">
<script src="${up}assets/site.js"></script>
</head>
<body data-root="${up}">

<header class="site-header">
  <div class="wrap">
    <a class="brand" href="${up}${lang}/"${current === 'home' ? ' aria-current="page"' : ''}>KANVERIFY</a>
    <nav class="site-nav" aria-label="${esc(L.main)}">
      <ul>
        <li><a href="${up}${lang}/topic/${DOMAINS[0]}/"${current === 'topic' ? ' aria-current="page"' : ''}>${L.topics}</a></li>
        <li><a href="${up}${lang}/method/"${current === 'method' ? ' aria-current="page"' : ''}>${L.method}</a></li>
      </ul>
    </nav>
    <ul class="tools">
      ${LANGS.map(langLink).join('\n      ')}
      <li><button type="button" data-theme-toggle hidden aria-pressed="false">${L.darkTheme}</button></li>
    </ul>
  </div>
</header>

<main${view ? ` data-view="${view}"` : ''}${attrs}>
${body}
</main>

<footer class="site-footer">
  <div class="wrap">
    <ul>
      <li><a href="${up}${lang}/">${L.timeline}</a></li>
      <li><a href="${up}${lang}/topic/${DOMAINS[0]}/">${L.topics}</a></li>
      <li><a href="${up}${lang}/method/">${L.method}</a></li>
      <li><a href="${up}${lang}/corrections/">${L.corrections}</a></li>
      <li><a href="mailto:${CORRECTIONS_EMAIL}">${L.requestCorrection}</a></li>
    </ul>${home ? `\n    <p class="muted">${L.footerLine} <a href="${up}${lang}/method/">${L.how}</a></p>` : ''}
  </div>
</footer>
</body>
</html>
`;
}

function claimHref(up, lang, id) {
  return `${up}${lang}/claim/${id}/`;
}

// Rows, cards and groups mirror design/mockups/stats.js, so the page reads the same before and
// after the scripts replace the printed lists. tag: 'p' in cards, 'span' inside a row's <summary>.
// Founder, decision 0007 addendum: the page is entirely in the reader's language. Typography
// (design/components.md, "Translated quote"): serif = their actual words only; the translation is sans.
// A quote in the
// other language shows its translation first and the original right under it, labelled, never hidden.
// Without a translation the original is the main text, as before.
function quoteLines(it, cls, lang, tag = 'p') {
  const L = T[lang];
  const tr = it[lang];
  if (!tr) return `<${tag} class="${cls}-quote" lang="${esc(it.lang)}">${esc(it.q)}</${tag}>`;
  return (
    `<${tag} class="${cls}-translated" lang="${lang}"><span class="visually-hidden">${L.transl}${L.colon}</span>${esc(tr)}</${tag}>` +
    `<${tag} class="${cls}-original"><span class="label-inline">${esc(L.original(languageName(it.lang, lang)))}${L.colon}</span><span lang="${esc(it.lang)}">${esc(it.q)}</span></${tag}>`
  );
}

/** Two lines of the verdict's basis under the chip; "What is missing" for to_evaluate; none for pending. */
function summaryLine(it, cls, lang, tag = 'p') {
  const L = T[lang];
  const oq = it[`oq_${lang}`];
  const sum = it[`sum_${lang}`];
  if (it.verdict === 'to_evaluate' && oq) return `<${tag} class="${cls}-summary"><span class="summary-label">${L.missingColon}</span> ${esc(oq)}</${tag}>`;
  return sum ? `<${tag} class="${cls}-summary">${esc(sum)}</${tag}>` : '';
}

/** An open row: the detail layer in place. Nothing here replaces the item page. */
function rowBody(it, lang, up) {
  const L = T[lang];
  const out = [];
  if (it.verdict === 'to_evaluate' && it[`sum_${lang}`]) out.push(`<p>${esc(it[`sum_${lang}`])}</p>`);
  if (it.evidence.length) {
    out.push(
      `<p class="row-body-h">${L.basedOn}</p><ul class="row-basis">${it.evidence
        .map(
          (e) =>
            `<li><span lang="${esc(e.lang)}">${esc(e.title)}</span> <span class="muted">· ${esc(lowerFirst(L.kind[e.kind]))}, ${isLegifrance(e) ? esc(L.legifrance) : `<span lang="${esc(e.lang)}">${esc(e.publisher)}</span>`}</span></li>`
        )
        .join('')}</ul>`
    );
  } else if (it.verif !== 'measurable') {
    out.push(`<p class="row-body-h">${L.basedOn}</p><ul class="row-basis"><li>${L.wording} <span class="muted">· ${lowerFirst(L.verif[it.verif])}</span></li></ul>`);
  }
  const deadline = it.deadline ? `${L.deadline} ${fmt(it.deadline, lang)}, ${it.basis === 'inferred' ? L.inferred : L.stated}` : L.noDeadline;
  out.push(`<p class="muted">${deadline} · ${L.confirmedOn(fmt(it.confirmed, lang))}</p>`);
  out.push(`<p><a href="${claimHref(up, lang, it.id)}">${L.fullRecordItem(it.id)}</a></p>`);
  return `<div class="row-body">${out.join('')}</div>`;
}

/** A row is an accordion (native <details>, works without JavaScript). inGroup: under its source's heading. */
function row(it, lang, up, subjects, showWho, inGroup = false) {
  const L = T[lang];
  const role = it[`role_${lang}`];
  const meta = [chip(it.verdict, lang), `<span>${L.ty[it.type]}</span>`];
  if (!inGroup) meta.push(`<span>${fmt(it.said, lang)}${role ? `, ${L.as} ${esc(role)}` : ''}</span>`);
  if (it.deadline && !inGroup) meta.push(`<span>${L.deadline} ${fmt(it.deadline, lang)}, ${it.basis === 'inferred' ? L.inferred : L.stated}</span>`);
  const who = showWho
    ? `<span class="row-meta"><span class="row-who">${esc(subjects.get(it.s).name)}</span><span>${esc(L.d[it.domain])}</span></span>`
    : '';
  return (
    `<li><details class="row" id="r-${it.id}"><summary>${who}${quoteLines(it, 'row', lang, 'span')}` +
    `<span class="row-meta">${meta.join('')}</span>${summaryLine(it, 'row', lang, 'span')}</summary>${rowBody(it, lang, up)}</details></li>`
  );
}

function rowsHtml(list, lang, up, subjects, showWho) {
  return list.length
    ? list.map((it) => row(it, lang, up, subjects, showWho)).join('\n')
    : `<li><p class="empty">${T[lang].none}</p></li>`;
}

const bySaid = (a, b) => (a.said < b.said ? -1 : a.said > b.said ? 1 : a.id - b.id);
const groupKey = (it) => `${it.src}|${it.role_fr || ''}`;

/**
 * Person page: one group per (origin.id, role), groups by their earliest said_on then key, rows
 * inside by said_on then id; six counts per group. Returns [{ key, items, counts }] for tests too.
 */
function groupItems(list) {
  const g = new Map();
  for (const it of list) {
    const k = groupKey(it);
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(it);
  }
  const groups = [...g].map(([key, items]) => ({ key, items: items.sort(bySaid), counts: counts(items) }));
  return groups.sort((a, b) => bySaid(a.items[0], b.items[0]) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function countList(c, lang) {
  return `<ul class="gcounts">${VERDICTS.map(
    (v) => `<li data-verdict="${v}">${swatch(v)}<span>${esc(T[lang].v[v])}</span><span class="n">${c[v]}</span></li>`
  ).join('')}</ul>`;
}

function groupsHtml(list, lang, up, m) {
  const L = T[lang];
  if (!list.length) return `<p class="empty">${L.none}</p>`;
  return groupItems(list)
    .map(({ key, items, counts: c }) => {
      const first = items[0];
      const src = m.sources.get(first.src);
      const role = first[`role_${lang}`];
      const meta = [L.kind[src.kind], src.published_on ? fmt(src.published_on, lang) : null, role ? esc(role) : null].filter(Boolean).join(' · ');
      return (
        `<section class="group" data-group="${esc(key)}"><h3 lang="${esc(src.lang)}">${esc(src.title)}</h3>` +
        `<p class="muted">${meta}</p><p class="muted">${L.items(c.total)}</p>${countList(c, lang)}` +
        `<ul class="rows">${items.map((it) => row(it, lang, up, m.subjects, false, true)).join('')}</ul></section>`
      );
    })
    .join('\n');
}

function periodLayer(lang) {
  const L = T[lang];
  return `<section class="tl layers" id="tl" hidden aria-label="${L.period}">
        <details class="layer">
          <summary><span class="t">${L.period}</span><span class="s tl-title" aria-live="polite"></span></summary>
          <div class="tl-head">
            <button type="button" class="tl-step" data-step="-1" aria-label="${L.prevYear}">‹</button>
            <span class="tl-sub"></span>
            <button type="button" class="tl-step" data-step="1" aria-label="${L.nextYear}">›</button>
          </div>
          <div class="tl-svg"></div>
          <p class="tl-note"></p>
          <fieldset class="toggle">
            <legend>${L.placeItems}</legend>
            <label><input type="radio" name="basis" value="said"> ${L.bySaid}</label>
            <label><input type="radio" name="basis" value="deadline"> ${L.byDeadline}</label>
          </fieldset>
          <fieldset class="toggle"><legend>${L.show}</legend><label><input type="radio" name="type" value="all"> ${L.both}</label><label><input type="radio" name="type" value="promise"> ${L.promises}</label><label><input type="radio" name="type" value="prediction"> ${L.predictions}</label></fieldset>
          <div class="range">
            <label>${L.from} <input type="range" name="from" id="r-from"> <output class="out-from" for="r-from"></output></label>
            <label>${L.to} <input type="range" name="to" id="r-to"> <output class="out-to" for="r-to"></output></label>
          </div>
          <div class="presets"><button type="button" data-preset="all">${L.allYears}</button><button type="button" data-preset="year">${L.thisYear}</button></div>
        </details>
      </section>`;
}

// ------------------------------------------------------------------ pages

function homePage(lang, m, today) {
  const L = T[lang];
  const up = '../';
  const year = today.slice(0, 4);
  const inYear = m.items
    .filter((it) => it.deadline && it.deadline.slice(0, 4) === year)
    .sort((a, b) => (a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : a.id - b.id));
  let cards = '';
  if (!inYear.length) cards = `<p class="empty">${L.none}</p>`;
  else {
    let cur = null;
    const out = [];
    for (const it of inYear) {
      const month = it.deadline.slice(0, 7);
      if (month !== cur) {
        if (cur !== null) out.push('</ol>');
        out.push(`<h3 class="month">${esc(monthLong(month, lang))}</h3><ol class="cards">`);
        cur = month;
      }
      out.push(
        `<li id="c-${it.id}"><a class="card" href="${claimHref(up, lang, it.id)}">` +
          `<p class="card-meta"><span class="row-who">${esc(m.subjects.get(it.s).name)}</span><span>${L.due} ${fmt(it.deadline, lang)}</span></p>` +
          quoteLines(it, 'card', lang) +
          `<p class="card-meta">${chip(it.verdict, lang)}<span>${L.ty[it.type]}</span></p>${summaryLine(it, 'card', lang)}</a></li>`
      );
    }
    out.push('</ol>');
    cards = out.join('\n');
  }
  const subjects = [...m.subjects.values()].sort((a, b) => a.name.localeCompare(b.name, lang) || a.id - b.id);
  const people = subjects.length
    ? `<ul class="subjects">\n${subjects
        .map((s) => {
          const n = m.items.filter((it) => it.s === s.id).length;
          return `    <li><a href="${up}${lang}/subject/${subjectDir(s)}/"><span>${esc(s.name)} <span class="muted">· ${L.sk[s.kind]} · ${esc(countryName(s.country, lang))}</span></span><span class="n">${L.items(n)}</span></a></li>`;
        })
        .join('\n')}\n  </ul>`
    : `<p class="empty">${L.nothing}</p>`;
  const body = `<div class="wrap">
  <h1 class="visually-hidden">${L.homeH1}</h1>
  <p class="tagline">${L.tagline}</p>

  <section class="tl" id="tl" hidden aria-labelledby="tl-title">
    <div class="tl-head">
      <button type="button" class="tl-step" data-step="-1" aria-label="${L.prevYear}">‹</button>
      <h2 class="tl-title" id="tl-title" aria-live="polite">${year}</h2>
      <button type="button" class="tl-step" data-step="1" aria-label="${L.nextYear}">›</button>
    </div>
    <p class="tl-sub">${L.fallingDue}</p>
    <div class="tl-svg"></div>
    <p class="tl-note"></p>
    <details>
      <summary>${L.changePeriod}</summary>
      <fieldset class="toggle">
        <legend>${L.placePromises}</legend>
        <label><input type="radio" name="basis" value="deadline"> ${L.byDeadline}</label>
        <label><input type="radio" name="basis" value="said"> ${L.bySaid}</label>
      </fieldset>
      <fieldset class="toggle"><legend>${L.show}</legend><label><input type="radio" name="type" value="all"> ${L.both}</label><label><input type="radio" name="type" value="promise"> ${L.promises}</label><label><input type="radio" name="type" value="prediction"> ${L.predictions}</label></fieldset>
      <div class="range">
        <label>${L.from} <input type="range" name="from" id="r-from"> <output class="out-from" for="r-from"></output></label>
        <label>${L.to} <input type="range" name="to" id="r-to"> <output class="out-to" for="r-to"></output></label>
      </div>
      <div class="presets"><button type="button" data-preset="year">${L.thisYear}</button><button type="button" data-preset="all">${L.allYears}</button></div>
    </details>
  </section>

  <div id="cards" aria-live="polite">
${cards}
  </div>

  <h2>${L.people}</h2>
  ${people}
</div>`;
  return shell({ lang, path: [lang], title: L.homeTitle, body, view: 'home', current: 'home', home: true });
}

function legendHtml(c, lang) {
  const L = T[lang];
  return `<ul class="legend">${VERDICTS.map(
    (v) => `<li data-verdict="${v}"><span class="legend-l">${esc(L.v[v])}</span> <span class="n">${c[v]}</span></li>`
  ).join('')}</ul>`;
}

function subjectPage(lang, m, s) {
  const L = T[lang];
  const path = [lang, 'subject', subjectDir(s)];
  const up = '../'.repeat(path.length);
  const mine = m.items.filter((it) => it.s === s.id);
  const c = counts(mine);
  const byDomain = new Map();
  for (const it of mine) byDomain.set(it.domain, (byDomain.get(it.domain) || 0) + 1);
  const doms = [...byDomain.keys()].sort((a, b) => L.d[a].localeCompare(L.d[b], lang));
  const wd = s.wikidata_id ? ` · <a href="https://www.wikidata.org/wiki/${esc(s.wikidata_id)}">Wikidata ${esc(s.wikidata_id)}</a>` : '';
  const asOf = mine.reduce((d, it) => (it.confirmed > d ? it.confirmed : d), '');
  const documents = new Set(mine.map((it) => it.src)).size;
  const body = `${patternDefs()}
<div class="wrap">
  <h1>${esc(s.name)}</h1>
  <p class="muted">${L.sk[s.kind]} · ${esc(countryName(s.country, lang))} · ${L.items(mine.length)} · ${L.asOf(`<time datetime="${asOf}">${fmt(asOf, lang)}</time>`)}${wd}</p>
  <p class="prose">${esc(L.coverage(mine.length, documents, s.name))}</p>

  <div class="split">
    <div>
      <section aria-labelledby="h-verdicts">
        <h2 id="h-verdicts">${L.verdicts}</h2>
        <div class="stats">
          <div class="donut" id="donut"></div>
          <div id="legend">${legendHtml(c, lang)}</div>
        </div>
        <p class="muted">${L.notScore} ${L.tapVerdict} <a href="${up}${lang}/method/#verdicts">${L.verdictsMean}</a></p>
      </section>

      <section aria-labelledby="h-topics">
        <h2 id="h-topics">${L.topics}</h2>
        <ul class="topics" id="topics">${doms
          .map((d) => `<li><a href="${up}${lang}/topic/${d}/"><span>${esc(L.d[d])}</span> <span class="n">${byDomain.get(d)}</span></a></li>`)
          .join('')}</ul>
      </section>

      ${periodLayer(lang)}
    </div>

    <section aria-labelledby="h-items">
      <h2 id="h-items">${L.itemsBySource}</h2>
      <p><span id="filter-state" class="muted" aria-live="polite">${L.items(mine.length)}</span> <button type="button" class="linkbtn" id="reset" hidden>${L.showAll}</button></p>
      <div id="rows">
${groupsHtml(mine, lang, up, m)}
      </div>
    </section>
  </div>
</div>`;
  return shell({ lang, path, title: `${s.name} — KANVERIFY`, body, view: 'subject', attrs: ` data-subject="${s.id}"` });
}

function redirectPage(lang, s) {
  const L = T[lang];
  const target = `../${subjectDir(s)}/`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<link rel="canonical" href="${esc(target)}">
<title>${esc(s.name)} — KANVERIFY</title>
</head>
<body>
<p>${L.redirectNote} <a href="${esc(target)}">${esc(s.name)}</a></p>
</body>
</html>
`;
}

function topicPage(lang, m, domain) {
  const L = T[lang];
  const path = [lang, 'topic', domain];
  const up = '../'.repeat(path.length);
  const inTopic = m.items.filter((it) => it.domain === domain);
  const domainCount = (d) => m.items.filter((it) => it.domain === d).length;
  const sortedDomains = [...DOMAINS].sort((a, b) => L.d[a].localeCompare(L.d[b], lang));
  const options = sortedDomains
    .map((d) => `<option value="${d}"${d === domain ? ' selected' : ''}>${esc(L.d[d])} (${domainCount(d)})</option>`)
    .join('');
  const links = sortedDomains
    .map((d) => `<li><a href="${up}${lang}/topic/${d}/"${d === domain ? ' aria-current="page"' : ''}>${esc(L.d[d])}</a> <span class="n">${domainCount(d)}</span></li>`)
    .join('');
  const countries = [...new Set([...m.subjects.values()].map((s) => s.country))]
    .map((c) => [c, countryName(c, lang)])
    .sort((a, b) => a[1].localeCompare(b[1], lang));
  const byName = (a, b) => a.name.localeCompare(b.name, lang) || a.id - b.id;
  const all = [...m.subjects.values()].sort(byName);
  const withItems = all
    .map((s) => ({ s, c: counts(inTopic.filter((it) => it.s === s.id)) }))
    .filter((p) => p.c.total > 0);
  const without = all.filter((s) => !inTopic.some((it) => it.s === s.id));
  const countsText = (c) => VERDICTS.map((v) => `${L.v[v]}${NB}${c[v]}`).join(' · ');
  const people = withItems
    .map(
      (p) =>
        `<li data-subject="${p.s.id}"><span><span class="who">${esc(p.s.name)}</span> <span class="muted">· ${esc(countryName(p.s.country, lang))}</span></span> <span class="n">${L.items(p.c.total)}</span> <span class="ctext">${esc(countsText(p.c))}</span></li>`
    )
    .join('');
  const table =
    `<table><thead><tr><th scope="col"></th>${VERDICTS.map((v) => `<th scope="col">${esc(L.v[v])}</th>`).join('')}</tr></thead><tbody>` +
    withItems
      .map((p) => `<tr><th scope="row">${esc(p.s.name)}</th>${VERDICTS.map((v) => `<td class="num">${p.c[v]}</td>`).join('')}</tr>`)
      .join('') +
    '</tbody></table>';
  const listed = [...inTopic].sort((a, b) => {
    const sa = m.subjects.get(a.s);
    const sb = m.subjects.get(b.s);
    return byName(sa, sb) || (a.said < b.said ? -1 : a.said > b.said ? 1 : a.id - b.id);
  });
  const body = `<div class="wrap">
  <h1>${L.topics}</h1>

  <div class="split">
    <div>
      <div class="controls">
        <label class="field">${L.topic} <select id="topic">${options}</select></label>
        <label class="field">${L.country}
          <select id="country"><option value="">${L.allCountries}</option>${countries.map(([c, n]) => `<option value="${esc(c)}">${esc(n)}</option>`).join('')}</select>
        </label>
        <fieldset class="toggle">
          <legend>${L.order}</legend>
          <label><input type="radio" name="sort" value="name" checked> ${L.byName}</label>
          <label><input type="radio" name="sort" value="items"> ${L.byItems}</label>
        </fieldset>
      </div>
      <noscript><ul class="topic-links">${links}</ul></noscript>

      <ul class="keylist" id="key" aria-label="${L.key}"></ul>
      <ul class="people" id="people">${people}</ul>
      <p class="muted">${L.oneScale} <span id="nobody">${without.length ? esc(L.noneTopic + without.map((s) => s.name).join(', ') + '.') : ''}</span></p>

      <div class="layers">
        <details class="layer">
          <summary><span class="t">${L.sameAsTable}</span><span class="s">${L.allFive}</span></summary>
          <div class="table-scroll" id="table">${table}</div>
        </details>
        ${periodLayer(lang)}
      </div>
    </div>

    <section aria-labelledby="h-items">
      <h2 id="h-items">${L.itemsH}</h2>
      <p><span id="filter-state" class="muted" aria-live="polite">${L.items(inTopic.length)} · ${esc(L.d[domain])}</span> <button type="button" class="linkbtn" id="reset" hidden>${L.everyone}</button></p>
      <ul class="rows" id="rows">
${rowsHtml(listed, lang, up, m.subjects, true)}
      </ul>
    </section>
  </div>
</div>`;
  return shell({ lang, path, title: `${L.d[domain]} — ${L.topics} — KANVERIFY`, body, view: 'topic', attrs: ` data-domain="${domain}"`, current: 'topic' });
}

/** Label of a ledger entry in history and on Corrections: a verdict only when its snapshot may be shown. */
function entryLabel(e, lang) {
  const L = T[lang];
  if (e.status === 'withdrawn') return esc(L.withdrawnLabel);
  if (e.snap) return chip(e.snap.verdict.verdict, lang);
  return esc(L.publishedLabel);
}

function quoteBlock(text, textLang, translation, lang) {
  const L = T[lang];
  if (!translation) return `<blockquote class="quote" lang="${esc(textLang)}"><p>${esc(text)}</p></blockquote>`;
  return (
    `<div class="translated" lang="${lang}"><span class="label">${L.transl}</span><p>${esc(translation)}</p></div>` +
    `
<div class="original"><span class="label">${esc(L.original(languageName(textLang, lang)))}</span><p lang="${esc(textLang)}">${esc(text)}</p></div>`
  );
}

function claimPage(lang, m, claim) {
  const L = T[lang];
  const path = [lang, 'claim', String(claim.id)];
  const up = '../'.repeat(path.length);
  const cur = claim.current;
  const correctionsHref = `${up}${lang}/corrections/`;

  if (cur.status !== 'published') {
    const parts = claim.entries.map((e, i) => {
      const w = e.status === 'withdrawn' ? L.histWithdrawn : L.histPublished;
      const s = `${w} ${fmt(e.date, lang)}`;
      return i === 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
    });
    const body = `<article class="wrap prose">
  <p class="muted">${L.itemNo(claim.id)}</p>
  <h1>${L.withdrawnH1}</h1>
  <div class="notice">
    <p><strong>${L.withdrawnOn(fmt(cur.date, lang))}</strong></p>
    <p>${esc(cur.note[lang])}</p>
  </div>
  <p class="muted">${parts.join(' · ')} · ${L.listedOn} <a href="${correctionsHref}#entry-${cur.id}">${L.corrections}</a></p>
</article>`;
    return shell({ lang, path, title: `${L.itemNo(claim.id)} — KANVERIFY`, body });
  }

  const s = cur.snap;
  const c = s.claim;
  const v = s.verdict;
  const subject = m.subjects.get(s.subject.id);
  const subjectHref = `${up}${lang}/subject/${subjectDir(subject)}/`;
  const summary = pair(v, 'summary', lang);
  const openQ = pair(v, 'open_question', lang);
  const role = pair(c, 'speaker_role', lang);
  const criteria = pair(c, 'criteria', lang);
  const evidence = s.evidence || [];
  // Only the votes of the round the verdict rests on (record format 11: verdict.based_on_round).
  // Earlier rounds stay in the snapshot but are not shown or counted as this verdict's jury; a
  // verdict that rests on no round (written from the wording alone) shows no jury.
  const jury = (s.jury || []).filter((j) => Number.isInteger(v.based_on_round) && j.round === v.based_on_round);

  // "Based on, in date order": said → evidence by published_on → deadline → confirmed, sorted by
  // date (ties in that order). Undated entries come after the dated ones, marked as such.
  const o = s.origin;
  const chain = [];
  chain.push({ date: c.said_on, rank: 0, html: L.saidIn(o.kind, `<a href="#src-${c.id}">${esc(L.kindLower[o.kind] ?? lowerFirst(L.kind[o.kind]))}, ${esc(c.source_locator)}</a>`) });
  // Evidence is numbered 1…n. A public reversal by the speaker can only be cited under not_came_true,
  // where it is evidence like any other (record format 12, RN-1 row 5).
  evidence.forEach((e, i) => {
    const kind = esc(lowerFirst(L.kind[e.kind])) +
      (isLegifrance(e) ? `, ${esc(L.legifrance)}` : e.kind === 'media' || e.kind === 'dataset_study' ? `, <span lang="${esc(e.lang)}">${esc(e.publisher)}</span>` : '');
    chain.push({ date: e.published_on || null, rank: 1, undated: L.dateNotStated, html: `<a href="#ev-${c.id}-${i + 1}" lang="${esc(e.lang)}">${esc(e.title)}</a> · ${kind}` });
  });
  if (c.deadline) chain.push({ date: c.deadline, rank: 2, html: esc(L.chainDeadline(c.deadline_basis, c.type)) });
  if (!evidence.length && c.verifiability !== 'measurable') {
    chain.push({ date: null, rank: 2, undated: L.noDate, html: esc(L.wordingChain(lowerFirst(L.verif[c.verifiability]), !c.deadline)) });
  }
  chain.push({ date: cur.date, rank: 3, html: L.confirmedShort });
  const ordered = [...chain.filter((x) => x.date)].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rank - b.rank));
  // Undated entries: the wording itself sits before the confirmation (as in the mockup); evidence
  // without a date goes after every dated entry.
  const wording = chain.filter((x) => !x.date && x.rank === 2);
  const confirmedAt = ordered.findIndex((x) => x.rank === 3);
  ordered.splice(confirmedAt, 0, ...wording);
  ordered.push(...chain.filter((x) => !x.date && x.rank === 1));
  const chainHtml = ordered
    .map((x) =>
      x.date
        ? `<li><span class="when"><time datetime="${x.date}">${fmt(x.date, lang)}</time></span><span>${x.html}</span></li>`
        : `<li class="open"><span class="when">${x.undated}</span><span>${x.html}</span></li>`
    )
    .join('\n        ');

  let questionBlock = '';
  if (v.verdict === 'to_evaluate' && openQ) questionBlock = `\n      <h2>${L.missing}</h2>\n      <p>${esc(openQ)}</p>`;
  else if (openQ) questionBlock = `\n      <h2>${L.openQuestion}</h2>\n      <p>${esc(openQ)}</p>`;

  const layers = [];
  // One layer per piece of evidence ("Evidence n").
  const docLayer = (e, id, title, first, intro) => {
    const sum = [first, esc(publisherOf(e, lang)), e.published_on ? fmt(e.published_on, lang) : null].filter(Boolean).join(' · ');
    return `<details class="layer" id="${id}">
          <summary><span class="t">${title}</span><span class="s">${sum}</span></summary>${intro ? `
          <p class="muted">${intro}</p>` : ''}
          ${quoteBlock(e.excerpt, e.lang, translationOf(e, e.lang, 'excerpt', lang), lang)}
          <dl class="meta">
            <div><dt>${L.document}</dt><dd lang="${esc(e.lang)}">${esc(e.title)}</dd></div>${isLegifrance(e) ? `
            <div><dt>${L.publishedBy}</dt><dd>${esc(L.legifrance)}</dd></div>` : ''}
            <div><dt>${L.location}</dt><dd>${esc(e.locator)}</dd></div>
            <div><dt>${L.address}</dt><dd>${urlCell(e.url)}</dd></div>
            <div><dt>${L.retrieved}</dt><dd>${fmt(e.retrieved_on, lang)}</dd></div>
            <div><dt>${L.fingerprint}</dt><dd class="mono">${esc(e.sha256)}</dd></div>
          </dl>
        </details>`;
  };
  evidence.forEach((e, i) => layers.push(docLayer(e, `ev-${c.id}-${i + 1}`, L.evidence(i + 1), L.kind[e.kind])));
  layers.push(`<details class="layer" id="src-${c.id}">
          <summary><span class="t">${L.whereSaid}</span><span class="s">${L.kind[o.kind]} · ${esc(c.source_locator)}</span></summary>
          <dl class="meta">
            <div><dt>${L.who}</dt><dd>${esc(subject.name)}${role ? `, ${esc(role)}` : ''}</dd></div>
            <div><dt>${L.document}</dt><dd lang="${esc(o.lang)}">${esc(o.title)}</dd></div>
            <div><dt>${L.publishedBy}</dt><dd>${esc(o.publisher)}${o.published_on ? `, ${fmt(o.published_on, lang)}` : ''}</dd></div>
            <div><dt>${L.location}</dt><dd>${esc(c.source_locator)}</dd></div>
            <div><dt>${L.address}</dt><dd>${urlCell(o.url)}</dd></div>
            <div><dt>${L.retrieved}</dt><dd>${fmt(o.retrieved_on, lang)}</dd></div>
            <div><dt>${L.fingerprint}</dt><dd class="mono">${esc(o.sha256)}</dd></div>
          </dl>
          <p class="muted">${L.copies}</p>
        </details>`);
  if (criteria || c.deadline) {
    const basisLine = c.deadline
      ? `\n          <p class="muted">${c.deadline_basis === 'inferred' ? L.basisInferred(fmt(c.deadline, lang)) : L.basisStated(c.type)}</p>`
      : '';
    layers.push(`<details class="layer">
          <summary><span class="t">${L.criteria}</span><span class="s">${L.verif[c.verifiability]}${c.deadline ? ` · ${L.deadline.toLowerCase()} ${c.deadline_basis === 'inferred' ? L.inferred : L.stated}` : ''}</span></summary>${criteria ? `\n          <p>${esc(criteria)}</p>` : ''}${basisLine}
        </details>`);
  }
  const unanimous = jury.every((j) => j.verdict === jury[0]?.verdict);
  const jurySum = jury.length ? ` · ${L.jurySummary(jury.length, unanimous)}` : '';
  const juryTable = jury.length
    ? `\n          <div class="table-scroll"><table>
            <thead><tr><th scope="col">${L.company}</th><th scope="col">${L.model}</th><th scope="col">${L.instructions}</th><th scope="col">${L.vote}</th></tr></thead>
            <tbody>
              ${jury.map((j) => `<tr><td>${esc(j.provider)}</td><td class="mono">${esc(j.model)}</td><td class="mono">${esc(j.prompt_version)}</td><td>${esc(L.v[j.verdict])}</td></tr>`).join('\n              ')}
            </tbody>
          </table></div>`
    : '';
  layers.push(`<details class="layer">
          <summary><span class="t">${L.howDecided}</span><span class="s">${L.confirmedShort}${jurySum}</span></summary>
          <p><strong>${L.confirmedOn(fmt(cur.date, lang))}.</strong> ${v.decided_by === 'jury' ? L.decidedJury : L.decidedHuman}${jury.length ? ` ${L.juryListed}` : ''} <a href="${up}${lang}/method/#jury">${L.howJury}</a></p>${juryTable}
        </details>`);
  const hist = claim.entries;
  const histSum = hist.length === 1 ? L.firstPublished(fmt(hist[0].date, lang)) : L.updated(hist.length - 1, fmt(hist[0].date, lang));
  layers.push(`<details class="layer">
          <summary><span class="t">${L.history}</span><span class="s">${histSum}</span></summary>
          <ol class="history">
            ${hist
              .map(
                (e, i) =>
                  `<li><span>${fmt(e.date, lang)}</span> ${entryLabel(e, lang)} ${i === 0 ? `<span class="muted">${L.firstPub}</span>` : `<a href="${correctionsHref}#entry-${e.id}">${L.seeChange}</a>`}</li>`
              )
              .join('\n            ')}
          </ol>
        </details>`);

  const body = `<article class="wrap">
  <div class="split item-split">
    <div class="summary-layer">
      <p class="muted">${L.itemNo(c.id)} · ${L.ty[c.type]} · <a href="${up}${lang}/topic/${c.domain}/">${esc(L.d[c.domain])}</a></p>
      <h1><a href="${subjectHref}">${esc(subject.name)}</a>, ${fmt(c.said_on, lang)}</h1>
      ${quoteBlock(c.quote_original, c.lang, translationOf(c, c.lang, 'quote', lang), lang)}
      <p class="verdict-line">${chip(v.verdict, lang)}</p>${summary ? `\n      <p>${esc(summary)}</p>` : ''}${questionBlock}
      <h2>${L.chainH}</h2>
      <ol class="chain">
        ${chainHtml}
      </ol>${rulesBlock(v, lang, up)}
    </div>

    <div class="detail-layer">
      <h2>${L.fullRecord}</h2>
      <div class="layers">
        ${layers.join('\n        ')}
      </div>
      <p><a href="mailto:${CORRECTIONS_EMAIL}?subject=${encodeURIComponent(L.mailSubject(c.id))}">${L.requestCorrection}</a> <span class="muted">(${L.itemNo(c.id)})</span></p>
    </div>
  </div>
</article>`;
  return shell({ lang, path, title: `${L.by(L.ty[c.type], subject.name, fmt(c.said_on, lang))} — KANVERIFY`, body });
}

/** The page the rules line links to (`<lang>/method/rules-<version>/`). */
function rulesHref(up, lang, version, id) {
  return `${up}${lang}/method/rules-${version}/#${id}`;
}

/**
 * Decision 0014 (design/components.md "Rules applied and the rules page"): last in the summary layer, after the
 * chain, the rules the verdict was judged by: one line each, the sentence in the page's language, then the id as the
 * link to its rule in that version. In the standard's order, each once. A version or an id the kept standard of that
 * version does not hold stops the build (src/standard.js; confirm() refuses them too).
 */
function rulesBlock(v, lang, up) {
  const ids = Array.isArray(v.rules_applied) ? v.rules_applied : [];
  if (!ids.length) return '';
  const standard = loadStandard(v.rules_version);
  for (const id of ids) if (!standard.rules.has(id)) throw new Error(`rule ${id} is not in the verdict standard ${v.rules_version}`);
  const items = [...standard.rules.values()].filter((r) => ids.includes(r.id))
    .map((r) => `<li>${esc(r[lang])} <a href="${rulesHref(up, lang, standard.version, r.id)}">${esc(r.id)}</a></li>`);
  return `\n      <p class="muted">${esc(T[lang].rulesApplied(standard.version))}</p>
      <ul class="rules-applied">
        ${items.join('\n        ')}
      </ul>`;
}

/** The rules of one version: standards, then rules, each with its id as anchor; a note when a newer version exists. */
function rulesPage(lang, version, built) {
  const L = T[lang];
  const standard = loadStandard(version);
  const current = loadStandard().version;
  const path = [lang, 'method', `rules-${version}`];
  const up = '../'.repeat(path.length);
  const dl = (rules) => `<dl class="rules">
${rules.map((r) => `    <div class="rule" id="${esc(r.id)}"><dt>${esc(r.id)}</dt><dd>${esc(r[lang])}</dd></div>`).join('\n')}
  </dl>`;
  const all = [...standard.rules.values()];
  const newer = version === current ? ''
    : `\n  <p class="muted">${L.rulesNewer(built.has(current) ? `<a href="${up}${lang}/method/rules-${current}/">${esc(L.rulesVersion(current))}</a>` : esc(L.rulesVersion(current)))}</p>`;
  const body = `<div class="wrap prose">
  <h1>${esc(L.rulesTitle(version))}</h1>
  <p>${L.rulesIntro(esc(version))}</p>${newer}
  <h2>${L.rulesStandards}</h2>
  ${dl(all.filter((r) => r.id.startsWith('ST-')))}
  <h2>${L.rulesRules}</h2>
  ${dl(all.filter((r) => !r.id.startsWith('ST-')))}
</div>`;
  return shell({ lang, path, title: `${L.rulesTitle(version)} — KANVERIFY`, body, current: 'method' });
}

function correctionsPage(lang, m) {
  const L = T[lang];
  const path = [lang, 'corrections'];
  const up = '../'.repeat(path.length);
  const changes = [];
  for (const c of m.claims.values()) {
    c.entries.forEach((e, i) => {
      if (i > 0) changes.push({ e, before: c.entries[i - 1] });
    });
  }
  changes.sort((a, b) => b.e.id - a.e.id);
  const list = changes.length
    ? `<ol class="history">\n${changes
        .map(
          ({ e, before }) =>
            `  <li id="entry-${e.id}"><span>${fmt(e.date, lang)}</span> <a href="${claimHref(up, lang, e.claimId)}">${L.itemNo(e.claimId)}${L.colon}${entryLabel(before, lang)} → ${entryLabel(e, lang)}</a>${e.status === 'withdrawn' ? `<p>${esc(e.note[lang])}</p>` : ''}</li>`
        )
        .join('\n')}\n</ol>`
    : `<p class="empty">${L.noCorrections}</p>`;
  const body = `<div class="wrap prose">
  <h1>${L.corrections}</h1>
  <p>${L.correctionsIntro}</p>
  ${list}
  <p>${L.correctionsAsk(`<a href="mailto:${CORRECTIONS_EMAIL}">${CORRECTIONS_EMAIL}</a>`)}</p>
</div>`;
  return shell({ lang, path, title: `${L.corrections} — KANVERIFY`, body });
}

function methodPage(lang) {
  const html = readFileSync(join(MOCKUPS, `method.${lang}.html`), 'utf8');
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/);
  if (!main) throw new Error(`design/mockups/method.${lang}.html has no <main>`);
  const up = '../../';
  const body = main[1]
    .replaceAll(`href="home.${lang}.html"`, `href="${up}${lang}/"`)
    .replaceAll(`href="topic.${lang}.html"`, `href="${up}${lang}/topic/${DOMAINS[0]}/"`)
    .replaceAll(`href="method.${lang}.html"`, `href="${up}${lang}/method/"`)
    .replaceAll('corrections@example.org', CORRECTIONS_EMAIL);
  return shell({ lang, path: [lang, 'method'], title: `${T[lang].method} — KANVERIFY`, body: `<div class="wrap prose">${body}</div>`, current: 'method' });
}

/** ia.md section 3: brand, one line in each language, two links. No script, no redirect, no cookie. */
function rootPage() {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KANVERIFY</title>
<link rel="stylesheet" href="assets/kanverify.css">
</head>
<body>
<main class="wrap prose">
  <h1>KANVERIFY</h1>
  <p>${T.fr.rootLine}</p>
  <p lang="en">${T.en.rootLine}</p>
  <ul class="subjects">
    <li><a href="fr/" hreflang="fr" lang="fr"><span>Français</span></a></li>
    <li><a href="en/" hreflang="en" lang="en"><span>English</span></a></li>
  </ul>
</main>
</body>
</html>
`;
}

/**
 * index.json for one language (ia.md section 2), nothing else: no excerpt, URL, hash, jury,
 * criteria or history. The files differ only where a label depends on the language (the
 * Légifrance publisher). "<" is escaped so the file is inert if ever inlined.
 */
function indexJson(m, lang) {
  const subjects = {};
  for (const s of m.subjects.values()) subjects[s.id] = { id: s.id, name: s.name, kind: s.kind, country: s.country, slug: s.slug };
  const sources = {};
  for (const [id, o] of m.sources) {
    sources[id] = { title: o.title, kind: o.kind, publisher: publisherOf(o, lang), date: o.published_on, lang: o.lang };
  }
  const items = m.items.map((x) => ({
    id: x.id, s: x.s, type: x.type, domain: x.domain, said: x.said, deadline: x.deadline, basis: x.basis,
    verif: x.verif, verdict: x.verdict, confirmed: x.confirmed, lang: x.lang, q: x.q, fr: x.fr, en: x.en,
    role_fr: x.role_fr, role_en: x.role_en, sum_fr: x.sum_fr, sum_en: x.sum_en, oq_fr: x.oq_fr, oq_en: x.oq_en,
    src: x.src, ev: x.evidence.map((e) => ({ t: e.title, k: e.kind, p: publisherOf(e, lang), l: e.lang })),
  }));
  return JSON.stringify({ subjects, sources, items }).replace(/</g, String.fromCharCode(92) + 'u003c');
}

// ------------------------------------------------------------------ build

/** The rules versions of every snapshot the site shows. */
function rulesVersions(m) {
  const out = new Set();
  for (const c of m.claims.values()) for (const e of c.entries) if (e.snap?.verdict?.rules_version) out.add(e.snap.verdict.rules_version);
  return [...out].sort();
}

/** Refuses to replace a folder the generator did not make. */
function checkOutDir(outDir) {
  if (!existsSync(outDir)) return;
  const entries = readdirSync(outDir);
  if (entries.length && !entries.includes(MARKER)) {
    throw new Error(`${outDir} is not empty and was not made by the site generator. Refusing to replace it.`);
  }
}

/**
 * Writes the French and English sites into outDir. Reads the ledger only.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} outDir
 * @param {{ today?: string, rename?: typeof renameSync }} [options] today: YYYY-MM-DD, decides the home
 *   page's default year; rename: for tests that simulate a failed swap
 * @returns {{ files: string[], items: number, claims: number, subjects: number }}
 */
export function buildSite(db, outDir, { today = localToday(), rename = renameSync } = {}) {
  outDir = resolve(outDir);
  checkOutDir(outDir);
  const m = model(db);
  // Everything is written to a sibling folder first. The previous site is replaced only
  // once every page has rendered, and nothing from it survives (a page that should no
  // longer exist, such as a subject whose items were all withdrawn, is gone).
  const tag = randomUUID().slice(0, 8);
  const tmp = join(dirname(outDir), `.${basename(outDir)}.build-${tag}`);
  const old = join(dirname(outDir), `.${basename(outDir)}.old-${tag}`);
  mkdirSync(tmp, { recursive: true });
  const files = [];
  const write = (rel, content) => {
    const full = join(tmp, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    files.push(rel);
  };

  try {
    write(MARKER, 'Built by src/site.js. This folder is replaced on every build.' + String.fromCharCode(10));
    write('assets/kanverify.css', readFileSync(join(MOCKUPS, 'kanverify.css')));
    write('assets/site.js', readFileSync(join(MOCKUPS, 'theme.js'), 'utf8') + String.fromCharCode(10) + readFileSync(join(ASSETS, 'views.js'), 'utf8'));
    write('index.html', rootPage());
      for (const lang of LANGS) {
      write(`${lang}/index.json`, indexJson(m, lang));
      write(`${lang}/index.html`, homePage(lang, m, today));
      for (const d of DOMAINS) write(`${lang}/topic/${d}/index.html`, topicPage(lang, m, d));
      for (const s of m.subjects.values()) {
        write(`${lang}/subject/${subjectDir(s)}/index.html`, subjectPage(lang, m, s));
        write(`${lang}/subject/${s.id}/index.html`, redirectPage(lang, s));
      }
      for (const c of m.claims.values()) write(`${lang}/claim/${c.id}/index.html`, claimPage(lang, m, c));
      write(`${lang}/method/index.html`, methodPage(lang));
      // Every version of the verdict rules a shown verdict was judged by (decision 0014).
      const versions = rulesVersions(m);
      for (const version of versions) write(`${lang}/method/rules-${version}/index.html`, rulesPage(lang, version, new Set(versions)));
      write(`${lang}/corrections/index.html`, correctionsPage(lang, m));
    }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true });
    throw error;
  }
  // Swap. If a rename fails (a file in the old site is open, for example), the previous
  // site is put back and the new build removed, so nothing is left beside the output.
  let movedOld = false;
  try {
    checkOutDir(outDir); // again, right before replacing it
    if (existsSync(outDir)) {
      rename(outDir, old);
      movedOld = true;
    }
    rename(tmp, outDir);
  } catch (error) {
    if (movedOld && !existsSync(outDir)) rename(old, outDir);
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`Could not replace ${outDir} with the new build (${error.code || error.message}). The previous site was kept.`, { cause: error });
  }
  rmSync(old, { recursive: true, force: true });
  files.shift(); // the marker is not part of the site
  return { files, items: m.items.length, claims: m.claims.size, subjects: m.subjects.size };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dbPath = resolve(here, '../data/kanverify.db');
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath}. Run "npm run db:init" first.`);
    process.exit(1);
  }
  const outDir = resolve(process.argv[2] || resolve(here, '../dist'));
  const db = openDatabase(dbPath);
  try {
    const r = buildSite(db, outDir);
    console.log(`Built ${r.files.length} files into ${outDir}: ${r.items} published items, ${r.claims} item pages, ${r.subjects} subjects.`);
  } finally {
    db.close();
  }
}
