const Admin = (() => {
  let _modal = null;

  // ── Open / close ──────────────────────────────────────────────────
  function open() {
    if (_modal) return;
    _modal = document.createElement('div');
    _modal.className = 'modal-bg';
    _modal.id = 'admin-modal';
    _modal.innerHTML = `
      <div class="modal modal-narrow" role="dialog" aria-label="admin panel">
        <div class="modal-header">
          <span>// admin</span>
          <span class="modal-close" id="adm-close">[ esc ]</span>
        </div>
        <div class="modal-body" style="gap:24px">

          <div>
            <div class="modal-section-label" style="padding:0 0 10px;border:none">
              <span class="adm-users-label">// users</span>
            </div>
            <div id="admin-users"><div class="empty-hint">loading…</div></div>
          </div>

          <div style="height:1px;background:var(--line-2)"></div>

          <div>
            <div class="modal-section-label" style="padding:0 0 10px;border:none;display:flex;align-items:center;justify-content:space-between">
              <span class="adm-codes-label">// invite codes</span>
              <button class="chip" id="adm-gen-btn">[ + generate ]</button>
            </div>
            <div id="admin-codes"><div class="empty-hint">loading…</div></div>
          </div>

        </div>
      </div>`;

    document.body.appendChild(_modal);

    document.getElementById('adm-close').onclick = close;
    _modal.addEventListener('click', e => { if (e.target === _modal) close(); });
    document.addEventListener('keydown', _escHandler);

    document.getElementById('adm-gen-btn').onclick = generateCode;

    loadUsers();
    loadInviteCodes();
  }

  function close() {
    if (_modal) { _modal.remove(); _modal = null; }
    document.removeEventListener('keydown', _escHandler);
  }

  function _escHandler(e) { if (e.key === 'Escape') close(); }
  function toggle() { _modal ? close() : open(); }

  // ── Users ─────────────────────────────────────────────────────────
  async function loadUsers() {
    try {
      const users = await API.get('/api/admin/users');
      renderUsersTable(users);
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  function renderUsersTable(users) {
    const container = document.getElementById('admin-users');
    if (!container) return;
    if (!users.length) { container.innerHTML = '<div class="empty-hint">no users</div>'; return; }

    const meId = App.user ? App.user.id : null;

    const usersHeader = document.querySelector('#admin-modal .adm-users-label');
    if (usersHeader) usersHeader.textContent = `// users (${users.length})`;

    container.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--fg-dim);border-bottom:1px solid var(--line)">
        <th style="text-align:left;padding:8px 0">username</th>
        <th style="text-align:left;padding:8px 0">role</th>
        <th style="text-align:left;padding:8px 0">joined</th>
        <th style="text-align:right;padding:8px 0">actions</th>
      </tr></thead>
      <tbody>${users.map(u => {
        const isMe = u.id === meId;
        const nameCell = `<td style="padding:8px 0;color:var(--fg-bright)">${esc(u.username)}</td>`;
        const roleCell = `<td style="padding:8px 24px 8px 0">${esc(u.role)}</td>`;
        const joinedCell = `<td style="padding:8px 0">${esc(u.created_at ? new Date(u.created_at).toLocaleDateString() : '—')}</td>`;
        const actionsCell = isMe
          ? `<td style="padding:8px 0;text-align:right"><span style="color:var(--fg-dimmer);font-size:11px">you</span></td>`
          : `<td style="padding:8px 0;text-align:right;white-space:nowrap">
              <button class="chip" onclick="Admin.toggleUserRole(${u.id})" style="margin-left:4px">[→${u.role === 'admin' ? 'user' : 'admin'}]</button>
              <button class="chip" style="margin-left:4px;color:#d4736c;border-color:rgba(212,115,108,0.3)" onclick="Admin.confirmDeleteUser(${u.id},'${esc(u.username)}')">[ del ]</button>
            </td>`;
        return `<tr style="border-bottom:1px solid var(--line-2)">${nameCell}${roleCell}${joinedCell}${actionsCell}</tr>`;
      }).join('')}</tbody>
    </table>`;
  }

  async function toggleUserRole(userId) {
    try {
      const data = await API.patch(`/api/admin/users/${userId}/role`, {});
      Toast.show(`Role updated to ${data.role}`);
      await loadUsers();
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  function confirmDeleteUser(userId, username) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-bg';
    overlay.innerHTML = `
      <div class="modal modal-narrow" role="dialog" aria-label="delete user">
        <div class="modal-header">
          <span>// delete user</span>
          <span class="modal-close" id="du-close">[ esc ]</span>
        </div>
        <div class="modal-body" style="gap:20px">

          <div style="font-size:12px;color:var(--fg-dim);line-height:1.7;border-left:2px solid rgba(212,115,108,0.5);padding-left:14px">
            permanently delete <span style="color:var(--fg-bright)">${esc(username)}</span>.<br>
            all their connected inboxes and credentials will be removed. this cannot be undone.
          </div>

          <div class="field">
            <div class="field-label">your password to confirm</div>
            <input class="input" id="du-password" type="password" placeholder="your current password" autocomplete="current-password">
          </div>

          <div id="du-error" style="display:none;font-size:11.5px;color:#d4736c;align-items:center;gap:8px">
            <span>—</span><span id="du-error-msg"></span>
          </div>

        </div>
        <div class="modal-footer">
          <button class="btn" id="du-cancel" style="width:auto;padding:10px 18px;color:var(--fg-dim)">[ cancel ]</button>
          <button class="btn" id="du-submit" disabled style="width:auto;padding:10px 18px;color:#d4736c;border-color:rgba(212,115,108,0.35);opacity:0.45;cursor:not-allowed">
            [ delete user ]
          </button>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const passEl   = overlay.querySelector('#du-password');
    const submitEl = overlay.querySelector('#du-submit');
    const errorEl  = overlay.querySelector('#du-error');
    const errorMsg = overlay.querySelector('#du-error-msg');

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

    overlay.querySelector('#du-close').onclick  = closeOverlay;
    overlay.querySelector('#du-cancel').onclick = closeOverlay;
    overlay.addEventListener('click', e => { if (e.target === overlay) closeOverlay(); });
    document.addEventListener('keydown', escHandler);

    passEl.addEventListener('keydown', e => { if (e.key === 'Enter' && !submitEl.disabled) doDelete(); });
    submitEl.onclick = doDelete;

    async function doDelete() {
      if (submitEl.disabled) return;
      submitEl.disabled = true;
      submitEl.textContent = '[ deleting… ]';
      errorEl.style.display = 'none';

      try {
        await API.delete(`/api/admin/users/${userId}`, { password: passEl.value });
        closeOverlay();
        Toast.show(`"${username}" deleted.`);
        await loadUsers();
      } catch (e) {
        errorMsg.textContent = e.message || 'Incorrect password';
        errorEl.style.display = 'flex';
        submitEl.disabled = false;
        submitEl.textContent = '[ delete user ]';
        updateSubmit();
        passEl.focus();
      }
    }

    setTimeout(() => passEl.focus(), 50);
  }

  // ── Invite codes ──────────────────────────────────────────────────
  async function loadInviteCodes() {
    try {
      const codes = await API.get('/api/admin/invite-codes');
      renderCodesTable(codes);
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  function renderCodesTable(codes) {
    const container = document.getElementById('admin-codes');
    if (!container) return;

    const active = codes.filter(c => !c.used_by && !c.revoked);
    const used   = codes.filter(c => c.used_by);

    const codesHeader = document.querySelector('#admin-modal .adm-codes-label');
    if (codesHeader) codesHeader.textContent = `// invite codes (${active.length} active)`;

    let html = '';

    if (!active.length) {
      html += '<div class="empty-hint" style="margin-bottom:8px">no active codes — generate one above</div>';
    } else {
      html += `<table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:${used.length ? '12px' : '0'}">
        <thead><tr style="color:var(--fg-dim);border-bottom:1px solid var(--line)">
          <th style="text-align:left;padding:8px 0">code</th>
          <th style="text-align:left;padding:8px 0">created</th>
          <th style="text-align:right;padding:8px 0"></th>
        </tr></thead>
        <tbody>${active.map(c => `<tr style="border-bottom:1px solid var(--line-2)">
          <td style="padding:8px 0;font-family:monospace;color:var(--fg-bright)">${esc(c.code)}</td>
          <td style="padding:8px 0">${esc(c.created_at ? new Date(c.created_at).toLocaleDateString() : '—')}</td>
          <td style="padding:8px 0;text-align:right">
            <button class="chip" style="color:#d4736c;border-color:rgba(212,115,108,0.3)" onclick="Admin.revokeCode('${esc(c.code)}')">[ revoke ]</button>
          </td>
        </tr>`).join('')}</tbody>
      </table>`;
    }

    if (used.length) {
      html += `<details style="font-size:12px;color:var(--fg-dim)">
        <summary style="cursor:pointer;list-style:none;display:flex;align-items:center;gap:6px;padding:4px 0;user-select:none">
          <span style="font-size:10px">▶</span>
          <span style="color:var(--fg-dim)">// used codes (${used.length})</span>
        </summary>
        <table style="width:100%;border-collapse:collapse;margin-top:8px">
          <thead><tr style="color:var(--fg-dim);border-bottom:1px solid var(--line)">
            <th style="text-align:left;padding:6px 0">code</th>
            <th style="text-align:left;padding:6px 0">used by</th>
            <th style="text-align:left;padding:6px 0">created</th>
          </tr></thead>
          <tbody style="opacity:0.6">${used.map(c => `<tr style="border-bottom:1px solid var(--line-2)">
            <td style="padding:6px 0;font-family:monospace">${esc(c.code)}</td>
            <td style="padding:6px 0">${esc(c.used_by_username || '—')}</td>
            <td style="padding:6px 0">${esc(c.created_at ? new Date(c.created_at).toLocaleDateString() : '—')}</td>
          </tr>`).join('')}</tbody>
        </table>
      </details>`;
    }

    container.innerHTML = html;
  }

  async function generateCode() {
    try {
      const data = await API.post('/api/admin/invite-codes', {});
      Toast.show(`Code generated: ${data.code}`, 'ok');
      await loadInviteCodes();
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  async function revokeCode(code) {
    try {
      await API.delete(`/api/admin/invite-codes/${code}`);
      Toast.show('Code revoked');
      await loadInviteCodes();
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  return { open, close, toggle, toggleUserRole, confirmDeleteUser, generateCode, revokeCode };
})();
