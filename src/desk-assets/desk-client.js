// Review desk, browser side: keyboard shortcuts, the per-item timer, the 5-second confirmation
// countdown, and the writes (always with the desk token in a header; the server refuses anything else).
//
// The token arrives once in the address printed in the terminal, after '#': a fragment is never sent
// to the server and never appears in a Referer. It is moved into this tab's sessionStorage and the
// address is cleaned at once.
//
// After C the server holds a pending confirmation and tells only this page its id. The next item is
// fetched and swapped into this same page, so the countdown keeps running here; after 5 seconds this
// page asks the server to write it. If the page is closed or reloaded meanwhile, nobody asks and the
// server writes nothing (design §5.3).
(() => {
  'use strict';
  const KEY = 'kanverify-desk-token';
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('token')) {
    sessionStorage.setItem(KEY, fragment.get('token'));
    history.replaceState(null, '', location.pathname + location.search);
  }
  const token = sessionStorage.getItem(KEY);

  let seconds = 0;
  let lastActivity = Date.now();
  let openPanel = null;
  let busy = false;
  let pendingConfirm = null; // { id, claimId, timer, tick, due }

  const $ = (sel) => document.querySelector(sel);
  function toast(text, { error = false } = {}) {
    const box = $('#toasts');
    if (!box) return;
    if (error) {
      const e = $('#error');
      e.textContent = text;
      e.hidden = false;
      return;
    }
    const p = document.createElement('p');
    p.className = 'toast';
    p.setAttribute('role', 'status');
    p.textContent = text;
    box.prepend(p);
    return p;
  }

  // ---- timer: counts only while the page is in front and someone did something in the last 120 s
  for (const ev of ['keydown', 'mousemove', 'mousedown', 'wheel', 'touchstart', 'scroll']) {
    addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
  }
  setInterval(() => {
    if (document.hidden || Date.now() - lastActivity > 120_000) return;
    seconds += 1;
    const timer = $('#timer');
    if (timer) timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);

  // ---- requests
  async function post(path, data) {
    if (!token) return { error: 'This tab has no desk token. Open the address printed in the terminal.' };
    if (busy) return null;
    busy = true;
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Desk-Token': token },
        body: JSON.stringify(data),
        credentials: 'omit',
      });
      const json = await res.json();
      return json.ok ? json : { error: json.error, next: json.next };
    } catch (e) {
      return { error: `The desk did not answer (${e.message}). Nothing was written.` };
    } finally {
      busy = false;
    }
  }

  /** Shows another page of the desk without leaving this one, so a pending confirmation keeps its page. */
  async function fetchPage(url) {
    // The server cancels a pending confirmation on any page load that is not from the view that pressed C.
    const headers = pendingConfirm ? { 'X-Desk-View': pendingConfirm.id } : {};
    const res = await fetch(url, { credentials: 'omit', headers });
    return new DOMParser().parseFromString(await res.text(), 'text/html');
  }
  async function go(url, { push = true, keepTimer = false } = {}) {
    try {
      const doc = await fetchPage(url);
      document.title = doc.title;
      document.body.replaceWith(document.adoptNode(doc.body));
      // History grows only when the address changes.
      const here = location.pathname + location.search;
      if (push && url !== here) history.pushState(null, '', url);
      else if (push) history.replaceState(null, '', url);
      init({ keepTimer });
    } catch (e) {
      toast(`The desk did not answer (${e.message}).`, { error: true });
    }
  }
  /**
   * After a confirmation ends: fresh header ("Today"), toasts and blockers for the item on screen.
   * The whole page is redrawn unless a panel is open or a field has focus; then only header and toasts.
   */
  async function refresh() {
    const url = location.pathname + location.search;
    if (!openPanel && !typing(document.activeElement)) return go(url, { keepTimer: true });
    try {
      const doc = await fetchPage(url);
      for (const sel of ['header.desk-head', '#toasts']) {
        const fresh = doc.querySelector(sel);
        if (fresh) $(sel)?.replaceWith(document.adoptNode(fresh));
      }
      for (const a of document.querySelectorAll('.tabs a')) a.addEventListener('click', (ev) => { ev.preventDefault(); go(a.getAttribute('href')); });
    } catch (e) {
      toast(`The desk did not answer (${e.message}).`, { error: true });
    }
  }
  addEventListener('popstate', () => go(location.pathname + location.search, { push: false }));

  async function act(data, form = null) {
    const r = await post('/api/action', { queue: document.body.dataset.queue, item: document.body.dataset.item, seconds, ...data });
    if (!r) return;
    if (r.error) {
      const slot = form?.querySelector('.form-error');
      if (slot) { slot.textContent = r.error; slot.hidden = false; } else toast(r.error, { error: true });
      return;
    }
    if (r.pending) startCountdown(r.pending);
    await go(r.next);
  }

  async function undo() {
    if (pendingConfirm) stopCountdown();
    const r = await post('/api/undo', {});
    if (!r) return;
    if (r.error) toast(r.error, { error: true });
    else await go(r.next);
  }

  function stopCountdown() {
    clearTimeout(pendingConfirm.timer);
    clearInterval(pendingConfirm.tick);
    pendingConfirm.el?.remove();
    pendingConfirm = null;
  }
  function startCountdown({ id, ms, claimId }) {
    const due = Date.now() + ms;
    pendingConfirm = { id, claimId, due };
    const render = () => {
      if (!pendingConfirm) return;
      const left = Math.max(0, Math.ceil((due - Date.now()) / 1000));
      const text = `Item #${claimId} will be written to the ledger in ${left} s. Z to cancel (nothing will be written)`;
      if (!pendingConfirm.el || !pendingConfirm.el.isConnected) pendingConfirm.el = toast(text);
      else pendingConfirm.el.textContent = text;
    };
    pendingConfirm.render = render;
    pendingConfirm.tick = setInterval(render, 250);
    pendingConfirm.timer = setTimeout(async () => {
      const mine = pendingConfirm;
      if (!mine || mine.id !== id) return;
      clearInterval(mine.tick);
      mine.el?.remove();
      pendingConfirm = null;
      // Wait for any other request of this page to finish, then ask once.
      while (busy) await new Promise((r) => setTimeout(r, 50));
      const r = await post('/api/commit', { id });
      if (!r) return;
      if (r.error) {
        if (r.next) await go(r.next);
        toast(r.error, { error: true });
        return;
      }
      // Redraw first (it drops every older toast and any stale blocker), then say what happened.
      await refresh();
      // The verdict page already shows the server's toast; elsewhere (the founder switched queue) say it here.
      if (!$('#toasts')?.textContent.includes(r.toast)) toast(r.toast);
    }, ms + 200);
  }

  // ---- panels
  function open(id) {
    if (id.startsWith('toggle:')) {
      const d = document.getElementById(id.slice(7));
      if (d) d.open = !d.open;
      return;
    }
    const p = document.getElementById(id);
    if (!p) return;
    if (openPanel) openPanel.hidden = true;
    p.hidden = false;
    openPanel = p;
    if (!p.querySelector('input[type=radio]')) p.querySelector('input, textarea, select')?.focus();
    p.scrollIntoView({ block: 'nearest' });
  }
  function close() {
    if (openPanel) openPanel.hidden = true;
    openPanel = null;
  }
  function submit(form) {
    const data = new FormData(form);
    const action = form.dataset.action;
    if (form.classList.contains('reasons')) {
      act({ action, reason: Number(data.get('reason')), note: String(data.get('note') ?? '') }, form);
    } else {
      const fields = {};
      for (const [k, v] of data.entries()) fields[k] = String(v);
      act({ action, fields }, form);
    }
  }

  /** Wires up the page that is showing: buttons, forms, the timer, the marked quote. */
  function init({ keepTimer = false } = {}) {
    if (!keepTimer) seconds = 0;
    openPanel = null;
    for (const form of document.querySelectorAll('form.dialog')) {
      form.addEventListener('submit', (ev) => { ev.preventDefault(); submit(form); });
    }
    for (const b of document.querySelectorAll('button[data-key]')) {
      b.addEventListener('click', () => {
        if (b.disabled) return;
        if (b.hasAttribute('data-undo')) return undo();
        if (b.dataset.href) return go(b.dataset.href);
        if (b.dataset.open) return open(b.dataset.open);
        if (b.dataset.act === 'adopt') return act({ action: 'adopt', vote: Number(b.dataset.vote) });
        if (b.dataset.act) return act({ action: b.dataset.act });
      });
    }
    for (const a of document.querySelectorAll('.tabs a')) {
      a.addEventListener('click', (ev) => { ev.preventDefault(); go(a.getAttribute('href')); });
    }
    if (pendingConfirm) { pendingConfirm.el = null; pendingConfirm.render(); }
    const mark = document.querySelector('.source-text mark');
    if (mark) {
      const box = mark.closest('.source-text');
      box.scrollTop = Math.max(0, mark.offsetTop - box.offsetTop - box.clientHeight / 3);
    }
  }

  // ---- keys (not while typing in a field)
  const typing = (t) => t instanceof HTMLElement && (t.isContentEditable || (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName) && t.type !== 'radio'));
  addEventListener('keydown', (ev) => {
    if (openPanel) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (openPanel.tagName === 'FORM' && openPanel.classList.contains('reasons')) {
        if (/^[1-4]$/.test(ev.key) && !typing(ev.target)) {
          ev.preventDefault();
          const r = openPanel.querySelector(`input[type=radio][value="${ev.key}"]`);
          if (r) { r.checked = true; openPanel.querySelector('input[type=text]')?.focus(); }
          return;
        }
        if (ev.key === 'Enter') { ev.preventDefault(); submit(openPanel); }
        return;
      }
      if (openPanel.tagName === 'FORM' && ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); submit(openPanel); }
      return;
    }
    if (typing(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === ' ') {
      const src = $('.source-text');
      if (src) { ev.preventDefault(); src.scrollBy({ top: src.clientHeight * 0.8 }); }
      return;
    }
    if (ev.key.toLowerCase() === 'o') {
      const a = $('#open-original');
      if (a) { ev.preventDefault(); a.click(); }
      return;
    }
    const k = ev.key === '?' ? '?' : ev.key.toLowerCase();
    const b = document.querySelector(`button[data-key="${CSS.escape(k)}"]`);
    if (b) { ev.preventDefault(); if (!b.disabled) b.click(); }
  });

  init();
})();
