/**
 * composer.js — Floating compose window: new / reply / forward.
 *
 * Usage:
 *   Composer.open()                        — new blank message
 *   Composer.openReply(msgData, acctId)    — reply to a message
 *   Composer.openForward(msgData, acctId)  — forward a message
 */

const Composer = (() => {
  let _modal     = null;
  let _minimized = false;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Open ──────────────────────────────────────────────────────────
  let _fromSelect = null; // CustomSelect instance for the from picker

  function open(opts = {}) {
    close(); // close any existing

    const accounts = App.accounts;
    const rawId = opts.accountId || App.activeAcct;
    const activeId = String(
      (rawId && rawId !== 'all') ? rawId : (accounts[0] && accounts[0].id) || ''
    );

    _modal = document.createElement('div');
    _modal.className = 'modal-bg';
    _modal.id = 'compose-modal';
    _modal.innerHTML = `
      <div class="modal" role="dialog" aria-label="compose message">
        <div class="modal-header" id="compose-header">
          <span>// ${opts.mode === 'reply' ? 're: ' + esc(opts.subject||'') : opts.mode === 'forward' ? 'fwd: ' + esc(opts.subject||'') : 'new message'}</span>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="modal-min" id="compose-minimize" title="minimize">[ _ ]</span>
            <span class="modal-close" id="compose-close">[ esc ]</span>
          </div>
        </div>
        <div class="modal-body">
          <div class="compose-row">
            <div class="lbl">// from</div>
            <div id="c-from-wrap" style="flex:1;min-width:0"></div>
          </div>
          <div class="compose-row with-extra">
            <div class="lbl">// to</div>
            <input class="input" id="c-to" placeholder="someone@somewhere" autocomplete="off" value="${esc(opts.to||'')}">
            <div class="compose-toggles">
              <button class="chip" id="c-cc-btn">cc</button>
              <button class="chip" id="c-bcc-btn">bcc</button>
            </div>
          </div>
          <div class="compose-row" id="c-cc-row" style="display:none">
            <div class="lbl">// cc</div>
            <input class="input" id="c-cc" placeholder="carbon copy" autocomplete="off">
          </div>
          <div class="compose-row" id="c-bcc-row" style="display:none">
            <div class="lbl">// bcc</div>
            <input class="input" id="c-bcc" placeholder="blind carbon copy" autocomplete="off">
          </div>
          <div class="compose-row">
            <div class="lbl">// subj</div>
            <input class="input" id="c-subj" placeholder="subject line" autocomplete="off" value="${esc(opts.subject||'')}">
          </div>
          <textarea class="compose-textarea" id="c-body" placeholder="compose your message…">${opts.body||''}</textarea>
        </div>
        <div class="modal-footer">
          <div class="mf-left">
            <button class="chip">[ attach ]</button>
            <button class="chip" id="c-draft">[ draft ]</button>
          </div>
          <button class="btn" id="c-send" style="width:auto;padding:10px 18px">[ send ] <span class="ret">↵</span></button>
        </div>
      </div>`;

    document.body.appendChild(_modal);

    // Build the from custom select and inject it
    const fromOptions = accounts.map(a => ({
      value: String(a.id),
      label: `${a.display_name || a.email_address} — ${a.email_address}`,
    }));
    _fromSelect = CustomSelect.create(fromOptions, activeId, { borderless: true });
    document.getElementById('c-from-wrap').appendChild(_fromSelect.el);

    wireModal(opts);
    document.getElementById('c-to').focus();
  }

  function _toggleMinimize() {
    _minimized = !_minimized;
    _modal.classList.toggle('compose-minimized', _minimized);
    const btn = document.getElementById('compose-minimize');
    if (btn) btn.textContent = _minimized ? '[ □ ]' : '[ _ ]';
  }

  function wireModal(opts) {
    document.getElementById('compose-minimize').onclick = e => { e.stopPropagation(); _toggleMinimize(); };
    document.getElementById('compose-close').onclick    = e => { e.stopPropagation(); close(); };

    // Click the minimized header bar to restore; backdrop click closes when not minimized
    document.getElementById('compose-header').onclick = () => { if (_minimized) _toggleMinimize(); };
    _modal.addEventListener('click', e => { if (e.target === _modal && !_minimized) close(); });

    // CC / BCC toggles
    document.getElementById('c-cc-btn').onclick = function() {
      const row = document.getElementById('c-cc-row');
      const on  = row.style.display === 'none';
      row.style.display = on ? 'grid' : 'none';
      this.classList.toggle('active', on);
    };
    document.getElementById('c-bcc-btn').onclick = function() {
      const row = document.getElementById('c-bcc-row');
      const on  = row.style.display === 'none';
      row.style.display = on ? 'grid' : 'none';
      this.classList.toggle('active', on);
    };

    // Send
    document.getElementById('c-send').onclick = send;

    // Esc key
    document.addEventListener('keydown', escHandler);
  }

  function escHandler(e) {
    if (e.key === 'Escape' && !_minimized) close();
  }

  function close() {
    if (_modal) {
      _modal.remove();
      _modal = null;
    }
    _fromSelect = null;
    _minimized  = false;
    document.removeEventListener('keydown', escHandler);
  }

  async function send() {
    const accountId = _fromSelect ? _fromSelect.getValue() : '';
    const to        = document.getElementById('c-to').value.trim();
    const cc        = document.getElementById('c-cc').value.trim();
    const bcc       = document.getElementById('c-bcc').value.trim();
    const subject   = document.getElementById('c-subj').value.trim();
    const body      = document.getElementById('c-body').value;

    if (!to) { Toast.show('Recipient required', 'err'); return; }
    if (!accountId) { Toast.show('Select a sending account', 'err'); return; }

    const btn = document.getElementById('c-send');
    btn.disabled = true;
    btn.innerHTML = '[ sending… ]';

    try {
      await API.post(`/api/email/${accountId}/send`, { to, cc: cc||undefined, bcc: bcc||undefined, subject, body });
      Toast.show('Sent', 'ok');
      close();
    } catch (e) {
      btn.disabled = false;
      btn.innerHTML = '[ send ] <span class="ret">↵</span>';
      Toast.show(e.message || 'Send failed', 'err');
    }
  }

  // ── Reply / Forward helpers ───────────────────────────────────────
  function openReply(msg, accountId) {
    const to      = msg.from_addr || msg.from || '';
    const subject = /^re:/i.test(msg.subject||'') ? msg.subject : `Re: ${msg.subject||''}`;
    const body    = quoteMessage(msg);
    open({ mode:'reply', to, subject, body, accountId });
  }

  function openReplyAll(msg) {
    openReply(msg, App.activeAcct);
  }

  function openForward(msg, accountId) {
    const subject = /^fwd:/i.test(msg.subject||'') ? msg.subject : `Fwd: ${msg.subject||''}`;
    const body    = quoteMessage(msg);
    open({ mode:'forward', subject, body, accountId });
  }

  function quoteMessage(msg) {
    const date = msg.date ? new Date(msg.date).toLocaleString() : '';
    const from = msg.from_name ? `${msg.from_name} <${msg.from_addr||''}>` : (msg.from_addr || msg.from || '');
    const text = msg.text || '';
    return `\n\n\n— On ${date}, ${from} wrote:\n\n${text.split('\n').map(l => '> ' + l).join('\n')}`;
  }

  return { open, close, openReply, openReplyAll, openForward };
})();
