/**
 * app.js — Main app init, global state, routing.
 *
 * State shape:
 *   App.user        — { id, username, role, theme }
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

    await loadAccounts();

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
    if (state.accounts.length > 0 && !state.activeAcct) {
      selectAccount(state.accounts[0].id);
    } else if (state.accounts.length === 0) {
      EmailList.clear();
      Reader.showEmpty();
    }
  }

  function selectAccount(accountId, folder) {
    state.activeAcct   = accountId;
    state.activeFolder = folder || 'INBOX';
    state.activeMsg    = null;
    Sidebar.setActive(accountId, state.activeFolder);
    EmailList.load(accountId, state.activeFolder);
    Reader.showFolderEmpty();
  }

  function selectFolder(accountId, folder) {
    state.activeAcct   = accountId;
    state.activeFolder = folder;
    state.activeMsg    = null;
    Sidebar.setActive(accountId, folder);
    EmailList.load(accountId, folder);
    Reader.showFolderEmpty();
  }

  // ── Theme ─────────────────────────────────────────────────────────
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme || 'dark';
  }

  async function toggleTheme() {
    const next = (state.user.theme === 'light') ? 'dark' : 'light';
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
    location.href = '/login.html';
  }

  // ── Background refresh (every 60 s) ──────────────────────────────
  function scheduleRefresh() {
    setInterval(async () => {
      if (!state.activeAcct) return;
      try {
        // Refresh the active account's folder silently
        await EmailList.refresh(state.activeAcct, state.activeFolder);
      } catch (_) {}
    }, 60_000);
  }

  return {
    init,
    loadAccounts,
    selectAccount,
    selectFolder,
    toggleTheme,
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
    case 'c': Composer.open(); break;
    case 'r': Reader.reply(); break;
    case 'e': Reader.archive(); break;
    case '#': Reader.deleteMsg(); break;
    case 'u': Reader.toggleRead(); break;
  }
});

document.addEventListener('DOMContentLoaded', () => App.init());
