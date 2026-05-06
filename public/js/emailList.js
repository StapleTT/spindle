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

    // Update the header immediately so the correct name shows during the load
    if (header) {
      const acct = App.accounts.find(a => a.id === accountId);
      const name = acct ? (acct.display_name || acct.email_address) : folder;
      header.innerHTML = `<span>// ${esc(name.toLowerCase())}</span><button class="hdr-refresh-btn" id="hdr-refresh" title="refresh">↺</button>`;
      const refreshBtn = document.getElementById('hdr-refresh');
      if (refreshBtn) refreshBtn.onclick = () => load(_currentAcct, _currentFolder, 1);
    }

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

  async function loadAll() {
    _currentAcct   = 'all';
    _currentFolder = 'INBOX';
    _page          = 1;
    _loading       = true;

    const panel  = document.getElementById('thread-list-panel');
    const header = document.getElementById('thread-list-header');
    const list   = document.getElementById('thread-list-rows');
    const pg     = document.getElementById('thread-list-pagination');
    if (!panel || !list) return;

    panel.style.display = 'flex';
    const body = document.getElementById('app-body');
    if (body) body.classList.add('has-list');

    if (header) {
      header.innerHTML = `<span>// all inboxes</span><button class="hdr-refresh-btn" id="hdr-refresh" title="refresh">↺</button>`;
      const refreshBtn = document.getElementById('hdr-refresh');
      if (refreshBtn) refreshBtn.onclick = () => loadAll();
    }

    if (pg) pg.innerHTML = '';
    list.innerHTML = skeletons();

    try {
      const accounts = App.accounts;
      if (accounts.length === 0) {
        list.innerHTML = `<div class="empty" style="height:200px"><div class="empty-sub">no accounts connected</div></div>`;
        return;
      }

      // Fetch INBOX from all accounts in parallel
      const results = await Promise.allSettled(
        accounts.map(a =>
          API.get(`/api/email/${a.id}/messages?folder=INBOX&page=1&limit=20`)
            .then(d => (d.messages || []).map(m => ({ ...m, _accountId: a.id, _accountName: a.display_name || a.email_address })))
        )
      );

      // Merge fulfilled results and sort by date descending
      const allMsgs = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 50);

      _messages = allMsgs;
      _totalPages = 1;

      renderAllRows(list);
    } catch (e) {
      list.innerHTML = `<div class="empty" style="padding:24px;height:auto">
        <div class="empty-sub">failed to load messages</div>
        <div class="empty-hint">${esc(e.message)}</div>
      </div>`;
    } finally {
      _loading = false;
    }
  }

  // Renders merged rows — includes account name badge on each row
  function renderAllRows(container) {
    container.innerHTML = '';

    if (_messages.length === 0) {
      container.innerHTML = `<div class="empty" style="height:200px"><div class="empty-sub">no messages</div></div>`;
      return;
    }

    _messages.forEach(msg => {
      const row = document.createElement('div');
      row.className = `thread-row${msg.unread ? ' unread' : ''}`;
      row.dataset.uid = msg.uid;
      row.dataset.acctId = msg._accountId;
      row.innerHTML = `
        <div class="tr-top">
          <div class="tr-from"><span class="pip"></span>${esc(msg.from_name || msg.from_addr || '')}</div>
          <div class="tr-time">${esc(formatDate(msg.date))}</div>
        </div>
        <div class="tr-subj">${esc(msg.subject || '(no subject)')}</div>
        <div class="tr-preview tr-preview-all">
          <span class="tr-acct-badge">${esc(msg._accountName)}</span>${esc(msg.preview || '')}
        </div>
        <div class="tr-actions"></div>`;
      row.onclick = () => {
        document.querySelectorAll('#thread-list-rows .thread-row').forEach(r =>
          r.classList.toggle('active', r.dataset.uid == msg.uid && r.dataset.acctId == msg._accountId));
        App.activeMsg = { uid: msg.uid, accountId: msg._accountId, folder: 'INBOX' };
        Reader.loadMessage(msg._accountId, 'INBOX', msg.uid);
        markReadInList(msg.uid);
      };

      // Hover actions
      const readBtn = document.createElement('button');
      readBtn.className = 'tr-action-btn';
      const updateReadBtn = () => {
        readBtn.title       = msg.unread ? 'mark as read' : 'mark as unread';
        readBtn.textContent = msg.unread ? '✓' : '●';
      };
      updateReadBtn();
      readBtn.onclick = async e => {
        e.stopPropagation();
        try {
          await API.patch(`/api/email/${msg._accountId}/messages/${msg.uid}/read`, { read: msg.unread, folder: 'INBOX' });
          msg.unread = !msg.unread;
          row.classList.toggle('unread', msg.unread);
          updateReadBtn();
        } catch (err) { Toast.show(err.message, 'err'); }
      };

      const delBtn = document.createElement('button');
      delBtn.className = 'tr-action-btn tr-action-delete';
      delBtn.title = 'delete';
      delBtn.textContent = '✕';
      delBtn.onclick = async e => {
        e.stopPropagation();
        try {
          await API.delete(`/api/email/${msg._accountId}/messages/${msg.uid}?folder=INBOX`);
          row.remove();
          _messages = _messages.filter(m => !(m.uid === msg.uid && m._accountId === msg._accountId));
          Toast.show('Message deleted.');
        } catch (err) { Toast.show(err.message, 'err'); }
      };

      const actions = row.querySelector('.tr-actions');
      actions.appendChild(readBtn);
      actions.appendChild(delBtn);
      container.appendChild(row);
    });
  }

  async function refresh(accountId, folder) {
    if (_loading || accountId !== _currentAcct || folder !== _currentFolder) return;

    // Fetch silently — no skeletons, no panel flash
    try {
      const data = await API.get(
        `/api/email/${accountId}/messages?folder=${encodeURIComponent(folder)}&page=${_page}&limit=${LIMIT}`
      );

      // Always update unread badge / doc title
      if (data.unreadCount !== undefined) {
        App.unreadCounts[accountId] = data.unreadCount;
        App.updateDocTitle();
      }

      // Only re-render if the set of UIDs changed
      const newUids = (data.messages || []).map(m => m.uid).join(',');
      const oldUids = _messages.map(m => m.uid).join(',');
      if (newUids === oldUids) return;

      _messages   = data.messages;
      _totalPages = data.total ? Math.ceil(data.total / LIMIT) : (data.hasMore ? _page + 1 : _page);

      const list = document.getElementById('thread-list-rows');
      if (list) renderRows(list);
      renderPagination();
    } catch (_) { /* silent — don't disturb the UI on a background poll failure */ }
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
        <div class="tr-preview">${esc(msg.preview || '')}</div>
        <div class="tr-actions"></div>`;
      row.onclick = () => openMessage(msg);

      // ── Hover action: toggle read/unread ──────────────────────────
      const readBtn = document.createElement('button');
      readBtn.className = 'tr-action-btn';
      const updateReadBtn = () => {
        readBtn.title     = msg.unread ? 'mark as read' : 'mark as unread';
        readBtn.textContent = msg.unread ? '✓' : '●';
      };
      updateReadBtn();
      readBtn.onclick = async e => {
        e.stopPropagation();
        const targetRead = msg.unread; // true = mark read, false = mark unread
        try {
          await API.patch(
            `/api/email/${_currentAcct}/messages/${msg.uid}/read`,
            { read: targetRead, folder: _currentFolder }
          );
          msg.unread = !targetRead;
          row.classList.toggle('unread', msg.unread);
          updateReadBtn();
        } catch (err) { Toast.show(err.message, 'err'); }
      };

      // ── Hover action: delete ──────────────────────────────────────
      const delBtn = document.createElement('button');
      delBtn.className = 'tr-action-btn tr-action-delete';
      delBtn.title = 'delete';
      delBtn.textContent = '✕';
      delBtn.onclick = async e => {
        e.stopPropagation();
        try {
          await API.delete(
            `/api/email/${_currentAcct}/messages/${msg.uid}?folder=${encodeURIComponent(_currentFolder)}`
          );
          row.remove();
          _messages = _messages.filter(m => m.uid !== msg.uid);
          // Clear reading pane if this message is currently open
          const active = App.activeMsg;
          if (active && active.uid == msg.uid) Reader.showFolderEmpty();
          Toast.show('Message deleted.');
        } catch (err) { Toast.show(err.message, 'err'); }
      };

      const actions = row.querySelector('.tr-actions');
      actions.appendChild(readBtn);
      actions.appendChild(delBtn);
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

  return { load, loadAll, refresh, clear, markReadInList };
})();
