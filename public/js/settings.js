/**
 * settings.js — Settings panel interactions.
 * Phase 8 implementation.
 */

const Settings = (() => {
  let _open = false;

  function toggle() {
    _open = !_open;
    const panel = document.getElementById('settings-panel');
    if (panel) panel.classList.toggle('open', _open);
  }

  function close() {
    _open = false;
    const panel = document.getElementById('settings-panel');
    if (panel) panel.classList.remove('open');
  }

  async function deleteAccount() {
    const password = prompt('Enter your password to confirm account deletion:');
    if (!password) return;

    if (!confirm('This is permanent. Delete your Spindle account and all connected inboxes?')) return;

    try {
      await API.delete('/api/settings/account', { password });
      location.href = '/login.html';
    } catch (e) {
      Toast.show(e.message || 'Deletion failed', 'err');
    }
  }

  return { toggle, close, deleteAccount };
})();
