/**
 * emailList.js — Email list panel rendering, pagination, refresh.
 */

const EmailList = (() => {
  let _currentAcct   = null;
  let _currentFolder = null;
  let _page          = 1;
  let _totalPages    = 1;
  let _loading       = false;
  let _messages      = [];

  const LIMIT = 20;

  // ── Load ──────────────────────────────────────────────────────────
  async function load(accountId, folder, page = 1) {
    _currentAcct   = accountId;
    _currentFolder = folder;
    _page          = page;
    _loading       = true;

    const panel  = document.getElementById('thread-list-panel');
    const header = document.getElementById('thread-list-header');
    const list   = document.getElementById('thread-list-rows');
    if (!panel || !list) return;

    panel.style.display = 'flex';
    const body = document.getElementById('app-body');
    if (body) body.classList.add('has-list');

    if (page === 1) {
      list.innerHTML = skeletons();
    }

    try {
      const data = await API.get(
        `/api/email/${accountId}/messages?folder=${encodeURIComponent(folder)}&page=${page}&limit=${LIMIT}`
      );
      _messages   = data.messages;
      _totalPages = data.total ? Math.ceil(data.total / LIMIT) : (data.hasMore ? page + 1 : page);

      // Update unread counts
      if (data.unreadCount !== undefined) {
        App.unreadCounts[accountId] = data.unreadCount;
        App.updateDocTitle();
      }

      if (header) {
        const acct = App.accounts.find(a => a.id === accountId);
        const name = acct ? (acct.display_name || acct.email_address) : folder;
        header.innerHTML = `<span>// ${esc(name.toLowerCase())} — ${_messages.length}</span><span>↑↓</span>`;
      }

      renderRows(list);
      renderPagination();
    } catch (e) {
      list.innerHTML = `<div class="empty" style="padding:24px;height:auto">
        <div class="empty-sub">failed to load messages</div>
        <div class="empty-hint">${esc(e.message)}</div>
      </div>`;
    } finally {
      _loading = false;
    }
  }

  async function refresh(accountId, folder) {
    if (_loading || accountId !== _currentAcct || folder !== _currentFolder) return;
    await load(accountId, folder, 1);
  }

  function clear() {
    const panel = document.getElementById('thread-list-panel');
    if (panel) panel.style.display = 'none';
    const body = document.getElementById('app-body');
    if (body) body.classList.remove('has-list');
    const pg = document.getElementById('thread-list-pagination');
    if (pg) pg.innerHTML = '';
  }

  // ── Render rows ───────────────────────────────────────────────────
  function renderRows(container) {
    container.innerHTML = '';

    if (_messages.length === 0) {
      container.innerHTML = `<div class="empty" style="height:200px">
        <div class="empty-sub">no messages in this folder</div>
      </div>`;
      return;
    }

    _messages.forEach(msg => {
      const row = document.createElement('div');
      row.className = `thread-row${msg.unread ? ' unread' : ''}`;
      row.dataset.uid = msg.uid;
      row.innerHTML = `
        <div class="tr-top">
          <div class="tr-from"><span class="pip"></span>${esc(msg.from_name || msg.from_addr || '')}</div>
          <div class="tr-time">${esc(formatDate(msg.date))}</div>
        </div>
        <div class="tr-subj">${esc(msg.subject || '(no subject)')}</div>
        <div class="tr-preview">${esc(msg.preview || '')}</div>`;
      row.onclick = () => openMessage(msg);
      container.appendChild(row);
    });

  }

  function renderPagination() {
    const el = document.getElementById('thread-list-pagination');
    if (!el) return;
    if (_totalPages <= 1) { el.innerHTML = ''; return; }
    el.innerHTML = `
      <div class="pagination">
        <button class="chip" id="pg-prev" ${_page <= 1 ? 'disabled' : ''}>[ ← ]</button>
        <span class="pg-info">page ${_page} / ${_totalPages}</span>
        <button class="chip" id="pg-next" ${_page >= _totalPages ? 'disabled' : ''}>[ → ]</button>
      </div>`;
    const prev = document.getElementById('pg-prev');
    const next = document.getElementById('pg-next');
    if (prev) prev.onclick = () => { if (_page > 1) load(_currentAcct, _currentFolder, _page - 1); };
    if (next) next.onclick = () => { if (_page < _totalPages) load(_currentAcct, _currentFolder, _page + 1); };
  }

  function openMessage(msg) {
    // Mark row active
    document.querySelectorAll('#thread-list-rows .thread-row').forEach(r =>
      r.classList.toggle('active', r.dataset.uid == msg.uid));

    App.activeMsg = { uid: msg.uid, accountId: _currentAcct, folder: _currentFolder };
    Reader.loadMessage(_currentAcct, _currentFolder, msg.uid);

    // Optimistically mark as read in list
    markReadInList(msg.uid);
  }

  function markReadInList(uid) {
    const row = document.querySelector(`#thread-list-rows .thread-row[data-uid="${uid}"]`);
    if (row) row.classList.remove('unread');
    const msg = _messages.find(m => m.uid == uid);
    if (msg) msg.unread = false;
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function skeletons() {
    return Array(8).fill(0).map(() => `
      <div class="thread-row-skel">
        <div class="skeleton sk-line" style="width:60%;height:11px"></div>
        <div class="skeleton sk-line" style="width:80%;height:11px"></div>
        <div class="skeleton sk-line" style="width:90%;height:11px;opacity:.6"></div>
      </div>`).join('');
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    const now  = new Date();
    const diff = now - d;
    const days = Math.floor(diff / 86400000);
    if (days === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (days === 1) return 'yesterday';
    if (days < 7)  return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { load, refresh, clear, markReadInList };
})();
