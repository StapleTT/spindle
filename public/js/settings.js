const Settings = (() => {
  let _modal = null;

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Open / close ──────────────────────────────────────────────────
  function open() {
    if (_modal) return;
    const theme      = App.user ? App.user.theme || 'system' : 'system';
    const autoImages = App.user ? !!App.user.auto_load_images : false;

    _modal = document.createElement('div');
    _modal.className = 'modal-bg';
    _modal.id = 'settings-modal';
    _modal.innerHTML = `
      <div class="modal modal-narrow" role="dialog" aria-label="settings">
        <div class="modal-header">
          <span>// settings</span>
          <span class="modal-close" id="st-close">[ esc ]</span>
        </div>
        <div class="modal-body" style="gap:24px">

          <div>
            <div class="modal-section-label" style="padding:0 0 10px;border:none">
              <span class="slash">//</span>appearance
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px">
              <span style="font-size:12px;color:var(--fg-dim)">
                theme — <span id="st-theme-label" style="color:var(--fg-bright)">${theme}</span>
              </span>
              <button class="chip" id="st-theme-btn">[ cycle theme ]</button>
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:16px">
              <span style="font-size:12px;color:var(--fg-dim)">
                remote images — <span id="st-images-label" style="color:var(--fg-bright)">${autoImages ? 'auto-load' : 'blocked'}</span>
              </span>
              <button class="chip" id="st-images-btn">[ toggle ]</button>
            </div>
          </div>

          <div style="height:1px;background:var(--line-2)"></div>

          <div>
            <div class="modal-section-label" style="padding:0 0 10px;border:none">
              <span class="slash">//</span>inboxes
            </div>
            <div id="st-inboxes-list"></div>
            <button class="chip" id="st-add-inbox" style="margin-top:12px">[ + add inbox ]</button>
          </div>

          <div style="height:1px;background:var(--line-2)"></div>

          <div>
            <div class="modal-section-label" style="padding:0 0 10px;border:none">
              <span class="slash">//</span>danger zone
            </div>
            <button class="btn" id="st-delete" style="color:#d4736c;border-color:rgba(212,115,108,0.3)">
              [ delete account ]
            </button>
          </div>

        </div>
      </div>`;

    document.body.appendChild(_modal);

    document.getElementById('st-close').onclick = close;
    _modal.addEventListener('click', e => { if (e.target === _modal) close(); });
    document.addEventListener('keydown', _escHandler);

    document.getElementById('st-theme-btn').onclick = async () => {
      await App.toggleTheme();
      const lbl = document.getElementById('st-theme-label');
      if (lbl) lbl.textContent = App.user.theme || 'system';
    };

    document.getElementById('st-images-btn').onclick = async () => {
      const next = await App.toggleImages();
      const lbl = document.getElementById('st-images-label');
      if (lbl) lbl.textContent = next ? 'auto-load' : 'blocked';
    };

    document.getElementById('st-add-inbox').onclick = () => {
      close();
      Accounts.openAddModal();
    };

    document.getElementById('st-delete').onclick = deleteAccount;

    renderInboxList();
  }

  function close() {
    if (_modal) { _modal.remove(); _modal = null; }
    document.removeEventListener('keydown', _escHandler);
  }

  function _escHandler(e) { if (e.key === 'Escape') close(); }
  function toggle() { _modal ? close() : open(); }

  // ── Inbox list ────────────────────────────────────────────────────
  function renderInboxList() {
    const el = document.getElementById('st-inboxes-list');
    if (!el) return;
    const accounts = App.accounts;

    if (accounts.length === 0) {
      el.innerHTML = `<div style="font-size:12px;color:var(--fg-dim);padding:4px 0">no inboxes connected.</div>`;
      return;
    }

    el.innerHTML = '';
    accounts.forEach((acct, i) => {
      const row = document.createElement('div');
      row.className = 'st-inbox-row';

      const name = document.createElement('span');
      name.className = 'st-inbox-name';
      name.textContent = acct.display_name || acct.email_address;
      name.title = acct.email_address;

      const provider = document.createElement('span');
      provider.className = 'st-inbox-provider';
      provider.textContent = acct.provider || 'imap';

      const btns = document.createElement('div');
      btns.className = 'st-inbox-btns';

      const upBtn = document.createElement('button');
      upBtn.className = 'st-reorder-btn';
      upBtn.textContent = '↑';
      upBtn.title = 'move up';
      upBtn.disabled = i === 0;
      upBtn.onclick = () => moveInbox(i, -1);

      const downBtn = document.createElement('button');
      downBtn.className = 'st-reorder-btn';
      downBtn.textContent = '↓';
      downBtn.title = 'move down';
      downBtn.disabled = i === accounts.length - 1;
      downBtn.onclick = () => moveInbox(i, 1);

      const removeBtn = document.createElement('button');
      removeBtn.className = 'st-remove-btn';
      removeBtn.textContent = '[ remove ]';
      removeBtn.onclick = () => deleteInbox(acct);

      btns.append(upBtn, downBtn, removeBtn);
      row.append(name, provider, btns);
      el.appendChild(row);
    });
  }

  async function moveInbox(index, direction) {
    const accts  = [...App.accounts];
    const newIdx = index + direction;
    if (newIdx < 0 || newIdx >= accts.length) return;

    [accts[index], accts[newIdx]] = [accts[newIdx], accts[index]];
    const order = accts.map((a, i) => ({ id: a.id, sort_order: i }));

    try {
      await API.patch('/api/accounts/reorder', { order });
      await App.loadAccounts();
      renderInboxList();
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  async function deleteInbox(acct) {
    const label    = acct.display_name || acct.email_address;
    const password = prompt(`Enter your password to remove "${label}":`);
    if (!password) return;
    try {
      await API.delete(`/api/accounts/${acct.id}`, { password });
      Toast.show(`"${label}" removed.`);
      await App.loadAccounts();
      renderInboxList();
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  // ── Delete Spindle account ────────────────────────────────────────
  async function deleteAccount() {
    const password = prompt('Enter your password to confirm account deletion:');
    if (!password) return;
    if (!confirm('This is permanent. Delete your Spindle account and all connected inboxes?')) return;
    try {
      await API.delete('/api/settings/account', { password });
      location.href = '/auth';
    } catch (e) {
      Toast.show(e.message || 'Deletion failed', 'err');
    }
  }

  return { open, close, toggle, deleteAccount };
})();
