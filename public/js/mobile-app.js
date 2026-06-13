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
 *  - Swipe right from reader edge → back to list
 */

const MobileNav = (() => {
  const ACCOUNTS = 'accounts';
  const LIST     = 'list';
  const READER   = 'reader';

  let _panel   = ACCOUNTS;
  let _hasList = false;

  // ── Panel switching ─────────────────────────────────────────────────────
  function _setPanel(p) {
    _panel = p;

    const accountsEl = document.getElementById('m-panel-accounts');
    const listEl     = document.getElementById('thread-list-panel');
    const readerEl   = document.getElementById('reading-pane');

    const panels = { [ACCOUNTS]: accountsEl, [LIST]: listEl, [READER]: readerEl };

    Object.entries(panels).forEach(([key, el]) => {
      if (!el) return;
      el.classList.remove('m-panel-active', 'm-panel-bg');
      if (key === p) {
        el.classList.add('m-panel-active');
      } else if (
        (p === LIST   && key === ACCOUNTS) ||
        (p === READER && key !== READER)
      ) {
        el.classList.add('m-panel-bg');
      }
    });

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

    // MutationObserver isn't needed — we use event delegation on the stable container.
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

  // ── Swipe-right from reader to go back ──────────────────────────────────
  function _initReaderSwipe() {
    const reader = document.getElementById('reading-pane');
    if (!reader) return;

    let sx = 0, sy = 0, swiping = false;

    reader.addEventListener('touchstart', e => {
      sx = e.touches[0].clientX;
      sy = e.touches[0].clientY;
      swiping = false;
    }, { passive: true });

    reader.addEventListener('touchmove', e => {
      if (swiping) return;
      const dx = e.touches[0].clientX - sx;
      const dy = Math.abs(e.touches[0].clientY - sy);
      // Edge swipe: start < 40px from left, horizontal > vertical
      if (dx > 20 && dy < 50 && sx < 50) swiping = true;
    }, { passive: true });

    reader.addEventListener('touchend', e => {
      if (!swiping) return;
      const dx = e.changedTouches[0].clientX - sx;
      if (dx > 50 && _panel === READER) _setPanel(LIST);
      swiping = false;
    }, { passive: true });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // Tab bar wiring
    const tabAcc  = document.getElementById('m-tab-accounts');
    const tabList = document.getElementById('m-tab-list');
    const tabSet  = document.getElementById('m-tab-settings');

    if (tabAcc)  tabAcc.addEventListener('click',  () => _setPanel(ACCOUNTS));
    if (tabList) tabList.addEventListener('click', () => {
      if (_hasList) _setPanel(LIST);
      else          _setPanel(ACCOUNTS);
    });
    if (tabSet)  tabSet.addEventListener('click', () => {
      if (typeof Settings !== 'undefined') Settings.toggle();
    });

    // Header back button
    const back = document.getElementById('m-header-back');
    if (back) back.addEventListener('click', () => {
      if (_panel === READER) _setPanel(LIST);
      else                   goToSidebar();
    });

    // Start on accounts panel; showList() will switch to list once email loads
    _setPanel(ACCOUNTS);

    // Touch interactions
    _initSheet();
    _initLongPress();
    _initReaderSwipe();

    // Badge refresh — hook into App's unread update cycle.
    // App.updateDocTitle() is called whenever counts change; we patch it once.
    const _schedBadge = () => {
      if (typeof App !== 'undefined' && App.updateDocTitle) {
        const orig = App.updateDocTitle.bind(App);
        // Replace via the module's returned function — App exposes it directly
        // so we just poll on a short interval after init instead of monkey-patching.
      }
      setInterval(_updateBadge, 8000);
      setTimeout(_updateBadge, 1500); // first update after App.init() resolves
    };
    _schedBadge();
  }

  function _esc(s) {
    return String(s)
      .replace(/&/g,'&amp;')
      .replace(/</g,'&lt;')
      .replace(/>/g,'&gt;');
  }

  return { init, showList, close, goToSidebar, toggle };
})();
