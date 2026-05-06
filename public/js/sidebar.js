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

    // ── All Inboxes card (always shown when there are accounts) ──
    const allCard = document.createElement('div');
    allCard.className = 'folder folder-all';
    allCard.dataset.acctId = 'all';
    allCard.dataset.folder = 'INBOX';

    const totalUnread = accounts.reduce((sum, a) =>
      sum + (App.unreadCounts[a.id] || a.unread_count || 0), 0);

    allCard.innerHTML = `
      <div class="f-name">all inboxes</div>
      <div class="f-count">${totalUnread || '—'}</div>
      <div class="f-meta">${accounts.length} account${accounts.length !== 1 ? 's' : ''}</div>`;
    allCard.onclick = () => App.selectAllInboxes();
    inboxList.appendChild(allCard);

    // Separator between All Inboxes and individual accounts
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
      const isAll = el.dataset.acctId === 'all';
      if (isAll) {
        el.classList.toggle('active', accountId === 'all');
      } else {
        el.classList.toggle('active',
          el.dataset.acctId == accountId && (el.dataset.folder || 'INBOX') === folder);
      }
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
