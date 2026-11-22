// The browser script (src/site-assets/views.js), run in a bare VM with a stub document: only the
// pure rendering functions are exercised (no layout, no events beyond a recorded listener).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

function loadViews(lang) {
  const listeners = [];
  const element = () => ({
    innerHTML: '',
    buttons: [],
    querySelectorAll() { return this.buttons; },
  });
  const document = {
    documentElement: { lang },
    body: { getAttribute: () => '', insertBefore() {}, firstChild: null },
    getElementById: () => null,
    createElement: () => ({ innerHTML: '', firstChild: {} }),
    addEventListener: (type, fn) => listeners.push(fn),
    querySelector: () => null,
  };
  const window = {};
  runInNewContext(readFileSync(new URL('../src/site-assets/views.js', import.meta.url), 'utf8'), {
    window, document, Intl, Math, String, Number, Array, Object, Date, location: {},
  });
  return { S: window.KVStats, window, element };
}

const item = (id, verdict, extra = {}) => ({
  id, s: 1, type: 'promise', domain: 'tax', said: `2020-01-0${id}`, deadline: null, basis: null, verif: 'measurable',
  verdict, confirmed: '2026-11-22', lang: 'fr', q: `Citation ${id}`, fr: null, en: `Quote ${id}`,
  role_fr: null, role_en: null, sum_fr: 'Résumé.', sum_en: 'Summary.', oq_fr: null, oq_en: null, src: 7, ev: [], ...extra,
});

test('a group header says how many of its items are shown while a verdict filter is on', () => {
  const { S, window, element } = loadViews('en');
  window.KV = { subjects: { 1: { id: 1, name: 'A', kind: 'person', country: 'FR', slug: 'a' } },
    sources: { 7: { title: 'Doc', kind: 'platform', publisher: 'P', date: null, lang: 'fr' } } };
  const all = [item(1, 'came_true'), item(2, 'pending'), item(3, 'came_true')];
  const el = element();
  S.groups(el, all.filter((i) => i.verdict === 'came_true'), all);
  assert.match(el.innerHTML, /<p class="muted">3 items, 2 shown<\/p>/);
  // The six counts stay those of the whole group (before the verdict filter), as designed.
  assert.match(el.innerHTML, /<span>Pending<\/span><span class="n">1<\/span>/);
  S.groups(el, all, all);
  assert.match(el.innerHTML, /<p class="muted">3 items<\/p>/);
  const fr = loadViews('fr');
  fr.window.KV = window.KV;
  fr.S.groups(el, all.slice(0, 1), all);
  assert.match(el.innerHTML, /<p class="muted">3 fiches, 1 affichée<\/p>/);
});

test('a verdict with no items cannot be picked, unless it is the current filter', () => {
  const { S, element } = loadViews('en');
  const el = element();
  const c = { total: 2, unverifiable: 0, pending: 2, to_evaluate: 0, came_true: 0, partly_came_true: 0, not_came_true: 0 };
  S.legend(el, c, () => {}, 'came_true');
  const button = (v) => el.innerHTML.match(new RegExp(`<button type="button" data-v="${v}"[^>]*>`))[0];
  assert.match(button('unverifiable'), /aria-disabled="true"/);
  assert.doesNotMatch(button('pending'), /aria-disabled/);
  assert.doesNotMatch(button('came_true'), /aria-disabled/); // picked: must stay clickable to clear it
  // A click on a disabled button does nothing.
  const picked = [];
  const make = (v, disabled) => {
    const b = { attrs: { 'data-v': v, 'aria-disabled': disabled ? 'true' : null }, getAttribute(n) { return this.attrs[n]; },
      addEventListener(type, fn) { this.click = fn; } };
    return b;
  };
  el.buttons = [make('unverifiable', true), make('pending', false)];
  S.legend(el, c, (v) => picked.push(v), null);
  el.buttons.forEach((b) => b.click());
  assert.deepEqual(picked, ['pending']);
});

test('an empty topic list under a country filter says so', () => {
  const { S, element } = loadViews('en');
  assert.equal(S.emptyText('CA'), 'No items from Canada on this topic.');
  assert.equal(S.emptyText(''), 'No items in this period.');
  const el = element();
  S.rows(el, [], true, S.emptyText('CA'));
  assert.equal(el.innerHTML, '<li><p class="empty">No items from Canada on this topic.</p></li>');
  assert.equal(loadViews('fr').S.emptyText('CA'), 'Aucune fiche pour ce pays (Canada) sur ce thème.');
});

test('rows show the translation first and the labelled original under it (decision 0007 addendum)', () => {
  const { S, window, element } = loadViews('en');
  window.KV = { subjects: { 1: { id: 1, name: 'A', kind: 'person', country: 'FR', slug: 'a' } } };
  const el = element();
  S.rows(el, [item(1, 'pending'), item(2, 'pending', { lang: 'en', q: 'Said in English', en: null, fr: 'Dit en anglais' })], false);
  // Translation in sans (.row-translated), original in serif (.row-original) with its inline label.
  assert.ok(el.innerHTML.includes('<span class="row-translated" lang="en"><span class="visually-hidden">Translation: </span>Quote 1</span>' +
    '<span class="row-original"><span class="label-inline">Original (French): </span><span lang="fr">Citation 1</span></span>'));
  // Said in the page language: the serif quote alone, as before.
  assert.ok(el.innerHTML.includes('<span class="row-quote" lang="en">Said in English</span><span class="row-meta">'));
});
