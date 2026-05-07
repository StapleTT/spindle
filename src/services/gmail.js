/**
 * gmail.js — Gmail API email service.
 *
 * Implements the same interface as imap.js so email routes can call either
 * service transparently based on account.provider.
 *
 * Interface:
 *   fetchMessages(account, folder, page, limit) → { messages, total }
 *   fetchMessage(account, folder, uid)          → full message object
 *   markRead(account, folder, uid, isRead)      → void
 *   archiveMessage(account, folder, uid)        → void
 *   deleteMessage(account, folder, uid)         → void
 *   getFolders(account)                         → [{ id, name, type }]
 *
 * Notes:
 *   - "uid" for Gmail is the string message ID (e.g. "18f4b2c1d0e9a3f2")
 *   - "folder" maps to a Gmail label (INBOX, SENT, TRASH, SPAM, etc.)
 *   - Pagination is cursor-based; page tokens are cached in memory between calls.
 *     Navigating forward through pages caches each next-page token.
 *     Restarting the server resets the cache — users restart from page 1.
 */

const { google } = require('googleapis');
const { getClient } = require('./oauth/gmail');

// ── Label / folder mapping ─────────────────────────────────────────────────

const FOLDER_TO_LABEL = {
  INBOX:   'INBOX',
  SENT:    'SENT',
  TRASH:   'TRASH',
  SPAM:    'SPAM',
  STARRED: 'STARRED',
  DRAFTS:  'DRAFT',
  DRAFT:   'DRAFT',
};

function folderToLabel(folder) {
  return FOLDER_TO_LABEL[(folder || 'INBOX').toUpperCase()] || folder || 'INBOX';
}

// ── Page token cache ───────────────────────────────────────────────────────
// Key: `${accountId}:${label}:${page}` → nextPageToken for page+1
const _pageTokens = new Map();

// ── Header / body parsing ──────────────────────────────────────────────────

function parseHeaders(headers = []) {
  const map = {};
  for (const { name, value } of headers) {
    map[name.toLowerCase()] = value;
  }
  return map;
}

function parseFrom(raw = '') {
  // "Display Name <addr@example.com>" or bare "addr@example.com"
  const m = raw.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"+|"+$/g, ''), addr: m[2].trim() };
  return { name: '', addr: raw.trim() };
}

function decodeBase64url(data = '') {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/**
 * Walk a Gmail message payload tree and extract text/plain and text/html parts.
 * Gmail nests parts inside multipart/* containers recursively.
 */
function extractBody(payload) {
  if (!payload) return { text: '', html: '' };

  let text = '', html = '';

  function walk(node) {
    const mime = (node.mimeType || '').toLowerCase();

    if (mime === 'text/plain'  && !text) { text = decodeBase64url(node.body?.data); return; }
    if (mime === 'text/html'   && !html) { html = decodeBase64url(node.body?.data); return; }
    if (mime.startsWith('multipart/')) {
      for (const part of node.parts || []) walk(part);
    }
  }

  walk(payload);
  return { text, html };
}

// ── Message shape normalisation ────────────────────────────────────────────

function normaliseMetadata(msg) {
  const h    = parseHeaders(msg.payload?.headers);
  const from = parseFrom(h.from);
  return {
    uid:       msg.id,
    threadId:  msg.threadId,
    subject:   h.subject  || '(no subject)',
    from:      h.from     || '',
    from_name: from.name,
    from_addr: from.addr,
    to:        h.to       || '',
    date:      h.date     || '',
    unread:    (msg.labelIds || []).includes('UNREAD'),
    preview:   msg.snippet || '',
  };
}

function normaliseFullMessage(msg) {
  const meta     = normaliseMetadata(msg);
  const h        = parseHeaders(msg.payload?.headers);
  const { text, html } = extractBody(msg.payload);
  return { ...meta, cc: h.cc || '', text, html };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Fetch a paginated list of message summaries for a label/folder.
 * Page tokens are cached in memory so forward navigation works correctly.
 */
async function fetchMessages(account, folder, page, limit) {
  const auth    = getClient(account);
  const gmail   = google.gmail({ version: 'v1', auth });
  const label   = folderToLabel(folder);
  const prevKey = `${account.id}:${label}:${page - 1}`;
  const thisKey = `${account.id}:${label}:${page}`;

  const pageToken = page > 1 ? _pageTokens.get(prevKey) : undefined;

  // ALLMAIL is not a valid labelIds filter in messages.list; omitting labelIds
  // returns all messages, which is the correct behaviour for the archive view.
  const listRes = await gmail.users.messages.list({
    userId:     'me',
    ...(label !== 'ALLMAIL' ? { labelIds: [label] } : {}),
    maxResults: limit,
    ...(pageToken ? { pageToken } : {}),
  });

  // Cache the next-page token so page+1 can use it
  if (listRes.data.nextPageToken) {
    _pageTokens.set(thisKey, listRes.data.nextPageToken);
  }

  const ids    = listRes.data.messages || [];
  const total  = listRes.data.resultSizeEstimate || ids.length;

  // Fetch metadata for all messages in parallel — format=metadata is lightweight
  const messages = await Promise.all(
    ids.map(({ id }) =>
      gmail.users.messages.get({
        userId:          'me',
        id,
        format:          'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      }).then(r => normaliseMetadata(r.data))
    )
  );

  return { messages, total };
}

/**
 * Fetch the full content of a single message (headers + decoded body).
 */
async function fetchMessage(account, folder, uid) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  const res = await gmail.users.messages.get({
    userId: 'me',
    id:     uid,
    format: 'full',
  });

  return normaliseFullMessage(res.data);
}

/**
 * Mark a message as read or unread by adding/removing the UNREAD label.
 */
async function markRead(account, folder, uid, isRead) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.modify({
    userId: 'me',
    id:     uid,
    requestBody: {
      addLabelIds:    isRead ? []         : ['UNREAD'],
      removeLabelIds: isRead ? ['UNREAD'] : [],
    },
  });
}

/**
 * Archive a message by removing it from the INBOX label.
 */
async function archiveMessage(account, folder, uid) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.modify({
    userId: 'me',
    id:     uid,
    requestBody: { removeLabelIds: ['INBOX'] },
  });
}

/**
 * Move a message from one label to another by swapping label IDs.
 */
async function moveMessage(account, fromFolder, toFolder, uid) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const fromLabel = folderToLabel(fromFolder);
  const toLabel   = folderToLabel(toFolder);

  const body = { addLabelIds: [], removeLabelIds: [] };
  if (toLabel && toLabel !== fromLabel) body.addLabelIds.push(toLabel);
  // Don't remove ALLMAIL — it's a view, not a real label
  if (fromLabel && fromLabel !== 'ALLMAIL') body.removeLabelIds.push(fromLabel);

  await gmail.users.messages.modify({ userId: 'me', id: uid, requestBody: body });
}

/**
 * Restore a message to the inbox (remove TRASH label if present, add INBOX).
 */
async function restoreMessage(account, folder, uid) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.modify({
    userId: 'me',
    id:     uid,
    requestBody: {
      addLabelIds:    ['INBOX'],
      removeLabelIds: ['TRASH'],
    },
  });
}

/**
 * Move a message to trash (recoverable; does not permanently delete).
 */
async function deleteMessage(account, folder, uid) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.trash({ userId: 'me', id: uid });
}

// System label IDs that are not navigable mailboxes and should never appear.
const GMAIL_SKIP = new Set([
  'UNREAD', 'IMPORTANT', 'CHAT', 'SCHEDULED',
  'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS',
  'CATEGORY_PROMOTIONS', 'CATEGORY_PERSONAL',
  'NOTES', // Apple Notes sync label
]);

// Priority order for the main system labels in the sidebar
const GMAIL_PRIORITY = ['INBOX', 'STARRED', 'SENT', 'DRAFT', 'ALLMAIL', 'TRASH', 'SPAM'];

/**
 * List all navigable Gmail labels as normalised folder objects.
 * System labels come first; labelListVisibility only applies to user labels.
 */
async function getFolders(account) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  const res    = await gmail.users.labels.list({ userId: 'me' });
  const labels = res.data.labels || [];

  const visible = labels.filter(l => {
    if (GMAIL_SKIP.has(l.id)) return false;
    if (/[_-]star$/i.test(l.id)) return false;
    if (l.type === 'system') return true;
    return l.labelListVisibility !== 'labelHide';
  });

  // Gmail sometimes omits ALLMAIL from labels.list despite it being a standard
  // system label — add it explicitly so the archive folder always shows.
  if (!visible.some(l => l.id === 'ALLMAIL')) {
    visible.push({ id: 'ALLMAIL', name: 'All Mail', type: 'system' });
  }

  visible.sort((a, b) => {
    const ai = GMAIL_PRIORITY.indexOf(a.id);
    const bi = GMAIL_PRIORITY.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return  1;
    if (a.type === 'system' && b.type !== 'system') return -1;
    if (a.type !== 'system' && b.type === 'system') return  1;
    return a.name.localeCompare(b.name);
  });

  // labels.list doesn't reliably return messagesUnread for system labels;
  // fetch each label individually to get accurate counts.
  const withCounts = await Promise.all(
    visible.map(l =>
      gmail.users.labels.get({ userId: 'me', id: l.id })
        .then(r => ({ ...l, unread: r.data.messagesUnread || 0 }))
        .catch(() => ({ ...l, unread: 0 }))
    )
  );

  // Rename ALLMAIL to "Archive" for consistency with Outlook/IMAP naming and
  // because that's the action users trigger; "All Mail" is a Gmail-internal term.
  return withCounts.map(l => ({
    id:     l.id,
    name:   l.id === 'ALLMAIL' ? 'Archive' : l.name,
    type:   l.type || 'user',
    unread: l.unread,
  }));
}

// ── Unread count ───────────────────────────────────────────────────────────

async function getUnreadCount(account) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  // labels.get returns the real messagesUnread count; messages.list
  // resultSizeEstimate is capped at ~200 by the API.
  const res = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
  return res.data.messagesUnread || 0;
}

/**
 * Send an email via the Gmail API.
 * Builds an RFC 2822 MIME message, base64url-encodes it, and uses
 * users.messages.send to deliver via the user's Gmail account.
 *
 * @param {object} account  — email_accounts row from DB
 * @param {object} opts     — { to, cc, bcc, subject, text, replyTo }
 */
async function sendMessage(account, { to, cc, bcc, subject, text, replyTo } = {}) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  // Omit From — Gmail API injects it automatically from the authenticated account.
  // Including it risks a mismatch rejection (error 69585).
  const lines = [
    `To: ${to || ''}`,
  ];
  if (cc)      lines.push(`Cc: ${cc}`);
  if (bcc)     lines.push(`Bcc: ${bcc}`);
  if (replyTo) lines.push(`Reply-To: ${replyTo}`);
  lines.push(`Subject: ${subject || '(no subject)'}`);
  lines.push('MIME-Version: 1.0');
  lines.push('Content-Type: text/plain; charset=UTF-8');
  lines.push('');
  lines.push(text || '');

  const raw = Buffer.from(lines.join('\r\n')).toString('base64url');

  await gmail.users.messages.send({
    userId:      'me',
    requestBody: { raw },
  });
}

/**
 * Fetch all messages in a Gmail thread (oldest first).
 */
async function fetchThread(account, threadId) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });
  const res = await gmail.users.threads.get({
    userId: 'me',
    id:     threadId,
    format: 'full',
  });
  return (res.data.messages || []).map(normaliseFullMessage);
}

/**
 * Search messages across all labels using Gmail's q parameter.
 * field: 'all' | 'from' | 'to' | 'subject'
 * Gmail q supports operators: from:, to:, subject: and free text.
 */
async function searchMessages(account, query, field, _folder, page, limit) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  const raw = query.trim();
  let q;
  if (field === 'from')         q = `from:${raw}`;
  else if (field === 'to')      q = `to:${raw}`;
  else if (field === 'subject') q = `subject:${raw}`;
  else                          q = raw;

  // Gmail pagination is cursor-based; for simplicity use pageToken cache keyed by query
  const cacheKey = `search:${account.id}:${q}:${page}`;
  const prevKey  = `search:${account.id}:${q}:${page - 1}`;
  const pageToken = page > 1 ? _pageTokens.get(prevKey) : undefined;

  const listRes = await gmail.users.messages.list({
    userId:     'me',
    q,
    maxResults: limit,
    ...(pageToken ? { pageToken } : {}),
  });

  if (listRes.data.nextPageToken) {
    _pageTokens.set(cacheKey, listRes.data.nextPageToken);
  }

  const ids   = listRes.data.messages || [];
  const total = listRes.data.resultSizeEstimate || ids.length;

  const messages = await Promise.all(
    ids.map(({ id }) =>
      gmail.users.messages.get({
        userId:          'me',
        id,
        format:          'metadata',
        metadataHeaders: ['From', 'To', 'Subject', 'Date'],
      }).then(r => normaliseMetadata(r.data))
    )
  );

  return { messages, total };
}

module.exports = { fetchMessages, fetchMessage, markRead, archiveMessage, restoreMessage, moveMessage, deleteMessage, getFolders, getUnreadCount, sendMessage, fetchThread, searchMessages };
