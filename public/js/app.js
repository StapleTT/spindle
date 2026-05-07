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
    user:          null,
    accounts:      [],
    activeAcct:    null,
    activeFolder:  'INBOX',
    activeMsg:     null,
    unreadCounts:  {}, // { accountId: count }
  };

  // ── Boot ─────────────────────────────────────────────────────────
  async function init() {
    try {
      state.user = await API.get('/api/auth/me');
    } catch {
      return; // API.get redirects to login on 401
    }

    applyTheme(state.user.theme);
    updateDocTitle();
    const tbUser = document.getElementById('tb-username');
    if (tbUser) tbUser.textContent = state.user.username;

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
    state.activeAcct   = accountId;
    state.activeFolder = f;
    state.activeMsg    = null;
    Sidebar.setActive(accountId, f);
    EmailList.load(accountId, f);
    Reader.showFolderEmpty();
  }

  function selectFolder(accountId, folder) {
    if (state.activeAcct === accountId && state.activeFolder === folder) return;
    state.activeAcct   = accountId;
    state.activeFolder = folder;
    state.activeMsg    = null;
    Sidebar.setActive(accountId, folder);
    EmailList.load(accountId, folder);
    Reader.showFolderEmpty();
  }

  function selectAllInboxes() {
    if (state.activeAcct === 'all') return;
    state.activeAcct   = 'all';
    state.activeFolder = 'INBOX';
    state.activeMsg    = null;
    Sidebar.setActive('all', 'INBOX');
    EmailList.loadAll();
    Reader.showFolderEmpty();
  }

  // ── Theme ─────────────────────────────────────────────────────────
  function applyTheme(theme) {
    if (!theme || theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      document.documentElement.dataset.theme = prefersDark ? 'dark' : 'light';
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
    document.title = total > 0 ? `(${total}) Spindle` : 'Spindle';
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

  return {
    init,
    loadAccounts,
    refreshUnreadCounts,
    selectAccount,
    selectFolder,
    selectAllInboxes,
    toggleTheme,
    toggleImages,
    logout,
    applyTheme,
    updateDocTitle,
    get user()        { return state.user; },
    get accounts()    { return state.accounts; },
    get activeAcct()  { return state.activeAcct; },
    get activeFolder(){ return state.activeFolder; },
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
  }
});

document.addEventListener('DOMContentLoaded', () => App.init());
