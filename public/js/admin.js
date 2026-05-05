/**
 * admin.js — Admin panel: users table, invite code management.
 * Phase 9 implementation.
 */

const Admin = (() => {
  async function loadUsers() {
    try {
      const users = await API.get('/api/admin/users');
      renderUsersTable(users);
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  async function loadInviteCodes() {
    try {
      const codes = await API.get('/api/admin/invite-codes');
      renderCodesTable(codes);
    } catch (e) {
      Toast.show(e.message, 'err');
    }
  }

  async function generateCode() {
    try {
      const code = await API.post('/api/admin/invite-codes', {});
      Toast.show(`Code generated: ${code.code}`, 'ok');
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

  function renderUsersTable(users) {
    const container = document.getElementById('admin-users');
    if (!container) return;
    if (!users.length) { container.innerHTML = '<div class="empty-hint">no users</div>'; return; }
    container.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--fg-dim);border-bottom:1px solid var(--line)">
        <th style="text-align:left;padding:8px 0">username</th>
        <th style="text-align:left;padding:8px 0">role</th>
        <th style="text-align:left;padding:8px 0">joined</th>
        <th style="text-align:left;padding:8px 0">invite used</th>
      </tr></thead>
      <tbody>${users.map(u => `<tr style="border-bottom:1px solid var(--line-2)">
        <td style="padding:8px 0;color:var(--fg-bright)">${esc(u.username)}</td>
        <td style="padding:8px 0">${esc(u.role)}</td>
        <td style="padding:8px 0">${esc(u.created_at ? new Date(u.created_at).toLocaleDateString() : '—')}</td>
        <td style="padding:8px 0;font-family:monospace">${esc(u.invite_code_used||'—')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function renderCodesTable(codes) {
    const container = document.getElementById('admin-codes');
    if (!container) return;
    container.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="color:var(--fg-dim);border-bottom:1px solid var(--line)">
        <th style="text-align:left;padding:8px 0">code</th>
        <th style="text-align:left;padding:8px 0">used by</th>
        <th style="text-align:left;padding:8px 0">created</th>
        <th style="text-align:left;padding:8px 0"></th>
      </tr></thead>
      <tbody>${codes.map(c => `<tr style="border-bottom:1px solid var(--line-2)${c.revoked?' opacity:.5':''}">
        <td style="padding:8px 0;font-family:monospace;color:var(--fg-bright)">${esc(c.code)}</td>
        <td style="padding:8px 0">${esc(c.used_by_username||'unused')}</td>
        <td style="padding:8px 0">${esc(c.created_at?new Date(c.created_at).toLocaleDateString():'—')}</td>
        <td style="padding:8px 0;text-align:right">${!c.used_by&&!c.revoked
          ?`<button class="chip" onclick="Admin.revokeCode('${esc(c.code)}')">revoke</button>`
          :(c.revoked?'<span style="color:var(--fg-dimmer)">revoked</span>':'')}</td>
      </tr>`).join('')}</tbody>
    </table>`;
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  return { loadUsers, loadInviteCodes, generateCode, revokeCode };
})();
