// Topic page: everyone side by side for one topic, counts on one shared scale, a neutral sort the reader
// switches (name or number of items, never a verdict). Tap a person to list their items. No percentages.
document.addEventListener('DOMContentLoaded', function () {
  var S = window.KVStats, L = S.L;
  var sel = document.getElementById('topic'), ctry = document.getElementById('country');
  var peopleEl = document.getElementById('people'), emptyEl = document.getElementById('nobody');
  var rowsEl = document.getElementById('rows'), stateEl = document.getElementById('filter-state'), resetEl = document.getElementById('reset');
  var tableEl = document.getElementById('table'), keyEl = document.getElementById('key');
  var st = { domain: 'transport', country: '', sort: 'name', person: null, inTime: KV.items };

  // All 20 topics, each with its number of items; empty topics stay listed.
  sel.innerHTML = Object.keys(L.d).sort(function (a, b) { return L.d[a].localeCompare(L.d[b], S.lang); }).map(function (d) {
    var n = KV.items.filter(function (it) { return it.domain === d; }).length;
    return '<option value="' + d + '"' + (d === st.domain ? ' selected' : '') + '>' + S.esc(L.d[d]) + ' (' + n + ')</option>';
  }).join('');
  sel.addEventListener('change', function () { st.domain = sel.value; st.person = null; render(); });
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
    Object.keys(KV.subjects).forEach(function (k) {
      var s = KV.subjects[k]; if (st.country && s.country !== st.country) return;
      var its = inTopic.filter(function (it) { return it.s === s.id; });
      (its.length ? withItems : without).push({ s: s, c: S.count(its) });
    });
    withItems.sort(function (a, b) {
      if (st.sort === 'items' && b.c.total !== a.c.total) return b.c.total - a.c.total;
      return a.s.name.localeCompare(b.s.name, S.lang);
    });
    var max = Math.max.apply(null, withItems.map(function (p) { return p.c.total; }).concat([1]));

    peopleEl.innerHTML = withItems.map(function (p) {
      return '<li><button type="button" class="pick" data-s="' + p.s.id + '" aria-pressed="' + (st.person === p.s.id) + '">' +
        '<span><span class="who"' + S.nameAttr(p.s) + '>' + S.esc(p.s.name) + '</span> <span class="muted">· ' + L.c[p.s.country] + '</span></span>' +
        '<span class="n">' + L.items(p.c.total) + '</span>' + S.bar(p.c, max) +
        '<span class="ctext">' + S.esc(S.countsText(p.c)) + '</span></button></li>';
    }).join('') || '<li class="empty">' + L.none + '</li>';
    Array.prototype.forEach.call(peopleEl.querySelectorAll('button[data-s]'), function (b) {
      b.addEventListener('click', function () { var id = +b.getAttribute('data-s'); st.person = st.person === id ? null : id; render(); });
    });
    emptyEl.textContent = without.length ? (S.lang === 'fr' ? 'Aucune fiche sur ce thème : ' : 'No items on this topic: ') + without.map(function (p) { return p.s.name; }).join(', ') + '.' : '';

    tableEl.innerHTML = '<table><thead><tr><th scope="col"></th>' + S.ORDER.map(function (v) { return '<th scope="col">' + S.esc(S.lab(v)) + '</th>'; }).join('') +
      '</tr></thead><tbody>' + withItems.map(function (p) {
        return '<tr><th scope="row"' + S.nameAttr(p.s) + '>' + S.esc(p.s.name) + '</th>' + S.ORDER.map(function (v) { return '<td class="num">' + p.c[v] + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table>';

    var list = inTopic.filter(function (it) { return (!st.person || it.s === st.person) && (!st.country || KV.subjects[it.s].country === st.country); });
    S.rows(rowsEl, list, true);
    stateEl.textContent = L.items(list.length) + ' · ' + L.d[st.domain] + (st.person ? ' · ' + KV.subjects[st.person].name : '');
    resetEl.hidden = !st.person;
  }

  S.timeline(document.getElementById('tl'), {
    items: KV.items, basis: 'said', all: true,
    onChange: function (list) { st.inTime = list; render(); }
  });
});
