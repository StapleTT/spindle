/**
 * accounts.js — Add inbox modal (provider picker + IMAP/SMTP form).
 *               Also handles OAuth redirect callbacks.
 */

const Accounts = (() => {
  let _modal = null;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Provider picker icons ─────────────────────────────────────────
  const ICON_IMAP = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
    <rect x="6" y="9" width="28" height="9" rx="1"/><rect x="6" y="22" width="28" height="9" rx="1"/>
    <circle cx="11" cy="13.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="11" cy="26.5" r="1.2" fill="currentColor" stroke="none"/>
    <line x1="16" y1="13.5" x2="28" y2="13.5"/><line x1="16" y1="26.5" x2="28" y2="26.5"/>
  </svg>`;
  const ICON_GMAIL   = `<img src="/img/gmail.png"   width="40" height="40" style="object-fit:contain" alt="Gmail">`;
  const ICON_OUTLOOK = `<img src="/img/outlook.png" width="40" height="40" style="object-fit:contain" alt="Outlook">`;
  const ICON_ICLOUD  = `<img src="/img/icloud.png"  width="40" height="40" style="object-fit:contain" alt="iCloud Mail">`;

  const PROVIDERS = [
    { id: 'imap',    name: 'manual imap / smtp', icon: ICON_IMAP,    enabled: true },
    { id: 'gmail',   name: 'gmail',              icon: ICON_GMAIL,   enabled: false, badge: 'oauth — coming soon' },
    { id: 'outlook', name: 'outlook',            icon: ICON_OUTLOOK, enabled: false, badge: 'oauth — coming soon' },
    { id: 'icloud',  name: 'icloud mail',        icon: ICON_ICLOUD,  enabled: false, badge: 'oauth — coming soon' },
  ];

  // IMAP presets
  const PRESETS = {
    yahoo:  { imap_host:'imap.mail.yahoo.com',  imap_port:'993', smtp_host:'smtp.mail.yahoo.com',  smtp_port:'587' },
    icloud: { imap_host:'imap.mail.me.com',     imap_port:'993', smtp_host:'smtp.mail.me.com',     smtp_port:'587' },
  };

  // ── Open modal ────────────────────────────────────────────────────
  function openAddModal() {
    if (_modal) _modal.remove();
    _modal = document.createElement('div');
    _modal.className = 'modal-bg';
    _modal.id = 'add-provider-modal';
    _modal.innerHTML = buildPickerHTML();
    document.body.appendChild(_modal);

    _modal.addEventListener('click', e => { if (e.target === _modal) closeModal(); });
    document.getElementById('ap-close').onclick = closeModal;
    wirePicker();
  }

  function closeModal() {
    if (_modal) { _modal.remove(); _modal = null; }
  }

  // ── Picker step ───────────────────────────────────────────────────
  function buildPickerHTML() {
    const tiles = PROVIDERS.map(p => `
      <div class="provider-tile${p.enabled ? '' : ' disabled'}" data-provider="${p.id}">
        <div class="p-icon">${p.icon}</div>
        <div class="p-name">${esc(p.name)}</div>
        ${p.badge ? `<div class="p-badge">${esc(p.badge)}</div>` : ''}
      </div>`).join('');

    return `<div class="modal modal-narrow modal-tall" role="dialog">
      <div class="modal-header">
        <span id="ap-title">// add email provider</span>
        <span class="modal-close" id="ap-close">×</span>
      </div>
      <div id="ap-content">
        <div class="provider-grid">${tiles}</div>
      </div>
    </div>`;
  }

  function wirePicker() {
    document.querySelectorAll('.provider-tile:not(.disabled)').forEach(tile => {
      tile.onclick = () => showIMAPForm(tile.dataset.provider);
    });
  }

  // ── IMAP/SMTP form step ───────────────────────────────────────────
  function showIMAPForm(providerId) {
    const preset = PRESETS[providerId] || {};
    document.getElementById('ap-title').innerHTML =
      `<span class="modal-back" id="ap-back">← back</span>manual imap / smtp`;
    document.getElementById('ap-content').innerHTML = buildIMAPFormHTML(preset);
    document.getElementById('ap-back').onclick = () => {
      document.getElementById('ap-title').textContent = '// add email provider';
      document.getElementById('ap-content').innerHTML = `<div class="provider-grid">${
        PROVIDERS.map(p=>`<div class="provider-tile${p.enabled?'':' disabled'}" data-provider="${p.id}">
          <div class="p-icon">${p.icon}</div><div class="p-name">${esc(p.name)}</div>
          ${p.badge?`<div class="p-badge">${esc(p.badge)}</div>`:''}</div>`).join('')
      }</div>`;
      wirePicker();
    };
    document.getElementById('ap-connect').onclick = submitIMAPForm;
    // Test connection button
    document.getElementById('ap-test').onclick = testConnection;
  }

  function buildIMAPFormHTML(preset) {
    const inp = (id, placeholder, val='') =>
      `<input class="input" id="${id}" placeholder="${placeholder}" value="${esc(val)}" autocomplete="off">`;

    return `<div class="modal-scroll">
      <div class="modal-section-label"><span class="slash">//</span>account</div>
      <div class="modal-form">
        <div class="field"><div class="field-label">display name</div>${inp('ap-dname','My Email')}</div>
        <div class="field"><div class="field-label">email address</div>${inp('ap-email','user@example.com')}</div>
        <div class="field"><div class="field-label">username</div>${inp('ap-user','usually your email address')}</div>
        <div class="field"><div class="field-label">password / app password</div>
          <input class="input" id="ap-pass" type="password" autocomplete="off"></div>
      </div>
      <div class="modal-section-label"><span class="slash">//</span>imap <span class="sub">incoming</span></div>
      <div class="modal-form">
        <div class="field"><div class="field-label">host</div>${inp('ap-imap-host','imap.example.com',preset.imap_host||'')}</div>
        <div class="field-row">
          <div class="field"><div class="field-label">port</div>${inp('ap-imap-port','993',preset.imap_port||'993')}</div>
          <div class="field"><div class="field-label">security</div>
            <select class="select" id="ap-imap-sec">
              <option value="1">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
              <option value="0">None</option>
            </select></div>
        </div>
      </div>
      <div class="modal-section-label"><span class="slash">//</span>smtp <span class="sub">outgoing</span></div>
      <div class="modal-form">
        <div class="field"><div class="field-label">host</div>${inp('ap-smtp-host','smtp.example.com',preset.smtp_host||'')}</div>
        <div class="field-row">
          <div class="field"><div class="field-label">port</div>${inp('ap-smtp-port','587',preset.smtp_port||'587')}</div>
          <div class="field"><div class="field-label">security</div>
            <select class="select" id="ap-smtp-sec">
              <option value="starttls">STARTTLS</option>
              <option value="1">SSL/TLS</option>
              <option value="0">None</option>
            </select></div>
        </div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" id="ap-test" style="width:auto;padding:10px 14px;font-size:11px">[ test ]</button>
      <button class="btn" id="ap-connect" style="width:auto;padding:10px 18px">[ connect ] <span class="ret">↵</span></button>
    </div>`;
  }

  async function testConnection() {
    const payload = collectFormData();
    if (!payload) return;
    const btn = document.getElementById('ap-test');
    btn.textContent = '[ testing… ]'; btn.disabled = true;
    try {
      await API.post('/api/accounts/test', payload);
      Toast.show('Connection successful', 'ok');
    } catch (e) {
      Toast.show('Connection failed: ' + e.message, 'err');
    } finally {
      btn.textContent = '[ test ]'; btn.disabled = false;
    }
  }

  async function submitIMAPForm() {
    const payload = collectFormData();
    if (!payload) return;
    const btn = document.getElementById('ap-connect');
    btn.disabled = true; btn.innerHTML = '[ connecting… ]';
    try {
      await API.post('/api/accounts', payload);
      Toast.show('Account added', 'ok');
      closeModal();
      await App.loadAccounts();
    } catch (e) {
      btn.disabled = false; btn.innerHTML = '[ connect ] <span class="ret">↵</span>';
      Toast.show(e.message, 'err');
    }
  }

  function collectFormData() {
    const email = document.getElementById('ap-email').value.trim();
    if (!email) { Toast.show('Email address required', 'err'); return null; }
    const user  = document.getElementById('ap-user').value.trim() || email;
    const pass  = document.getElementById('ap-pass').value;
    if (!pass)  { Toast.show('Password required', 'err'); return null; }

    const imapHost = document.getElementById('ap-imap-host').value.trim();
    const smtpHost = document.getElementById('ap-smtp-host').value.trim();
    if (!imapHost) { Toast.show('IMAP host required', 'err'); return null; }
    if (!smtpHost) { Toast.show('SMTP host required', 'err'); return null; }

    const imapSec = document.getElementById('ap-imap-sec').value;
    const smtpSec = document.getElementById('ap-smtp-sec').value;

    return {
      display_name:  document.getElementById('ap-dname').value.trim() || email,
      email_address: email,
      provider:      'imap',
      imap_host:     imapHost,
      imap_port:     parseInt(document.getElementById('ap-imap-port').value) || 993,
      imap_secure:   imapSec === '1' ? 1 : 0,
      smtp_host:     smtpHost,
      smtp_port:     parseInt(document.getElementById('ap-smtp-port').value) || 587,
      smtp_secure:   smtpSec === '1' ? 1 : 0,
      imap_user:     user,
      password:      pass,
    };
  }

  return { openAddModal, closeModal };
})();
