// Verification Mode для Label Studio — кастомизация поверх native LS UI.
//
// Что делает:
//   1. Добавляет toggle-кнопку справа сверху: "Verif OFF" / "✓ Verif ON".
//   2. При Verif ON клик по карточке в grid:
//      - НЕ открывает editor (preventDefault + stopPropagation на capture phase),
//      - вместо этого помечает task как rejected (создаёт cancelled annotation
//        через POST /api/tasks/{id}/annotations/),
//      - визуально: dim + red badge на карточке.
//   3. Второй клик по rejected карточке = удаляет annotation (восстанавливает).
//   4. State per-project в localStorage — настройка живёт между сессиями.
//
// Загружается через nginx-overlay sub_filter на каждой странице LS.

(function () {
  'use strict';
  if (window.__carsVerifInstalled) return;
  window.__carsVerifInstalled = true;
  console.log('[verif-mode] loaded');

  const STORAGE_KEY = 'cars-verification-mode';
  const state = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  // shape: { "<projectId>": { enabled: bool, rejected: {taskId: annotationId} } }

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function projectId() {
    const m = location.pathname.match(/\/projects\/(\d+)/);
    return m ? m[1] : null;
  }

  function projState() {
    const pid = projectId();
    if (!pid) return null;
    if (!state[pid]) state[pid] = { enabled: false, rejected: {} };
    if (!state[pid].rejected) state[pid].rejected = {};
    return state[pid];
  }

  // ============================================================
  //  CSS — visual marker + toggle button
  // ============================================================
  const STYLE_ID = 'verif-mode-styles';
  if (!document.getElementById(STYLE_ID)) {
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      .verif-rejected {
        position: relative;
        opacity: 0.4 !important;
        filter: grayscale(0.6) !important;
        transition: opacity .15s ease, filter .15s ease !important;
      }
      .verif-rejected::after {
        content: '✕ ВЫКИНУТЬ';
        position: absolute;
        top: 6px; right: 6px;
        background: oklch(0.55 0.2 28);
        color: white;
        font: 600 10px/1 system-ui, sans-serif;
        padding: 3px 7px;
        border-radius: 4px;
        z-index: 1000;
        pointer-events: none;
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
      }
      body.verif-mode-on [class*="grid-view"] [class*="cell"]:not(.verif-rejected) {
        cursor: pointer !important;
      }
      body.verif-mode-on [class*="grid-view"] [class*="cell"]:not(.verif-rejected):hover {
        outline: 2px solid oklch(0.78 0.13 195) !important;
        outline-offset: -2px;
      }
      #verif-toggle {
        position: fixed;
        top: 12px; right: 280px;
        z-index: 2147483647;
        background: #555;
        color: white;
        border: none;
        padding: 6px 14px;
        border-radius: 6px;
        font: 600 12px/1 system-ui, -apple-system, sans-serif;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        transition: background .15s ease;
      }
      #verif-toggle.on {
        background: oklch(0.55 0.2 28);
      }
      #verif-toast {
        position: fixed;
        bottom: 24px; left: 50%;
        transform: translateX(-50%);
        background: oklch(0.18 0.02 240);
        color: white;
        padding: 8px 16px;
        border-radius: 6px;
        font: 500 12px/1 system-ui, sans-serif;
        z-index: 2147483647;
        box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        animation: verif-toast-in .15s ease;
      }
      @keyframes verif-toast-in {
        from { opacity: 0; transform: translate(-50%, 8px); }
        to { opacity: 1; transform: translate(-50%, 0); }
      }
    `;
    document.head.appendChild(s);
  }

  function toast(msg, ms = 1500) {
    document.querySelectorAll('#verif-toast').forEach(t => t.remove());
    const t = document.createElement('div');
    t.id = 'verif-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // ============================================================
  //  API via LS session cookie (no token in code)
  // ============================================================
  async function api(method, path, body) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const m = document.cookie.match(/csrftoken=([^;]+)/);
    if (m) opts.headers['X-CSRFToken'] = m[1];
    const r = await fetch(path, opts);
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`${method} ${path} -> ${r.status}: ${txt.slice(0, 120)}`);
    }
    if (r.status === 204) return null;
    return r.json();
  }

  async function rejectTask(taskId) {
    const resp = await api('POST', `/api/tasks/${taskId}/annotations/`, {
      result: [],
      was_cancelled: true,
      ground_truth: false,
      lead_time: 0,
    });
    return resp.id;
  }

  async function unrejectTask(annotationId) {
    await api('DELETE', `/api/annotations/${annotationId}/`);
  }

  // ============================================================
  //  Toggle button
  // ============================================================
  function ensureToggle() {
    const ps = projState();
    if (!ps) {
      document.querySelector('#verif-toggle')?.remove();
      document.body.classList.remove('verif-mode-on');
      return;
    }
    let btn = document.querySelector('#verif-toggle');
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'verif-toggle';
      btn.onclick = () => {
        const s = projState();
        s.enabled = !s.enabled;
        persist();
        updateToggleVisual();
        toast(s.enabled
          ? `Verif ON — клик = выкинуть (project ${projectId()})`
          : 'Verif OFF — клик открывает editor (native)');
        if (s.enabled) markExistingRejected();
        else document.querySelectorAll('.verif-rejected').forEach(e => e.classList.remove('verif-rejected'));
      };
      document.body.appendChild(btn);
    }
    updateToggleVisual();
  }

  function updateToggleVisual() {
    const btn = document.querySelector('#verif-toggle');
    if (!btn) return;
    const s = projState();
    btn.textContent = s.enabled ? '✓ Verif ON' : 'Verif OFF';
    btn.classList.toggle('on', s.enabled);
    document.body.classList.toggle('verif-mode-on', s.enabled);
  }

  // ============================================================
  //  Card detection — finds LS grid cards and their task IDs
  // ============================================================
  function findCardForEvent(target) {
    let el = target;
    while (el && el !== document.body) {
      const header = el.querySelector
        ? el.querySelector('[class*="cell-header"], [class*="cell_header"]')
        : null;
      if (header) {
        const span = header.querySelector('span');
        if (span && /^\d+$/.test(span.textContent.trim())) {
          return { card: el, taskId: parseInt(span.textContent.trim(), 10), header };
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function markRejected(card) { card.classList.add('verif-rejected'); }
  function unmarkRejected(card) { card.classList.remove('verif-rejected'); }

  function markExistingRejected() {
    const s = projState();
    if (!s || !s.enabled) return;
    const ids = s.rejected;
    if (!ids || Object.keys(ids).length === 0) return;
    document.querySelectorAll('[class*="grid-view"] [class*="cell"]').forEach(cellEl => {
      const header = cellEl.querySelector('[class*="cell-header"], [class*="cell_header"]');
      const span = header?.querySelector('span');
      if (!span) return;
      const tid = parseInt(span.textContent.trim(), 10);
      if (ids[tid]) markRejected(cellEl);
    });
  }

  // ============================================================
  //  Click interceptor — capture phase
  // ============================================================
  let busy = false;
  document.addEventListener('click', async function (e) {
    const s = projState();
    if (!s || !s.enabled) return;
    if (e.target.closest('button, input, a, [class*="checkbox"], [role="button"]')) return;

    const found = findCardForEvent(e.target);
    if (!found) return;

    e.preventDefault();
    e.stopImmediatePropagation();
    e.stopPropagation();

    if (busy) return;
    busy = true;
    try {
      const tid = found.taskId;
      const existing = s.rejected[tid];
      if (existing) {
        try { await unrejectTask(existing); } catch (err) { console.warn('unreject:', err); }
        delete s.rejected[tid];
        unmarkRejected(found.card);
        toast(`#${tid}: восстановлен`);
      } else {
        const annId = await rejectTask(tid);
        s.rejected[tid] = annId;
        markRejected(found.card);
        toast(`#${tid}: выкинут`);
      }
      persist();
    } catch (err) {
      console.error('[verif-mode] toggle fail:', err);
      toast('Ошибка: ' + (err.message || err));
    } finally {
      busy = false;
    }
  }, true);

  // ============================================================
  //  Bootstrap + SPA route observer
  // ============================================================
  let lastPath = location.pathname;
  function tick() {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      const s = projState();
      document.body.classList.toggle('verif-mode-on', !!(s && s.enabled));
    }
    if (document.body) {
      ensureToggle();
      markExistingRejected();
    }
  }
  setInterval(tick, 600);
  if (document.body) tick();
  else document.addEventListener('DOMContentLoaded', tick);
})();
