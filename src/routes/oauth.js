const router    = require('express').Router();
const crypto    = require('crypto');
const requireAuth = require('../middleware/requireAuth');
const gmail     = require('../services/oauth/gmail');
const outlook   = require('../services/oauth/outlook');
const db        = require('../db/queries');
const { encrypt } = require('../utils/crypto');

// ── Gmail ─────────────────────────────────────────────────────────────────────

// GET /api/oauth/gmail/init
// Generates a CSRF state token, saves it to the session, then redirects the
// browser to Google's consent screen.
router.get('/gmail/init', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session save failed' });
    res.redirect(gmail.getAuthUrl(state));
  });
});

// GET /api/oauth/gmail/callback
// Google redirects here after the user approves (or denies) the consent screen.
// Verifies the state token, exchanges the code for tokens, fetches the user's
// Gmail address, and saves the account to the DB.
router.get('/gmail/callback', async (req, res) => {
  const { code, state, error } = req.query;

  // User denied or Google returned an error
  if (error) {
    return res.redirect(`/inbox?oauth_error=${encodeURIComponent(error)}`);
  }

  // Session must still be alive (it was created when the user clicked "connect")
  if (!req.session || !req.session.userId) {
    return res.redirect('/auth');
  }

  // Validate CSRF state token
  if (!state || state !== req.session.oauthState) {
    return res.redirect('/inbox?oauth_error=invalid_state');
  }

  const userId = req.session.userId;
  delete req.session.oauthState;

  try {
    const tokens  = await gmail.exchangeCode(code);
    const profile = await gmail.getProfile(tokens);

    const result = db.insertEmailAccount.run({
      user_id:                 userId,
      display_name:            profile.name || profile.email,
      email_address:           profile.email,
      provider:                'gmail',
      sort_order:              0,
      imap_host:               null,
      imap_port:               null,
      imap_secure:             1,
      smtp_host:               null,
      smtp_port:               null,
      smtp_secure:             1,
      imap_user:               null,
      imap_password_encrypted: null,
      oauth_access_token:      tokens.access_token  ? encrypt(tokens.access_token)  : null,
      oauth_refresh_token:     tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      oauth_token_expiry:      tokens.expiry_date   ? new Date(tokens.expiry_date).toISOString() : null,
    });

    res.redirect(`/inbox?oauth_success=gmail&acct=${result.lastInsertRowid}`);
  } catch (e) {
    console.error('Gmail OAuth callback error:', e);
    res.redirect(`/inbox?oauth_error=${encodeURIComponent(e.message)}`);
  }
});

// ── Outlook ───────────────────────────────────────────────────────────────────

// GET /api/oauth/outlook/init
router.get('/outlook/init', requireAuth, (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  req.session.save(err => {
    if (err) return res.status(500).json({ error: 'Session save failed' });
    res.redirect(outlook.getAuthUrl(state));
  });
});

// GET /api/oauth/outlook/callback
router.get('/outlook/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/inbox?oauth_error=${encodeURIComponent(error)}`);
  }

  if (!req.session || !req.session.userId) {
    return res.redirect('/auth');
  }

  if (!state || state !== req.session.oauthState) {
    return res.redirect('/inbox?oauth_error=invalid_state');
  }

  const userId = req.session.userId;
  delete req.session.oauthState;

  try {
    const tokens  = await outlook.exchangeCode(code);
    const profile = await outlook.getProfile(tokens);

    const result = db.insertEmailAccount.run({
      user_id:                 userId,
      display_name:            profile.name || profile.email,
      email_address:           profile.email,
      provider:                'outlook',
      sort_order:              0,
      imap_host:               null,
      imap_port:               null,
      imap_secure:             1,
      smtp_host:               null,
      smtp_port:               null,
      smtp_secure:             1,
      imap_user:               null,
      imap_password_encrypted: null,
      oauth_access_token:      tokens.access_token  ? encrypt(tokens.access_token)  : null,
      oauth_refresh_token:     tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      oauth_token_expiry:      tokens.expiry_date   ? new Date(tokens.expiry_date).toISOString() : null,
    });

    res.redirect(`/inbox?oauth_success=outlook&acct=${result.lastInsertRowid}`);
  } catch (e) {
    console.error('Outlook OAuth callback error:', e);
    res.redirect(`/inbox?oauth_error=${encodeURIComponent(e.message)}`);
  }
});

module.exports = router;
