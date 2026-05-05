/**
 * sidebar.js — Account list, folder navigation, sidebar rendering.
 */

const Sidebar = (() => {
  // ── Render ─────────────────────────────────────────────────────
  function render() {
    const accounts  = App.accounts;
    const inboxList = document.getElementById('inbox-list');
    if (!inboxList) return;

    inboxList.innerHTML = '';

    if (accounts.length === 0) {
      inboxList.innerHTML = `<div class="folder" style="opacity:.5;cursor:default">
        <div class="f-name">no accounts</div>
        <div class="f-meta">add one below</div>
      </div>`;
      return;
    }

    accounts.forEach(acct => {
      const unread = App.unreadCounts[acct.id] || acct.unread_count || 0;
      const item = document.createElement('div');
      item.className = 'folder';
      item.dataset.acctId = acct.id;
      item.dataset.folder = 'INBOX';
      item.innerHTML = `
        <div class="f-name">${esc(acct.display_name || acct.email_address)}</div>
        <div class="f-count">${unread || '—'}</div>
        <div class="f-meta">${esc(acct.email_address)}</div>`;
      item.onclick = () => App.selectAccount(acct.id, 'INBOX');
      inboxList.appendChild(item);
    });
  }

  function setActive(accountId, folder) {
    document.querySelectorAll('#inbox-list .folder').forEach(el => {
      el.classList.toggle('active',
        el.dataset.acctId == accountId && (el.dataset.folder || 'INBOX') === folder);
    });
    document.querySelectorAll('#system-list .folder').forEach(el => {
      el.classList.remove('active');
    });
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { render, setActive };
})();
