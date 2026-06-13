/**
 * mobile-app.js — Mobile navigation, touch interactions, action sheet.
 *
 * Replaces desktop mobile.js on /m/inbox. Provides the same MobileNav
 * interface (init, showList, close, goToSidebar, toggle) that app.js,
 * emailList.js, and reader.js call into.
 *
 * Features:
 *  - Three-panel nav: accounts ←→ list ←→ reader
 *  - Bottom tab bar with unread badge
 *  - Contextual header with back button
 *  - Long-press on email rows → action sheet
 *  - Fixed left-edge overlay for reliable swipe-back from reader
 *  - Settings / search mutual exclusion
 */

const MobileNav = (() => {
  const ACCOUNTS = 'accounts';
  const LIST     = 'list';
  const READER   = 'reader';

  let _panel   = ACCOUNTS;
  let _hasList = false;
  let _edgeEl  = null;

  // ── Panel switching ─────────────────────────────────────────────────────
  function _setPanel(p) {
    _panel = p;

    const accountsEl = document.getElementById('m-panel-accounts');
    const listEl     = document.getElementById('thread-list-panel');
    const readerEl   = document.getElementById('reading-pane');

    const panels = { [ACCOUNTS]: accountsEl, [LIST]: listEl, [READER]: readerEl };

    Object.entries(panels).forEach(([key, el]) => {
      if (!el) return;
      el.classList.toggle('m-panel-active', key === p);
    });

    // Show left-edge swipe zone only when reading pane is active
    if (_edgeEl) _edgeEl.style.display = (p === READER) ? 'block' : 'none';

    _updateHeader(p);
    _updateTabBar(p);
  }

  // ── Header ──────────────────────────────────────────────────────────────
  function _updateHeader(p) {
    const backBtn = document.getElementById('m-header-back');
    if (!backBtn) return;
    backBtn.classList.toggle('m-hidden', p !== READER);
  }

  // ── Tab bar ─────────────────────────────────────────────────────────────
  function _updateTabBar(p) {
    [
      { id: 'm-tab-accounts', panel: ACCOUNTS },
      { id: 'm-tab-list',     panel: LIST     },
    ].forEach(({ id, panel }) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('m-tab-active', panel === p);
    });
  }

  // ── Unread badge ─────────────────────────────────────────────────────────
  function _updateBadge() {
    const badge = document.getElementById('m-tab-badge');
    if (!badge || typeof App === 'undefined') return;
    const total = Object.values(App.unreadCounts || {}).reduce((s, n) => s + n, 0);
    badge.textContent = total > 99 ? '99+' : (total || '');
    badge.classList.toggle('visible', total > 0);
  }

  // ── Public API ───────────────────────────────────────────────────────────
  function showList() {
    _hasList = true;
    _setPanel(LIST);
  }

  function close() {
    _setPanel(READER);
  }

  function goToSidebar() {
    if (typeof App !== 'undefined') App.clearSelection();
    _setPanel(ACCOUNTS);
  }

  function toggle() {
    _setPanel(_panel !== ACCOUNTS ? ACCOUNTS : (_hasList ? LIST : ACCOUNTS));
  }

  // ── Action sheet ─────────────────────────────────────────────────────────
  let _sheetCtx = null;

  function _initSheet() {
    const overlay = document.getElementById('m-sheet-overlay');
    if (!overlay) return;
    overlay.addEventListener('click', e => {
      if (e.target === overlay) _closeSheet();
    });
  }

  function _closeSheet() {
    const overlay = document.getElementById('m-sheet-overlay');
    if (overlay) overlay.classList.remove('open');
    _sheetCtx = null;
  }

  function _showSheet(ctx) {
    _sheetCtx = ctx;
    const overlay = document.getElementById('m-sheet-overlay');
    const sheet   = document.getElementById('m-sheet');
    if (!overlay || !sheet) return;

    const readLabel = ctx.isUnread ? 'mark as read' : 'mark as unread';
    sheet.innerHTML = `
      <div class="m-sheet-title">${_esc(ctx.fromName || 'message')}</div>
      <button class="m-sheet-item" data-action="open">open</button>
      <button class="m-sheet-item" data-action="reply">reply</button>
      <button class="m-sheet-item" data-action="toggle-read">${readLabel}</button>
      <button class="m-sheet-item" data-action="archive">archive</button>
      <button class="m-sheet-item m-sheet-del" data-action="delete">delete</button>
      <button class="m-sheet-item m-sheet-cancel" data-action="cancel">cancel</button>`;

    sheet.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => _execSheet(btn.dataset.action));
    });

    overlay.classList.add('open');
  }

  async function _execSheet(action) {
    const ctx = _sheetCtx;
    _closeSheet();
    if (!ctx || action === 'cancel') return;

    const { uid, acctId, folder, isUnread } = ctx;

    switch (action) {
      case 'open': {
        const row = _row(uid);
        if (row) row.click();
        break;
      }
      case 'reply': {
        try {
          const data = await API.get(
            `/api/email/${acctId}/messages/${uid}?folder=${encodeURIComponent(folder)}`
          );
          Composer.openReply(data, acctId);
        } catch (e) { Toast.show(e.message, 'err'); }
        break;
      }
      case 'toggle-read': {
        const row = _row(uid);
        try {
          await API.patch(`/api/email/${acctId}/messages/${uid}/read`,
            { read: isUnread, folder });
          if (row) row.classList.toggle('unread', !isUnread);
          const delta = isUnread ? -1 : 1;
          if (typeof App !== 'undefined') {
            App.unreadCounts[acctId] = Math.max(0, (App.unreadCounts[acctId] || 0) + delta);
            if (typeof Sidebar !== 'undefined') Sidebar.render();
            App.updateDocTitle();
          }
          _updateBadge();
          Toast.show(isUnread ? 'Marked as read.' : 'Marked as unread.');
        } catch (e) { Toast.show(e.message, 'err'); }
        break;
      }
      case 'archive': {
        try {
          await API.post(`/api/email/${acctId}/messages/${uid}/archive`, { folder });
          _removeRow(uid);
          Toast.show('Moved to Archive.');
          if (_isActiveMsg(uid)) { Reader.showFolderEmpty(); _setPanel(LIST); }
        } catch (e) { Toast.show(e.message, 'err'); }
        break;
      }
      case 'delete': {
        try {
          await API.delete(
            `/api/email/${acctId}/messages/${uid}?folder=${encodeURIComponent(folder)}`
          );
          _removeRow(uid);
          Toast.show('Moved to Trash.');
          if (_isActiveMsg(uid)) { Reader.showFolderEmpty(); _setPanel(LIST); }
        } catch (e) { Toast.show(e.message, 'err'); }
        break;
      }
    }
  }

  function _row(uid) {
    return document.querySelector(`#thread-list-rows .thread-row[data-uid="${uid}"]`);
  }

  function _removeRow(uid) {
    const row = _row(uid);
    if (!row) return;
    row.style.transition = 'opacity 0.18s ease, transform 0.18s ease';
    row.style.opacity = '0';
    row.style.transform = 'translateX(-16px)';
    setTimeout(() => row.remove(), 180);
  }

  function _isActiveMsg(uid) {
    return typeof App !== 'undefined' && App.activeMsg && String(App.activeMsg.uid) === String(uid);
  }

  // ── Long-press detection (event delegation on list rows) ─────────────────
  let _lp = { timer: null, row: null, moved: false, startX: 0, startY: 0 };

  function _initLongPress() {
    const container = document.getElementById('thread-list-rows');
    if (!container) return;

    container.addEventListener('touchstart', _lpStart, { passive: true });
    container.addEventListener('touchmove',  _lpMove,  { passive: true });
    container.addEventListener('touchend',   _lpEnd,   { passive: true });
    container.addEventListener('touchcancel',_lpCancel,{ passive: true });
  }

  function _lpStart(e) {
    const row = e.target.closest('.thread-row');
    if (!row) return;
    _lp.row    = row;
    _lp.moved  = false;
    _lp.startX = e.touches[0].clientX;
    _lp.startY = e.touches[0].clientY;

    _lp.timer = setTimeout(() => {
      if (_lp.moved || !_lp.row) return;
      if (navigator.vibrate) navigator.vibrate(32);
      _lp.row.classList.add('m-row-pressed');
      setTimeout(() => _lp.row && _lp.row.classList.remove('m-row-pressed'), 180);
      _openRowSheet(_lp.row);
      _lp.timer = null;
    }, 490);
  }

  function _lpMove(e) {
    if (!_lp.row) return;
    const dx = Math.abs(e.touches[0].clientX - _lp.startX);
    const dy = Math.abs(e.touches[0].clientY - _lp.startY);
    if (dx > 8 || dy > 8) {
      _lp.moved = true;
      clearTimeout(_lp.timer);
      _lp.timer = null;
    }
  }

  function _lpEnd()    { clearTimeout(_lp.timer); _lp.timer = null; _lp.row = null; }
  function _lpCancel() { clearTimeout(_lp.timer); _lp.timer = null; _lp.row = null; }

  function _openRowSheet(row) {
    const uid      = row.dataset.uid;
    const acctId   = row.dataset.acctId || (typeof App !== 'undefined' ? App.activeAcct : null);
    const folder   = typeof App !== 'undefined' ? (App.activeFolder || 'INBOX') : 'INBOX';
    const isUnread = row.classList.contains('unread');
    const fromEl   = row.querySelector('.tr-from');
    const fromName = fromEl ? fromEl.textContent.trim() : '';

    _showSheet({ uid, acctId, folder, isUnread, fromName });
  }

  // ── Left-edge swipe overlay → back to list from reader ───────────────────
  // A 24px transparent strip at the left edge of the screen captures swipe-
  // back touches that would otherwise be swallowed by the email iframe.
  function _initEdgeSwipe() {
    const shell = document.querySelector('.m-shell');
    if (!shell) return;

    const edge = document.createElement('div');
    edge.id = 'm-edge-swipe';
    edge.setAttribute('aria-hidden', 'true');
    shell.appendChild(edge);
    _edgeEl = edge;

    let _sx = 0, _tracking = false;

    edge.addEventListener('touchstart', e => {
      _sx = e.touches[0].clientX;
      _tracking = true;
      e.preventDefault(); // overlay is gesture-only; safe to prevent
    }, { passive: false });

    edge.addEventListener('touchmove', e => {
      if (!_tracking) return;
      e.preventDefault(); // prevent scroll-behind while swiping
    }, { passive: false });

    edge.addEventListener('touchend', e => {
      if (!_tracking) return;
      const dx = e.changedTouches[0].clientX - _sx;
      if (dx > 48 && _panel === READER) _setPanel(LIST);
      _tracking = false;
    });

    edge.addEventListener('touchcancel', () => { _tracking = false; });
  }

  // ── Settings / search mutual exclusion ──────────────────────────────────
  // Runs after DOMContentLoaded (via setTimeout 0) so inbox-init.js has
  // already set onclick handlers, letting us safely override them.
  function _patchMutualExclusion() {
    // Settings tab + sys-settings: close search before toggling settings
    const _openSettings = () => {
      if (typeof Search !== 'undefined') Search.close();
      if (typeof Settings !== 'undefined') Settings.toggle();
    };
    const tabSet = document.getElementById('m-tab-settings');
    const sysSet = document.getElementById('sys-settings');
    if (tabSet) tabSet.onclick = _openSettings;
    if (sysSet) sysSet.onclick = _openSettings;

    // Search button: close settings if open before toggling search
    const searchBtn = document.getElementById('btn-search');
    if (searchBtn) {
      searchBtn.onclick = () => {
        if (document.getElementById('settings-modal')) {
          if (typeof Settings !== 'undefined') Settings.toggle();
          return;
        }
        if (typeof Search !== 'undefined') Search.toggle();
      };
    }

    // MutationObserver: if search opens via keyboard shortcut (/), close settings
    const sp = document.getElementById('search-panel');
    if (sp) {
      new MutationObserver(() => {
        if (sp.style.display !== 'none' && document.getElementById('settings-modal')) {
          if (typeof Settings !== 'undefined') Settings.toggle();
        }
      }).observe(sp, { attributes: true, attributeFilter: ['style'] });
    }
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Tab bar wiring
    const tabAcc  = document.getElementById('m-tab-accounts');
    const tabList = document.getElementById('m-tab-list');

    if (tabAcc)  tabAcc.addEventListener('click',  () => _setPanel(ACCOUNTS));
    if (tabList) tabList.addEventListener('click', () => {
      if (_hasList) _setPanel(LIST);
      else          _setPanel(ACCOUNTS);
    });

    // Header back button
    const back = document.getElementById('m-header-back');
    if (back) back.addEventListener('click', () => {
      if (_panel === READER) _setPanel(LIST);
      else                   goToSidebar();
    });

    // Touch interactions
    _initSheet();
    _initLongPress();
    _initEdgeSwipe(); // must be before _setPanel so _edgeEl exists

    // Start on accounts panel
    _setPanel(ACCOUNTS);

    // Badge refresh
    setInterval(_updateBadge, 8000);
    setTimeout(_updateBadge, 1500);

    // Patch mutual exclusion after all DOMContentLoaded handlers have run
    setTimeout(_patchMutualExclusion, 0);
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;');
  }

  return { init, showList, close, goToSidebar, toggle };
})();
