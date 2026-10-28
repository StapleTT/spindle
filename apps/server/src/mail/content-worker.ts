import type { Pool } from 'pg';
import { trimContentCache } from './content-cache.js';
import { decryptCredential, type MailKeys } from './credentials.js';
import { connectImap } from './imap.js';
import { listAttachments, MAX_ATTACHMENT_BYTES } from './media.js';
import { MAX_RAW_BYTES, parseMessage } from './parse.js';
import { SANITIZER_VERSION } from './sanitize.js';
import {
  claimAccount,
  type MailAccount,
  releaseLease,
  withLease,
} from './store.js';

export type ContentJob = {
  userId: string;
  accountId: string;
  messageId: string;
  version: string;
  attachment?: number;
};

type Located = { uid: string; uid_validity: string; path: string };
type Client = Awaited<ReturnType<typeof connectImap>>;

const locate = `SELECT m.size_bytes,mm.uid,mm.uid_validity,b.path,c.attachments
  FROM mail_content c JOIN mail_messages m ON m.user_id=c.user_id AND m.id=c.message_id
  JOIN mail_memberships mm ON mm.user_id=c.user_id AND mm.account_id=c.account_id AND mm.message_id=c.message_id
  JOIN mailboxes b ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=mm.mailbox_id
  WHERE c.user_id=$1 AND c.account_id=$2 AND c.message_id=$3 AND c.version=$4`;
const leased = (
  token: string,
) => `EXISTS(SELECT 1 FROM mail_accounts a JOIN users u ON u.id=a.user_id
  WHERE a.id=$2 AND a.user_id=$1 AND a.lease_token=${token} AND a.lease_until>clock_timestamp() AND u.email_verified)`;

async function withMailbox<T>(
  account: MailAccount,
  keys: MailKeys,
  message: Located,
  connect: typeof connectImap,
  operation: (client: Client) => Promise<T>,
) {
  const client = await connect(
    account,
    decryptCredential(account.credential, account.user_id, account.id, keys),
  );
  const timer = setTimeout(() => client.close(), 45000);
  try {
    const lock = await client.getMailboxLock(message.path, { readOnly: true });
    try {
      if (
        !client.mailbox ||
        String(client.mailbox.uidValidity) !== message.uid_validity
      )
        throw new Error('Message identity changed');
      return await operation(client);
    } finally {
      lock.release();
    }
  } finally {
    clearTimeout(timer);
    client.close();
  }
}

async function download(
  client: Client,
  uid: string,
  part: string | undefined,
  max: number,
) {
  const result = await client.download(uid, part, {
    uid: true,
    chunkSize: 64 * 1024,
    maxBytes: max + 1,
  });
  if (!result.content) throw new Error('Message unavailable');
  // Part sizes are transfer-encoded; only the raw message size is comparable.
  if (!part && (result.meta.expectedSize ?? 0) > max) {
    result.content.destroy();
    throw new Error('Message size limit');
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of result.content) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += value.length;
    if (bytes > max) {
      result.content.destroy();
      throw new Error('Content size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function fetchMessageContent(
  pool: Pool,
  keys: MailKeys,
  job: ContentJob,
  connect = connectImap,
) {
  if (job.attachment !== undefined)
    return fetchAttachment(pool, keys, job, job.attachment, connect);
  const { userId: owner, accountId, messageId, version } = job;
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  try {
    const message = (
      await pool.query(`${locate} AND c.state='pending' LIMIT 1`, [
        owner,
        accountId,
        messageId,
        version,
      ])
    ).rows[0];
    if (!message) {
      await pool.query(
        "DELETE FROM mail_content WHERE user_id=$1 AND message_id=$2 AND version=$3 AND state='pending'",
        [owner, messageId, version],
      );
      return;
    }
    await withLease(pool, account, async (db) => {
      await db.query(
        `UPDATE mail_content SET next_attempt_at=clock_timestamp()+interval '90 seconds'
        WHERE user_id=$1 AND message_id=$2 AND version=$3`,
        [owner, messageId, version],
      );
    });
    if (Number(message.size_bytes) > MAX_RAW_BYTES)
      throw new Error('Message size limit');
    const { source, attachments } = await withMailbox(
      account,
      keys,
      message,
      connect,
      async (client) => {
        const structure = await client.fetchOne(
          String(message.uid),
          { bodyStructure: true },
          { uid: true },
        );
        if (!structure) throw new Error('Message unavailable');
        return {
          attachments: listAttachments(structure.bodyStructure),
          source: await download(
            client,
            String(message.uid),
            undefined,
            MAX_RAW_BYTES,
          ),
        };
      },
    );
    const parsed = await parseMessage(source);
    await withLease(pool, account, async (db) => {
      const updated = await db.query(
        `UPDATE mail_content SET state='ready',plain_text=$5,html=$6,resources=$7,byte_size=$8,attachments=$9,
        sanitizer_version=${SANITIZER_VERSION},error_code=NULL,expires_at=clock_timestamp()+interval '7 days',accessed_at=clock_timestamp()
        WHERE user_id=$1 AND account_id=$2 AND message_id=$3 AND version=$4 AND state='pending' RETURNING message_id`,
        [
          owner,
          accountId,
          messageId,
          version,
          parsed.plain,
          parsed.html,
          JSON.stringify(parsed.resources),
          parsed.bytes,
          JSON.stringify(attachments),
        ],
      );
      if (!updated.rowCount) return;
      for (const image of parsed.images)
        await db.query(
          `INSERT INTO mail_content_images(user_id,account_id,message_id,position,content_type,data)
        VALUES($1,$2,$3,$4,$5,$6)`,
          [owner, accountId, messageId, image.position, image.type, image.data],
        );
      await trimContentCache(db, owner, messageId);
    });
  } catch {
    await pool.query(
      `UPDATE mail_content c SET state='failed',error_code='content_unavailable'
      WHERE c.user_id=$1 AND c.account_id=$2 AND c.message_id=$3 AND c.version=$4 AND c.state='pending' AND ${leased('$5')}`,
      [owner, accountId, messageId, version, account.lease_token],
    );
  } finally {
    await releaseLease(pool, account);
  }
}

async function fetchAttachment(
  pool: Pool,
  keys: MailKeys,
  job: ContentJob,
  position: number,
  connect: typeof connectImap,
) {
  const { userId: owner, accountId, messageId, version } = job;
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  // Every write requires the cached body version the attachment list came from.
  const attachmentRow = `FROM mail_content c WHERE t.user_id=$1 AND t.message_id=$3 AND t.position=$5
    AND t.state='pending' AND c.user_id=t.user_id AND c.message_id=t.message_id AND c.account_id=$2
    AND c.version=$4 AND c.state='ready'`;
  try {
    const message = (
      await pool.query(
        `${locate} AND c.state='ready' AND EXISTS(SELECT 1 FROM mail_content_attachments t
        WHERE t.user_id=c.user_id AND t.message_id=c.message_id AND t.position=$5 AND t.state='pending') LIMIT 1`,
        [owner, accountId, messageId, version, position],
      )
    ).rows[0];
    const part: string | undefined = message?.attachments[position]?.part;
    if (!message || !part) {
      await pool.query(
        `DELETE FROM mail_content_attachments t USING ${attachmentRow}`,
        [owner, accountId, messageId, version, position],
      );
      return;
    }
    await withLease(pool, account, async (db) => {
      await db.query(
        `UPDATE mail_content_attachments SET next_attempt_at=clock_timestamp()+interval '90 seconds'
        WHERE user_id=$1 AND message_id=$2 AND position=$3`,
        [owner, messageId, position],
      );
    });
    const data = await withMailbox(account, keys, message, connect, (client) =>
      download(client, String(message.uid), part, MAX_ATTACHMENT_BYTES),
    );
    await withLease(pool, account, async (db) => {
      const updated = await db.query(
        `UPDATE mail_content_attachments t SET state='ready',data=$6 ${attachmentRow}`,
        [owner, accountId, messageId, version, position, data],
      );
      if (!updated.rowCount) return;
      await db.query(
        'UPDATE mail_content SET byte_size=byte_size+$3 WHERE user_id=$1 AND message_id=$2',
        [owner, messageId, data.length],
      );
      await trimContentCache(db, owner, messageId);
    });
  } catch {
    await pool.query(
      `UPDATE mail_content_attachments t SET state='failed' ${attachmentRow} AND ${leased('$6')}`,
      [owner, accountId, messageId, version, position, account.lease_token],
    );
  } finally {
    await releaseLease(pool, account);
  }
}
