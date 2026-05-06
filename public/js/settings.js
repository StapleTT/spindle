const Settings = (() => {
  let _modal = null;

  function open() {
    if (_modal) return;
    const theme = App.user ? App.user.theme || 'system' : 'system';
    const themeLabel = theme === 'system' ? 'system' : theme;
    const autoImages = localStorage.getItem('autoLoadImages') === '1';

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
                theme — <span id="st-theme-label" style="color:var(--fg-bright)">${themeLabel}</span>
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

    document.getElementById('st-images-btn').onclick = () => {
      const current = localStorage.getItem('autoLoadImages') === '1';
      localStorage.setItem('autoLoadImages', current ? '0' : '1');
      const lbl = document.getElementById('st-images-label');
      if (lbl) lbl.textContent = current ? 'blocked' : 'auto-load';
    };

    document.getElementById('st-delete').onclick = deleteAccount;
  }

  function close() {
    if (_modal) { _modal.remove(); _modal = null; }
    document.removeEventListener('keydown', _escHandler);
  }

  function _escHandler(e) {
    if (e.key === 'Escape') close();
  }

  // Keep toggle() as an alias so sidebar sys-settings still works
  function toggle() { _modal ? close() : open(); }

  async function deleteAccount() {
    const password = prompt('Enter your password to confirm account deletion:');
    if (!password) return;
    if (!confirm('This is permanent. Delete your Spindle account and all connected inboxes?')) return;
    try {
      await API.delete('/api/settings/account', { password });
      location.href = '/auth.html';
    } catch (e) {
      Toast.show(e.message || 'Deletion failed', 'err');
    }
  }

  return { open, close, toggle, deleteAccount };
})();
