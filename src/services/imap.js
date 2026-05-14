const imapSimple = require('imap-simple');
const { simpleParser } = require('mailparser');
const { decrypt } = require('../utils/crypto');

// Connection pool keyed by account id
const pool = new Map();

// ── Connection helpers ─────────────────────────────────────────────────────

function buildConfig(account, password) {
  return {
    imap: {
      user: account.imap_user,
      password,
      host: account.imap_host,
      port: account.imap_port,
      tls: !!account.imap_secure,
      tlsOptions: { rejectUnauthorized: process.env.ALLOW_SELF_SIGNED_TLS !== 'true' },
      authTimeout: 15000,
      connTimeout: 15000,
    },
  };
}

async function getConnection(account) {
  if (!account.imap_password_encrypted) {
    const provider = account.provider || 'oauth';
    throw new Error(
      `${provider.charAt(0).toUpperCase() + provider.slice(1)} accounts use the web API rather than IMAP — ` +
      `full read support coming soon.`
    );
  }

  if (pool.has(account.id)) {
    try {
      // imap-simple exposes the underlying imap client on .imap
      const cached = pool.get(account.id);
      if (cached.imap.state !== 'disconnected') return cached;
    } catch (_) {}
    pool.delete(account.id);
  }

  const password = decrypt(account.imap_password_encrypted);
  const conn = await imapSimple.connect(buildConfig(account, password));

  conn.on('error', () => pool.delete(account.id));
  conn.on('close', () => pool.delete(account.id));
  pool.set(account.id, conn);
  return conn;
}

function evict(accountId) {
  const conn = pool.get(accountId);
  if (conn) { try { conn.end(); } catch (_) {} }
  pool.delete(accountId);
}

// ── Test connection (no pooling — connect then immediately end) ───────────

async function testConnection(accountConfig) {
  // accountConfig: { imap_host, imap_port, imap_secure, imap_user, password }
  const fakeAccount = {
    id: '__test__',
    imap_host: accountConfig.imap_host,
    imap_port: accountConfig.imap_port,
    imap_secure: accountConfig.imap_secure,
    imap_user: accountConfig.imap_user,
    imap_password_encrypted: null,
  };
  const conn = await imapSimple.connect(buildConfig(fakeAccount, accountConfig.password));
  conn.end();
}

// ── Folder listing ─────────────────────────────────────────────────────────

// Common folders in display-priority order (matched case-insensitively)
const FOLDER_PRIORITY = [
  'inbox', 'starred', 'sent', 'sent mail', 'sent items',
  'drafts', 'draft', 'archive', 'all mail',
  'trash', 'deleted', 'deleted items', 'junk', 'spam', 'junk mail',
];

async function getFolders(account) {
  const conn = await getConnection(account);

  // Build the folder list from the box tree
  const folders = await new Promise((resolve, reject) => {
    conn.imap.getBoxes((err, boxes) => {
      if (err) return reject(err);
      const list = [];

      function walk(tree, prefix) {
        for (const [name, box] of Object.entries(tree)) {
          const full = prefix ? `${prefix}${box.delimiter || '/'}${name}` : name;
          const noSelect = (box.attribs || []).some(
            a => a.toLowerCase() === '\\noselect'
          );
          if (!noSelect) {
            const parts = full.split(/[/.]/).filter(Boolean);
            const displayName = parts[parts.length - 1] || full;
            const lower = displayName.toLowerCase();
            list.push({
              id:   full,
              name: displayName,
              type: FOLDER_PRIORITY.includes(lower) ? 'system' : 'user',
            });
          }
          if (box.children) walk(box.children, full);
        }
      }

      walk(boxes, '');

      list.sort((a, b) => {
        const ai = FOLDER_PRIORITY.indexOf(a.name.toLowerCase());
        const bi = FOLDER_PRIORITY.indexOf(b.name.toLowerCase());
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return  1;
        return a.name.localeCompare(b.name);
      });

      resolve(list);
    });
  });

  return folders.map(f => ({ ...f, unread: 0 }));
}

// ── From header parser ─────────────────────────────────────────────────────

function parseFrom(raw) {
  if (!raw) return { from_name: '', from_addr: '' };
  // Match: optional quoted name, then <addr>
  const m = raw.match(/^"?([^"<>\n]+?)"?\s*<([^>]+)>/);
  if (m) return { from_name: m[1].trim(), from_addr: m[2].trim() };
  // Bare email address only
  return { from_name: '', from_addr: raw.trim() };
}

// ── Message list ───────────────────────────────────────────────────────────

async function fetchMessages(account, folder, page = 1, limit = 50) {
  const conn = await getConnection(account);
  await conn.openBox(folder);

  // Fetch UIDs + flags + headers for all messages
  const raw = await conn.search(['ALL'], {
    bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)'],
    markSeen: false,
  });

  if (raw.length === 0) return { messages: [], hasMore: false, unreadCount: 0 };

  // Sort newest-first (UIDs are monotonically increasing)
  raw.sort((a, b) => b.attributes.uid - a.attributes.uid);

  const unreadCount = raw.filter(m => !m.attributes.flags.includes('\\Seen')).length;

  const start  = (page - 1) * limit;
  const slice  = raw.slice(start, start + limit);
  const hasMore = raw.length > start + limit;

  const messages = slice.map(msg => {
    const header  = msg.parts[0]?.body || {};
    const { from_name, from_addr } = parseFrom(header.from?.[0] || '');
    const subject = (header.subject?.[0] || '').trim();
    const date    = header.date?.[0] ? new Date(header.date[0]) : null;

    return {
      uid:       msg.attributes.uid,
      from_name,
      from_addr,
      subject,
      date:    date?.toISOString() || null,
      preview: '',
      unread:  !msg.attributes.flags.includes('\\Seen'),
    };
  });

  return { messages, hasMore, unreadCount, total: raw.length };
}

// ── Full message ───────────────────────────────────────────────────────────

async function fetchMessage(account, folder, uid) {
  const conn = await getConnection(account);
  await conn.openBox(folder);

  const results = await conn.search([['UID', String(uid)]], {
    bodies: [''],
    markSeen: false,
    struct: true,
  });

  if (!results.length) throw new Error('Message not found');

  const raw  = results[0].parts.find(p => p.which === '')?.body || '';
  const parsed = await simpleParser(raw);

  const attachments = (parsed.attachments || [])
    .filter(a => a.filename)
    .map((a, i) => ({
      attachmentId: String(i),
      filename:     a.filename,
      contentType:  a.contentType || 'application/octet-stream',
      size:         a.size || a.content?.length || 0,
    }));

  return {
    uid,
    subject:   parsed.subject || '',
    from_name: parsed.from?.value?.[0]?.name  || '',
    from_addr: parsed.from?.value?.[0]?.address || '',
    to:        parsed.to?.text || '',
    date:      parsed.date?.toISOString() || null,
    html:      parsed.html  || null,
    text:      parsed.text  || '',
    unread:    !results[0].attributes.flags.includes('\\Seen'),
    attachments,
  };
}

async function fetchAttachment(account, folder, uid, attachmentId) {
  const conn = await getConnection(account);
  await conn.openBox(folder);

  const results = await conn.search([['UID', String(uid)]], {
    bodies:   [''],
    markSeen: false,
  });
  if (!results.length) throw new Error('Message not found');

  const raw    = results[0].parts.find(p => p.which === '')?.body || '';
  const parsed = await simpleParser(raw);
  const named  = (parsed.attachments || []).filter(a => a.filename);
  const idx    = parseInt(attachmentId, 10);
  const att    = named[idx];
  if (!att) throw new Error('Attachment not found');

  return { content: att.content, contentType: att.contentType, filename: att.filename };
}

// ── Flag operations ────────────────────────────────────────────────────────

async function markRead(account, folder, uid, read) {
  const conn = await getConnection(account);
  await conn.openBox(folder);
  if (read) {
    await conn.addFlags(String(uid), ['\\Seen']);
  } else {
    await conn.delFlags(String(uid), ['\\Seen']);
  }
}

// ── Move helpers ───────────────────────────────────────────────────────────

async function findFolder(conn, candidates) {
  return new Promise((resolve) => {
    conn.imap.getBoxes((err, boxes) => {
      if (err) return resolve(null);
      const names = [];
      function walk(tree, prefix) {
        for (const [name, box] of Object.entries(tree)) {
          const full = prefix ? `${prefix}${box.delimiter}${name}` : name;
          names.push(full);
          if (box.children) walk(box.children, full);
        }
      }
      walk(boxes, '');
      for (const c of candidates) {
        const match = names.find(n => n.toLowerCase().includes(c.toLowerCase()));
        if (match) return resolve(match);
      }
      resolve(null);
    });
  });
}

async function archiveMessage(account, folder, uid) {
  const conn = await getConnection(account);
  await conn.openBox(folder);
  const dest = await findFolder(conn, ['Archive', 'All Mail', 'Archived']);
  if (!dest) throw new Error('No Archive folder found on this account');
  await conn.moveMessage(String(uid), dest);
}

async function restoreMessage(account, folder, uid) {
  const conn = await getConnection(account);
  await conn.openBox(folder);
  await conn.moveMessage(String(uid), 'INBOX');
}

async function moveMessage(account, fromFolder, toFolder, uid) {
  const conn = await getConnection(account);
  await conn.openBox(fromFolder);
  await conn.moveMessage(String(uid), toFolder);
}

async function deleteMessage(account, folder, uid) {
  const conn = await getConnection(account);
  await conn.openBox(folder);
  // Try moving to Trash first; fall back to deleting with \Deleted flag
  const trash = await findFolder(conn, ['Trash', 'Deleted', 'Deleted Messages']);
  if (trash) {
    await conn.moveMessage(String(uid), trash);
  } else {
    await conn.addFlags(String(uid), ['\\Deleted']);
    await new Promise((resolve, reject) =>
      conn.imap.expunge((err) => err ? reject(err) : resolve()));
  }
}

// ── Unread count ───────────────────────────────────────────────────────────

async function getUnreadCount(account) {
  const conn = await getConnection(account);
  await conn.openBox('INBOX');
  const uids = await conn.search(['UNSEEN'], {});
  return uids.length;
}

/**
 * IMAP does not natively support threading; return empty to fall back to single-message view.
 */
async function fetchThread(account, threadId) {
  return [];
}

/**
 * Search messages in a folder using IMAP SEARCH criteria.
 * field: 'all' | 'from' | 'to' | 'subject'
 * Searches INBOX by default (IMAP requires an open mailbox; opening all folders is too slow).
 */
async function searchMessages(account, query, field, folder = 'INBOX', page = 1, limit = 20) {
  const conn = await getConnection(account);
  await conn.openBox(folder);

  const q = query.trim();
  let criteria;
  if (field === 'from')         criteria = [['FROM', q]];
  else if (field === 'to')      criteria = [['TO', q]];
  else if (field === 'subject') criteria = [['SUBJECT', q]];
  else                          criteria = [['TEXT', q]]; // headers + body

  const raw = await conn.search(criteria, {
    bodies: ['HEADER.FIELDS (FROM SUBJECT DATE)'],
    markSeen: false,
  });

  if (raw.length === 0) return { messages: [], total: 0 };

  raw.sort((a, b) => b.attributes.uid - a.attributes.uid);

  const start = (page - 1) * limit;
  const slice = raw.slice(start, start + limit);

  const messages = slice.map(msg => {
    const header  = msg.parts[0]?.body || {};
    const { from_name, from_addr } = parseFrom(header.from?.[0] || '');
    const subject = (header.subject?.[0] || '').trim();
    const date    = header.date?.[0] ? new Date(header.date[0]) : null;
    return {
      uid:       msg.attributes.uid,
      from_name, from_addr, subject,
      date:      date?.toISOString() || null,
      preview:   '',
      unread:    !msg.attributes.flags.includes('\\Seen'),
    };
  });

  return { messages, total: raw.length };
}

module.exports = { testConnection, getFolders, fetchMessages, fetchMessage, fetchAttachment, markRead, archiveMessage, restoreMessage, moveMessage, deleteMessage, evict, getUnreadCount, fetchThread, searchMessages };
