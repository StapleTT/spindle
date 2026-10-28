import type { Pool } from 'pg';
import { trimContentCache } from './content-cache.js';
import { decryptCredential, type MailKeys } from './credentials.js';
import { connectImap } from './imap.js';
import { MAX_RAW_BYTES, parseMessage } from './parse.js';
import { SANITIZER_VERSION } from './sanitize.js';
import { claimAccount, withLease } from './store.js';

export type ContentJob = {
  userId: string;
  accountId: string;
  messageId: string;
  version: string;
};

export async function fetchMessageContent(
  pool: Pool,
  keys: MailKeys,
  job: ContentJob,
  connect = connectImap,
) {
  const { userId: owner, accountId, messageId, version } = job;
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending = await pool.query(
      `SELECT c.message_id,m.size_bytes,mm.uid,mm.uid_validity,b.path
      FROM mail_content c JOIN mail_messages m ON m.user_id=c.user_id AND m.id=c.message_id
      JOIN mail_memberships mm ON mm.user_id=c.user_id AND mm.account_id=c.account_id AND mm.message_id=c.message_id
      JOIN mailboxes b ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=mm.mailbox_id
      WHERE c.user_id=$1 AND c.account_id=$2 AND c.message_id=$3 AND c.version=$4 AND c.state='pending' LIMIT 1`,
      [owner, accountId, messageId, version],
    );
    const message = pending.rows[0];
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
    client = await connect(
      account,
      decryptCredential(account.credential, owner, accountId, keys),
    );
    timer = setTimeout(() => client?.close(), 45000);
    const lock = await client.getMailboxLock(message.path, { readOnly: true });
    let source: Buffer;
    try {
      if (
        !client.mailbox ||
        String(client.mailbox.uidValidity) !== message.uid_validity
      )
        throw new Error('Message identity changed');
      const download = await client.download(String(message.uid), undefined, {
        uid: true,
        chunkSize: 64 * 1024,
        maxBytes: MAX_RAW_BYTES + 1,
      });
      if (!download.content) throw new Error('Message unavailable');
      if ((download.meta.expectedSize ?? 0) > MAX_RAW_BYTES) {
        download.content.destroy();
        throw new Error('Message size limit');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of download.content) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += value.length;
        if (bytes > MAX_RAW_BYTES) {
          download.content.destroy();
          throw new Error('Message size limit');
        }
        chunks.push(value);
      }
      source = Buffer.concat(chunks);
    } finally {
      lock.release();
    }
    const parsed = await parseMessage(source);
    await withLease(pool, account, async (db) => {
      const updated = await db.query(
        `UPDATE mail_content SET state='ready',plain_text=$5,html=$6,resources=$7,byte_size=$8,
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
      WHERE c.user_id=$1 AND c.account_id=$2 AND c.message_id=$3 AND c.version=$4 AND c.state='pending'
      AND EXISTS(SELECT 1 FROM mail_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=$2 AND a.user_id=$1
        AND a.lease_token=$5 AND a.lease_until>clock_timestamp() AND u.email_verified)`,
      [owner, accountId, messageId, version, account.lease_token],
    );
  } finally {
    if (timer) clearTimeout(timer);
    client?.close();
    await pool.query(
      'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2 AND lease_token=$3',
      [owner, accountId, account.lease_token],
    );
  }
}
