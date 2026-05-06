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

  const listRes = await gmail.users.messages.list({
    userId:     'me',
    labelIds:   [label],
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
 * Move a message to trash (recoverable; does not permanently delete).
 */
async function deleteMessage(account, folder, uid) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  await gmail.users.messages.trash({ userId: 'me', id: uid });
}

/**
 * List all visible Gmail labels as normalised folder objects.
 * System labels (INBOX, SENT, etc.) come first.
 */
async function getFolders(account) {
  const auth  = getClient(account);
  const gmail = google.gmail({ version: 'v1', auth });

  const res    = await gmail.users.labels.list({ userId: 'me' });
  const labels = res.data.labels || [];

  return labels
    .filter(l => l.labelListVisibility !== 'labelHide')
    .sort((a, b) => {
      // System labels first, then alphabetical
      if (a.type === 'system' && b.type !== 'system') return -1;
      if (a.type !== 'system' && b.type === 'system') return  1;
      return a.name.localeCompare(b.name);
    })
    .map(l => ({ id: l.id, name: l.name, type: l.type || 'user' }));
}

module.exports = { fetchMessages, fetchMessage, markRead, archiveMessage, deleteMessage, getFolders };
