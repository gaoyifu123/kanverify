// Theme switch for the mockups. Default follows the system; the button forces the other theme.
// Reading the site never depends on this script.
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem('kv-theme'); } catch (e) {}
  if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  function current() {
    var t = root.getAttribute('data-theme');
    if (t) return t;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // A link to something inside a closed detail row (#ev-1042-1) opens that row.
  function openTarget() {
    var id = decodeURIComponent(location.hash.slice(1)); if (!id) return;
    var el = document.getElementById(id);
    while (el) { if (el.tagName === 'DETAILS') el.open = true; el = el.parentElement; }
  }
  window.addEventListener('hashchange', openTarget);

  document.addEventListener('DOMContentLoaded', function () {
    openTarget();
    var btn = document.querySelector('[data-theme-toggle]');
    if (!btn) return;
    btn.hidden = false;
    function label() {
      var dark = current() === 'dark';
      btn.setAttribute('aria-pressed', dark ? 'true' : 'false');
    }
    label();
    btn.addEventListener('click', function () {
      var next = current() === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('kv-theme', next); } catch (e) {}
      label();
    });
  });
})();
