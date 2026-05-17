const router = require('express').Router();
const requireAuth = require('../middleware/requireAuth');
const multer      = require('multer');
const db = require('../db/queries');
const imap           = require('../services/imap');
const gmailService   = require('../services/gmail');
const outlookService = require('../services/outlook');
const smtpService    = require('../services/smtp');

const MAX_FILE_BYTES  = 10 * 1024 * 1024;  // 10 MB per file
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;  // 25 MB total
const MAX_RECIPIENTS  = 50;

// Allowlist for Content-Type values supplied via query string in attachment downloads
const SAFE_MIME_RE = /^[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]{0,62}\/[a-zA-Z0-9][a-zA-Z0-9!#$&\-^_.+]{0,62}$/;

function svcError(res, e) {
  console.error('[email]', e.message);
  res.status(500).json({ error: e.message });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 10 },
});

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

// Resolve folder from request query or body, defaulting to INBOX
function reqFolder(req, field = 'folder') {
  return sanitizeFolder(req.query[field] || req.body?.[field] || 'INBOX');
}

// GET /api/email/:accountId/unread — lightweight unread count for sidebar badges
router.get('/:accountId/unread', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    const count = await getService(account).getUnreadCount(account);
    res.json({ unreadCount: count });
  } catch (e) {
    svcError(res, e);
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
    svcError(res, e);
  }
});

// GET /api/email/:accountId/messages?folder=INBOX&page=1&limit=50
router.get('/:accountId/messages', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = reqFolder(req);
  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, parseInt(req.query.limit) || 50);

  try {
    const result = await getService(account).fetchMessages(account, folder, page, limit);
    res.json(result);
  } catch (e) {
    svcError(res, e);
  }
});

// GET /api/email/:accountId/messages/:uid?folder=INBOX
router.get('/:accountId/messages/:uid', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = reqFolder(req);
  const uid    = parseUid(account, req.params.uid);

  try {
    const message = await getService(account).fetchMessage(account, folder, uid);
    res.json(message);
  } catch (e) {
    svcError(res, e);
  }
});

// PATCH /api/email/:accountId/messages/:uid/read
router.patch('/:accountId/messages/:uid/read', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = reqFolder(req);
  const uid    = parseUid(account, req.params.uid);
  const read   = req.body.read !== false;

  try {
    await getService(account).markRead(account, folder, uid, read);
    res.json({ ok: true });
  } catch (e) {
    svcError(res, e);
  }
});

// POST /api/email/:accountId/messages/:uid/archive
router.post('/:accountId/messages/:uid/archive', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = reqFolder(req);
  const uid    = parseUid(account, req.params.uid);

  try {
    await getService(account).archiveMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    svcError(res, e);
  }
});

// POST /api/email/:accountId/messages/:uid/restore
router.post('/:accountId/messages/:uid/restore', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = reqFolder(req);
  const uid    = parseUid(account, req.params.uid);

  try {
    await getService(account).restoreMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    svcError(res, e);
  }
});

// POST /api/email/:accountId/messages/:uid/move
router.post('/:accountId/messages/:uid/move', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  if (!req.body.toFolder) return res.status(400).json({ error: 'toFolder is required' });
  const fromFolder = sanitizeFolder(req.body.fromFolder || 'INBOX');
  const toFolder   = sanitizeFolder(req.body.toFolder);
  const uid = parseUid(account, req.params.uid);

  try {
    await getService(account).moveMessage(account, fromFolder, toFolder, uid);
    res.json({ ok: true });
  } catch (e) {
    svcError(res, e);
  }
});

// GET /api/email/:accountId/search?q=...&field=all|from|to|subject&folder=INBOX&page=1&limit=20
// accountId may be 'all' to search across every account belonging to the user
router.get('/:accountId/search', async (req, res) => {
  const { q, field = 'all', folder, page: pageStr, limit: limitStr } = req.query;
  if (!q || !q.trim()) return res.status(400).json({ error: 'q is required' });

  const sanitizedQ      = String(q).substring(0, 500);
  const sanitizedField  = ['all', 'from', 'to', 'subject'].includes(field) ? field : 'all';
  const sanitizedFolder = sanitizeFolder(folder || 'INBOX');
  const page            = Math.max(1, parseInt(pageStr) || 1);
  const limit           = Math.min(50, parseInt(limitStr) || 20);

  // ── All accounts ───────────────────────────────────────────────────────────
  if (req.params.accountId === 'all') {
    const accounts = db.getEmailAccountsByUser.all(req.user.id);
    const results  = await Promise.allSettled(
      accounts.map(async acctRow => {
        // getEmailAccountsByUser omits OAuth tokens; fetch the full row so
        // Gmail/Outlook search can authenticate correctly.
        const account = db.getEmailAccountById.get(acctRow.id);
        if (!account) return [];
        const svc  = getService(account);
        if (typeof svc.searchMessages !== 'function') return [];
        const data = await svc.searchMessages(account, sanitizedQ, sanitizedField, sanitizedFolder, 1, limit);
        return (data.messages || []).map(m => ({
          ...m,
          _accountId:   account.id,
          _accountName: account.display_name || account.email_address,
        }));
      })
    );

    const messages = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, limit);

    return res.json({ messages, total: messages.length });
  }

  // ── Single account ─────────────────────────────────────────────────────────
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const svc = getService(account);
  if (typeof svc.searchMessages !== 'function') {
    return res.status(501).json({ error: 'Search not supported for this provider' });
  }

  try {
    const data = await svc.searchMessages(account, sanitizedQ, sanitizedField, sanitizedFolder, page, limit);
    res.json(data);
  } catch (e) {
    svcError(res, e);
  }
});

// GET /api/email/:accountId/messages/:uid/attachments/:attachmentId
router.get('/:accountId/messages/:uid/attachments/:attachmentId', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder       = reqFolder(req);
  const uid          = parseUid(account, req.params.uid);
  const attachmentId = req.params.attachmentId;
  const filename     = String(req.query.filename || 'attachment').replace(/[^a-zA-Z0-9._\- ]/g, '_');
  const rawCt        = String(req.query.contentType || '');
  const contentType  = SAFE_MIME_RE.test(rawCt) ? rawCt : 'application/octet-stream';

  const svc = getService(account);
  if (typeof svc.fetchAttachment !== 'function') {
    return res.status(501).json({ error: 'Attachments not supported for this provider' });
  }

  try {
    const data = await svc.fetchAttachment(account, folder, uid, attachmentId);
    const buf  = Buffer.isBuffer(data) ? data : (data.content || data);
    const ct   = Buffer.isBuffer(data) ? contentType : (data.contentType || contentType);
    const fn   = Buffer.isBuffer(data) ? filename     : (data.filename    || filename);

    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="${fn.replace(/"/g, '')}"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (e) {
    svcError(res, e);
  }
});

// GET /api/email/:accountId/threads/:threadId?folder=INBOX
router.get('/:accountId/threads/:threadId', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { threadId } = req.params;
  const folder = reqFolder(req);
  const svc = getService(account);
  if (typeof svc.fetchThread !== 'function') return res.json([]);

  try {
    const messages = await svc.fetchThread(account, threadId, folder);
    res.json(messages);
  } catch (e) {
    svcError(res, e);
  }
});

// DELETE /api/email/:accountId/messages/:uid?folder=INBOX
router.delete('/:accountId/messages/:uid', async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const folder = reqFolder(req);
  const uid    = parseUid(account, req.params.uid);

  try {
    await getService(account).deleteMessage(account, folder, uid);
    res.json({ ok: true });
  } catch (e) {
    svcError(res, e);
  }
});

// POST /api/email/:accountId/send  (multipart/form-data or JSON)
router.post('/:accountId/send', (req, res, next) => {
  upload.array('attachments')(req, res, err => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Each attachment must be under ${MAX_FILE_BYTES / 1048576} MB` });
    }
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const account = getAccount(req.params.accountId, req.user.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  const { to, cc, bcc, subject, body, replyTo } = req.body;
  if (!to || !to.trim()) return res.status(400).json({ error: 'Recipient (to) is required' });

  const _rcpt = (s) => (s ? String(s).split(',').filter(p => p.trim()).length : 0);
  if (_rcpt(to) + _rcpt(cc) + _rcpt(bcc) > MAX_RECIPIENTS) {
    return res.status(400).json({ error: `Too many recipients (max ${MAX_RECIPIENTS} total)` });
  }

  // Enforce total attachment size limit server-side
  const files = req.files || [];
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  if (totalBytes > MAX_TOTAL_BYTES) {
    return res.status(413).json({ error: `Total attachments exceed ${MAX_TOTAL_BYTES / 1048576} MB limit` });
  }

  const attachments = files.map(f => ({
    filename:    f.originalname,
    content:     f.buffer,
    contentType: f.mimetype || 'application/octet-stream',
  }));

  const opts = { to, cc, bcc, subject, text: body, replyTo, attachments };

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
    svcError(res, e);
  }
});

module.exports = router;
