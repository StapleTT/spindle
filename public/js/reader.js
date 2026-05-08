/**
 * reader.js — Email reading pane, message rendering, action toolbar.
 *
 * [FUTURE] Attachment download support — placeholder only in this version.
 */

const Reader = (() => {
  let _current = null; // { accountId, folder, uid, data }

  const pane = () => document.getElementById('reading-pane');

  // ── Load & display message ────────────────────────────────────────
  async function loadMessage(accountId, folder, uid) {
    _current = { accountId, folder, folderName: App.activeFolderName || '', uid, data: null };
    const p = pane();
    if (!p) return;

    p.innerHTML = `<div class="thread-view">
      <div class="thread-header">
        <div class="skeleton sk-line" style="width:55%;height:16px;margin-bottom:10px"></div>
        <div style="display:flex;gap:12px">
          <div class="skeleton sk-line" style="width:130px;height:11px"></div>
          <div class="skeleton sk-line" style="width:90px;height:11px"></div>
        </div>
      </div>
      <div class="thread-msgs">
        <div class="msg">
          <div style="display:flex;gap:12px;margin-bottom:16px;align-items:center">
            <div class="skeleton" style="width:28px;height:28px;border-radius:50%;flex-shrink:0"></div>
            <div class="skeleton sk-line" style="width:38%;height:11px"></div>
          </div>
          <div class="skeleton sk-line" style="width:96%;height:12px;margin-bottom:9px"></div>
          <div class="skeleton sk-line" style="width:89%;height:12px;margin-bottom:9px"></div>
          <div class="skeleton sk-line" style="width:93%;height:12px;margin-bottom:9px"></div>
          <div class="skeleton sk-line" style="width:61%;height:12px"></div>
        </div>
      </div>
    </div>`;

    try {
      const data = await API.get(
        `/api/email/${accountId}/messages/${uid}?folder=${encodeURIComponent(folder)}`
      );
      _current.data = data;

      // Mark as read (fire-and-forget)
      EmailList.markReadInList(uid);
      API.patch(`/api/email/${accountId}/messages/${uid}/read`, { read: true })
        .then(() => { if (_current?.data) _current.data.unread = false; })
        .catch(() => {});

      // If the provider returns a threadId, try to fetch all messages in the thread
      if (data.threadId) {
        try {
          const thread = await API.get(
            `/api/email/${accountId}/threads/${encodeURIComponent(data.threadId)}?folder=${encodeURIComponent(folder)}`
          );
          if (Array.isArray(thread) && thread.length > 1) {
            renderThread(thread, uid);
            return;
          }
        } catch (_) {
          // Thread fetch failed — fall through to single-message view
        }
      }

      render(data);
    } catch (e) {
      p.innerHTML = `<div class="empty"><div class="empty-sub">failed to load message</div><div class="empty-hint">${esc(e.message)}</div></div>`;
    }
  }

  function render(msg) {
    const p = pane();
    if (!p) return;

    const fromDisplay = msg.from_name
      ? `${esc(msg.from_name)} &lt;${esc(msg.from_addr || '')}&gt;`
      : esc(msg.from_addr || msg.from || '');

    let bodyHtml;
    if (msg.html) {
      bodyHtml = `
        <div class="msg-images-bar" id="images-bar" style="display:none">
          <span>Remote images blocked.</span>
          <button type="button" id="show-images-btn">show images</button>
        </div>
        <iframe class="msg-body-html" id="msg-iframe" sandbox="allow-same-origin allow-popups" style="width:100%;border:none;background:transparent"></iframe>`;
    } else {
      bodyHtml = `<div class="msg-body">${esc(msg.text || '').replace(/\n/g,'<br>')}</div>`;
    }

    p.innerHTML = `<div class="thread-view">
      <div class="thread-header">
        <div class="th-subj">${esc(msg.subject || '(no subject)')}</div>
        <div class="th-meta">
          <span>from <span class="em">${fromDisplay}</span></span>
          ${msg.to ? `<span>to <span class="em">${esc(msg.to)}</span></span>` : ''}
          ${msg.date ? `<span>${esc(new Date(msg.date).toLocaleString())}</span>` : ''}
        </div>
        <div class="th-actions" id="msg-actions">
          <button class="chip" onclick="Reader.reply()">[ reply ]</button>
          <button class="chip" onclick="Composer.openReplyAll(Reader.current)">[ reply all ]</button>
          <button class="chip" onclick="Reader.forward()">[ forward ]</button>
          <button class="chip" id="read-toggle" onclick="Reader.toggleRead()">[ mark unread ]</button>
          ${_folderActions(_current)}
        </div>
      </div>
      <div class="thread-msgs">
        <div class="msg">
          <div class="msg-head">
            ${_avatar(msg.from_name, msg.from_addr)}
            <div class="msg-head-info">
              <div><span class="msg-from">${fromDisplay}</span>&nbsp;·&nbsp;${esc(msg.date ? new Date(msg.date).toLocaleString() : '')}</div>
              ${msg.to ? `<div class="msg-head-to">to ${esc(msg.to)}</div>` : ''}
            </div>
          </div>
          ${bodyHtml}
          ${_attachmentsHtml(msg.attachments, _current.accountId, _current.uid, _current.folder)}
        </div>
      </div>
    </div>`;

    // Write HTML into iframe after render
    if (msg.html) {
      requestAnimationFrame(() => {
        const iframe = document.getElementById('msg-iframe');
        if (!iframe) return;
        const sanitized = typeof DOMPurify !== 'undefined'
          ? DOMPurify.sanitize(msg.html, { FORCE_BODY: true })
          : msg.html;

        const autoLoad = App.user ? !!App.user.auto_load_images : false;
        const hasImages = /<img/i.test(sanitized);
        const content = autoLoad ? sanitized : sanitized.replace(/(<img[^>]+)\bsrc=/gi, '$1data-src=');

        iframe.onload = () => {
          try {
            const h = iframe.contentDocument.documentElement.scrollHeight;
            iframe.style.height = h + 'px';
          } catch (_) {}
        };
        iframe.srcdoc = iframeDoc(content);

        if (hasImages && !autoLoad) {
          const bar = document.getElementById('images-bar');
          if (bar) bar.style.display = 'flex';
        }

        const showBtn = document.getElementById('show-images-btn');
        if (showBtn) showBtn.onclick = () => Reader.showImages();
      });
    }
  }

  function iframeDoc(body) {
    return `<html><head><base target="_blank"><style>
      body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.6;color:#d4d4d4;background:transparent;margin:16px}
      a{color:#aaa}img{max-width:100%;height:auto}
    </style></head><body>${body}</body></html>`;
  }

  function showImages() {
    if (!_current || !_current.data || !_current.data.html) return;
    const iframe = document.getElementById('msg-iframe');
    if (!iframe) return;
    const sanitized = typeof DOMPurify !== 'undefined'
      ? DOMPurify.sanitize(_current.data.html, { FORCE_BODY: true })
      : _current.data.html;
    iframe.onload = () => {
      try {
        const h = iframe.contentDocument.documentElement.scrollHeight;
        iframe.style.height = h + 'px';
      } catch (_) {}
    };
    iframe.srcdoc = iframeDoc(sanitized);
    const bar = document.getElementById('images-bar');
    if (bar) bar.style.display = 'none';
  }

  // ── Empty states ──────────────────────────────────────────────────
  function showEmpty() {
    const p = pane();
    const user = App.user;
    if (!p) return;
    p.innerHTML = `<div class="empty">
      <div class="empty-greet">welcome, <span class="em">${user ? esc(user.username) : 'there'}</span>.</div>
      <div class="empty-sub">add an inbox from the nav panel to get started.</div>
      <button class="chip" style="margin-top:18px" onclick="Accounts.openAddModal()">[ + add email provider ]</button>
    </div>`;
  }

  function showFolderEmpty() {
    const p = pane();
    const user = App.user;
    if (!p) return;
    p.innerHTML = `<div class="empty">
      <div class="empty-greet">welcome, <span class="em">${user ? esc(user.username) : 'there'}</span>.</div>
      <div class="empty-sub">select a message to read.</div>
    </div>`;
  }

  // ── Actions ───────────────────────────────────────────────────────
  function reply() {
    if (!_current || !_current.data) return;
    Composer.openReply(_current.data, _current.accountId);
  }

  function forward() {
    if (!_current || !_current.data) return;
    Composer.openForward(_current.data, _current.accountId);
  }

  async function toggleRead() {
    if (!_current) return;
    const { accountId, folder, uid, data } = _current;
    const wasUnread = data ? data.unread : false;
    try {
      await API.patch(`/api/email/${accountId}/messages/${uid}/read`, { read: wasUnread, folder });
      if (data) data.unread = !wasUnread;
      const btn = document.getElementById('read-toggle');
      if (btn) btn.innerHTML = data.unread ? '[ mark unread ]' : '[ mark read ]';
      if (wasUnread) {
        EmailList.markReadInList(uid);
      } else {
        EmailList.markUnreadInList(uid);
      }
      // Update sidebar badge
      const delta = wasUnread ? -1 : 1;
      App.unreadCounts[accountId] = Math.max(0, (App.unreadCounts[accountId] || 0) + delta);
      Sidebar.render();
      App.updateDocTitle();
      Toast.show(wasUnread ? 'Marked as read.' : 'Marked as unread.');
    } catch (e) { Toast.show(e.message, 'err'); }
  }

  async function archive() {
    if (!_current) return;
    const { accountId, folder, uid } = _current;
    _lockActions(true);
    try {
      await API.post(`/api/email/${accountId}/messages/${uid}/archive`, { folder });
      Toast.show('Moved to Archive.');
      showFolderEmpty();
      _current = null;
    } catch (e) { _lockActions(false); Toast.show(e.message, 'err'); }
  }

  async function deleteMsg() {
    if (!_current) return;
    const { accountId, folder, uid } = _current;
    _lockActions(true);
    try {
      await API.delete(`/api/email/${accountId}/messages/${uid}?folder=${encodeURIComponent(folder)}`);
      Toast.show('Moved to Trash.');
      showFolderEmpty();
      _current = null;
    } catch (e) { _lockActions(false); Toast.show(e.message, 'err'); }
  }

  async function restoreMsg() {
    if (!_current) return;
    const { accountId, folder, uid } = _current;
    _lockActions(true);
    try {
      await API.post(`/api/email/${accountId}/messages/${uid}/restore`, { folder });
      Toast.show('Moved to inbox.');
      showFolderEmpty();
      _current = null;
    } catch (e) { _lockActions(false); Toast.show(e.message, 'err'); }
  }

  // Classify the current folder so the toolbar shows the right actions.
  // Gmail uses label IDs (TRASH, ALLMAIL); IMAP and Outlook are matched by name.
  function _folderKind(cur) {
    const id   = (cur.folder     || '').toUpperCase();
    const name = (cur.folderName || '').toLowerCase().trim();
    if (id === 'TRASH')   return 'trash';
    if (id === 'ALLMAIL') return 'archive';
    if (/^(trash|deleted|deleted items|deleted messages)$/.test(name)) return 'trash';
    if (/^(archive|all mail|archived)$/.test(name))                    return 'archive';
    return 'normal';
  }

  function _folderActions(cur) {
    const kind = _folderKind(cur);
    if (kind === 'trash') {
      return `<button class="chip" onclick="Reader.restoreMsg()">[ move to inbox ]</button>`;
    }
    if (kind === 'archive') {
      return `<button class="chip" onclick="Reader.restoreMsg()">[ move to inbox ]</button>
              <button class="chip" onclick="Reader.deleteMsg()">[ delete ]</button>`;
    }
    return `<button class="chip" onclick="Reader.archive()">[ archive ]</button>
            <button class="chip" onclick="Reader.deleteMsg()">[ delete ]</button>`;
  }

  // ── Thread view ───────────────────────────────────────────────────────────
  function renderThread(messages, currentUid) {
    const p = pane();
    if (!p) return;

    // Use the selected message for header/toolbar; fall back to latest
    const current = messages.find(m => m.uid == currentUid) || messages[messages.length - 1];

    p.innerHTML = `<div class="thread-view">
      <div class="thread-header">
        <div class="th-subj">${esc(current.subject || '(no subject)')}</div>
        <div class="th-meta">
          <span class="em">${messages.length} messages</span>
        </div>
        <div class="th-actions" id="msg-actions">
          <button class="chip" onclick="Reader.reply()">[ reply ]</button>
          <button class="chip" onclick="Composer.openReplyAll(Reader.current)">[ reply all ]</button>
          <button class="chip" onclick="Reader.forward()">[ forward ]</button>
          <button class="chip" id="read-toggle" onclick="Reader.toggleRead()">[ mark unread ]</button>
          ${_folderActions(_current)}
        </div>
      </div>
      <div class="thread-msgs" id="thread-msgs-list"></div>
    </div>`;

    const container = document.getElementById('thread-msgs-list');
    messages.forEach((msg, idx) => {
      const isSelected = msg.uid == currentUid;
      const isNewest   = idx === messages.length - 1;
      const expanded   = isSelected || isNewest;
      container.appendChild(_buildMsgEl(msg, expanded));
    });
  }

  function _buildMsgEl(msg, expanded) {
    const el = document.createElement('div');
    el.className = `msg ${expanded ? 'msg-expanded' : 'msg-collapsed'}`;
    if (expanded) {
      _renderExpanded(el, msg);
    } else {
      _renderCollapsed(el, msg);
    }
    return el;
  }

  function _renderCollapsed(el, msg) {
    const from = msg.from_name ? esc(msg.from_name) : esc(msg.from_addr || '');
    el.innerHTML = `
      <div class="msg-summary">
        ${_avatar(msg.from_name, msg.from_addr, 'sm')}
        <span class="msg-from">${from}</span>
        <span class="msg-summary-preview">${esc(msg.preview || '')}</span>
        <span class="msg-summary-date">${esc(_fmtDate(msg.date))}</span>
      </div>`;
    el.onclick = () => {
      el.classList.replace('msg-collapsed', 'msg-expanded');
      _renderExpanded(el, msg);
    };
  }

  function _renderExpanded(el, msg) {
    const from    = msg.from_name ? esc(msg.from_name) : esc(msg.from_addr || '');
    const dateStr = msg.date ? new Date(msg.date).toLocaleString() : '';
    const iframeId = `tmsg-iframe-${String(msg.uid).replace(/[^a-z0-9]/gi, '')}`;

    let bodyHtml;
    if (msg.html) {
      bodyHtml = `<iframe class="msg-body-html" id="${iframeId}" sandbox="allow-same-origin allow-popups" style="width:100%;border:none;background:transparent"></iframe>`;
    } else {
      bodyHtml = `<div class="msg-body">${esc(msg.text || '').replace(/\n/g,'<br>')}</div>`;
    }

    el.innerHTML = `
      <div class="msg-head msg-head-clickable">
        ${_avatar(msg.from_name, msg.from_addr)}
        <div class="msg-head-info">
          <div><span class="msg-from">${from}</span>&nbsp;·&nbsp;${esc(dateStr)}</div>
          ${msg.to ? `<div class="msg-head-to">to ${esc(msg.to)}</div>` : ''}
        </div>
      </div>
      ${bodyHtml}
      ${_attachmentsHtml(msg.attachments, _current.accountId, msg.uid, _current.folder)}`;

    // Click the header to collapse
    el.querySelector('.msg-head-clickable').onclick = () => {
      el.classList.replace('msg-expanded', 'msg-collapsed');
      _renderCollapsed(el, msg);
    };

    // Inject HTML body into iframe
    if (msg.html) {
      requestAnimationFrame(() => {
        const iframe = document.getElementById(iframeId);
        if (!iframe) return;
        const sanitized = typeof DOMPurify !== 'undefined'
          ? DOMPurify.sanitize(msg.html, { FORCE_BODY: true })
          : msg.html;
        const autoLoad = App.user ? !!App.user.auto_load_images : false;
        const content = autoLoad
          ? sanitized
          : sanitized.replace(/(<img[^>]+)\bsrc=/gi, '$1data-src=');
        iframe.onload = () => {
          try {
            const h = iframe.contentDocument.documentElement.scrollHeight;
            iframe.style.height = h + 'px';
          } catch (_) {}
        };
        iframe.srcdoc = iframeDoc(content);
      });
    }
  }

  function _attachmentsHtml(attachments, accountId, uid, folder) {
    if (!attachments || attachments.length === 0) return '';
    const items = attachments.map(a => {
      const url = `/api/email/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(uid)}/attachments/${encodeURIComponent(a.attachmentId)}` +
        `?folder=${encodeURIComponent(folder)}&filename=${encodeURIComponent(a.filename)}&contentType=${encodeURIComponent(a.contentType || 'application/octet-stream')}`;
      return `<a class="attachment-chip" href="${url}" download="${esc(a.filename)}">` +
        `<span class="attachment-name">${esc(a.filename)}</span>` +
        (a.size ? `<span class="attachment-size">${_fmtSize(a.size)}</span>` : '') +
        `</a>`;
    }).join('');
    return `<div class="msg-attachments">${items}</div>`;
  }

  function _fmtSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024)        return `${bytes} B`;
    if (bytes < 1048576)     return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  }

  function _avatar(name, addr, size) {
    return Avatar.html(name, addr, size ? `avatar avatar-${size}` : 'avatar');
  }

  function _lockActions(locked) {
    const actions = document.getElementById('msg-actions');
    if (!actions) return;
    actions.querySelectorAll('.chip').forEach(btn => { btn.disabled = locked; });
  }

  function _fmtDate(dateStr) {
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

  return {
    loadMessage,
    showEmpty,
    showFolderEmpty,
    reply,
    forward,
    toggleRead,
    archive,
    deleteMsg,
    restoreMsg,
    showImages,
    get current() { return _current ? _current.data : null; },
  };
})();
