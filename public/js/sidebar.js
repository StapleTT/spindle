/**
 * sidebar.js — Account list, expandable folder trees, sidebar rendering.
 */

const Sidebar = (() => {
  // Per-account folder cache.
  // Values: undefined = not yet requested, null = loading, Array = loaded, {error:true} = failed
  const _folders = new Map();

  // Which account was active the last time render() ran.
  // Used to decide whether setActive() needs a full re-render or just a CSS update.
  let _renderedAcct = null;

  // ── Render ─────────────────────────────────────────────────────────
  function render() {
    const activeAcct   = App.activeAcct;
    const activeFolder = App.activeFolder;
    _renderedAcct = String(activeAcct);

    const accounts  = App.accounts;
    const inboxList = document.getElementById('inbox-list');
    if (!inboxList) return;

    inboxList.innerHTML = '';

    // ── All Inboxes card ──────────────────────────────────────────────
    const totalUnread = accounts.reduce((sum, a) =>
      sum + (App.unreadCounts[a.id] || 0), 0);

    const allCard = document.createElement('div');
    allCard.className = 'folder folder-all' + (activeAcct === 'all' ? ' active' : '');
    allCard.dataset.acctId = 'all';
    allCard.innerHTML = `
      <div class="f-name">all inboxes</div>
      <div class="f-count">${totalUnread || '—'}</div>
      <div class="f-meta">${accounts.length} account${accounts.length !== 1 ? 's' : ''}</div>`;
    allCard.onclick = () => App.selectAllInboxes();
    inboxList.appendChild(allCard);

    const sep = document.createElement('div');
    sep.className = 'folder-sep';
    inboxList.appendChild(sep);

    if (accounts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'folder';
      empty.style.cssText = 'opacity:.5;cursor:default';
      empty.innerHTML = `<div class="f-name">no accounts</div><div class="f-meta">add one below</div>`;
      inboxList.appendChild(empty);
      return;
    }

    // ── Per-account rows + folder trees ───────────────────────────────
    accounts.forEach(acct => {
      const acctIdStr = String(acct.id);
      const isOpen    = acctIdStr === String(activeAcct) && activeAcct !== 'all';
      const unread    = App.unreadCounts[acct.id] || 0;

      const item = document.createElement('div');
      item.className = 'folder' + (isOpen ? ' folder-open' : '');
      item.dataset.acctId = acctIdStr;
      item.innerHTML = `
        <div class="f-name">${esc(acct.display_name || acct.email_address)}</div>
        <div class="f-count">${unread || '—'}</div>
        <div class="f-meta">${esc(acct.email_address)}</div>`;
      item.onclick = () => App.selectAccount(acct.id, 'INBOX');
      inboxList.appendChild(item);

      if (!isOpen) return;

      // ── Folder tree ─────────────────────────────────────────────
      const cached = _folders.get(acctIdStr);

      if (cached === undefined) {
        // Not yet requested — start load, show placeholder
        _startLoad(acct.id);
        inboxList.appendChild(_mkLoading());
      } else if (cached === null) {
        // Loading in progress
        inboxList.appendChild(_mkLoading());
      } else if (Array.isArray(cached)) {
        cached.forEach(folder => {
          // For OAuth providers the stored activeFolder may be the generic 'INBOX'
          // string while folder.id is an opaque provider ID. Fall back to matching
          // by display name so the inbox row is highlighted on initial selection.
          const isActive =
            folder.id === activeFolder ||
            (activeFolder === 'INBOX' && folder.name.toLowerCase() === 'inbox');
          const isInbox = folder.name.toLowerCase() === 'inbox';
          const rawCount = isInbox
            ? (App.unreadCounts[acct.id] || 0)
            : folder.unread;
          const count = rawCount > 0 ? rawCount : '';

          const fi = document.createElement('div');
          fi.className = 'folder-tree-item' + (isActive ? ' active' : '');
          fi.dataset.folder = folder.id;
          fi.innerHTML = `
            <div class="ft-name">${esc(folder.name.toLowerCase())}</div>
            <div class="ft-count">${count}</div>`;
          fi.onclick = () => App.selectFolder(acct.id, folder.id);
          inboxList.appendChild(fi);
        });
      }
      // If {error:true}: show nothing — account card still navigates to INBOX
    });
  }

  // ── Folder loading ──────────────────────────────────────────────────
  function _mkLoading() {
    const el = document.createElement('div');
    el.className = 'folder-tree-loading';
    el.textContent = 'loading…';
    return el;
  }

  function _startLoad(accountId) {
    const key = String(accountId);
    if (_folders.has(key)) return; // Already in progress or cached
    _folders.set(key, null);       // Sentinel: loading

    API.get(`/api/email/${accountId}/folders`)
      .then(data => {
        _folders.set(key, Array.isArray(data) ? data : []);
        render();
      })
      .catch(err => {
        console.error(`[sidebar] folder load failed for account ${accountId}:`, err);
        _folders.set(key, { error: true });
        render();
      });
  }

  // ── Active state ────────────────────────────────────────────────────
  function setActive(accountId, folder) {
    // Switching accounts (or to/from 'all') requires a full re-render to
    // show or hide the folder tree.
    if (String(accountId) !== _renderedAcct) {
      render();
      return;
    }

    // Same account, different folder — just update CSS classes.
    document.querySelectorAll('#inbox-list .folder-tree-item').forEach(el => {
      const match = el.dataset.folder === folder ||
        (folder === 'INBOX' && el.querySelector('.ft-name')?.textContent === 'inbox');
      el.classList.toggle('active', match);
    });
    document.querySelectorAll('#system-list .folder').forEach(el =>
      el.classList.remove('active'));
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { render, setActive };
})();
