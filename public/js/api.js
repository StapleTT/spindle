/**
 * api.js — Centralised fetch wrapper for all Spindle API calls.
 *
 * Usage:
 *   const data = await API.get('/api/accounts');
 *   const data = await API.post('/api/auth/login', { username, password });
 */

const API = (() => {
  let _csrf = null;

  async function request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (_csrf && method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      headers['X-CSRF-Token'] = _csrf;
    }
    const opts = { method, headers, credentials: 'same-origin' };
    if (body !== undefined) opts.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      Toast.show('Network error — check your connection', 'err');
      throw err;
    }

    // Session expired
    if (res.status === 401) {
      location.href = '/auth';
      throw new Error('Not authenticated');
    }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = data.error || `Error ${res.status}`;
      throw Object.assign(new Error(msg), { status: res.status, data });
    }

    return data;
  }

  return {
    setCSRF: (token) => { _csrf = token; },
    getCSRF: ()      => _csrf || '',
    get:    (url)       => request('GET',    url),
    post:   (url, body) => request('POST',   url, body),
    patch:  (url, body) => request('PATCH',  url, body),
    delete: (url, body) => request('DELETE', url, body),
  };
})();

/* ── Custom select component ──────────────────────────────────────── */
/**
 * CustomSelect.create(options, initialValue, opts)
 *
 * Builds a fully custom, site-styled dropdown — no native <select>.
 *
 * @param {Array}  options      — [{ value, label }]
 * @param {string} initial      — initially selected value
 * @param {object} [cfg]
 *   cfg.borderless {bool}  — remove outer border (for compose-row context)
 *   cfg.onChange   {fn}    — called with new value on selection
 *
 * @returns {{ el, getValue(), setValue(v) }}
 */
const CustomSelect = (() => {
  // Close all open dropdowns (called on outside click)
  document.addEventListener('click', () => {
    document.querySelectorAll('.cs-wrap.open').forEach(w => w.classList.remove('open'));
  });

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function create(options, initial, cfg = {}) {
    let current = initial !== undefined ? String(initial) : String(options[0]?.value ?? '');
    const onChange = cfg.onChange || null;

    // ── Elements ──────────────────────────────────────────────────
    const wrap = document.createElement('div');
    wrap.className = 'cs-wrap' + (cfg.borderless ? ' cs-borderless' : '');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'cs-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    const triggerLabel = document.createElement('span');
    triggerLabel.className = 'cs-label';

    const arrow = document.createElement('span');
    arrow.className = 'cs-arrow';
    arrow.setAttribute('aria-hidden', 'true');

    trigger.appendChild(triggerLabel);
    trigger.appendChild(arrow);

    const dropdown = document.createElement('div');
    dropdown.className = 'cs-dropdown';
    dropdown.setAttribute('role', 'listbox');

    // ── Options ───────────────────────────────────────────────────
    const optEls = options.map(opt => {
      const item = document.createElement('div');
      item.className = 'cs-option';
      item.setAttribute('role', 'option');
      item.dataset.value = String(opt.value);
      item.textContent = opt.label;
      item.addEventListener('click', e => {
        e.stopPropagation();
        setValue(String(opt.value));
        wrap.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.focus();
        if (onChange) onChange(current);
      });
      dropdown.appendChild(item);
      return item;
    });

    // ── Toggle open/close ─────────────────────────────────────────
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      const opening = !wrap.classList.contains('open');
      // Close any other open selects first
      document.querySelectorAll('.cs-wrap.open').forEach(w => {
        w.classList.remove('open');
        w.querySelector('.cs-trigger')?.setAttribute('aria-expanded', 'false');
      });
      if (opening) {
        wrap.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
        // Scroll selected option into view
        const sel = dropdown.querySelector('.cs-option.cs-selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      }
    });

    // Keyboard navigation
    trigger.addEventListener('keydown', e => {
      const isOpen = wrap.classList.contains('open');
      if (e.key === 'Escape' && isOpen) {
        e.stopPropagation();
        wrap.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
      if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !isOpen) {
        e.preventDefault();
        wrap.classList.add('open');
        trigger.setAttribute('aria-expanded', 'true');
      }
      if (e.key === 'ArrowDown' && isOpen) {
        e.preventDefault();
        const cur = options.findIndex(o => o.value == current);
        const next = options[Math.min(cur + 1, options.length - 1)];
        if (next) { setValue(String(next.value)); if (onChange) onChange(current); }
      }
      if (e.key === 'ArrowUp' && isOpen) {
        e.preventDefault();
        const cur = options.findIndex(o => o.value == current);
        const prev = options[Math.max(cur - 1, 0)];
        if (prev) { setValue(String(prev.value)); if (onChange) onChange(current); }
      }
    });

    wrap.appendChild(trigger);
    wrap.appendChild(dropdown);

    // ── setValue / getValue ───────────────────────────────────────
    function setValue(v) {
      current = String(v);
      const opt = options.find(o => String(o.value) === current);
      triggerLabel.textContent = opt ? opt.label : current;
      optEls.forEach(el => {
        el.classList.toggle('cs-selected', el.dataset.value === current);
        el.setAttribute('aria-selected', el.dataset.value === current);
      });
    }

    setValue(current); // initialise display

    return {
      el: wrap,
      getValue() { return current; },
      setValue,
    };
  }

  return { create };
})();

/* ── Avatar helper ────────────────────────────────────────────────── */
// Renders a circular initials avatar. Gravatar was removed: the d=404
// fallback returns a text/html 404 that Firefox's ORB blocks, and the
// onerror attribute is blocked by script-src-attr 'none'. Initials are
// consistent, require no external requests, and carry no privacy concern.
const Avatar = (() => {
  const COLORS = ['#5b7fa6','#7a6ea6','#6ea69a','#a67c6e','#7aa672','#a6a26e','#a66e8a','#6e8aa6'];

  function _color(label) {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) & 0xffff;
    return COLORS[h % COLORS.length];
  }

  function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Returns HTML for a circular initials avatar.
  // cls: 'avatar' (28px) | 'avatar avatar-sm' (20px) | 'avatar avatar-row' (16px)
  function html(name, addr, cls) {
    cls = cls || 'avatar';
    const label  = (name || addr || '?').trim();
    const letter = (label[0] || '?').toUpperCase();
    const color  = _color(label);
    return `<span class="${cls}" style="background:${color}">${_esc(letter)}</span>`;
  }

  return { html };
})();

/* ── Toast notification system ────────────────────────────────────── */
const Toast = (() => {
  let container = null;

  function getContainer() {
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function show(message, kind = '') {
    const el = document.createElement('div');
    el.className = `toast ${kind ? 'toast-' + kind : ''}`;
    const dot = document.createElement('span');
    dot.className = 'toast-dot';
    const msg = document.createElement('span');
    msg.textContent = String(message);
    el.appendChild(dot);
    el.appendChild(msg);
    getContainer().appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }

  return { show };
})();
