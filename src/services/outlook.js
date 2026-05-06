/**
 * outlook.js — Microsoft Graph API email service.
 *
 * Implements the same interface as imap.js and gmail.js so email routes can
 * call any service transparently based on account.provider.
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
 *   - "uid" for Outlook is the Graph message ID (long opaque string)
 *   - "folder" is a well-known folder name (inbox, sentitems, deleteditems,
 *     drafts, archive, junkemail) or a folder ID from getFolders()
 *   - Pagination uses $skip (offset-based); no cursor cache needed
 *   - Graph API returns HTML bodies natively — text is also requested
 */

const { graphFetch } = require('./oauth/outlook');

const GRAPH = 'https://graph.microsoft.com/v1.0/me';

// ── Folder name mapping ───────────────────────────────────────────────────────
// Maps our generic folder names to Graph well-known folder names
const FOLDER_MAP = {
  INBOX:   'inbox',
  SENT:    'sentitems',
  TRASH:   'deleteditems',
  DELETED: 'deleteditems',
  SPAM:    'junkemail',
  JUNK:    'junkemail',
  DRAFTS:  'drafts',
  DRAFT:   'drafts',
  ARCHIVE: 'archive',
};

function folderToGraph(folder) {
  return FOLDER_MAP[(folder || 'INBOX').toUpperCase()] || folder || 'inbox';
}

// ── Message normalisation ─────────────────────────────────────────────────────

function parseFrom(emailAddress) {
  if (!emailAddress) return { name: '', addr: '' };
  return {
    name: emailAddress.name  || '',
    addr: emailAddress.address || '',
  };
}

function normaliseMetadata(msg) {
  const from = parseFrom(msg.from?.emailAddress);
  const toList = (msg.toRecipients || [])
    .map(r => r.emailAddress?.address || '')
    .filter(Boolean)
    .join(', ');

  return {
    uid:       msg.id,
    subject:   msg.subject || '(no subject)',
    from:      from.addr ? `${from.name} <${from.addr}>` : '',
    from_name: from.name,
    from_addr: from.addr,
    to:        toList,
    date:      msg.receivedDateTime || msg.sentDateTime || '',
    unread:    !msg.isRead,
    preview:   msg.bodyPreview || '',
  };
}

function normaliseFullMessage(msg) {
  const meta = normaliseMetadata(msg);
  const ccList = (msg.ccRecipients || [])
    .map(r => r.emailAddress?.address || '')
    .filter(Boolean)
    .join(', ');

  const body     = msg.body || {};
  const isHtml   = body.contentType === 'html';
  const bodyText = body.content || '';

  return {
    ...meta,
    cc:   ccList,
    html: isHtml   ? bodyText : '',
    text: !isHtml  ? bodyText : '',
  };
}

// ── Helper: throw on Graph error ──────────────────────────────────────────────

async function checkResponse(res, context) {
  if (res.ok) return;
  let msg = `Graph API error ${res.status}`;
  try {
    const data = await res.json();
    msg = data.error?.message || msg;
  } catch (_) {}
  throw new Error(`${context}: ${msg}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Fetch a paginated list of message summaries.
 * Uses $skip for offset-based pagination (Graph supports it up to 1000 items).
 */
async function fetchMessages(account, folder, page, limit) {
  const folderName = folderToGraph(folder);
  const skip       = (page - 1) * limit;

  const params = new URLSearchParams({
    $top:     limit,
    $skip:    skip,
    $select:  'id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview',
    $orderby: 'receivedDateTime desc',
    $count:   'true',
  });

  const url = `${GRAPH}/mailFolders/${folderName}/messages?${params}`;
  const res  = await graphFetch(account, url, {
    headers: { ConsistencyLevel: 'eventual' },
  });
  await checkResponse(res, 'fetchMessages');

  const data     = await res.json();
  const messages = (data.value || []).map(normaliseMetadata);
  const total    = data['@odata.count'] ?? messages.length;

  return { messages, total };
}

/**
 * Fetch the full content of a single message (headers + decoded body).
 */
async function fetchMessage(account, folder, uid) {
  const params = new URLSearchParams({
    $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body',
  });

  const url = `${GRAPH}/messages/${encodeURIComponent(uid)}?${params}`;
  const res  = await graphFetch(account, url);
  await checkResponse(res, 'fetchMessage');

  const data = await res.json();
  return normaliseFullMessage(data);
}

/**
 * Mark a message as read or unread.
 */
async function markRead(account, folder, uid, isRead) {
  const url = `${GRAPH}/messages/${encodeURIComponent(uid)}`;
  const res  = await graphFetch(account, url, {
    method: 'PATCH',
    body:   JSON.stringify({ isRead }),
  });
  await checkResponse(res, 'markRead');
}

/**
 * Archive a message by moving it to the Archive folder.
 */
async function archiveMessage(account, folder, uid) {
  const url = `${GRAPH}/messages/${encodeURIComponent(uid)}/move`;
  const res  = await graphFetch(account, url, {
    method: 'POST',
    body:   JSON.stringify({ destinationId: 'archive' }),
  });
  await checkResponse(res, 'archiveMessage');
}

/**
 * Move a message to Deleted Items (recoverable delete).
 */
async function deleteMessage(account, folder, uid) {
  const url = `${GRAPH}/messages/${encodeURIComponent(uid)}/move`;
  const res  = await graphFetch(account, url, {
    method: 'POST',
    body:   JSON.stringify({ destinationId: 'deleteditems' }),
  });
  await checkResponse(res, 'deleteMessage');
}

/**
 * List all mail folders, system folders first then alphabetical.
 */
async function getFolders(account) {
  const params = new URLSearchParams({
    $select:  'id,displayName,totalItemCount,unreadItemCount,wellKnownName',
    $top:     100,
  });

  const url = `${GRAPH}/mailFolders?${params}`;
  const res  = await graphFetch(account, url);
  await checkResponse(res, 'getFolders');

  const data    = await res.json();
  const folders = data.value || [];

  // Well-known folders come first, user folders alphabetical after
  const WELL_KNOWN_ORDER = ['inbox','sentitems','drafts','archive','deleteditems','junkemail'];

  folders.sort((a, b) => {
    const ai = WELL_KNOWN_ORDER.indexOf(a.wellKnownName || '');
    const bi = WELL_KNOWN_ORDER.indexOf(b.wellKnownName || '');
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return  1;
    return (a.displayName || '').localeCompare(b.displayName || '');
  });

  return folders.map(f => ({
    id:   f.id,
    name: f.displayName,
    type: f.wellKnownName ? 'system' : 'user',
  }));
}

module.exports = { fetchMessages, fetchMessage, markRead, archiveMessage, deleteMessage, getFolders };
