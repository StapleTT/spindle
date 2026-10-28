import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withMailbox } from './content-worker.js';
import type { MailKeys } from './credentials.js';
import { scanFile } from './file-scanner.js';
import { FILE_BYTES, fileStream, fixedChunks } from './file-storage.js';
import { connectImap } from './imap.js';
import { claimAccount, releaseLease, transaction, withLease } from './store.js';

export async function scanUpload(
  pool: Pool,
  owner: string,
  id: string,
  scan = scanFile,
) {
  const token = randomUUID();
  const claimed = await pool.query(
    `UPDATE mail_uploads f SET state='scanning',token=$3,lease_until=clock_timestamp()+interval '90 seconds'
    WHERE user_id=$1 AND id=$2 AND (state='pending_scan' OR (state='scanning' AND lease_until<clock_timestamp()))
    AND EXISTS(SELECT 1 FROM users WHERE id=$1 AND email_verified) RETURNING id`,
    [owner, id, token],
  );
  if (!claimed.rowCount) return;
  let state = 'failed',
    code: string | null = 'scan_unavailable';
  try {
    const result = await scan(fileStream(pool, owner, id));
    state = result === 'clean' ? 'ready' : 'quarantined';
    code = result === 'clean' ? null : 'malware_detected';
  } catch {
    /* Scanner failure never releases a file for sending. */
  }
  await transaction(pool, async (db) => {
    await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
    const updated = await db.query(
      `UPDATE mail_uploads SET state=$4,error_code=$5,token=NULL,lease_until=NULL,
      reserved_bytes=CASE WHEN $4='quarantined' THEN 0 ELSE reserved_bytes END WHERE user_id=$1 AND id=$2 AND token=$3 AND state='scanning'
      AND EXISTS(SELECT 1 FROM users WHERE id=$1 AND email_verified) RETURNING id`,
      [owner, id, token, state, code],
    );
    if (updated.rowCount && state === 'quarantined')
      await db.query(
        'DELETE FROM mail_upload_chunks WHERE user_id=$1 AND file_id=$2',
        [owner, id],
      );
  });
}

export async function fetchForwardFile(
  pool: Pool,
  keys: MailKeys,
  owner: string,
  accountId: string,
  id: string,
  connect = connectImap,
) {
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  const token = randomUUID();
  try {
    const file = (
      await pool.query(
        `UPDATE mail_uploads SET state='fetching',token=$3,lease_until=clock_timestamp()+interval '90 seconds'
      WHERE user_id=$1 AND id=$2 AND state='pending_fetch' AND source->>'accountId'=$4 RETURNING source`,
        [owner, id, token, accountId],
      )
    ).rows[0];
    if (!file) return;
    const source = file.source;
    const message = (
      await pool.query(
        `SELECT mm.uid,mm.uid_validity,b.path,c.attachments FROM mail_content c
      JOIN mail_memberships mm ON mm.user_id=c.user_id AND mm.message_id=c.message_id AND mm.account_id=c.account_id
      JOIN mailboxes b ON b.user_id=mm.user_id AND b.id=mm.mailbox_id AND b.account_id=mm.account_id
      WHERE c.user_id=$1 AND c.account_id=$2 AND c.message_id=$3 AND c.version=$4 AND c.state='ready' LIMIT 1`,
        [owner, accountId, source.messageId, source.version],
      )
    ).rows[0];
    const part = message?.attachments[source.position]?.part;
    if (!message || !part) throw new Error('Original attachment unavailable');
    await pool.query(
      'DELETE FROM mail_upload_chunks WHERE user_id=$1 AND file_id=$2',
      [owner, id],
    );
    let bytes = 0,
      position = 0;
    await withMailbox(account, keys, message, connect, async (client) => {
      const downloaded = await client.download(String(message.uid), part, {
        uid: true,
        maxBytes: FILE_BYTES + 1,
        chunkSize: 64 * 1024,
      });
      if (!downloaded.content)
        throw new Error('Original attachment unavailable');
      try {
        for await (const data of fixedChunks(downloaded.content)) {
          bytes += data.length;
          if (bytes > FILE_BYTES) throw new Error('Attachment size limit');
          await withLease(pool, account, async (db) => {
            const inserted = await db.query(
              `INSERT INTO mail_upload_chunks(user_id,file_id,position,data)
              SELECT $1,$2,$4,$5 FROM mail_uploads WHERE user_id=$1 AND id=$2 AND token=$3 AND state='fetching' RETURNING position`,
              [owner, id, token, position++, data],
            );
            if (!inserted.rowCount) throw new Error('Attachment cancelled');
          });
        }
      } finally {
        downloaded.content.destroy();
      }
    });
    await withLease(pool, account, (db) =>
      db.query(
        "UPDATE mail_uploads SET state='pending_scan',size_bytes=$4,reserved_bytes=$4,token=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2 AND token=$3 AND state='fetching'",
        [owner, id, token, bytes],
      ),
    );
  } catch {
    await withLease(pool, account, async (db) => {
      const changed = await db.query(
        "UPDATE mail_uploads SET state='failed',error_code='source_unavailable',reserved_bytes=0,token=NULL WHERE user_id=$1 AND id=$2 AND token=$3 AND state='fetching' RETURNING id",
        [owner, id, token],
      );
      if (changed.rowCount)
        await db.query(
          'DELETE FROM mail_upload_chunks WHERE user_id=$1 AND file_id=$2',
          [owner, id],
        );
    }).catch(() => {});
  } finally {
    await releaseLease(pool, account);
  }
}

export async function cleanupUploads(pool: Pool) {
  // Lock owners in the same order as saves, sends and scan completion.
  const owners = (
    await pool.query(`SELECT DISTINCT user_id FROM mail_uploads WHERE (state IN ('uploading','fetching') AND lease_until<clock_timestamp())
    OR created_at<clock_timestamp()-interval '1 day' LIMIT 100`)
  ).rows;
  for (const { user_id: owner } of owners)
    await transaction(pool, async (db) => {
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
      const expired = await db.query(
        `UPDATE mail_uploads SET state='failed',error_code='upload_failed',reserved_bytes=0,token=NULL
      WHERE user_id=$1 AND state IN ('uploading','fetching') AND lease_until<clock_timestamp() RETURNING id`,
        [owner],
      );
      for (const row of expired.rows)
        await db.query(
          'DELETE FROM mail_upload_chunks WHERE user_id=$1 AND file_id=$2',
          [owner, row.id],
        );
      await db.query(
        `DELETE FROM mail_uploads f WHERE user_id=$1 AND created_at<clock_timestamp()-interval '1 day'
      AND NOT EXISTS(SELECT 1 FROM mail_draft_attachments d WHERE d.user_id=f.user_id AND d.file_id=f.id)
      AND NOT EXISTS(SELECT 1 FROM mail_draft_conflict_files c WHERE c.user_id=f.user_id AND c.file_id=f.id)`,
        [owner],
      );
    });
}
