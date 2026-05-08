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
        Sidebar.render();
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
      const failed  = results.filter(r => r.status === 'rejected');
      const allMsgs = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 50);

      _messages = allMsgs;
      _totalPages = 1;

      renderAllRows(list);

      if (failed.length > 0) {
        const note = document.createElement('div');
        note.className = 'list-warn-note';
        note.textContent = `${failed.length} account${failed.length !== 1 ? 's' : ''} failed to load`;
        list.prepend(note);
      }
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
          <div class="tr-from">${Avatar.html(msg.from_name, msg.from_addr, 'avatar avatar-row')}<span class="pip"></span>${esc(msg.from_name || msg.from_addr || '')}</div>
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
        if (typeof MobileNav !== 'undefined') MobileNav.close();
        if (msg.unread) {
          markReadInList(msg.uid);
          adjustUnreadCount(msg._accountId, -1);
        }
      };
      row.oncontextmenu = e => showContextMenu(e, msg, msg._accountId, 'INBOX');

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
        const wasUnread  = msg.unread;
        const targetRead = wasUnread;

        // ── Optimistic update ─────────────────────────────────────
        msg.unread = !wasUnread;
        row.classList.toggle('unread', msg.unread);
        updateReadBtn();
        adjustUnreadCount(msg._accountId, wasUnread ? -1 : 1);

        try {
          await API.patch(`/api/email/${msg._accountId}/messages/${msg.uid}/read`, { read: targetRead, folder: 'INBOX' });
        } catch (err) {
          // Revert on failure
          msg.unread = wasUnread;
          row.classList.toggle('unread', msg.unread);
          updateReadBtn();
          adjustUnreadCount(msg._accountId, wasUnread ? 1 : -1);
          Toast.show(err.message, 'err');
        }
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
          Toast.show('Moved to Trash.');
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
        Sidebar.render();
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
          <div class="tr-from">${Avatar.html(msg.from_name, msg.from_addr, 'avatar avatar-row')}<span class="pip"></span>${esc(msg.from_name || msg.from_addr || '')}</div>
          <div class="tr-time">${esc(formatDate(msg.date))}</div>
        </div>
        <div class="tr-subj">${esc(msg.subject || '(no subject)')}</div>
        <div class="tr-preview">${esc(msg.preview || '')}</div>
        <div class="tr-actions"></div>`;
      row.onclick = () => openMessage(msg);
      row.oncontextmenu = e => showContextMenu(e, msg, _currentAcct, _currentFolder);

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
        const wasUnread  = msg.unread;
        const targetRead = wasUnread; // true = mark read, false = mark unread

        // ── Optimistic update ─────────────────────────────────────
        msg.unread = !wasUnread;
        row.classList.toggle('unread', msg.unread);
        updateReadBtn();
        adjustUnreadCount(_currentAcct, wasUnread ? -1 : 1);

        try {
          await API.patch(
            `/api/email/${_currentAcct}/messages/${msg.uid}/read`,
            { read: targetRead, folder: _currentFolder }
          );
        } catch (err) {
          // Revert on failure
          msg.unread = wasUnread;
          row.classList.toggle('unread', msg.unread);
          updateReadBtn();
          adjustUnreadCount(_currentAcct, wasUnread ? 1 : -1);
          Toast.show(err.message, 'err');
        }
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
          Toast.show('Moved to Trash.');
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
    if (typeof MobileNav !== 'undefined') MobileNav.close();

    // Optimistically mark as read in list and update sidebar count
    if (msg.unread) {
      markReadInList(msg.uid);
      adjustUnreadCount(_currentAcct, -1);
    }
  }

  function markReadInList(uid) {
    const row = document.querySelector(`#thread-list-rows .thread-row[data-uid="${uid}"]`);
    if (row) row.classList.remove('unread');
    const msg = _messages.find(m => m.uid == uid);
    if (msg) msg.unread = false;
  }

  function markUnreadInList(uid) {
    const row = document.querySelector(`#thread-list-rows .thread-row[data-uid="${uid}"]`);
    if (row) row.classList.add('unread');
    const msg = _messages.find(m => m.uid == uid);
    if (msg) msg.unread = true;
  }

  // Adjust sidebar unread count for an account by delta (+1 or -1) and re-render
  function adjustUnreadCount(accountId, delta) {
    if (!accountId || accountId === 'all') return;
    App.unreadCounts[accountId] = Math.max(0, (App.unreadCounts[accountId] || 0) + delta);
    Sidebar.render();
    App.updateDocTitle();
  }

  // ── Context menu ──────────────────────────────────────────────────
  let _ctxEl   = null;
  let _ctxOpen = false;

  function _ctxEnsure() {
    if (_ctxEl) return;
    _ctxEl = document.createElement('div');
    _ctxEl.className = 'ctx-menu';
    _ctxEl.style.display = 'none';
    document.body.appendChild(_ctxEl);

    // Close on outside click or Escape
    document.addEventListener('mousedown', e => {
      if (_ctxOpen && !_ctxEl.contains(e.target)) _ctxClose();
    }, true);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && _ctxOpen) _ctxClose();
    });
  }

  function _ctxClose() {
    if (_ctxEl) _ctxEl.style.display = 'none';
    _ctxOpen = false;
  }

  function showContextMenu(e, msg, acctId, folder) {
    e.preventDefault();
    e.stopPropagation();
    _ctxEnsure();

    const isUnread = msg.unread;
    // Filter folders: exclude current folder, Trash, and Gmail ALLMAIL (archive view)
    const folders = Sidebar.getCachedFolders(acctId).filter(f =>
      f.id !== folder &&
      !['TRASH', 'ALLMAIL'].includes(f.id.toUpperCase())
    );

    _ctxEl.innerHTML = `
      <div class="ctx-item" data-action="open">open</div>
      <div class="ctx-item" data-action="reply">reply</div>
      <div class="ctx-sep"></div>
      <div class="ctx-item" data-action="toggle-read">${isUnread ? 'mark as read' : 'mark as unread'}</div>
      <div class="ctx-item" data-action="archive">archive</div>
      <div class="ctx-item ctx-item-del" data-action="delete">delete</div>
      ${folders.length ? `
      <div class="ctx-sep"></div>
      <div class="ctx-item ctx-has-sub">move to folder
        <div class="ctx-sub">
          ${folders.map(f => `<div class="ctx-sub-item" data-folder="${esc(f.id)}">${esc(f.name.toLowerCase())}</div>`).join('')}
        </div>
      </div>` : ''}`;

    // Wire up action items
    _ctxEl.querySelectorAll('[data-action]').forEach(el => {
      el.onmousedown = async ev => {
        ev.stopPropagation();
        _ctxClose();
        await _ctxExec(el.dataset.action, msg, acctId, folder);
      };
    });

    // Wire up submenu folder items
    _ctxEl.querySelectorAll('.ctx-sub-item').forEach(el => {
      el.onmousedown = async ev => {
        ev.stopPropagation();
        _ctxClose();
        await _ctxMove(msg, acctId, folder, el.dataset.folder, el.textContent.trim());
      };
    });

    // Position — keep inside viewport
    _ctxEl.style.display = 'block';
    _ctxEl.style.left = '0px';
    _ctxEl.style.top  = '0px';
    const mw = _ctxEl.offsetWidth;
    const mh = _ctxEl.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth  - 8) x = window.innerWidth  - mw - 8;
    if (y + mh > window.innerHeight - 8) y = window.innerHeight - mh - 8;
    _ctxEl.style.left = `${x}px`;
    _ctxEl.style.top  = `${y}px`;
    _ctxOpen = true;
  }

  function _ctxRow(uid, acctId) {
    // In the all-inboxes view rows have data-acct-id; in single-account view they don't.
    const byBoth = document.querySelector(
      `#thread-list-rows .thread-row[data-uid="${uid}"][data-acct-id="${acctId}"]`
    );
    return byBoth || document.querySelector(`#thread-list-rows .thread-row[data-uid="${uid}"]`);
  }

  async function _ctxExec(action, msg, acctId, folder) {
    switch (action) {

      case 'open': {
        document.querySelectorAll('#thread-list-rows .thread-row').forEach(r =>
          r.classList.toggle('active', r.dataset.uid == msg.uid));
        App.activeMsg = { uid: msg.uid, accountId: acctId, folder };
        Reader.loadMessage(acctId, folder, msg.uid);
        if (msg.unread) { markReadInList(msg.uid); adjustUnreadCount(acctId, -1); }
        break;
      }

      case 'reply': {
        try {
          const data = await API.get(
            `/api/email/${acctId}/messages/${msg.uid}?folder=${encodeURIComponent(folder)}`
          );
          Composer.openReply(data, acctId);
        } catch (err) { Toast.show(err.message, 'err'); }
        break;
      }

      case 'toggle-read': {
        const wasUnread  = msg.unread;
        const targetRead = wasUnread; // true → mark read
        msg.unread = !wasUnread;
        const row = _ctxRow(msg.uid, acctId);
        if (row) row.classList.toggle('unread', msg.unread);
        adjustUnreadCount(acctId, wasUnread ? -1 : 1);
        try {
          await API.patch(`/api/email/${acctId}/messages/${msg.uid}/read`,
            { read: targetRead, folder });
        } catch (err) {
          msg.unread = wasUnread;
          if (row) row.classList.toggle('unread', msg.unread);
          adjustUnreadCount(acctId, wasUnread ? 1 : -1);
          Toast.show(err.message, 'err');
        }
        break;
      }

      case 'archive': {
        try {
          await API.post(`/api/email/${acctId}/messages/${msg.uid}/archive`, { folder });
          const row = _ctxRow(msg.uid, acctId);
          if (row) row.remove();
          _messages = _messages.filter(m => m.uid !== msg.uid);
          const active = App.activeMsg;
          if (active && active.uid == msg.uid) Reader.showFolderEmpty();
          Toast.show('Moved to Archive.');
        } catch (err) { Toast.show(err.message, 'err'); }
        break;
      }

      case 'delete': {
        try {
          await API.delete(
            `/api/email/${acctId}/messages/${msg.uid}?folder=${encodeURIComponent(folder)}`
          );
          const row = _ctxRow(msg.uid, acctId);
          if (row) row.remove();
          _messages = _messages.filter(m => m.uid !== msg.uid);
          const active = App.activeMsg;
          if (active && active.uid == msg.uid) Reader.showFolderEmpty();
          Toast.show('Moved to Trash.');
        } catch (err) { Toast.show(err.message, 'err'); }
        break;
      }
    }
  }

  async function _ctxMove(msg, acctId, fromFolder, toFolder, toFolderName) {
    try {
      await API.post(`/api/email/${acctId}/messages/${msg.uid}/move`,
        { fromFolder, toFolder });
      const row = _ctxRow(msg.uid, acctId);
      if (row) row.remove();
      _messages = _messages.filter(m => m.uid !== msg.uid);
      const active = App.activeMsg;
      if (active && active.uid == msg.uid) Reader.showFolderEmpty();
      Toast.show(`Moved to ${toFolderName || toFolder}.`);
    } catch (err) { Toast.show(err.message, 'err'); }
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

  return { load, loadAll, refresh, clear, markReadInList, markUnreadInList };
})();
