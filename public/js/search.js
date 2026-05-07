/**
 * search.js — Mail search panel.
 *
 * Renders a slide-down search bar below the top bar.
 * Results appear in the thread-list panel (same column as the inbox view).
 *
 * Public API:
 *   Search.toggle()  — open if closed, close if open
 *   Search.open()    — show panel and focus input
 *   Search.close()   — hide panel
 *   Search.submit()  — run the current query
 */

const Search = (() => {
  let _open        = false;
  let _accountSel  = null;
  let _fieldSel    = null;
  let _lastQuery   = '';

  // ── Init ──────────────────────────────────────────────────────────────────

  function _init() {
    const form  = document.getElementById('search-panel');
    const input = document.getElementById('search-q');
    const btn   = document.getElementById('search-submit');
    const close = document.getElementById('search-close');
    if (!form) return;

    btn?.addEventListener('click', submit);
    close?.addEventListener('click', () => Search.close());

    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
      if (e.key === 'Escape') { e.preventDefault(); Search.close(); }
    });
  }

  // ── Account & field selects ───────────────────────────────────────────────

  function _buildSelects() {
    const acctWrap  = document.getElementById('search-acct-wrap');
    const fieldWrap = document.getElementById('search-field-wrap');
    if (!acctWrap || !fieldWrap) return;

    // Rebuild account list every time (accounts may have been added/removed)
    acctWrap.innerHTML  = '';
    fieldWrap.innerHTML = '';

    const acctOptions = [
      { value: 'all', label: 'all inboxes' },
      ...App.accounts.map(a => ({
        value: String(a.id),
        label: (a.display_name || a.email_address).toLowerCase(),
      })),
    ];

    _accountSel = CustomSelect.create(acctOptions, 'all', { borderless: true });
    acctWrap.appendChild(_accountSel.el);

    const fieldOptions = [
      { value: 'all',     label: 'all fields' },
      { value: 'from',    label: 'from'       },
      { value: 'to',      label: 'to'         },
      { value: 'subject', label: 'subject'    },
    ];

    _fieldSel = CustomSelect.create(fieldOptions, 'all', { borderless: true });
    fieldWrap.appendChild(_fieldSel.el);
  }

  // ── Open / close ──────────────────────────────────────────────────────────

  function toggle() { _open ? close() : open(); }

  function open() {
    _open = true;
    const panel = document.getElementById('search-panel');
    if (panel) panel.style.display = 'flex';
    _buildSelects();
    // Small delay lets the panel paint before we focus, avoiding layout jank
    setTimeout(() => document.getElementById('search-q')?.focus(), 30);
  }

  function close() {
    _open = false;
    const panel = document.getElementById('search-panel');
    if (panel) panel.style.display = 'none';
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  async function submit() {
    const input     = document.getElementById('search-q');
    const q         = (input?.value || '').trim();
    if (!q) { input?.focus(); return; }

    const accountId = _accountSel?.getValue() || 'all';
    const field     = _fieldSel?.getValue()    || 'all';
    _lastQuery      = q;

    _showResults(accountId, field, q);
  }

  async function _showResults(accountId, field, q) {
    // Take over the thread list panel
    const panel  = document.getElementById('thread-list-panel');
    const header = document.getElementById('thread-list-header');
    const list   = document.getElementById('thread-list-rows');
    const pg     = document.getElementById('thread-list-pagination');
    if (!panel || !list) return;

    panel.style.display = 'flex';
    const body = document.getElementById('app-body');
    if (body) body.classList.add('has-list');
    if (pg) pg.innerHTML = '';

    // Visually highlight the selected scope without touching Sidebar's internal
    // state or App.activeAcct (which would confuse subsequent navigation).
    // Direct DOM update: toggle active class on account rows for both the
    // specific-account and 'all' cases so the previous selection is always cleared.
    {
      const acctStr = String(accountId);
      document.querySelectorAll('#inbox-list .folder[data-acct-id]').forEach(el => {
        el.classList.toggle('active', el.dataset.acctId === acctStr);
        // Remove folder-open highlight when a different account is now "active"
        if (el.dataset.acctId !== acctStr) el.classList.remove('folder-open');
      });
      document.querySelectorAll('#inbox-list .folder-tree-item, #system-list .folder').forEach(el =>
        el.classList.remove('active'));
    }

    // Update header
    if (header) {
      header.innerHTML = `<span>// search results</span><button class="hdr-refresh-btn" id="hdr-search-again" title="search again">↺</button>`;
      document.getElementById('hdr-search-again')?.addEventListener('click', () => _showResults(accountId, field, q));
    }

    // Show skeleton while loading
    list.innerHTML = _skeletons();

    try {
      const url  = `/api/email/${encodeURIComponent(accountId)}/search?q=${encodeURIComponent(q)}&field=${field}`;
      const data = await API.get(url);
      _renderResults(list, data.messages || [], accountId);
    } catch (e) {
      list.innerHTML = `<div class="empty" style="padding:24px;height:auto">
        <div class="empty-sub">search failed</div>
        <div class="empty-hint">${_esc(e.message)}</div>
      </div>`;
    }
  }

  function _renderResults(container, messages, accountId) {
    container.innerHTML = '';

    if (messages.length === 0) {
      container.innerHTML = `<div class="empty" style="height:200px">
        <div class="empty-sub">no results</div>
        <div class="empty-hint">try a different query or search scope</div>
      </div>`;
      return;
    }

    const isAll = accountId === 'all';

    messages.forEach(msg => {
      const acctId  = msg._accountId || accountId;
      const folder  = 'INBOX'; // search always loads from INBOX context
      const row     = document.createElement('div');
      row.className = `thread-row${msg.unread ? ' unread' : ''}`;
      row.dataset.uid    = msg.uid;
      row.dataset.acctId = acctId;

      row.innerHTML = `
        <div class="tr-top">
          <div class="tr-from"><span class="pip"></span>${_esc(msg.from_name || msg.from_addr || '')}</div>
          <div class="tr-time">${_esc(_formatDate(msg.date))}</div>
        </div>
        <div class="tr-subj">${_esc(msg.subject || '(no subject)')}</div>
        <div class="tr-preview${isAll ? ' tr-preview-all' : ''}">
          ${isAll ? `<span class="tr-acct-badge">${_esc(msg._accountName || '')}</span>` : ''}${_esc(msg.preview || '')}
        </div>
        <div class="tr-actions"></div>`;

      row.addEventListener('click', () => {
        container.querySelectorAll('.thread-row').forEach(r =>
          r.classList.toggle('active', r === row));
        App.activeMsg = { uid: msg.uid, accountId: acctId, folder };
        Reader.loadMessage(acctId, folder, msg.uid);
        if (msg.unread) {
          row.classList.remove('unread');
          msg.unread = false;
        }
      });

      // Hover quick action: delete
      const delBtn = document.createElement('button');
      delBtn.className = 'tr-action-btn tr-action-delete';
      delBtn.title     = 'delete';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await API.delete(`/api/email/${acctId}/messages/${msg.uid}?folder=${encodeURIComponent(folder)}`);
          row.remove();
          Toast.show('Moved to Trash.');
        } catch (err) { Toast.show(err.message, 'err'); }
      });

      row.querySelector('.tr-actions').appendChild(delBtn);
      container.appendChild(row);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function _skeletons() {
    return Array(6).fill(0).map(() => `
      <div class="thread-row-skel">
        <div class="skeleton sk-line" style="width:60%;height:11px"></div>
        <div class="skeleton sk-line" style="width:80%;height:11px"></div>
        <div class="skeleton sk-line" style="width:90%;height:11px;opacity:.6"></div>
      </div>`).join('');
  }

  function _formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    const now  = new Date();
    const days = Math.floor((now - d) / 86400000);
    if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return 'yesterday';
    if (days < 7)  return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Run init after DOM ready
  document.addEventListener('DOMContentLoaded', _init);

  return { toggle, open, close, submit };
})();
