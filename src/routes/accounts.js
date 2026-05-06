const router = require('express').Router();
const bcrypt = require('bcrypt');
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/queries');
const { encrypt } = require('../utils/crypto');
const imap = require('../services/imap');

router.use(requireAuth);

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
  try {
    await imap.testConnection({ imap_host, imap_port: imap_port || 993, imap_secure, imap_user, password });
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
    display_name:           display_name || email_address,
    email_address,
    provider:               provider || 'imap',
    sort_order:             sortOrder,
    imap_host,
    imap_port:              imap_port  || 993,
    imap_secure:            imap_secure  ?? 1,
    smtp_host,
    smtp_port:              smtp_port  || 587,
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

// PATCH /api/accounts/:id — update display name
router.patch('/:id', (req, res) => {
  const account = db.getEmailAccountById.get(req.params.id);
  if (!account || account.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Account not found' });
  }
  const name = (req.body.display_name || '').trim();
  if (!name) return res.status(400).json({ error: 'display_name is required' });
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

// PATCH /api/accounts/reorder — update sort_order for multiple accounts
router.patch('/reorder', (req, res) => {
  const { order } = req.body; // array of { id, sort_order }
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
  for (const { id, sort_order } of order) {
    db.updateEmailAccountSortOrder.run({ id, sort_order, user_id: req.user.id });
  }
  res.json({ ok: true });
});

module.exports = router;
