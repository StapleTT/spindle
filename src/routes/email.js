const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const db = require('../db/queries');
const imap           = require('../services/imap');
const gmailService   = require('../services/gmail');
const outlookService = require('../services/outlook');
const smtpService    = require('../services/smtp');

router.use(requireAuth);

// Resolve and authorize an account for the current user
function getAccount(accountId, userId) {
  const account = db.getEmailAccountById.get(accountId);
  if (!account || account.user_id !== userId) return null;
  return account;
}

// Return the appropriate service for an account based on its provider
function getService(account) {
  if (account.provider === 'gmail')   return gmailService;
  if (account.provider === 'outlook') return outlookService;
  return imap;
}

// Parse UID — OAuth providers use opaque string IDs; IMAP uses integers
function parseUid(account, raw) {
  if (account.provider === 'gmail' || account.provider === 'outlook') return raw;
  return parseInt(raw, 10);
}

// Sanitize a folder/label string: strip null bytes, cap length
function sanitizeFolder(f) {
  if (!f || typeof f !== 'string') return 'INBOX';
  return f.replace(/\0/g, '').substring(0, 200);
}

// GET /api/email/:accountId/unread — lightweight unread count for sidebar badges
router.get('/:accountId/unread', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const count = await getService(account).getUnreadCount(account);
    res.json({ unreadCount: count });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/folders
router.get('/:accountId/folders', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const folders = await getService(account).getFolders(account);
    res.json(folders);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/messages?folder=INBOX&page=1&limit=50
router.get('/:accountId/messages', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = sanitizeFolder(req.query.folder || 'INBOX');
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);

  try {
    const result = await getService(account).fetchMessages(account, folder, page, limit);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/messages/:uid?folder=INBOX
router.get('/:accountId/messages/:uid', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = sanitizeFolder(req.query.folder || 'INBOX');
  const uid    = parseUid(account, req.params.uid);

  try {
    const message = await getService(account).fetchMessage(account, folder, uid);
    res.json(message);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/email/:accountId/messages/:uid/read
router.patch('/:accountId/messages/:uid/read', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = sanitizeFolder(req.query.folder || req.body.folder || 'INBOX');
  const uid    = parseUid(account, req.params.uid);
  const read   = req.body.read !== false;

  try {
    await getService(account).markRead(account, folder, uid, read);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/:accountId/messages/:uid/archive
router.post('/:accountId/messages/:uid/archive', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = sanitizeFolder(req.body.folder || 'INBOX');
  const uid    = parseUid(account, req.params.uid);

  try {
    await getService(account).archiveMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/:accountId/messages/:uid/restore
router.post('/:accountId/messages/:uid/restore', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = sanitizeFolder(req.body.folder || 'INBOX');
  const uid    = parseUid(account, req.params.uid);

  try {
    await getService(account).restoreMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/:accountId/messages/:uid/move
router.post('/:accountId/messages/:uid/move', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const fromFolder = sanitizeFolder(req.body.fromFolder || 'INBOX');
  const toFolder   = sanitizeFolder(req.body.toFolder);
  if (!req.body.toFolder) return res.status(400).json({ error: 'toFolder is required' });
  const uid = parseUid(account, req.params.uid);

  try {
    await getService(account).moveMessage(account, fromFolder, toFolder, uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/email/:accountId/threads/:threadId?folder=INBOX
router.get('/:accountId/threads/:threadId', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { threadId } = req.params;
  const folder = sanitizeFolder(req.query.folder || 'INBOX');

  try {
    const messages = await getService(account).fetchThread(account, threadId, folder);
    res.json(messages);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/email/:accountId/messages/:uid?folder=INBOX
router.delete('/:accountId/messages/:uid', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = sanitizeFolder(req.query.folder || 'INBOX');
  const uid    = parseUid(account, req.params.uid);

  try {
    await getService(account).deleteMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/email/:accountId/send
router.post('/:accountId/send', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { to, cc, bcc, subject, body, replyTo } = req.body;
  if (!to || !to.trim()) return res.status(400).json({ error: 'Recipient (to) is required' });

  const opts = { to, cc, bcc, subject, text: body, replyTo };

  try {
    if (account.provider === 'gmail') {
      await gmailService.sendMessage(account, opts);
    } else if (account.provider === 'outlook') {
      await outlookService.sendMessage(account, opts);
    } else {
      await smtpService.sendEmail(account, opts);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
