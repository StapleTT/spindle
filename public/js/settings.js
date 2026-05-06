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

  function deleteInbox(acct) {
    const label = acct.display_name || acct.email_address;

    const overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.innerHTML = `
      <div class="modal modal-narrow" role="dialog" aria-label="remove inbox">
        <div class="modal-header">
          <span>// remove inbox</span>
          <span class="modal-close" id="di-close">[ esc ]</span>
        </div>
        <div class="modal-body" style="gap:20px">

          <div style="font-size:12px;color:var(--fg-dim);line-height:1.7">
            removing <span style="color:var(--fg-bright)">${esc(label)}</span> will disconnect it from Spindle.
            your emails are not deleted from the provider.
          </div>

          <div class="field">
            <div class="field-label">confirm password</div>
            <input class="input" id="di-password" type="password" placeholder="your current password" autocomplete="current-password">
          </div>

          <div id="di-error" style="display:none;font-size:11.5px;color:#d4736c;align-items:center;gap:8px">
            <span>—</span><span id="di-error-msg"></span>
          </div>

        </div>
        <div class="modal-footer">
          <button class="btn" id="di-cancel" style="width:auto;padding:10px 18px;color:var(--fg-dim)">[ cancel ]</button>
          <button class="btn" id="di-submit" disabled style="width:auto;padding:10px 18px;opacity:0.45;cursor:not-allowed">
            [ remove ]
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const passEl   = document.getElementById('di-password');
    const submitEl = document.getElementById('di-submit');
    const errorEl  = document.getElementById('di-error');
    const errorMsg = document.getElementById('di-error-msg');

    function updateSubmit() {
      const ready = passEl.value.length > 0;
      submitEl.disabled = !ready;
      submitEl.style.opacity = ready ? '1' : '0.45';
      submitEl.style.cursor  = ready ? 'pointer' : 'not-allowed';
    }

    passEl.addEventListener('input', updateSubmit);

    function closeOverlay() {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }

    function escHandler(e) { if (e.key === 'Escape') closeOverlay(); }

    document.getElementById('di-close').onclick  = closeOverlay;
    document.getElementById('di-cancel').onclick = closeOverlay;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });
    document.addEventListener('keydown', escHandler);

    passEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !submitEl.disabled) doRemove(); });
    submitEl.onclick = doRemove;

    async function doRemove() {
      if (submitEl.disabled) return;
      submitEl.disabled = true;
      submitEl.textContent = '[ removing… ]';
      errorEl.style.display = 'none';

      try {
        await API.delete(`/api/accounts/${acct.id}`, { password: passEl.value });
        closeOverlay();
        Toast.show(`"${label}" removed.`);
        await App.loadAccounts();
        renderInboxList();
      } catch (e) {
        errorMsg.textContent = e.message || 'Incorrect password';
        errorEl.style.display = 'flex';
        submitEl.disabled = false;
        submitEl.textContent = '[ remove ]';
        updateSubmit();
        passEl.focus();
      }
    }

    setTimeout(() => passEl.focus(), 50);
  }

  // ── Delete Spindle account ────────────────────────────────────────
  function deleteAccount() {
    // Open a dedicated confirmation modal — no native prompts
    const overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.id = 'delete-account-modal';
    overlay.innerHTML = `
      <div class="modal modal-narrow" role="dialog" aria-label="delete account">
        <div class="modal-header">
          <span>// delete account</span>
          <span class="modal-close" id="da-close">[ esc ]</span>
        </div>
        <div class="modal-body" style="gap:20px">

          <div style="font-size:12px;color:var(--fg-dim);line-height:1.7;border-left:2px solid rgba(212,115,108,0.5);padding-left:14px">
            this action is <span style="color:#d4736c">permanent</span> and cannot be undone.<br>
            your account, all connected inboxes, and all stored credentials will be deleted immediately.
          </div>

          <label style="display:flex;align-items:flex-start;gap:12px;cursor:pointer;font-size:12px;color:var(--fg-dim);line-height:1.6">
            <input type="checkbox" id="da-confirm-check" style="
              margin-top:3px;flex-shrink:0;width:14px;height:14px;
              accent-color:#d4736c;cursor:pointer
            ">
            <span>i understand that my account and all associated data will be permanently deleted and cannot be recovered</span>
          </label>

          <div class="field">
            <div class="field-label">confirm password</div>
            <input class="input" id="da-password" type="password" placeholder="your current password" autocomplete="current-password">
          </div>

          <div id="da-error" style="display:none;font-size:11.5px;color:#d4736c;display:none;align-items:center;gap:8px">
            <span>—</span><span id="da-error-msg"></span>
          </div>

        </div>
        <div class="modal-footer">
          <button class="btn" id="da-cancel" style="width:auto;padding:10px 18px;color:var(--fg-dim)">[ cancel ]</button>
          <button class="btn" id="da-submit" disabled style="width:auto;padding:10px 18px;color:#d4736c;border-color:rgba(212,115,108,0.35);opacity:0.45;cursor:not-allowed">
            [ delete account ]
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const checkEl  = document.getElementById('da-confirm-check');
    const passEl   = document.getElementById('da-password');
    const submitEl = document.getElementById('da-submit');
    const errorEl  = document.getElementById('da-error');
    const errorMsg = document.getElementById('da-error-msg');

    function updateSubmit() {
      const ready = checkEl.checked && passEl.value.length > 0;
      submitEl.disabled = !ready;
      submitEl.style.opacity = ready ? '1' : '0.45';
      submitEl.style.cursor  = ready ? 'pointer' : 'not-allowed';
    }

    checkEl.addEventListener('change', updateSubmit);
    passEl.addEventListener('input', updateSubmit);

    function closeOverlay() {
      overlay.remove();
      document.removeEventListener('keydown', escHandler);
    }

    function escHandler(e) { if (e.key === 'Escape') closeOverlay(); }

    document.getElementById('da-close').onclick  = closeOverlay;
    document.getElementById('da-cancel').onclick = closeOverlay;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });
    document.addEventListener('keydown', escHandler);

    passEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !submitEl.disabled) doDelete(); });

    submitEl.onclick = doDelete;

    async function doDelete() {
      if (submitEl.disabled) return;
      const password = passEl.value;

      submitEl.disabled = true;
      submitEl.textContent = '[ deleting… ]';
      errorEl.style.display = 'none';

      try {
        await API.delete('/api/settings/account', { password });
        location.href = '/auth';
      } catch (e) {
        errorMsg.textContent = e.message || 'Deletion failed';
        errorEl.style.display = 'flex';
        submitEl.disabled = false;
        submitEl.innerHTML = '[ delete account ]';
        updateSubmit();
        passEl.focus();
      }
    }

    // Focus the checkbox first so the user reads the warning
    setTimeout(() => checkEl.focus(), 50);
  }

  return { open, close, toggle, deleteAccount };
})();
