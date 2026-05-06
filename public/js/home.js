// Spindle — Home page: auth-aware CTA and status line
(async () => {
  function esc(s) {
    return String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  }

  const cta    = document.getElementById('js-cta');
  const status = document.getElementById('js-status');

  // Default: sign-in button navigates to /auth
  if (cta) cta.onclick = () => { location.href = '/auth'; };

  try {
    const r = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (r.ok) {
      const data = await r.json();

      if (cta) {
        cta.innerHTML = '[ open inbox ] <span class="ret">↵</span>';
        cta.onclick   = () => { location.href = '/inbox'; };
      }

      if (status && data.username) {
        status.innerHTML =
          '<span class="dot"></span>' +
          '<span>session: <span style="color:var(--fg-bright)">' + esc(data.username) + '</span></span>';
      }
    }
  } catch (_) {
    // network error — keep default sign-in behaviour
  }
})();
