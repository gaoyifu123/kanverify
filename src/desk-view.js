// HTML of the review desk (design/review-desk.md, design/mockups/desk.html). Server-rendered,
// no inline script or style (the page's Content-Security-Policy forbids both); the keyboard
// shortcuts are in desk-assets/desk-client.js. Interface language: English (founder,
// 2026-11-22, through the coordinator). Quotes and excerpts are shown in their original
// language; a translation is shown only when the original is neither French nor English.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const LABELS = {
  type: { promise: 'Promise', prediction: 'Prediction' },
  verifiability: { measurable: 'Measurable', vague: 'Vague', hedged: 'Hedged' },
  deadline_basis: { stated: 'stated', inferred: 'inferred' },
  verdict: {
    unverifiable: 'Unverifiable', pending: 'Pending', to_evaluate: 'To be assessed', came_true: 'Came true',
    partly_came_true: 'Partly came true', not_came_true: 'Did not come true',
  },
  domain: {
    economy: 'Economy', tax: 'Tax', employment: 'Employment and work', health: 'Health', education: 'Education and research',
    environment: 'Environment', energy: 'Energy', defence: 'Defence', security: 'Internal security', justice: 'Justice',
    immigration: 'Immigration and asylum', foreign_affairs: 'Foreign and European affairs', institutions: 'Institutions and public life',
    social: 'Social protection', housing: 'Housing', transport: 'Transport', agriculture: 'Agriculture and fisheries', digital: 'Digital',
    culture: 'Culture, media and sport', other: 'Other topics',
  },
  kind: {
    platform: 'Platform', statement: 'Statement', renunciation: 'Public renunciation', law: 'Law', gazette: 'Official gazette',
    statistic: 'Official statistics', budget: 'Budget document', parliament: 'Parliamentary record', court: 'Court decision',
    audit: 'Public audit report', official: 'Official document', media: 'News report', dataset_study: 'Study with published data',
  },
  channel: { subscription: 'subscription', api: 'API' },
};
const label = (group, code) => LABELS[group]?.[code] ?? code ?? '—';
const VERDICT_ORDER = ['unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true'];

function verdictChip(v) {
  return v ? `<span class="verdict" data-v="${esc(v)}">${esc(label('verdict', v))}</span>` : '<span class="muted">no verdict</span>';
}
function kbd(k) {
  return `<kbd>${esc(k)}</kbd>`;
}
function quoteBlock(text, lang) {
  return `<div class="quote" lang="${esc(lang)}"><p>${esc(text)}</p></div>`;
}
/** Translations only for an original that is neither French nor English. */
function translations(lang, fr, en) {
  if (lang === 'fr' || lang === 'en') return '';
  return [['fr', 'French', fr], ['en', 'English', en]]
    .map(([l, name, t]) => `<div class="translation" lang="${esc(l)}"><span class="label" lang="en">${name} translation</span><p>${t ? esc(t) : '<i lang="en">missing</i>'}</p></div>`)
    .join('');
}
function meta(rows) {
  return `<dl class="meta">${rows.map(([dt, dd]) => `<div><dt>${esc(dt)}</dt><dd>${dd}</dd></div>`).join('')}</dl>`;
}
function textOr(v, lang) {
  return v ? `<span lang="${esc(lang)}">${esc(v)}</span>` : '<span class="muted">—</span>';
}

/** The quote marked in a unit's text: exact, else tolerant of line breaks and spacing. */
export function markQuote(text, quote) {
  const t = String(text ?? '');
  const q = String(quote ?? '');
  let at = q ? t.indexOf(q) : -1;
  let len = q.length;
  if (at < 0 && q.trim()) {
    const words = q.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const m = new RegExp(words.join('[\\s\\u00ad-]+'), 'u').exec(t);
    if (m) { at = m.index; len = m[0].length; }
  }
  if (at < 0) return { html: esc(t), marked: false };
  return { html: `${esc(t.slice(0, at))}<mark>${esc(t.slice(at, at + len))}</mark>${esc(t.slice(at + len))}`, marked: true };
}

/** The archived text around a quote: a PDF page, or a few paragraphs, with the quote marked. */
export function sourcePassage(units, quote, unit, lang) {
  if (!units || units.error) return `<p class="ok-line"><b>The archived text cannot be shown:</b> ${esc(units?.error ?? 'missing')}</p>`;
  const list = units.units;
  const i = list.findIndex((u) => u.unit === unit);
  if (i < 0) return `<p class="ok-line">Unit ${esc(unit)} is not in the archived text${units.missing.includes(unit) ? ' (not transcribed)' : ''}.</p>`;
  const shown = units.kind === 'pdf_page' ? [list[i]] : list.slice(Math.max(0, i - 2), i + 3);
  let anyMark = false;
  const body = shown.map((u) => {
    const paragraphs = units.kind === 'pdf_page' ? String(u.text).split(/\n\s*\n/) : [u.text];
    return paragraphs.map((t) => {
      const m = markQuote(t, quote);
      anyMark ||= m.marked;
      return `<p${u.unit === unit && units.kind !== 'pdf_page' ? ' class="here"' : ''}>${units.kind === 'law' && u.label ? `<b>${esc(u.label)}</b> ` : ''}${m.html}</p>`;
    }).join('');
  }).join('');
  const note = anyMark ? '' : '<p class="muted">The quote could not be marked exactly in this text (spacing or hyphenation differ); the program\'s check ignores those differences.</p>';
  return `<div class="source-text" lang="${esc(lang)}" tabindex="0" aria-label="Archived text">${body}</div>${note}`;
}

function header({ today: t, counts, current }) {
  const avg = (v) => (v === null ? '—' : `${v} s`);
  return `<header class="desk-head"><div class="desk">
<span class="brand">KANVERIFY review desk</span>
<nav aria-label="Queues"><ul class="tabs">
<li><a href="/candidates"${current === 'candidate' ? ' aria-current="page"' : ''}>Candidates · ${counts.candidates} left</a></li>
<li><a href="/verdicts"${current === 'verdict' ? ' aria-current="page"' : ''}>Verdicts · ${counts.verdicts} left</a></li>
</ul></nav>
<p class="today">Today: auto-accepted <b>${t.autoAccepted}</b> · accepted <b>${t.accepted}</b> · rejected <b>${t.rejected}</b> · confirmed <b>${t.confirmed}</b> · rejected items <b>${t.rejectedClaims}</b> · human time <b>${t.minutes} min</b> (candidates avg ${avg(t.candidateAvg)}, verdicts avg ${avg(t.verdictAvg)})</p>
</div></header>`;
}

function page({ title, queue, item, pending, body, toast, today: t, counts }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · KANVERIFY review desk</title>
<link rel="stylesheet" href="/assets/kanverify.css">
<link rel="stylesheet" href="/assets/desk.css">
<script src="/assets/desk-client.js" defer></script>
</head>
<body data-queue="${esc(queue)}" data-item="${esc(item ?? '')}">
${header({ today: t, counts, current: queue })}
<main class="screen desk">
<div id="toasts">${pendingNotice(pending)}${toast ? `<p class="toast" role="status">${esc(toast)}</p>` : ''}<p class="toast error" role="alert" id="error" hidden></p></div>
${body}
</main>
${help(queue)}
</body>
</html>`;
}

/** A page never carries a pending confirmation: only the page that pressed C can complete it. */
function pendingNotice(pending) {
  if (!pending) return '';
  // Only the view that pressed C can load a page during the window (any other load cancels it), and that
  // view shows its own countdown.
  if (pending.state === 'active') return '';
  return `<p class="toast" role="status">Cancelled: item #${esc(pending.claimId)} was not written to the ledger (its page was closed or reloaded during the 5 seconds).</p>`;
}

function help(queue) {
  const rows = queue === 'candidate'
    ? [['A', 'accept'], ['F', 'apply the proposed fixes and accept'], ['E', 'edit, then accept (Tab between fields, Ctrl+Enter saves, Esc cancels)'], ['R', 'reject (1–4 picks the reason, Enter confirms)'], ['S', 'skip'], ['Z', 'undo the last step (press again to go further back)'], ['O', 'open the archived original'], ['Space', 'scroll the archived text'], ['Q', 'go to the verdict queue'], ['?', 'this list']]
    : [['C', 'confirm and publish (5 seconds to cancel with Z)'], ['1–3', 'adopt vote n'], ['E', 'edit the summary (and verdict)'], ['B', 'send back (1–4, a sentence, Enter)'], ['X', 'reject the item (never-published items only)'], ['S', 'skip'], ['Z', 'undo / cancel a pending confirmation'], ['U', 'show or hide "considered, not used"'], ['P', 'show or hide the source passage'], ['Q', 'go to the candidate queue'], ['?', 'this list']];
  return `<div class="panel dialog" id="help-panel" role="dialog" aria-label="Keyboard shortcuts" hidden><h2>Keyboard shortcuts</h2><dl class="meta">${rows.map(([k, t]) => `<div><dt>${kbd(k)}</dt><dd>${esc(t)}</dd></div>`).join('')}</dl><p class="muted">Keys work when the cursor is not in a text field. Esc closes.</p></div>`;
}

function reasonsPanel({ id, action, title, reasons, preset = null, noteLabel, noteValue = '', extra = '' }) {
  return `<form class="panel reasons dialog" id="${esc(id)}" data-action="${esc(action)}" role="dialog" aria-label="${esc(title)}" hidden>
<h2>${esc(title)}</h2>
<ol>${reasons.map((r, i) => `<li><label><input type="radio" name="reason" value="${i + 1}"${preset === i + 1 ? ' checked' : ''}> ${r}</label></li>`).join('')}</ol>
<label class="label" for="${esc(id)}-note">${esc(noteLabel)}</label>
<input id="${esc(id)}-note" name="note" type="text" value="${esc(noteValue)}" autocomplete="off">
<p class="form-error" role="alert" hidden></p>
${extra}<p class="muted">${kbd('1')}–${kbd('4')} picks a reason · ${kbd('Enter')} done · ${kbd('Esc')} cancel</p>
</form>`;
}

function actionsBar(buttons) {
  return `<div class="actions" role="toolbar" aria-label="Actions">${buttons.join('')}</div>`;
}
function button({ key, text, act = null, open = null, href = null, undo = false, disabled = false, primary = false, spacer = false, vote = null, title = null }) {
  const attrs = [
    `type="button"`, `data-key="${esc(key.toLowerCase())}"`,
    act ? `data-act="${esc(act)}"` : '', open ? `data-open="${esc(open)}"` : '', href ? `data-href="${esc(href)}"` : '', undo ? 'data-undo' : '',
    vote !== null ? `data-vote="${vote}"` : '', disabled ? 'disabled' : '', title ? `title="${esc(title)}"` : '',
    `class="${[primary && 'primary', spacer && 'spacer'].filter(Boolean).join(' ')}"`,
  ].filter(Boolean).join(' ');
  return `<button ${attrs}>${kbd(key)} ${esc(text)}</button>`;
}

// ---------------------------------------------------------------- queue A

function flagList(view, byId) {
  const e = view.entry;
  const items = [];
  const other = (id) => {
    const o = byId.get(id);
    return o ? `${esc(id)} (${esc(o.locator)}) — <span class="quote-inline" lang="${esc(o.lang)}">${esc(o.quote_original)}</span>` : esc(id);
  };
  if (view.reviewMismatch) items.push('<li>The review file has no entry for this candidate, or one with a different quote: treat it as flagged.</li>');
  if (e?.status === 'duplicate') items.push(`<li>Duplicate of ${(e.duplicate_of?.length ? e.duplicate_of : [e.canonical_id]).filter(Boolean).map(other).join('; ')}. <span class="muted">If they are the same promise, reject one with reason 1.</span></li>`);
  if (e?.status === 'possible_duplicate') items.push(`<li>Possible duplicate: worded like ${(e.possible_duplicate_of ?? []).map(other).join('; ')}. <span class="muted">Do not accept both; if they are the same promise, reject one with reason 1.</span></li>`);
  const consistency = [];
  for (const f of e?.flags ?? []) {
    if (f.kind === 'not_a_promise') items.push(`<li>Not a promise (${esc(f.severity)}): <span class="muted">“${esc(f.reason)}”</span></li>`);
    else if (f.kind === 'continuation') items.push(`<li>“Continue / poursuivre”: needs a baseline. ${f.reason ? `<span class="muted">“${esc(f.reason)}”</span>` : ''}</li>`);
    else if (f.kind === 'consistency_note') consistency.push(`<li class="muted">Consistency note: “${esc(f.reason ?? '')}”</li>`);
    else items.push(`<li>${esc(f.kind)}: <span class="muted">“${esc(f.reason ?? '')}”</span></li>`);
  }
  for (const f of view.fixes) {
    items.push(`<li class="fix">Proposed fix${f.needs_founder ? ' (needs your decision)' : ''}: ${esc(FIELD_NAMES[f.field] ?? f.field)} ${esc(fieldText(f.field, f.from))} → ${esc(fieldText(f.field, f.to))}. <span class="muted">“${esc(f.reason)}”</span> Press ${kbd('F')} to apply and accept.</li>`);
  }
  if (e?.needs_founder && view.fixes.every((f) => !f.needs_founder)) items.push('<li>The review marked this one as needing your decision.</li>');
  if (items.length > 0) items.push(...consistency);
  return items.length ? `<ul class="flags" aria-label="Review flags">${items.join('')}</ul>` : '';
}
const FIELD_NAMES = { domain: 'topic', deadline_basis: 'deadline basis', quote_original: 'quote', criteria_fr: 'criteria FR', criteria_en: 'criteria EN' };
function fieldText(field, v) {
  if (v === null || v === undefined) return '(empty)';
  if (['type', 'verifiability', 'domain', 'deadline_basis'].includes(field)) return label(field, v);
  return String(v);
}

function candidateFields(c, speaker, fixes) {
  const proposed = (field) => {
    const f = fixes.find((x) => x.field === field);
    return f ? ` <span class="muted">(proposed: ${esc(fieldText(field, f.to))})</span>` : '';
  };
  const roles = [c.speaker_role_fr && `<span lang="fr">${esc(c.speaker_role_fr)}</span>`, c.speaker_role_en && `<span lang="en">${esc(c.speaker_role_en)}</span>`].filter(Boolean).join(' / ');
  return meta([
    ['Speaker', `${speaker}${roles ? ` · ${roles}` : ''}`],
    ['Type', esc(label('type', c.type)) + proposed('type')],
    ['Topic', esc(label('domain', c.domain)) + proposed('domain')],
    ['Verifiability', esc(label('verifiability', c.verifiability)) + proposed('verifiability')],
    ['Deadline', (c.deadline ? `${esc(c.deadline)} · ${esc(label('deadline_basis', c.deadline_basis))}` : '<span class="muted">none</span>') + proposed('deadline')],
    ['Criteria FR', textOr(c.criteria_fr, 'fr')],
    ['Criteria EN', textOr(c.criteria_en, 'en')],
  ]);
}

function select(name, group, value, allowEmpty, idPrefix) {
  const opts = Object.keys(LABELS[group]).map((k) => `<option value="${esc(k)}"${k === value ? ' selected' : ''}>${esc(LABELS[group][k])}</option>`);
  return `<select name="${name}" id="${idPrefix}${name}">${allowEmpty ? `<option value=""${value ? '' : ' selected'}>(none)</option>` : ''}${opts.join('')}</select>`;
}
function candidateEditForm(c) {
  const input = (name, labelText, value, lang = null) => `<div><label class="label" for="e-${name}">${esc(labelText)}</label><input id="e-${name}" name="${name}" type="text" value="${esc(value ?? '')}"${lang ? ` lang="${esc(lang)}"` : ''} autocomplete="off"></div>`;
  const area = (name, labelText, value, lang = null) => `<div><label class="label" for="e-${name}">${esc(labelText)}</label><textarea id="e-${name}" name="${name}" rows="2"${lang ? ` lang="${esc(lang)}"` : ''}>${esc(value ?? '')}</textarea></div>`;
  const sel = (name, labelText, group, allowEmpty = false) => `<div><label class="label" for="e-${name}">${esc(labelText)}</label>${select(name, group, c[name], allowEmpty, 'e-')}</div>`;
  return `<form class="panel edit dialog" id="edit-panel" data-action="accept_edited" role="dialog" aria-label="Edit, then accept" hidden>
<h2>Edit, then accept</h2>
${area('quote_original', 'Quote (word for word, original language)', c.quote_original, c.lang)}
${input('unit', 'Page or paragraph number in the source text', c.unit)}
${input('locator', 'Location as cited (e.g. p. 9, §17)', c.locator)}
${c.lang !== 'fr' ? area('quote_fr', 'Quote, French translation', c.quote_fr, 'fr') : ''}
${c.lang !== 'en' ? area('quote_en', 'Quote, English translation', c.quote_en, 'en') : ''}
${sel('type', 'Type', 'type')}
${sel('domain', 'Topic', 'domain')}
${sel('verifiability', 'Verifiability', 'verifiability')}
${input('deadline', 'Deadline (YYYY-MM-DD; empty for none)', c.deadline)}
${sel('deadline_basis', 'Deadline basis', 'deadline_basis', true)}
${area('criteria_fr', 'Criteria FR', c.criteria_fr, 'fr')}
${area('criteria_en', 'Criteria EN', c.criteria_en, 'en')}
${input('speaker_role_fr', 'Speaker role FR', c.speaker_role_fr, 'fr')}
${input('speaker_role_en', 'Speaker role EN', c.speaker_role_en, 'en')}
<p class="form-error" role="alert" hidden></p>
<p class="muted">On save the program checks the quote against the source again, and the database rules. ${kbd('Ctrl+Enter')} save and accept · ${kbd('Esc')} discard</p>
</form>`;
}

export function renderCandidatePage(d) {
  const banners = d.files.filter((f) => f.problems.length > 0).map((f) =>
    `<p class="warn"><b>${f.source ? `Source ${f.source.id}` : esc(f.name)}: its candidates cannot be accepted.</b> ${f.problems.map(esc).join('; ')}${f.problems.some((p) => /subject_id/.test(p)) ? '. Link the source to its speaker with <span class="mono">npm run desk -- auto-import &lt;candidates file&gt; --subject &lt;id&gt;</span> (it writes the id into the file).' : ''}</p>`).join('');
  if (d.reviewMissing) {
    return page({ ...d, title: 'Candidates', queue: 'candidate', body: '<div class="panel"><p>No review file found (data/candidates/review-*.json). Start the desk with <span class="mono">--review &lt;file&gt;</span>.</p></div>' });
  }
  const v = d.view;
  if (!v) {
    const body = `${banners}<div class="panel"><p>All candidates done. Today: ${d.today.accepted} accepted, ${d.today.rejected} rejected.</p><p class="muted">${d.counts.verdicts} verdicts left: press ${kbd('Q')} to switch.</p></div>${actionsBar([button({ key: 'Q', text: 'Verdicts', href: '/verdicts' }), button({ key: 'Z', text: 'Undo', undo: true, spacer: true })])}`;
    return page({ ...d, title: 'Candidates', queue: 'candidate', body });
  }
  const c = v.candidate;
  const fileBlocked = v.file.problems.length > 0;
  const where = (unit) => (v.units.kind === 'pdf_page' ? `PDF page ${unit}` : v.units.kind === 'law' ? `unit ${unit}` : `§${unit}`);
  const checkLine = v.units.error ? `<b>The source text cannot be read:</b> ${esc(v.units.error)}. Only ${kbd('S')} (skip).`
    : c.verbatim ? `program check: verbatim match (${where(c.verbatim_unit)})`
      : `<b>Cannot accept: the program cannot find this quote word for word in the source.</b> Press ${kbd('E')} to correct the quote or page and check again, or ${kbd('R')} to reject (reason 3).`;
  const blockers = !fileBlocked && v.problems.length > 0
    ? `<div class="ok-line"><p><b>Cannot accept as it stands:</b></p><ul>${v.problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>${v.fixes.length > 0 && !v.canFix ? `<p class="muted">With the proposed fixes: ${esc(v.fixProblems.join('; '))}</p>` : ''}</div>` : '';
  const dup = ['duplicate', 'possible_duplicate'].includes(v.entry?.status);
  const dupIds = v.entry?.status === 'duplicate' ? (v.entry.duplicate_of?.length ? v.entry.duplicate_of : [v.entry.canonical_id]) : v.entry?.possible_duplicate_of ?? [];
  const speaker = v.file.raw.subject_id ? `person #${esc(v.file.raw.subject_id)}` : '<b>no speaker linked</b>';
  const unitWord = v.units.kind === 'pdf_page' ? 'PDF page' : v.units.kind === 'law' ? 'article' : 'paragraph';
  const body = `${banners}
<div class="screen-title"><h1>Flagged candidate ${d.position.n} / ${d.position.of}</h1>
<span class="muted">${esc(v.label)} · source ${v.source.id}: <span lang="${esc(v.source.lang)}">${esc(v.source.title)}</span> · ${d.counts.candidates} left in total · unflagged candidates were accepted automatically · this item <span id="timer">0:00</span></span></div>
${d.onlySkipped ? `<p class="muted">The ${d.counts.candidates} items left were all skipped.</p>` : ''}
<div class="cols">
<div class="panel">
${flagList(v, d.byId)}
${quoteBlock(c.quote_original, c.lang)}
<p class="muted">Source ${esc(c.locator)} · ${checkLine}</p>
${translations(c.lang, c.quote_fr, c.quote_en)}
${blockers}
${candidateFields(c, speaker, v.fixes)}
</div>
<div class="panel">
<h2>Source, ${unitWord} ${esc(c.unit)} <span class="muted">(${v.units.kind === 'pdf_page' ? 'transcription' : esc(v.units.basis ?? 'text')}, the text the program checks against)</span></h2>
${sourcePassage(v.units, c.quote_original, c.unit, v.source.lang)}
<p class="muted">Space scrolls · ${kbd('O')} opens the archived original (<a href="/original/${v.source.id}" target="_blank" rel="noopener noreferrer" id="open-original">source ${v.source.id}</a>)</p>
</div>
</div>
${actionsBar([
    button({ key: 'A', text: 'Accept', act: 'accept', disabled: !v.canAccept, primary: true }),
    button({ key: 'F', text: 'Apply fixes and accept', act: 'accept_with_fixes', disabled: !v.canFix }),
    button({ key: 'E', text: 'Edit, then accept', open: 'edit-panel', disabled: !v.canEdit }),
    button({ key: 'R', text: 'Reject…', open: 'reject-panel', disabled: !v.canReject }),
    button({ key: 'S', text: 'Skip', act: 'skip' }),
    button({ key: 'Z', text: 'Undo', undo: true, spacer: true }),
    button({ key: 'Q', text: 'Verdicts', href: '/verdicts' }),
    button({ key: '?', text: 'Shortcuts', open: 'help-panel' }),
  ])}
${reasonsPanel({
    id: 'reject-panel', action: 'reject', title: `Reject ${v.label}, reason:`, preset: dup ? 1 : null, noteValue: dup ? `duplicate of ${dupIds.join(', ')}` : '',
    reasons: [`<b>Duplicate</b>${dup ? ` — same as ${esc(dupIds.join(', '))} (from the review flag)` : ''}`, 'Not a promise or prediction (an attitude, an effort, a description)', 'The quote is wrong (cut, not in the source, wrong page that cannot be fixed)', 'Other (one sentence required)'],
    noteLabel: 'One more sentence (required for reason 4)',
  })}
${v.canEdit ? candidateEditForm(c) : ''}`;
  return page({ ...d, title: `Candidate ${v.label}`, queue: 'candidate', item: v.id, body });
}

// ---------------------------------------------------------------- queue B

// The publication checks in the wording of design/review-desk.md §5.4, matched on ledger.js's messages.
const BLOCKER_TEXT = [
  [/subject that does not exist/, 'The person this item points to does not exist'],
  [/origin is missing or is not/, "The origin is missing, or is not the person's own public words"],
  [/has no verdict yet/, 'No verdict yet'],
  [/vague or hedged claim can only be/, 'A vague or hedged item can only be “Unverifiable”'],
  [/needs a summary explaining it/, 'Every verdict except “Pending” needs a summary'],
  [/needs one official document, or two independent/, 'This verdict needs one official document, or independent reports from two different publishers (a public renunciation counts only for “Did not come true” on a promise)'],
  [/is used as evidence; evidence must be/, 'The evidence includes a speech, a platform, a renunciation or a missing source; evidence must be official documents or independent reports'],
  [/missing its French or English version/, 'A French or English version is missing'],
];
export function blockerText(message) {
  return BLOCKER_TEXT.find(([re]) => re.test(message))?.[1] ?? message;
}

function agreementLine(v) {
  const counts = [...v.tally.values()].sort((a, b) => b - a);
  if (v.valid.length < 2) return `<p><span class="agree">${v.valid.length} valid vote${v.valid.length === 1 ? '' : 's'}</span> <span class="muted">At least two different models must give a vote that passes the program's check.</span></p>`;
  const words = (n, k) => `${['no', 'one', 'two', 'three'][n] ?? n} vote${n === 1 ? '' : 's'} “${label('verdict', k)}”`;
  const plain = v.unanimous
    ? `All ${v.valid.length} votes say “${label('verdict', v.valid[0].vote.verdict)}”; that vote is pre-selected.`
    : `${[...v.tally.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => words(n, k)).join(', ').replace(/^./, (x) => x.toUpperCase())}. No vote is pre-selected on a split: press ${kbd('1')}–${kbd(String(v.p.votes.length))} to adopt one.`;
  return `<p><span class="agree">${v.unanimous ? `${counts[0]} : 0 agree` : `${counts.join(' : ')} split`}</span> <span class="muted">${plain}</span></p>`;
}

function voteColumn(x, v, excerptIndex) {
  const vote = x.vote;
  const isAdopted = v.adopted === x.n;
  const isPre = !v.ws.verdict && v.preselect === x.n;
  const cites = (vote.evidence ?? []).map((e) => {
    const i = excerptIndex(e);
    return i ? `<a href="#x${i}">[${i}]</a>` : `<span class="muted">source ${esc(e?.source_id)}</span>`;
  }).join(' ');
  return `<article class="judge${isAdopted || isPre ? ' adopted' : ''}" aria-label="Juror ${x.n}${isAdopted ? ', adopted' : isPre ? ', pre-selected' : ''}">
<p><b>${x.n}</b> · <span class="mono">${esc(vote.model ?? '?')}</span> <span class="muted">${esc(label('channel', vote.channel))}</span></p>
${x.valid ? '' : `<p class="ok-line">This vote failed the program's check: ${esc(x.problems.join('; '))}. It does not count towards agreement.</p>`}
<p>${verdictChip(vote.verdict)}</p>
<p class="muted">Cites ${cites || 'nothing'}${isAdopted ? ' · adopted' : isPre ? ' · pre-selected' : ''}</p>
${vote.summary_fr ? `<p lang="fr">${esc(vote.summary_fr)}</p>` : ''}
${vote.summary_en ? `<p class="muted" lang="en">${esc(vote.summary_en)}</p>` : ''}
${vote.open_question_fr || vote.open_question_en ? `<p>What is missing: <span lang="fr">${esc(vote.open_question_fr ?? '')}</span></p><p class="muted" lang="en">${esc(vote.open_question_en ?? '')}</p>` : ''}
<details><summary>Reasoning (working notes, not published)</summary><p>${esc(vote.reasoning ?? '')}</p></details>
</article>`;
}

function verdictEditForm(v) {
  const cur = v.ws.verdict ?? (v.preselect ? v.p.votes.find((x) => x.n === v.preselect).vote : null) ?? {};
  const area = (name, labelText, lang) => `<div><label class="label" for="v-${name}">${esc(labelText)}</label><textarea id="v-${name}" name="${name}" rows="3" lang="${esc(lang)}">${esc(cur[name] ?? '')}</textarea></div>`;
  return `<form class="panel edit dialog" id="edit-panel" data-action="edit" role="dialog" aria-label="Edit summary" hidden>
<h2>Edit the summary of item #${v.claimId}</h2>
<div><label class="label" for="v-verdict">Verdict (changing it records the decision as yours, not the jury's)</label>
<select id="v-verdict" name="verdict">${VERDICT_ORDER.map((k) => `<option value="${esc(k)}"${k === cur.verdict ? ' selected' : ''}>${esc(label('verdict', k))}</option>`).join('')}</select></div>
${area('summary_fr', 'Summary FR', 'fr')}
${area('summary_en', 'Summary EN', 'en')}
${area('open_question_fr', 'What is missing FR (for “To be assessed”)', 'fr')}
${area('open_question_en', 'What is missing EN (for “To be assessed”)', 'en')}
<p class="form-error" role="alert" hidden></p>
<p class="muted">${kbd('Ctrl+Enter')} save to the workspace · ${kbd('Esc')} discard. The publication check runs again after saving.</p>
</form>`;
}

export function renderVerdictPage(d) {
  const v = d.view;
  const unlinked = d.unlinked.length ? `<details class="muted"><summary>${d.unlinked.length} evidence pack(s) without a workspace item</summary><ul>${d.unlinked.map((u) => `<li><span class="mono">${esc(u.path)}</span>: ${esc(u.why)}</li>`).join('')}</ul></details>` : '';
  if (!v) {
    const body = `<div class="panel"><p>No verdicts waiting. Today: ${d.today.confirmed} confirmed, ${d.today.sentBack} sent back.</p><p class="muted">${d.counts.candidates} flagged candidates left: press ${kbd('Q')} to switch.</p></div>${unlinked}${actionsBar([button({ key: 'Q', text: 'Candidates', href: '/candidates' }), button({ key: 'Z', text: 'Undo', undo: true, spacer: true })])}`;
    return page({ ...d, title: 'Verdicts', queue: 'verdict', body });
  }
  const c = v.ws.claim;
  const pack = v.p.pack;
  const excerpts = pack.excerpts ?? [];
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const excerptIndex = (e) => {
    const i = excerpts.findIndex((x) => x.source_id === e?.source_id && norm(x.text).includes(norm(e?.excerpt)));
    return i >= 0 ? i + 1 : null;
  };
  const src = (id) => d.sources.get(id);
  const entered = v.entered === 'auto' ? 'auto-accepted' : v.entered === 'candidate' ? 'accepted from the candidate queue' : 'entered outside the desk';
  const status = v.published === 0 ? 'first publication' : v.unconfirmed ? '<b>unconfirmed changes</b>' : 'published';
  const after = v.after.state;
  const chosen = v.adopted ? `vote ${v.adopted} adopted` : !v.ws.verdict && v.preselect ? `vote ${v.preselect} pre-selected` : v.ws.verdict ? `edited at the desk (decided by ${v.ws.verdict.decided_by})` : 'no vote chosen';
  const stops = v.stops.map((s) => {
    if (!/missing its French or English version/.test(s)) return `<li>${esc(blockerText(s))}</li>`;
    return `<li>${esc(blockerText(s))}${v.bilingual.length ? `:<ul>${v.bilingual.map((g) => `<li>${esc(g)}</li>`).join('')}</ul>` : ''}</li>`;
  }).join('');
  const check = v.stops.length
    ? `<div class="ok-line"><p><b>Cannot confirm yet:</b></p><ul>${stops}</ul><p class="muted">At the desk only the summary and the verdict can be fixed (${kbd('E')}, ${kbd('1')}–${kbd('3')}). Anything else: ${kbd('B')} to send back, or ${kbd('S')} to skip.</p></div>`
    : '<p class="ok-line">Publication check: all checks pass (origin, evidence, summary, both languages).</p>';
  const evNumbers = after.evidence.map((e) => {
    const i = excerptIndex(e);
    return i ? `[${i}]` : `(${esc(e.locator)})`;
  }).join(' ');
  let prevSource = null;
  const excerptItems = excerpts.map((x, i) => {
    const s = src(x.source_id);
    const head = prevSource === x.source_id ? `Same document, ${esc(x.locator)}`
      : `${esc(label('kind', s?.kind))} · <span class="doc-title" lang="${esc(s?.lang)}">${esc(s?.title ?? `source ${x.source_id}`)}</span>, <span lang="${esc(s?.lang)}">${esc(s?.publisher ?? '')}</span>, ${esc(s?.published_on ?? 'no date')}, ${esc(x.locator)}`;
    prevSource = x.source_id;
    return `<li id="x${i + 1}"><span class="n">[${i + 1}]</span> ${head}${quoteBlock(x.text, s?.lang)}${translations(s?.lang, x.text_fr, x.text_en)}</li>`;
  }).join('');
  const body = `<div class="screen-title"><h1>Verdict ${d.position.n} / ${d.position.of}</h1>
<span class="muted">Item #${v.claimId} · ${entered} · evidence pack <span class="mono">pack ${esc(v.p.packSha256.slice(0, 4))}…${esc(v.p.packSha256.slice(-4))}</span> · ${status}</span></div>
${d.onlySkipped ? `<p class="muted">The ${d.counts.verdicts} items left were all skipped.</p>` : ''}
<div class="warn" role="note"><b>Confirm = publish.</b> Once written to the ledger it cannot be changed or deleted, only withdrawn, and the withdrawal is public too. After ${kbd('C')} you have 5 seconds: ${kbd('Z')} cancels and nothing is written.</div>
${v.changed.length ? `<p class="ok-line">Unconfirmed changes since the last ledger entry: ${v.changed.map(esc).join(', ')}</p>` : ''}
<div class="panel">
<p class="muted">${esc(d.subject?.name ?? `person #${c.subject_id}`)}${c.speaker_role_en ? ` · <span lang="en">${esc(c.speaker_role_en)}</span>` : ''} · <span class="doc-title" lang="${esc(d.origin?.lang)}">${esc(d.origin?.title ?? '')}</span>, ${esc(c.said_on)}, ${esc(c.source_locator)}</p>
${quoteBlock(c.quote_original, c.lang)}
${translations(c.lang, c.quote_fr, c.quote_en)}
${meta([
    ['Type · topic', `${esc(label('type', c.type))} · ${esc(label('domain', c.domain))}`],
    ['Verifiability · deadline', `${esc(label('verifiability', c.verifiability))} · ${c.deadline ? `${esc(c.deadline)}, ${esc(label('deadline_basis', c.deadline_basis))}` : 'no deadline'}`],
    ['Criteria FR', textOr(c.criteria_fr, 'fr')],
    ['Criteria EN', textOr(c.criteria_en, 'en')],
  ])}
${v.entered === 'auto' ? `<details id="passage"><summary>Source passage (${kbd('P')}) · auto-accepted item: this is the first time a person sees it</summary>${d.originUnits ? sourcePassage(d.originUnits, c.quote_original, passageUnit(d.originUnits, c.quote_original), d.origin?.lang) : ''}</details>` : ''}
</div>
<div class="cols wide-left">
<div class="panel">
<h2>Evidence pack: ${excerpts.length} excerpt${excerpts.length === 1 ? '' : 's'}</h2>
${v.p.checked.problems.length ? `<p class="ok-line"><b>The evidence pack fails its check:</b> ${esc(v.p.checked.problems.join('; '))}</p>` : ''}
<ol class="excerpts">${excerptItems}</ol>
<details id="unused"><summary>Considered, not used: ${(pack.considered_not_used ?? []).length} (${kbd('U')})</summary>
<ul>${(pack.considered_not_used ?? []).map((u) => {
    const s = src(u.source_id);
    return `<li>${esc(label('kind', s?.kind))} · <span lang="${esc(s?.lang)}">${esc(s?.title ?? `source ${u.source_id}`)}</span>, ${esc(u.locator ?? '')}${u.text ? ` — <span lang="${esc(s?.lang)}">“${esc(u.text)}”</span>` : ''} — “${esc(u.why)}”</li>`;
  }).join('')}</ul></details>
<details><summary>Gaps</summary><p>${esc(pack.gaps ?? 'none')}</p></details>
<p class="muted">Clipped by <span class="mono">${esc(pack.made_by?.model ?? '?')}</span> (${esc(label('channel', pack.made_by?.channel))})</p>
</div>
<div>
${agreementLine(v)}
<div class="judges">${v.p.votes.map((x) => voteColumn(x, v, excerptIndex)).join('')}</div>
</div>
</div>
<div class="panel publish">
<h2>What C will publish</h2>
<p>${verdictChip(after.verdict?.verdict)} <span class="muted">${esc(chosen)} · evidence ${evNumbers || 'none'}</span></p>
${after.verdict?.summary_fr ? `<p lang="fr">${esc(after.verdict.summary_fr)}</p>` : ''}
${after.verdict?.summary_en ? `<p class="muted" lang="en">${esc(after.verdict.summary_en)}</p>` : ''}
${after.verdict?.open_question_fr || after.verdict?.open_question_en ? `<p>What is missing: <span lang="fr">${esc(after.verdict.open_question_fr ?? '')}</span></p><p class="muted" lang="en">${esc(after.verdict.open_question_en ?? '')}</p>` : ''}
${check}
</div>
${unlinked}
${actionsBar([
    button({ key: 'C', text: 'Confirm and publish', act: 'confirm', disabled: !v.canConfirm, primary: true }),
    ...v.p.votes.map((x) => button({ key: String(x.n), text: `Adopt vote ${x.n}`, act: 'adopt', vote: x.n, disabled: !x.valid || v.adopted === x.n })),
    button({ key: 'E', text: 'Edit summary', open: 'edit-panel' }),
    button({ key: 'B', text: 'Send back…', open: 'send-back-panel' }),
    button({ key: 'X', text: 'Reject item…', open: 'reject-claim-panel', disabled: v.published > 0, title: v.published > 0 ? 'Published items can only be withdrawn' : null }),
    button({ key: 'S', text: 'Skip', act: 'skip' }),
    button({ key: 'Z', text: 'Undo', undo: true, spacer: true }),
    button({ key: 'Q', text: 'Candidates', href: '/candidates' }),
    button({ key: '?', text: 'Shortcuts', open: 'help-panel' }),
  ])}
<p hidden>${button({ key: 'U', text: 'Considered, not used', open: 'toggle:unused' })}${v.entered === 'auto' ? button({ key: 'P', text: 'Source passage', open: 'toggle:passage' }) : ''}</p>
${reasonsPanel({
    id: 'send-back-panel', action: 'send_back', title: `Send item #${v.claimId} back to:`,
    reasons: ['Evidence pack (excerpts insufficient, wrong, or a key passage missing)', 'Jury again (evidence is enough; the verdict or summary is wrong)', 'The item itself (quote, criteria or deadline need changing)', 'Translation'],
    noteLabel: 'One sentence about what is missing (required)',
  })}
${reasonsPanel({
    id: 'reject-claim-panel', action: 'reject_claim', title: `Reject item #${v.claimId} and delete it from the workspace, reason:`,
    reasons: ['Not a promise or prediction', 'Extraction error (quote cut wrongly, wrong page, wrongly split or merged)', 'Duplicate of another item (give the id)', 'Other (one sentence required)'],
    noteLabel: 'One more sentence (the id for reason 3; required for reason 4)',
    extra: `<p class="muted">The item's quote, verdict, evidence and votes are saved in the desk log; ${kbd('Z')} puts it back.</p>`,
  })}
${verdictEditForm(v)}`;
  return page({ ...d, title: `Item #${v.claimId}`, queue: 'verdict', item: v.id, body });
}

function passageUnit(units, quote) {
  if (!units || units.error) return null;
  const norm = (s) => String(s).replace(/\s+/g, '');
  const q = norm(quote);
  return units.units.find((u) => norm(u.text).includes(q))?.unit ?? units.units[0]?.unit ?? null;
}
