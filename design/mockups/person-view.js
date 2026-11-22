// Person page: donut + legend (verdict filter), topics (topic filter), timeline (period filter), and the
// items grouped by where they were said (source document + role), oldest first, six counts per block.
// The page passes the subject id in <main data-subject>. All counts come from the same current list.
document.addEventListener('DOMContentLoaded', function () {
  var S = window.KVStats, main = document.querySelector('main[data-subject]');
  var sid = +main.getAttribute('data-subject');
  var mine = KV.items.filter(function (it) { return it.s === sid; });
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
});
