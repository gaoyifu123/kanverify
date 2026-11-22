// KANVERIFY site scripts: timeline, verdict charts, filters. Adapted from design/mockups/stats.js,
// person-view.js and topic-view.js (frozen MVP design). No framework, no outside requests.
//
// Differences from the mockups, all forced by real data rather than sample data:
//   - data comes from {root}{lang}/index.json instead of sample-data.js;
//   - links go to the generated pages; the speaker role is role_fr / role_en on the item;
//   - country names come from Intl.DisplayNames instead of a two-entry table;
//   - "today" is the reader's date; an empty set does not break the timeline;
//   - subject names carry no lang attribute (the record does not say their language);
//   - the topic selector opens that topic's page;
//   - round 4: a group heading without a published_on date omits the date; groups with the
//     same first said_on are ordered by their key; the evidence kind list (ek) also has the two
//     own-words kinds; a Légifrance publisher label (already localised in index.json) has no lang.
// The pages already contain the default lists as HTML; these scripts replace them.
(function () {
  'use strict';
  var ORDER = ['unverifiable', 'pending', 'to_evaluate', 'came_true', 'partly_came_true', 'not_came_true'];

  var T = {
    en: {
      v: { unverifiable: 'Unverifiable', pending: 'Pending', to_evaluate: 'To be assessed', came_true: 'Came true', partly_came_true: 'Partly came true', not_came_true: 'Did not come true' },
      ty: { promise: 'Promise', prediction: 'Prediction' },
      d: { economy: 'Economy', tax: 'Tax', employment: 'Employment and work', health: 'Health', education: 'Education and research', environment: 'Environment', energy: 'Energy', defence: 'Defence', security: 'Internal security', justice: 'Justice', immigration: 'Immigration and asylum', foreign_affairs: 'Foreign and European affairs', institutions: 'Institutions and public life', social: 'Social protection', housing: 'Housing', transport: 'Transport', agriculture: 'Agriculture and fisheries', digital: 'Digital', culture: 'Culture, media and sport', other: 'Other topics' },
      m: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
      ms: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
      deadline: 'Deadline', inferred: 'inferred: end of term', stated: 'stated',
      items: function (n) { return n === 1 ? '1 item' : n + ' items'; },
      shown: function (n, k) { return (n === 1 ? '1 item' : n + ' items') + ', ' + k + ' shown'; },
      noneCountry: function (c) { return 'No items from ' + c + ' on this topic.'; },
      itemsWord: 'items',
      none: 'No items in this period.',
      noDate: function (n) { return n === 0 ? '' : (n === 1 ? '1 item has' : n + ' items have') + ' no deadline and ' + (n === 1 ? 'is' : 'are') + ' not on the timeline.'; },
      heading: function (b) { return b === 'deadline' ? 'Promises and predictions falling due' : 'Promises and predictions made'; },
      noneTopic: 'No items on this topic: ',
      transl: 'Translation', as: 'as', due: 'due', made: 'said',
      k: { platform: 'Platform', statement: 'Statement' },
      missing: 'What is missing:', basedOn: 'Based on', wording: 'the wording itself', vf: { vague: 'vague', hedged: 'hedged' },
      noDeadline: 'No deadline', confirmed: 'Confirmed by a person on',
      full: function (id) { return 'Full record, item ' + id; },
      legifrance: 'Légifrance (official database)',
      ek: { law: 'law', gazette: 'official gazette', statistic: 'official statistics', budget: 'budget document', parliament: 'parliamentary record', court: 'court decision', audit: 'public audit report', official: 'official document', media: 'news report', dataset_study: 'study with published data', renunciation: 'public renunciation', platform: 'platform', statement: 'statement' }
    },
    fr: {
      v: { unverifiable: 'Invérifiable', pending: 'En attente', to_evaluate: 'À évaluer', came_true: 'Réalisée', partly_came_true: 'Partiellement réalisée', not_came_true: 'Non réalisée' },
      ty: { promise: 'Promesse', prediction: 'Prévision' },
      d: { economy: 'Économie', tax: 'Fiscalité', employment: 'Emploi et travail', health: 'Santé', education: 'Éducation et recherche', environment: 'Environnement', energy: 'Énergie', defence: 'Défense', security: 'Sécurité intérieure', justice: 'Justice', immigration: 'Immigration et asile', foreign_affairs: 'Affaires étrangères et européennes', institutions: 'Institutions et vie publique', social: 'Protection sociale', housing: 'Logement', transport: 'Transports', agriculture: 'Agriculture et pêche', digital: 'Numérique', culture: 'Culture, médias et sport', other: 'Autres sujets' },
      m: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
      ms: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
      deadline: 'Échéance', inferred: 'déduite : fin du mandat', stated: 'fixée dans la promesse',
      items: function (n) { return n === 1 ? '1 fiche' : n + ' fiches'; },
      shown: function (n, k) { return (n === 1 ? '1 fiche' : n + ' fiches') + ', ' + k + (k === 1 ? ' affichée' : ' affichées'); },
      noneCountry: function (c) { return 'Aucune fiche pour ce pays (' + c + ') sur ce thème.'; },
      itemsWord: 'fiches',
      none: 'Aucune fiche sur cette période.',
      noDate: function (n) { return n === 0 ? '' : (n === 1 ? '1 fiche n’a pas' : n + ' fiches n’ont pas') + ' d’échéance et ' + (n === 1 ? 'n’est pas placée' : 'ne sont pas placées') + ' sur la frise.'; },
      heading: function (b) { return b === 'deadline' ? 'Promesses et prévisions arrivant à échéance' : 'Promesses et prévisions formulées'; },
      noneTopic: 'Aucune fiche sur ce thème : ',
      transl: 'Traduction', as: 'en tant que', due: 'échéance', made: 'dite le',
      k: { platform: 'Programme', statement: 'Déclaration' },
      missing: 'Ce qui manque' + String.fromCharCode(160) + ':', basedOn: 'Fondé sur', wording: 'la formulation elle-même', vf: { vague: 'imprécise', hedged: 'assortie de réserves' },
      noDeadline: 'Pas d’échéance', confirmed: 'Confirmé par une personne le',
      full: function (id) { return 'Dossier complet, fiche n°' + String.fromCharCode(160) + id; },
      legifrance: 'Légifrance (base officielle)',
      ek: { law: 'texte de loi', gazette: 'journal officiel', statistic: 'statistique officielle', budget: 'document budgétaire', parliament: 'document parlementaire', court: 'décision de justice', audit: 'rapport d’audit public', official: 'document officiel', media: 'article de presse', dataset_study: 'étude avec données publiées', renunciation: 'renonciation publique', platform: 'programme', statement: 'déclaration' }
    }
  };

  var lang = document.documentElement.lang === 'fr' ? 'fr' : 'en';
  var L = T[lang], NB = String.fromCharCode(160);
  var regions = null;
  try { regions = new Intl.DisplayNames([lang], { type: 'region' }); } catch (e) {}
  L.country = function (code) { try { return (regions && regions.of(code)) || code; } catch (e) { return code; } };

  function KV() { return window.KV; }
  function root() { return document.body.getAttribute('data-root') || ''; }
  function today() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(d) { var p = d.split('-'), day = +p[2]; return (lang === 'fr' && day === 1 ? '1er' : day) + NB + L.m[+p[1] - 1] + ' ' + p[0]; }
  function monthIdx(d) { var p = d.split('-'); return +p[0] * 12 + (+p[1] - 1); }
  function monthLabel(i) { return L.ms[i % 12] + ' ' + Math.floor(i / 12); }
  function monthLong(i) { var s = L.m[i % 12] + ' ' + Math.floor(i / 12); return s.charAt(0).toUpperCase() + s.slice(1); }
  function dateOf(it, basis) { return basis === 'deadline' ? it.deadline : it.said; }
  function typeOf(it) { return it.type || 'promise'; }
  function lab(v) { return L.v[v]; }
  function itemHref(id) { return root() + lang + '/claim/' + id + '/'; }
  function nameAttr() { return ''; }

  // ---------- Patterns: one hidden <svg> with defs, used by every chart ----------
  var PAT = {
    unverifiable: '<path d="M0,4 h8"/>',
    pending: '',
    to_evaluate: '<circle cx="4" cy="4" r="1.4" class="pat-dot"/>',
    came_true: '<path d="M-1,1 l2,-2 M0,8 l8,-8 M7,9 l2,-2"/>',
    partly_came_true: '<path d="M4,0 v8"/>', // provisional, for the designer to refine
    not_came_true: '<path d="M-1,7 l2,2 M0,0 l8,8 M7,-1 l2,2"/>'
  };
  function injectDefs() {
    if (document.getElementById('kv-defs')) return;
    var d = document.createElement('div');
    d.innerHTML = '<svg id="kv-defs" width="0" height="0" aria-hidden="true" focusable="false" style="position:absolute"><defs>' +
      ORDER.map(function (v) { return '<pattern id="kv-p-' + v + '" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" class="pat-bg pat-bg-' + v + '"/><g class="pat-ink">' + PAT[v] + '</g></pattern>'; }).join('') +
      '</defs></svg>';
    document.body.insertBefore(d.firstChild, document.body.firstChild);
  }
  function swatch(v) { return '<svg class="swatch" viewBox="0 0 18 18" aria-hidden="true"><rect x="0.5" y="0.5" width="17" height="17" fill="url(#kv-p-' + v + ')" class="seg"/></svg>'; }

  function count(list) {
    var c = { total: list.length };
    ORDER.forEach(function (v) { c[v] = 0; });
    list.forEach(function (it) { c[it.verdict]++; });
    return c;
  }

  // ---------- Rows, cards and groups (design/mockups/stats.js, round 4) ----------
  // The chip carries its verdict's pattern as a small icon (CSS, from data-v): the same mark as the charts.
  function chip(it) { return '<span class="verdict" data-v="' + esc(it.verdict) + '">' + esc(lab(it.verdict)) + '</span>'; }
  // tag: 'p' in cards (block content), 'span' in rows (inside <summary>, which takes phrasing content).
  function quoteBlock(it, cls, tag) {
    tag = tag || 'p';
    var tr = lang === it.lang ? null : it[lang];
    return '<' + tag + ' class="' + cls + '-quote" lang="' + esc(it.lang) + '">' + esc(it.q) + '</' + tag + '>' +
      (tr ? '<' + tag + ' class="' + cls + '-translation"><span class="visually-hidden">' + L.transl + ': </span>' + esc(tr) + '</' + tag + '>' : '');
  }
  // Two lines of the summary under the chip; "What is missing" for to_evaluate; none for pending.
  function summaryLine(it, cls, tag) {
    tag = tag || 'p';
    var oq = it['oq_' + lang], sum = it['sum_' + lang];
    if (it.verdict === 'to_evaluate' && oq) return '<' + tag + ' class="' + cls + '-summary"><span class="summary-label">' + L.missing + '</span> ' + esc(oq) + '</' + tag + '>';
    return sum ? '<' + tag + ' class="' + cls + '-summary">' + esc(sum) + '</' + tag + '>' : '';
  }
  // Opened row = the detail layer in place. Nothing here replaces the item page.
  function rowBody(it) {
    var out = [], ev = it.ev || [];
    if (it.verdict === 'to_evaluate' && it['sum_' + lang]) out.push('<p>' + esc(it['sum_' + lang]) + '</p>');
    if (ev.length) {
      out.push('<p class="row-body-h">' + L.basedOn + '</p><ul class="row-basis">' + ev.map(function (e) {
        return '<li><span lang="' + esc(e.l) + '">' + esc(e.t) + '</span> <span class="muted">· ' + esc(L.ek[e.k]) + ', ' +
          (e.p === L.legifrance ? esc(e.p) : '<span lang="' + esc(e.l) + '">' + esc(e.p) + '</span>') + '</span></li>';
      }).join('') + '</ul>');
    } else if (it.verif !== 'measurable') {
      out.push('<p class="row-body-h">' + L.basedOn + '</p><ul class="row-basis"><li>' + L.wording + ' <span class="muted">· ' + L.vf[it.verif] + '</span></li></ul>');
    }
    out.push('<p class="muted">' + (it.deadline ? L.deadline + ' ' + fmt(it.deadline) + ', ' + (it.basis === 'inferred' ? L.inferred : L.stated) : L.noDeadline) +
      ' · ' + L.confirmed + ' ' + fmt(it.confirmed) + '</p>');
    out.push('<p><a href="' + itemHref(it.id) + '">' + L.full(it.id) + '</a></p>');
    return '<div class="row-body">' + out.join('') + '</div>';
  }
  // A row is an accordion: closed = summary layer; open = detail in place.
  // inGroup: the row sits under its source's heading (person page), so date said and role are not repeated.
  function row(it, showWho, inGroup) {
    var s = KV().subjects[it.s], role = it['role_' + lang];
    var meta = [chip(it), '<span>' + L.ty[typeOf(it)] + '</span>'];
    if (!inGroup) meta.push('<span>' + fmt(it.said) + (role ? ', ' + L.as + ' ' + esc(role) : '') + '</span>');
    if (it.deadline && !inGroup) meta.push('<span>' + L.deadline + ' ' + fmt(it.deadline) + ', ' + (it.basis === 'inferred' ? L.inferred : L.stated) + '</span>');
    return '<li><details class="row" id="r-' + it.id + '"><summary>' +
      (showWho ? '<span class="row-meta"><span class="row-who">' + esc(s.name) + '</span><span>' + esc(L.d[it.domain]) + '</span></span>' : '') +
      quoteBlock(it, 'row', 'span') + '<span class="row-meta">' + meta.join('') + '</span>' + summaryLine(it, 'row', 'span') +
      '</summary>' + rowBody(it) + '</details></li>';
  }
  function rows(el, list, showWho, emptyText) {
    el.innerHTML = list.length ? list.map(function (it) { return row(it, showWho); }).join('') : '<li><p class="empty">' + esc(emptyText || L.none) + '</p></li>';
  }
  // Six counts with their pattern swatch, zeros included: the block's own key, not a score.
  function countList(c) {
    return '<ul class="gcounts">' + ORDER.map(function (v) {
      return '<li>' + swatch(v) + '<span>' + esc(lab(v)) + '</span><span class="n">' + c[v] + '</span></li>';
    }).join('') + '</ul>';
  }
  function bySaid(a, b) { return a.said < b.said ? -1 : a.said > b.said ? 1 : a.id - b.id; }
  // Person page: one block per (origin.id, role), oldest first; six counts per block from countBase
  // (same topic and period, before the verdict filter). Same order as the generator.
  function groups(el, list, countBase) {
    if (!list.length) { el.innerHTML = '<p class="empty">' + L.none + '</p>'; return; }
    var g = {}, keys = [];
    function key(it) { return it.src + '|' + (it.role_fr || ''); }
    list.forEach(function (it) { var k = key(it); if (!g[k]) { g[k] = []; keys.push(k); } g[k].push(it); });
    keys.forEach(function (k) { g[k].sort(bySaid); });
    keys.sort(function (a, b) { return bySaid(g[a][0], g[b][0]) || (a < b ? -1 : a > b ? 1 : 0); });
    injectDefs();
    el.innerHTML = keys.map(function (k) {
      var its = g[k], first = its[0], src = KV().sources[first.src], role = first['role_' + lang];
      var c = count(countBase.filter(function (it) { return key(it) === k; }));
      var meta = [L.k[src.kind], src.date ? fmt(src.date) : null, role ? esc(role) : null].filter(Boolean).join(' · ');
      return '<section class="group"><h3 lang="' + esc(src.lang) + '">' + esc(src.title) + '</h3>' +
        '<p class="muted">' + meta + '</p>' +
        '<p class="muted">' + (its.length < c.total ? L.shown(c.total, its.length) : L.items(c.total)) + '</p>' + countList(c) +
        '<ul class="rows">' + its.map(function (it) { return row(it, false, true); }).join('') + '</ul></section>';
    }).join('');
  }
  function cards(el, list, basis) {
    if (!list.length) { el.innerHTML = '<p class="empty">' + L.none + '</p>'; return; }
    var out = [], cur = null;
    list.forEach(function (it) {
      var d = dateOf(it, basis), m = monthIdx(d), s = KV().subjects[it.s];
      if (m !== cur) { if (cur !== null) out.push('</ol>'); out.push('<h3 class="month">' + esc(monthLong(m)) + '</h3><ol class="cards">'); cur = m; }
      out.push('<li id="c-' + it.id + '"><a class="card" href="' + itemHref(it.id) + '">' +
        '<p class="card-meta"><span class="row-who">' + esc(s.name) + '</span><span>' + (basis === 'deadline' ? L.due : L.made) + ' ' + fmt(d) + '</span></p>' +
        quoteBlock(it, 'card') + '<p class="card-meta">' + chip(it) + '<span>' + L.ty[typeOf(it)] + '</span></p>' + summaryLine(it, 'card') + '</a></li>');
    });
    out.push('</ol>');
    el.innerHTML = out.join('');
  }

  // ---------- Donut: six patterned sectors, clockwise from the top in the fixed order ----------
  function sector(r0, r1, a0, a1) {
    var c = 100, large = a1 - a0 > Math.PI ? 1 : 0;
    function p(r, a) { return (c + r * Math.cos(a)).toFixed(2) + ',' + (c + r * Math.sin(a)).toFixed(2); }
    return 'M' + p(r1, a0) + ' A' + r1 + ',' + r1 + ' 0 ' + large + ' 1 ' + p(r1, a1) + ' L' + p(r0, a1) + ' A' + r0 + ',' + r0 + ' 0 ' + large + ' 0 ' + p(r0, a0) + 'Z';
  }
  function donut(el, c) {
    injectDefs();
    var n = c.total, a = -Math.PI / 2, parts = [], labels = [];
    ORDER.forEach(function (v) {
      var k = c[v]; if (!k) return;
      var span = 2 * Math.PI * k / n, a1 = a + span - (k === n ? 0.0001 : 0), mid = a + span / 2;
      parts.push('<path class="seg" fill="url(#kv-p-' + v + ')" d="' + sector(50, 82, a, a1) + '"></path>');
      labels.push('<text class="chart-text" x="' + (100 + 96 * Math.cos(mid)).toFixed(1) + '" y="' + (106 + 96 * Math.sin(mid)).toFixed(1) + '" text-anchor="middle">' + k + '</text>');
      a += span;
    });
    el.innerHTML = '<svg viewBox="-16 -16 232 232" role="img" aria-label="' + esc(ORDER.map(function (v) { return lab(v) + ' ' + c[v]; }).join(', ')) + '">' +
      parts.join('') + labels.join('') +
      '<text x="100" y="104" text-anchor="middle" class="chart-big">' + n + '</text><text x="100" y="126" text-anchor="middle" class="chart-text">' + esc(L.itemsWord) + '</text></svg>';
  }
  // Legend = the data box: all six with their count, zeros included; each row filters.
  function legend(el, c, onPick, picked) {
    injectDefs();
    el.innerHTML = '<ul class="legend">' + ORDER.map(function (v) {
      var off = c[v] === 0 && picked !== v;
      return '<li><button type="button" data-v="' + v + '" aria-pressed="' + (picked === v) + '"' + (off ? ' aria-disabled="true"' : '') + '>' + swatch(v) +
        '<span class="legend-l">' + esc(lab(v)) + '</span><span class="n">' + c[v] + '</span></button></li>';
    }).join('') + '</ul>';
    Array.prototype.forEach.call(el.querySelectorAll('button[data-v]'), function (b) {
      b.addEventListener('click', function () { if (b.getAttribute('aria-disabled') !== 'true') onPick(b.getAttribute('data-v')); });
    });
  }
  // Stacked bar on a scale shared by every row in the view: one unit per item.
  function bar(c, max) {
    injectDefs();
    var x = 0, W = 300, rects = [];
    ORDER.forEach(function (v) {
      if (!c[v]) return; var w = W * c[v] / max;
      rects.push('<rect class="seg" x="' + x.toFixed(1) + '" y="1" width="' + Math.max(w - 1.5, 1).toFixed(1) + '" height="20" fill="url(#kv-p-' + v + ')"></rect>');
      x += w;
    });
    return '<svg class="bar" viewBox="0 0 ' + W + ' 22" preserveAspectRatio="none" aria-hidden="true">' + rects.join('') + '</svg>';
  }
  function countsText(c) { return ORDER.map(function (v) { return lab(v) + NB + c[v]; }).join(' · '); }

  // ---------- Timeline: drawn at its real pixel width so its text stays at body size ----------
  function timeline(root, opts) {
    var all = opts.items, dates = [];
    all.forEach(function (it) { dates.push(it.said); if (it.deadline) dates.push(it.deadline); });
    if (!dates.length) { opts.onChange([], { basis: opts.basis || 'deadline' }); return; }
    var lo = Math.min.apply(null, dates.map(monthIdx)), hi = Math.max.apply(null, dates.map(monthIdx));
    var y = +today().slice(0, 4);
    var st = { basis: opts.basis || 'deadline', type: 'all', from: opts.all ? lo : y * 12, to: opts.all ? hi : y * 12 + 11 };
    var f = root.querySelector('[name=from]'), t = root.querySelector('[name=to]');
    var fo = root.querySelector('.out-from'), to = root.querySelector('.out-to');
    [f, t].forEach(function (inp) { inp.min = Math.min(lo, y * 12); inp.max = Math.max(hi, y * 12 + 11); });
    var svgBox = root.querySelector('.tl-svg'), note = root.querySelector('.tl-note'), title = root.querySelector('.tl-title'), sub = root.querySelector('.tl-sub');

    function draw() {
      f.value = st.from; t.value = st.to; fo.textContent = monthLabel(st.from); to.textContent = monthLabel(st.to);
      var oneYear = st.from % 12 === 0 && st.to === st.from + 11;
      if (title) title.textContent = oneYear ? String(st.from / 12) : monthLabel(st.from) + ' – ' + monthLabel(st.to);
      if (sub) sub.textContent = L.heading(st.basis);
      var Wd = Math.max(svgBox.clientWidth || 0, 280), pad = 12, span = st.to - st.from + 1, ppm = (Wd - 2 * pad) / span;
      var stacks = {}, dots = [], ticks = [], list = [], noDate = 0;
      all.forEach(function (it) {
        if (st.type !== 'all' && typeOf(it) !== st.type) return;
        var d = dateOf(it, st.basis); if (!d) { noDate++; return; }
        var m = monthIdx(d); if (m < st.from || m > st.to) return;
        list.push(it);
        var x = pad + ppm * ((m - st.from) + (+d.split('-')[2] - 1) / 31), b = Math.round(x / 9);
        stacks[b] = (stacks[b] || 0) + 1;
        dots.push('<a href="#c-' + it.id + '" tabindex="-1"><circle class="dot" cx="' + x.toFixed(1) + '" cy="' + (48 - (stacks[b] - 1) * 9) + '" r="3.5"></circle></a>');
      });
      var steps = [1, 3, 6, 12, 24, 60, 120], ls = 120;
      for (var i = 0; i < steps.length; i++) { if (steps[i] * ppm >= (steps[i] < 12 ? 52 : 44)) { ls = steps[i]; break; } }
      var tickEvery = ppm >= 6 ? 1 : ls;
      for (var m = st.from; m <= st.to; m++) {
        if (m % tickEvery !== 0) continue;
        var x = pad + ppm * (m - st.from), lbl = m % ls === 0;
        ticks.push('<line x1="' + x + '" x2="' + x + '" y1="56" y2="' + (lbl ? 63 : 60) + '" class="tick"/>' +
          (lbl ? '<text x="' + (x + 2) + '" y="82">' + esc(ls >= 12 ? String(Math.floor(m / 12)) : (m % 12 === 0 && span > 12 ? String(m / 12) : L.ms[m % 12])) + '</text>' : ''));
      }
      var tm = monthIdx(today()), todayX = tm >= st.from && tm <= st.to ? pad + ppm * ((tm - st.from) + (+today().slice(8) - 1) / 31) : null;
      svgBox.innerHTML = '<svg viewBox="0 0 ' + Wd + ' 88" width="' + Wd + '" height="88" role="img" aria-label="' + esc(L.items(list.length)) + '">' +
        '<line x1="' + pad + '" x2="' + (Wd - pad) + '" y1="56" y2="56" class="axis"/>' + ticks.join('') +
        (todayX ? '<line x1="' + todayX + '" x2="' + todayX + '" y1="8" y2="56" class="today"/>' : '') + dots.join('') + '</svg>';
      if (note) note.textContent = st.basis === 'deadline' ? L.noDate(noDate) : '';
      list.sort(function (a, b) { var da = dateOf(a, st.basis), db = dateOf(b, st.basis); return da < db ? -1 : da > db ? 1 : a.id - b.id; });
      opts.onChange(list, st);
    }
    function on(sel, ev, fn) { Array.prototype.forEach.call(root.querySelectorAll(sel), function (el) { el.addEventListener(ev, function () { fn(el); }); }); }
    f.addEventListener('input', function () { st.from = Math.min(+f.value, st.to); draw(); });
    t.addEventListener('input', function () { st.to = Math.max(+t.value, st.from); draw(); });
    Array.prototype.forEach.call(root.querySelectorAll('[name=basis]'), function (r) { r.checked = r.value === st.basis; });
    Array.prototype.forEach.call(root.querySelectorAll('[name=type]'), function (r) { r.checked = r.value === st.type; });
    on('[name=basis]', 'change', function (r) { st.basis = r.value; draw(); });
    on('[name=type]', 'change', function (r) { st.type = r.value; draw(); });
    on('[data-step]', 'click', function (b) { var yy = Math.floor(st.from / 12) + +b.getAttribute('data-step'); st.from = yy * 12; st.to = yy * 12 + 11; draw(); });
    on('[data-preset]', 'click', function (b) { if (b.getAttribute('data-preset') === 'all') { st.from = lo; st.to = hi; } else { st.from = y * 12; st.to = y * 12 + 11; } draw(); });
    on('details', 'toggle', function () { draw(); });
    var rt; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(draw, 150); });
    root.hidden = false;
    draw();
  }

  // Topic page: what an empty list means under the current country filter.
  function emptyText(country) { return country ? L.noneCountry(L.country(country)) : L.none; }

  var S = { emptyText: emptyText, lab: lab, typeOf: typeOf, L: L, lang: lang, ORDER: ORDER, fmt: fmt, esc: esc, rows: rows, groups: groups, cards: cards, count: count,
    donut: donut, legend: legend, bar: bar, countsText: countsText, timeline: timeline, nameAttr: nameAttr, swatch: swatch, injectDefs: injectDefs };
  window.KVStats = S;

  // ---------- Home: timeline of the current year with cards ----------
  function initHome() {
    var out = document.getElementById('cards');
    S.timeline(document.getElementById('tl'), {
      items: KV().items, basis: 'deadline',
      onChange: function (list, st) { S.cards(out, list, st.basis); }
    });
  }

  // ---------- Subject page: donut + legend, topics, period, item list ----------
  function initSubject(main) {
    var sid = +main.getAttribute('data-subject');
    var mine = KV().items.filter(function (it) { return it.s === sid; });
    var st = { verdict: null, domain: null, inTime: mine };
    var donutEl = document.getElementById('donut'), legendEl = document.getElementById('legend');
    var topicsEl = document.getElementById('topics'), rowsEl = document.getElementById('rows');
    var stateEl = document.getElementById('filter-state'), resetEl = document.getElementById('reset');

    function render() {
      var base = st.inTime;
      var inTopic = st.domain ? base.filter(function (it) { return it.domain === st.domain; }) : base;
      var c = S.count(inTopic);
      S.donut(donutEl, c);
      S.legend(legendEl, c, function (v) { st.verdict = st.verdict === v ? null : v; render(); }, st.verdict);

      var by = {};
      base.forEach(function (it) { by[it.domain] = (by[it.domain] || 0) + 1; });
      var doms = Object.keys(by).sort(function (a, b) { return S.L.d[a].localeCompare(S.L.d[b], S.lang); });
      var max = Math.max.apply(null, doms.map(function (d) { return by[d]; }).concat([1]));
      topicsEl.innerHTML = doms.map(function (d) {
        return '<li><button type="button" class="pick" data-d="' + d + '" aria-pressed="' + (st.domain === d) + '"><span>' + S.esc(S.L.d[d]) +
          '</span><span class="n">' + by[d] + '</span><span class="tbar" style="width:' + (100 * by[d] / max) + '%" aria-hidden="true"></span></button></li>';
      }).join('');
      Array.prototype.forEach.call(topicsEl.querySelectorAll('button'), function (b) {
        b.addEventListener('click', function () { var d = b.getAttribute('data-d'); st.domain = st.domain === d ? null : d; render(); });
      });

      var list = inTopic.filter(function (it) { return !st.verdict || it.verdict === st.verdict; });
      S.groups(rowsEl, list, inTopic);
      var parts = [];
      if (st.domain) parts.push(S.L.d[st.domain]);
      if (st.verdict) parts.push(S.lab(st.verdict));
      stateEl.textContent = S.L.items(list.length) + (parts.length ? ' · ' + parts.join(' · ') : '');
      resetEl.hidden = !parts.length;
    }
    resetEl.addEventListener('click', function () { st.verdict = null; st.domain = null; render(); });
    S.timeline(document.getElementById('tl'), {
      items: mine, basis: 'said', all: true,
      onChange: function (list) { st.inTime = list; render(); }
    });
  }

  // ---------- Topic page: everyone side by side on one shared scale ----------
  function initTopic(main) {
    var sel = document.getElementById('topic'), ctry = document.getElementById('country');
    var peopleEl = document.getElementById('people'), emptyEl = document.getElementById('nobody');
    var rowsEl = document.getElementById('rows'), stateEl = document.getElementById('filter-state'), resetEl = document.getElementById('reset');
    var tableEl = document.getElementById('table'), keyEl = document.getElementById('key');
    var st = { domain: main.getAttribute('data-domain'), country: '', sort: 'name', person: null, inTime: KV().items };
    var subjects = KV().subjects;

    sel.addEventListener('change', function () { location.href = root() + lang + '/topic/' + sel.value + '/'; });
    ctry.addEventListener('change', function () { st.country = ctry.value; st.person = null; render(); });
    Array.prototype.forEach.call(document.querySelectorAll('[name=sort]'), function (r) {
      r.addEventListener('change', function () { st.sort = r.value; render(); });
    });
    resetEl.addEventListener('click', function () { st.person = null; render(); });
    S.injectDefs();
    keyEl.innerHTML = S.ORDER.map(function (v) { return '<li>' + S.swatch(v) + '<span>' + S.esc(S.lab(v)) + '</span></li>'; }).join('');

    function render() {
      var inTopic = st.inTime.filter(function (it) { return it.domain === st.domain; });
      var withItems = [], without = [];
      Object.keys(subjects).forEach(function (k) {
        var s = subjects[k]; if (st.country && s.country !== st.country) return;
        var its = inTopic.filter(function (it) { return it.s === s.id; });
        (its.length ? withItems : without).push({ s: s, c: S.count(its) });
      });
      withItems.sort(function (a, b) {
        if (st.sort === 'items' && b.c.total !== a.c.total) return b.c.total - a.c.total;
        return a.s.name.localeCompare(b.s.name, S.lang) || a.s.id - b.s.id;
      });
      without.sort(function (a, b) { return a.s.name.localeCompare(b.s.name, S.lang) || a.s.id - b.s.id; });
      var max = Math.max.apply(null, withItems.map(function (p) { return p.c.total; }).concat([1]));

      peopleEl.innerHTML = withItems.map(function (p) {
        return '<li><button type="button" class="pick" data-s="' + p.s.id + '" aria-pressed="' + (st.person === p.s.id) + '">' +
          '<span><span class="who">' + S.esc(p.s.name) + '</span> <span class="muted">· ' + S.esc(L.country(p.s.country)) + '</span></span>' +
          '<span class="n">' + L.items(p.c.total) + '</span>' + S.bar(p.c, max) +
          '<span class="ctext">' + S.esc(S.countsText(p.c)) + '</span></button></li>';
      }).join('') || '<li class="empty">' + S.esc(emptyText(st.country)) + '</li>';
      Array.prototype.forEach.call(peopleEl.querySelectorAll('button[data-s]'), function (b) {
        b.addEventListener('click', function () { var id = +b.getAttribute('data-s'); st.person = st.person === id ? null : id; render(); });
      });
      emptyEl.textContent = without.length && !(st.country && !withItems.length) ? L.noneTopic + without.map(function (p) { return p.s.name; }).join(', ') + '.' : '';

      tableEl.innerHTML = '<table><thead><tr><th scope="col"></th>' + S.ORDER.map(function (v) { return '<th scope="col">' + S.esc(S.lab(v)) + '</th>'; }).join('') +
        '</tr></thead><tbody>' + withItems.map(function (p) {
          return '<tr><th scope="row">' + S.esc(p.s.name) + '</th>' + S.ORDER.map(function (v) { return '<td class="num">' + p.c[v] + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody></table>';

      var list = inTopic.filter(function (it) { return (!st.person || it.s === st.person) && (!st.country || subjects[it.s].country === st.country); });
      S.rows(rowsEl, list, true, emptyText(st.country));
      stateEl.textContent = L.items(list.length) + ' · ' + L.d[st.domain] + (st.person ? ' · ' + subjects[st.person].name : '');
      resetEl.hidden = !st.person;
    }

    S.timeline(document.getElementById('tl'), {
      items: KV().items, basis: 'said', all: true,
      onChange: function (list) { st.inTime = list; render(); }
    });
  }

  // ---------- Loader: read index.json, then start the view this page asks for ----------
  document.addEventListener('DOMContentLoaded', function () {
    var main = document.querySelector('main[data-view]');
    if (!main || typeof fetch !== 'function') return;
    fetch(root() + lang + '/index.json').then(function (r) {
      if (!r.ok) throw new Error('index.json ' + r.status);
      return r.json();
    }).then(function (data) {
      window.KV = data;
      var view = main.getAttribute('data-view');
      if (view === 'home') initHome();
      else if (view === 'subject') initSubject(main);
      else if (view === 'topic') initTopic(main);
    }).catch(function () { /* the printed lists stay; nothing else to do */ });
  });
})();
