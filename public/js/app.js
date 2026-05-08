/**
 * app.js — Main app init, global state, routing.
 *
 * State shape:
 *   App.user        — { id, username, role, theme, auto_load_images }
 *   App.accounts    — array of email account objects
 *   App.activeAcct  — currently selected account id
 *   App.activeFolder— folder name (e.g. 'INBOX')
 *   App.activeMsg   — { uid, accountId, folder } | null
 */

const App = (() => {
  const state = {
    user:             null,
    accounts:         [],
    activeAcct:       null,
    activeFolder:     'INBOX',
    activeFolderName: '',
    activeMsg:        null,
    unreadCounts:     {}, // { accountId: count }
  };

  // ── Boot ─────────────────────────────────────────────────────────
  async function init() {
    try {
      state.user = await API.get('/api/auth/me');
      if (state.user.csrfToken) API.setCSRF(state.user.csrfToken);
    } catch {
      return; // API.get redirects to login on 401
    }

    applyTheme(state.user.theme);
    updateDocTitle();
    const tbUser = document.getElementById('tb-username');
    if (tbUser) tbUser.textContent = state.user.username;

    if (state.user.role === 'admin') {
      const adminBtn = document.getElementById('sys-admin');
      if (adminBtn) adminBtn.style.display = '';
    }

    await loadAccounts();

    // Fetch unread counts for all accounts immediately after loading
    await refreshUnreadCounts();

    // Handle redirect back from an OAuth provider
    handleOAuthReturn();

    // Kick off background inbox polling
    scheduleRefresh();
  }

  // ── Accounts ─────────────────────────────────────────────────────
  async function loadAccounts() {
    try {
      state.accounts = await API.get('/api/accounts');
    } catch {
      state.accounts = [];
    }
    Sidebar.render();
    // If the active account was deleted, clear the selection so a new one is picked below
    if (state.activeAcct && !state.accounts.some(a => a.id === state.activeAcct)) {
      state.activeAcct = null;
      EmailList.clear();
    }
    if (state.accounts.length > 0 && !state.activeAcct) {
      selectAllInboxes();
    } else if (state.accounts.length === 0) {
      EmailList.clear();
      Reader.showEmpty();
    }
  }

  function selectAccount(accountId, folder) {
    const f = folder || 'INBOX';
    if (state.activeAcct === accountId && state.activeFolder === f) return;
    state.activeAcct       = accountId;
    state.activeFolder     = f;
    state.activeFolderName = '';
    state.activeMsg        = null;
    Sidebar.setActive(accountId, f);
    EmailList.load(accountId, f);
    Reader.showFolderEmpty();
    if (typeof MobileNav !== 'undefined') MobileNav.showList();
  }

  function selectFolder(accountId, folder, folderName) {
    if (state.activeAcct === accountId && state.activeFolder === folder) return;
    state.activeAcct       = accountId;
    state.activeFolder     = folder;
    state.activeFolderName = folderName || '';
    state.activeMsg        = null;
    Sidebar.setActive(accountId, folder);
    EmailList.load(accountId, folder);
    Reader.showFolderEmpty();
    if (typeof MobileNav !== 'undefined') MobileNav.showList();
  }

  function selectAllInboxes() {
    if (state.activeAcct === 'all') return;
    state.activeAcct       = 'all';
    state.activeFolder     = 'INBOX';
    state.activeFolderName = '';
    state.activeMsg        = null;
    Sidebar.setActive('all', 'INBOX');
    EmailList.loadAll();
    Reader.showFolderEmpty();
    if (typeof MobileNav !== 'undefined') MobileNav.showList();
  }

  // ── Theme ─────────────────────────────────────────────────────────
  let _mqListener = null;

  function applyTheme(theme) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    // Remove any previously registered listener before deciding whether to re-add
    if (_mqListener) {
      mq.removeEventListener('change', _mqListener);
      _mqListener = null;
    }

    if (!theme || theme === 'system') {
      document.documentElement.dataset.theme = mq.matches ? 'dark' : 'light';
      // Track OS changes only while the stored preference is 'system'
      _mqListener = (e) => {
        document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
      };
      mq.addEventListener('change', _mqListener);
    } else {
      document.documentElement.dataset.theme = theme;
    }
  }

  async function toggleImages() {
    const next = !state.user.auto_load_images;
    try {
      await API.patch('/api/settings/images', { auto_load_images: next });
      state.user.auto_load_images = next;
    } catch (e) {
      Toast.show(e.message, 'err');
    }
    return next;
  }

  async function toggleTheme() {
    const current = state.user.theme;
    // Cycle: system → dark → light → system
    const next = current === 'system' ? 'dark' : current === 'dark' ? 'light' : 'system';
    try {
      await API.patch('/api/settings/theme', { theme: next });
      state.user.theme = next;
      applyTheme(next);
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  // ── Document title with unread count ─────────────────────────────
  function updateDocTitle() {
    const total = Object.values(state.unreadCounts).reduce((a, b) => a + b, 0);
    document.title = total > 0 ? `Spindle - Inbox (${total})` : 'Spindle - Inbox';
  }

  // ── Logout ───────────────────────────────────────────────────────
  async function logout() {
    try { await API.post('/api/auth/logout', {}); } catch (_) {}
    location.href = '/auth';
  }

  // ── OAuth return handling ─────────────────────────────────────────
  function handleOAuthReturn() {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('oauth_success') && !params.has('oauth_error')) return;

    history.replaceState({}, '', '/inbox');

    if (params.has('oauth_error')) {
      Toast.show(`OAuth error: ${decodeURIComponent(params.get('oauth_error'))}`, 'err');
      return;
    }

    const acctId = params.get('acct');
    const account = acctId ? state.accounts.find(a => a.id == acctId) : null;
    if (account) {
      // Prompt for a display name before adding to the sidebar
      Accounts.showNameModal(acctId, account.display_name, account.email_address);
    } else {
      Toast.show('Account connected.', 'ok');
    }
  }

  // ── Unread counts ─────────────────────────────────────────────────
  async function refreshUnreadCounts() {
    if (state.accounts.length === 0) return;
    const results = await Promise.allSettled(
      state.accounts.map(a =>
        API.get(`/api/email/${a.id}/unread`)
          .then(data => ({ id: a.id, count: data.unreadCount || 0 }))
      )
    );
    let changed = false;
    for (const r of results) {
      if (r.status === 'fulfilled') {
        state.unreadCounts[r.value.id] = r.value.count;
        changed = true;
      }
    }
    if (changed) {
      Sidebar.render();
      updateDocTitle();
    }
  }

  // ── Background refresh (every 60 s) ──────────────────────────────
  function scheduleRefresh() {
    setInterval(async () => {
      if (!state.activeAcct) return;
      try {
        // Refresh the active account's folder silently
        await EmailList.refresh(state.activeAcct, state.activeFolder);
      } catch (_) {}
      // Also refresh all unread counts in the background
      refreshUnreadCounts().catch(() => {});
    }, 60_000);
  }

  // Resets the selection guard without re-rendering anything.
  // Called by MobileNav when returning to the sidebar so the user can
  // tap the same inbox again to navigate back to the list.
  function clearSelection() {
    state.activeAcct   = null;
    state.activeFolder = 'INBOX';
  }

  return {
    init,
    loadAccounts,
    refreshUnreadCounts,
    selectAccount,
    selectFolder,
    selectAllInboxes,
    clearSelection,
    toggleTheme,
    toggleImages,
    logout,
    applyTheme,
    updateDocTitle,
    get user()        { return state.user; },
    get accounts()    { return state.accounts; },
    get activeAcct()  { return state.activeAcct; },
    get activeFolder()     { return state.activeFolder; },
    get activeFolderName() { return state.activeFolderName; },
    get activeMsg()   { return state.activeMsg; },
    set activeMsg(v)  { state.activeMsg = v; },
    get unreadCounts(){ return state.unreadCounts; },
  };
})();

/* ── Keyboard shortcuts ─────────────────────────────────────────── */
document.addEventListener('keydown', (e) => {
  // Don't fire shortcuts when typing in an input
  if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case 'c': e.preventDefault(); Composer.open(); break;
    case 'r': e.preventDefault(); Reader.reply(); break;
    case 'e': e.preventDefault(); Reader.archive(); break;
    case '#': e.preventDefault(); Reader.deleteMsg(); break;
    case 'u': e.preventDefault(); Reader.toggleRead(); break;
    case '/': e.preventDefault(); Search.open(); break;
  }
});

document.addEventListener('DOMContentLoaded', () => App.init());

/* ── Global error boundary ──────────────────────────────────────────── */
window.addEventListener('unhandledrejection', e => {
  // 401s are handled by API.request() which redirects to /auth
  if (e.reason?.status === 401) return;
  console.error('[spindle] unhandled rejection:', e.reason);
  const msg = e.reason?.message;
  if (msg) Toast.show(msg, 'err');
});

window.addEventListener('error', e => {
  if (e.error?.status === 401) return;
  console.error('[spindle] uncaught error:', e.error || e.message);
  Toast.show('An unexpected error occurred', 'err');
});
