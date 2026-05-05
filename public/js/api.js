/**
 * api.js — Centralised fetch wrapper for all Spindle API calls.
 *
 * Usage:
 *   const data = await API.get('/api/accounts');
 *   const data = await API.post('/api/auth/login', { username, password });
 */

const API = (() => {
  async function request(method, url, body) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
    };
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
      location.href = '/login.html';
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
    get:    (url)          => request('GET',    url),
    post:   (url, body)    => request('POST',   url, body),
    patch:  (url, body)    => request('PATCH',  url, body),
    delete: (url, body)    => request('DELETE', url, body),
  };
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
