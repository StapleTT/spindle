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

/* ── Avatar / Gravatar helper ─────────────────────────────────────── */
const Avatar = (() => {
  // Compact MD5 (Paul Johnston / Ronald Rivest) — used only for Gravatar hashing
  function _md5(str) {
    function add(x, y) { const l = (x & 0xFFFF) + (y & 0xFFFF); return ((x >> 16) + (y >> 16) + (l >> 16)) << 16 | l & 0xFFFF; }
    function rol(n, s) { return n << s | n >>> (32 - s); }
    function cmn(q, a, b, x, s, t) { return add(rol(add(add(a, q), add(x, t)), s), b); }
    const ff = (a,b,c,d,x,s,t) => cmn(b&c|~b&d, a,b,x,s,t);
    const gg = (a,b,c,d,x,s,t) => cmn(b&d|c&~d, a,b,x,s,t);
    const hh = (a,b,c,d,x,s,t) => cmn(b^c^d,    a,b,x,s,t);
    const ii = (a,b,c,d,x,s,t) => cmn(c^(b|~d), a,b,x,s,t);
    const n = str.length * 8;
    const m = [];
    for (let i = 0; i < str.length; i++) m[i >> 2] = (m[i >> 2] || 0) | (str.charCodeAt(i) & 0xFF) << (i % 4 * 8);
    m[n >> 5] = (m[n >> 5] || 0) | 0x80 << (n % 32);
    m[((n + 64 >> 9) << 4) + 14] = n;
    let [a, b, c, d] = [1732584193, -271733879, -1732584194, 271733878];
    for (let i = 0; i < m.length; i += 16) {
      const [oa,ob,oc,od] = [a,b,c,d];
      a=ff(a,b,c,d,m[i],7,-680876936);    d=ff(d,a,b,c,m[i+1],12,-389564586);
      c=ff(c,d,a,b,m[i+2],17,606105819); b=ff(b,c,d,a,m[i+3],22,-1044525330);
      a=ff(a,b,c,d,m[i+4],7,-176418897); d=ff(d,a,b,c,m[i+5],12,1200080426);
      c=ff(c,d,a,b,m[i+6],17,-1473231341);b=ff(b,c,d,a,m[i+7],22,-45705983);
      a=ff(a,b,c,d,m[i+8],7,1770035416); d=ff(d,a,b,c,m[i+9],12,-1958414417);
      c=ff(c,d,a,b,m[i+10],17,-42063);   b=ff(b,c,d,a,m[i+11],22,-1990404162);
      a=ff(a,b,c,d,m[i+12],7,1804603682);d=ff(d,a,b,c,m[i+13],12,-40341101);
      c=ff(c,d,a,b,m[i+14],17,-1502002290);b=ff(b,c,d,a,m[i+15],22,1236535329);
      a=gg(a,b,c,d,m[i+1],5,-165796510); d=gg(d,a,b,c,m[i+6],9,-1069501632);
      c=gg(c,d,a,b,m[i+11],14,643717713);b=gg(b,c,d,a,m[i],20,-373897302);
      a=gg(a,b,c,d,m[i+5],5,-701558691); d=gg(d,a,b,c,m[i+10],9,38016083);
      c=gg(c,d,a,b,m[i+15],14,-660478335);b=gg(b,c,d,a,m[i+4],20,-405537848);
      a=gg(a,b,c,d,m[i+9],5,568446438);  d=gg(d,a,b,c,m[i+14],9,-1019803690);
      c=gg(c,d,a,b,m[i+3],14,-187363961);b=gg(b,c,d,a,m[i+8],20,1163531501);
      a=gg(a,b,c,d,m[i+13],5,-1444681467);d=gg(d,a,b,c,m[i+2],9,-51403784);
      c=gg(c,d,a,b,m[i+7],14,1735328473);b=gg(b,c,d,a,m[i+12],20,-1926607734);
      a=hh(a,b,c,d,m[i+5],4,-378558);    d=hh(d,a,b,c,m[i+8],11,-2022574463);
      c=hh(c,d,a,b,m[i+11],16,1839030562);b=hh(b,c,d,a,m[i+14],23,-35309556);
      a=hh(a,b,c,d,m[i+1],4,-1530992060);d=hh(d,a,b,c,m[i+4],11,1272893353);
      c=hh(c,d,a,b,m[i+7],16,-155497632);b=hh(b,c,d,a,m[i+10],23,-1094730640);
      a=hh(a,b,c,d,m[i+13],4,681279174); d=hh(d,a,b,c,m[i],11,-358537222);
      c=hh(c,d,a,b,m[i+3],16,-722521979);b=hh(b,c,d,a,m[i+6],23,76029189);
      a=hh(a,b,c,d,m[i+9],4,-640364487); d=hh(d,a,b,c,m[i+12],11,-421815835);
      c=hh(c,d,a,b,m[i+15],16,530742520);b=hh(b,c,d,a,m[i+2],23,-995338651);
      a=ii(a,b,c,d,m[i],6,-198630844);   d=ii(d,a,b,c,m[i+7],10,1126891415);
      c=ii(c,d,a,b,m[i+14],15,-1416354905);b=ii(b,c,d,a,m[i+5],21,-57434055);
      a=ii(a,b,c,d,m[i+12],6,1700485571);d=ii(d,a,b,c,m[i+3],10,-1894986606);
      c=ii(c,d,a,b,m[i+10],15,-1051523); b=ii(b,c,d,a,m[i+1],21,-2054922799);
      a=ii(a,b,c,d,m[i+8],6,1873313359); d=ii(d,a,b,c,m[i+15],10,-30611744);
      c=ii(c,d,a,b,m[i+6],15,-1560198380);b=ii(b,c,d,a,m[i+13],21,1309151649);
      a=ii(a,b,c,d,m[i+4],6,-145523070); d=ii(d,a,b,c,m[i+11],10,-1120210379);
      c=ii(c,d,a,b,m[i+2],15,718787259); b=ii(b,c,d,a,m[i+9],21,-343485551);
      [a,b,c,d] = [add(a,oa),add(b,ob),add(c,oc),add(d,od)];
    }
    let hex = '';
    for (const w of [a,b,c,d]) for (let j = 0; j < 4; j++) hex += ((w >> j*8) & 0xFF).toString(16).padStart(2,'0');
    return hex;
  }

  const COLORS = ['#5b7fa6','#7a6ea6','#6ea69a','#a67c6e','#7aa672','#a6a26e','#a66e8a','#6e8aa6'];

  function _color(label) {
    let h = 0;
    for (let i = 0; i < label.length; i++) h = (h * 31 + label.charCodeAt(i)) & 0xffff;
    return COLORS[h % COLORS.length];
  }

  function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  // Called from onerror attribute on a failed Gravatar img — swaps it for an initials span
  function _fallback(img, letter, color, cls) {
    const span = document.createElement('span');
    span.className = cls;
    span.style.background = color;
    span.textContent = letter;
    img.parentNode?.replaceChild(span, img);
  }

  // Returns HTML for a circular avatar: Gravatar photo if the address has one, else initials.
  // cls controls size: 'avatar' (28px) | 'avatar avatar-sm' (20px) | 'avatar avatar-row' (16px)
  function html(name, addr, cls) {
    cls = cls || 'avatar';
    const label  = (name || addr || '?').trim();
    const letter = (label[0] || '?').toUpperCase();
    const color  = _color(label);
    const email  = (addr || '').trim().toLowerCase();

    if (!email) {
      return `<span class="${cls}" style="background:${color}">${_esc(letter)}</span>`;
    }

    const px   = cls.includes('row') ? 16 : cls.includes('sm') ? 20 : 28;
    const hash = _md5(email);
    const src  = `https://www.gravatar.com/avatar/${hash}?s=${px * 2}&d=404`;
    return `<img class="${cls}" src="${src}" alt="${_esc(letter)}" onerror="Avatar._fallback(this,'${_esc(letter)}','${color}','${cls}')">`;
  }

  return { html, _fallback };
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
    el.innerHTML = `<span class="toast-dot"></span><span>${message}</span>`;
    getContainer().appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 300);
    }, 3500);
  }

  return { show };
})();
