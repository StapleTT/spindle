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
    threadId:  msg.conversationId,
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
    $select: 'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,conversationId',
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
 * Restore a message to the inbox.
 */
async function restoreMessage(account, folder, uid) {
  const url = `${GRAPH}/messages/${encodeURIComponent(uid)}/move`;
  const res  = await graphFetch(account, url, {
    method: 'POST',
    body:   JSON.stringify({ destinationId: 'inbox' }),
  });
  await checkResponse(res, 'restoreMessage');
}

/**
 * Move a message to any folder by Graph folder ID or well-known name.
 */
async function moveMessage(account, fromFolder, toFolder, uid) {
  const url = `${GRAPH}/messages/${encodeURIComponent(uid)}/move`;
  const res  = await graphFetch(account, url, {
    method: 'POST',
    body:   JSON.stringify({ destinationId: toFolder }),
  });
  await checkResponse(res, 'moveMessage');
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

// Display-name priority list for sorting (English names; covers personal + M365 accounts).
// wellKnownName is intentionally not requested — it's unavailable on personal Outlook accounts.
const OUTLOOK_DISPLAY_PRIORITY = [
  'inbox', 'starred', 'sent items', 'sent mail', 'sent',
  'drafts', 'draft', 'archive', 'deleted items', 'junk email', 'spam', 'junk',
];

/**
 * List all mail folders, system folders first then alphabetical.
 */
async function getFolders(account) {
  // wellKnownName is excluded — it is unavailable on personal Outlook/Hotmail accounts
  // and causes the request to fail. unreadItemCount is available on all account types.
  const url = `${GRAPH}/mailFolders?$select=id,displayName,unreadItemCount&$top=100`;
  const res  = await graphFetch(account, url);
  await checkResponse(res, 'getFolders');

  const data    = await res.json();
  const folders = data.value || [];

  folders.sort((a, b) => {
    const al = (a.displayName || '').toLowerCase();
    const bl = (b.displayName || '').toLowerCase();
    const ai = OUTLOOK_DISPLAY_PRIORITY.indexOf(al);
    const bi = OUTLOOK_DISPLAY_PRIORITY.indexOf(bl);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return  1;
    return al.localeCompare(bl);
  });

  return folders.map(f => ({
    id:     f.id,
    name:   f.displayName,
    type:   OUTLOOK_DISPLAY_PRIORITY.includes((f.displayName || '').toLowerCase()) ? 'system' : 'user',
    unread: f.unreadItemCount || 0,
  }));
}

// ── Unread count ───────────────────────────────────────────────────────────

async function getUnreadCount(account) {
  const url = `${GRAPH}/mailFolders/inbox?$select=unreadItemCount`;
  const res  = await graphFetch(account, url);
  await checkResponse(res, 'getUnreadCount');
  const data = await res.json();
  return data.unreadItemCount || 0;
}

/**
 * Send an email via the Microsoft Graph API (POST /me/sendMail).
 *
 * @param {object} account  — email_accounts row from DB
 * @param {object} opts     — { to, cc, bcc, subject, text, replyTo }
 */
async function sendMessage(account, { to, cc, bcc, subject, text, replyTo } = {}) {
  function toRecipientList(str) {
    if (!str) return [];
    return str.split(',').map(s => s.trim()).filter(Boolean).map(addr => {
      const m = addr.match(/^(.*?)\s*<([^>]+)>\s*$/);
      return m
        ? { emailAddress: { name: m[1].trim(), address: m[2].trim() } }
        : { emailAddress: { address: addr } };
    });
  }

  const message = {
    subject: subject || '(no subject)',
    body: {
      contentType: 'Text',
      content:     text || '',
    },
    from: {
      emailAddress: {
        name:    account.display_name || '',
        address: account.email_address,
      },
    },
    toRecipients:  toRecipientList(to),
    ccRecipients:  toRecipientList(cc),
    bccRecipients: toRecipientList(bcc),
    ...(replyTo ? { replyTo: toRecipientList(replyTo) } : {}),
  };

  const url = `${GRAPH}/sendMail`;
  const res  = await graphFetch(account, url, {
    method: 'POST',
    body:   JSON.stringify({ message }),
  });

  if (!res.ok && res.status !== 202) {
    await checkResponse(res, 'sendMessage');
  }
}

/**
 * Fetch all messages in an Outlook conversation by conversationId (oldest first).
 * Searches across all folders so both sent and received messages appear.
 */
async function fetchThread(account, conversationId) {
  const params = new URLSearchParams({
    '$filter':  `conversationId eq '${conversationId}'`,
    '$orderby': 'receivedDateTime asc',
    '$top':     '50',
    '$select':  'id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,body,bodyPreview,conversationId',
  });
  const url = `${GRAPH}/messages?${params}`;
  const res  = await graphFetch(account, url);
  await checkResponse(res, 'fetchThread');
  const data = await res.json();
  return (data.value || []).map(msg => ({
    ...normaliseFullMessage(msg),
    threadId: msg.conversationId,
  }));
}

module.exports = { fetchMessages, fetchMessage, markRead, archiveMessage, restoreMessage, moveMessage, deleteMessage, getFolders, getUnreadCount, sendMessage, fetchThread };
