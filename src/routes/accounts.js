const router = require('express').Router();
const bcrypt = require('bcrypt');
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/queries');
const { encrypt } = require('../utils/crypto');
const imap = require('../services/imap');

router.use(requireAuth);

// ── Validation helpers ──────────────────────────────────────────────────────

const EMAIL_RE    = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Hostnames: letters, digits, hyphens, dots — no leading/trailing dot or hyphen
const HOSTNAME_RE = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$/;

function validPort(v) {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function validHost(h) {
  return typeof h === 'string' && h.length <= 253 && HOSTNAME_RE.test(h);
}

// GET /api/accounts — list accounts for the logged-in user
router.get('/', (req, res) => {
  const accounts = db.getEmailAccountsByUser.all(req.user.id);
  res.json(accounts);
});

// POST /api/accounts/test — test IMAP credentials without saving
router.post('/test', async (req, res) => {
  const { imap_host, imap_port, imap_secure, imap_user, password } = req.body;
  if (!imap_host || !imap_user || !password) {
    return res.status(400).json({ error: 'imap_host, imap_user, and password are required' });
  }
  if (!validHost(imap_host)) {
    return res.status(400).json({ error: 'Invalid IMAP hostname' });
  }
  const portN = validPort(imap_port || 993);
  if (!portN) return res.status(400).json({ error: 'Invalid IMAP port (must be 1–65535)' });
  try {
    await imap.testConnection({ imap_host, imap_port: portN, imap_secure, imap_user, password });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message || 'Connection failed' });
  }
});

// POST /api/accounts — add a new IMAP/SMTP account
router.post('/', async (req, res) => {
  const {
    display_name, email_address, provider,
    imap_host, imap_port, imap_secure,
    smtp_host, smtp_port, smtp_secure,
    imap_user, password,
  } = req.body;

  if (!email_address || !imap_host || !smtp_host || !imap_user || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!EMAIL_RE.test(email_address)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }
  if (!validHost(imap_host)) {
    return res.status(400).json({ error: 'Invalid IMAP hostname' });
  }
  if (!validHost(smtp_host)) {
    return res.status(400).json({ error: 'Invalid SMTP hostname' });
  }
  const imapPortN = validPort(imap_port || 993);
  const smtpPortN = validPort(smtp_port || 587);
  if (!imapPortN) return res.status(400).json({ error: 'Invalid IMAP port (must be 1–65535)' });
  if (!smtpPortN) return res.status(400).json({ error: 'Invalid SMTP port (must be 1–65535)' });
  if (display_name && display_name.length > 60) {
    return res.status(400).json({ error: 'Display name too long (max 60 characters)' });
  }
  if (typeof imap_user !== 'string' || imap_user.length > 254) {
    return res.status(400).json({ error: 'Invalid IMAP username' });
  }

  // Test the connection before saving
  try {
    await imap.testConnection({
      imap_host,
      imap_port: imap_port || 993,
      imap_secure: imap_secure ?? 1,
      imap_user,
      password,
    });
  } catch (e) {
    return res.status(400).json({ error: `IMAP connection failed: ${e.message}` });
  }

  const encrypted = encrypt(password);

  // Determine sort order (append at end)
  const existing = db.getEmailAccountsByUser.all(req.user.id);
  const sortOrder = existing.length;

  db.insertEmailAccount.run({
    user_id:                req.user.id,
    display_name:           (display_name || email_address).substring(0, 60),
    email_address,
    provider:               provider || 'imap',
    sort_order:             sortOrder,
    imap_host,
    imap_port:              imapPortN,
    imap_secure:            imap_secure  ?? 1,
    smtp_host,
    smtp_port:              smtpPortN,
    smtp_secure:            smtp_secure  ?? 0,
    imap_user,
    imap_password_encrypted: encrypted,
    oauth_access_token:     null,
    oauth_refresh_token:    null,
    oauth_token_expiry:     null,
  });

  const accounts = db.getEmailAccountsByUser.all(req.user.id);
  res.status(201).json(accounts[accounts.length - 1]);
});

// PATCH /api/accounts/reorder — update sort_order for multiple accounts
// Must be defined before /:id so Express doesn't treat "reorder" as an id
router.patch('/reorder', (req, res) => {
  const { order } = req.body; // array of { id, sort_order }
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  for (const entry of order) {
    const id = parseInt(entry.id, 10);
    const sort_order = parseInt(entry.sort_order, 10);
    if (!Number.isFinite(id) || !Number.isFinite(sort_order)) {
      return res.status(400).json({ error: 'Each entry must have numeric id and sort_order' });
    }
    db.updateEmailAccountSortOrder.run({ id, sort_order, user_id: req.user.id });
  }
  res.json({ ok: true });
});

// PATCH /api/accounts/:id — update display name
router.patch('/:id', (req, res) => {
  const account = db.getEmailAccountById.get(req.params.id);
  if (!account || account.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const name = (req.body.display_name || '').trim();
  if (!name) return res.status(400).json({ error: 'display_name is required' });
  if (name.length > 60) return res.status(400).json({ error: 'Display name too long (max 60 characters)' });
  db.updateEmailAccountName.run(name, account.id, req.user.id);
  res.json({ ok: true });
});

// DELETE /api/accounts/:id — remove an account (requires password confirmation)
router.delete('/:id', async (req, res) => {
  const account = db.getEmailAccountById.get(req.params.id);
  if (!account || account.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  const valid = await bcrypt.compare(password, req.user.password_hash);
  if (!valid) return res.status(403).json({ error: 'Incorrect password' });
  imap.evict(account.id);
  db.deleteEmailAccount.run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
