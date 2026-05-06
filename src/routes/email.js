const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/queries');
const imap = require('../services/imap');

router.use(requireAuth);

// Resolve and authorize an account for the current user
function getAccount(accountId, userId) {
  const account = db.getEmailAccountById.get(accountId);
  if (!account || account.user_id !== userId) return null;
  return account;
}

// GET /api/email/:accountId/folders
router.get('/:accountId/folders', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const folders = await imap.getFolders(account);
    res.json(folders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/messages?folder=INBOX&page=1&limit=50
router.get('/:accountId/messages', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.query.folder || 'INBOX';
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);

  try {
    const result = await imap.fetchMessages(account, folder, page, limit);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/messages/:uid?folder=INBOX
router.get('/:accountId/messages/:uid', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.query.folder || 'INBOX';
  const uid    = parseInt(req.params.uid);

  try {
    const message = await imap.fetchMessage(account, folder, uid);
    res.json(message);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/email/:accountId/messages/:uid/read
router.patch('/:accountId/messages/:uid/read', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.query.folder || req.body.folder || 'INBOX';
  const uid    = parseInt(req.params.uid);
  const read   = req.body.read !== false;

  try {
    await imap.markRead(account, folder, uid, read);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/:accountId/messages/:uid/archive
router.post('/:accountId/messages/:uid/archive', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.body.folder || 'INBOX';
  const uid    = parseInt(req.params.uid);

  try {
    await imap.archiveMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/email/:accountId/messages/:uid?folder=INBOX
router.delete('/:accountId/messages/:uid', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = req.query.folder || 'INBOX';
  const uid    = parseInt(req.params.uid);

  try {
    await imap.deleteMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
