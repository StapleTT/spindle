/**
 * mobile.js — Mobile navigation state machine.
 *
 * Panel states (set as data-mobile-panel on .app-shell):
 *   'none'    — only the reading pane visible (default)
 *   'sidebar' — sidebar visible (account/folder list)
 *   'list'    — email list visible
 *
 * Flow:
 *   hamburger tap → sidebar (first visit) or list (after inbox selected)
 *   select inbox  → list (auto-advance)
 *   tap email     → none (close panels, show reader)
 *   back arrow    → sidebar (from list)
 *   resize to desktop → reset panel state
 */

const MobileNav = (() => {
  const MQ = window.matchMedia('(max-width: 768px)');

  let _panel   = 'none';
  let _hasList = false;

  function _isMobile() { return MQ.matches; }

  function _setPanel(p) {
    _panel = p;
    const shell = document.querySelector('.app-shell');
    if (shell) shell.dataset.mobilePanel = p;
  }

  // Called by hamburger button
  function toggle() {
    if (!_isMobile()) return;
    if (_panel !== 'none') {
      _setPanel('none');
    } else {
      _setPanel(_hasList ? 'list' : 'sidebar');
    }
  }

  // Called by App.selectAccount / selectFolder / selectAllInboxes
  function showList() {
    _hasList = true;
    if (_isMobile()) _setPanel('list');
  }

  // Called by back arrow inside the list panel
  function goToSidebar() {
    if (!_isMobile()) return;
    // Clear the selection guard so the user can tap the same inbox again
    // without being blocked by the early-return dedup check.
    // Doesn't trigger a re-render, so the sidebar still shows the last active item.
    if (typeof App !== 'undefined') App.clearSelection();
    _setPanel('sidebar');
  }

  // Called when an email is opened
  function close() {
    if (_isMobile()) _setPanel('none');
  }

  function init() {
    // Wire hamburger
    const hamburger = document.getElementById('btn-hamburger');
    if (hamburger) hamburger.onclick = toggle;

    // Insert back button at top of thread-list-panel (before the rows)
    const panel = document.getElementById('thread-list-panel');
    if (panel) {
      const back = document.createElement('div');
      back.id = 'mobile-list-back';
      back.className = 'mobile-list-back';
      back.innerHTML = '← inboxes';
      back.onclick = goToSidebar;
      const rows = document.getElementById('thread-list-rows');
      if (rows) panel.insertBefore(back, rows);
      else panel.prepend(back);
    }

    // On resize to desktop, reset panel state so layout isn't stuck
    MQ.addEventListener('change', e => {
      if (!e.matches) _setPanel('none');
    });
  }

  return { init, toggle, showList, goToSidebar, close };
})();
