import type { Pool } from 'pg';
import { decryptCredential, type MailKeys } from './credentials.js';
import { connectImap } from './imap.js';
import { connectSmtp } from './smtp.js';
import { claimAccount, releaseLease, withLease } from './store.js';

// One leased account job handles checks, sending and Sent reconciliation. It
// shares mail-content's connection budget rather than adding another queue pool.
export async function processOutgoing(
  pool: Pool,
  keys: MailKeys,
  owner: string,
  accountId: string,
  connect = connectSmtp,
  imapConnect = connectImap,
) {
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  let smtp: Awaited<ReturnType<typeof connect>> | undefined;
  let sending: string | undefined;
  let sendStarted = false;
  try {
    // A new lease cannot prove whether a killed sender passed SMTP acceptance.
    await withLease(pool, account, async (db) => {
      await db.query(
        "UPDATE mail_outbox SET state='unknown',error_code='delivery_unknown',completed_at=clock_timestamp() WHERE user_id=$1 AND account_id=$2 AND state='sending'",
        [owner, accountId],
      );
      await db.query(
        "UPDATE mail_outbox SET sent_copy='unknown' WHERE user_id=$1 AND account_id=$2 AND sent_copy='appending'",
        [owner, accountId],
      );
      await db.query(
        `UPDATE mail_outbox SET sent_copy='failed' WHERE user_id=$1 AND account_id=$2
        AND state IN ('accepted','partial','unknown') AND sent_copy IN ('pending','unknown')
        AND completed_at<clock_timestamp()-interval '1 day'`,
        [owner, accountId],
      );
    });
    const settings = (
      await pool.query(
        'SELECT * FROM mail_smtp WHERE user_id=$1 AND account_id=$2',
        [owner, accountId],
      )
    ).rows[0];
    if (settings?.state === 'pending') {
      try {
        smtp = await connect(
          settings,
          decryptCredential(
            settings.credential,
            owner,
            `${accountId}:smtp`,
            keys,
          ),
        );
        const checked = await withLease(pool, account, (db) =>
          db.query(
            "UPDATE mail_smtp SET state='ready',checked_at=clock_timestamp(),error_code=NULL WHERE user_id=$1 AND account_id=$2 AND version=$3",
            [owner, accountId, settings.version],
          ),
        );
        if (!checked.rowCount) return;
        settings.state = 'ready';
      } catch {
        await withLease(pool, account, async (db) => {
          const checked = await db.query(
            "UPDATE mail_smtp SET state='failed',checked_at=clock_timestamp(),error_code='smtp_unavailable' WHERE user_id=$1 AND account_id=$2 AND version=$3",
            [owner, accountId, settings.version],
          );
          if (checked.rowCount)
            await db.query(
              `UPDATE mail_outbox SET state='failed',completed_at=clock_timestamp(),
            error_code=CASE WHEN smtp_version=$3 THEN 'smtp_unavailable' ELSE 'settings_changed' END
            WHERE user_id=$1 AND account_id=$2 AND state='queued'`,
              [owner, accountId, settings.version],
            );
        });
        return;
      }
    }
    const row = (
      await pool.query(
        `SELECT * FROM mail_outbox WHERE user_id=$1 AND account_id=$2 AND state='queued' AND next_attempt_at<=clock_timestamp() ORDER BY seq LIMIT 1`,
        [owner, accountId],
      )
    ).rows[0];
    if (row) {
      if (
        settings?.state !== 'ready' ||
        settings.version !== row.smtp_version
      ) {
        await withLease(pool, account, (db) =>
          db.query(
            "UPDATE mail_outbox SET state='failed',completed_at=clock_timestamp(),error_code='settings_changed' WHERE user_id=$1 AND id=$2 AND state='queued'",
            [owner, row.id],
          ),
        );
      } else {
        const claimed = await withLease(pool, account, (db) =>
          db.query(
            `UPDATE mail_outbox SET state='sending',started_at=clock_timestamp(),attempts=attempts+1
          WHERE user_id=$1 AND id=$2 AND state='queued' AND next_attempt_at<=clock_timestamp() RETURNING id`,
            [owner, row.id],
          ),
        );
        if (claimed.rowCount) {
          sending = row.id;
          if (!smtp)
            smtp = await connect(
              settings,
              decryptCredential(
                settings.credential,
                owner,
                `${accountId}:smtp`,
                keys,
              ),
            );
          // Recheck ownership, live configuration and the fence immediately before I/O.
          await withLease(pool, account, async (db) => {
            const valid = await db.query(
              "SELECT account_id FROM mail_smtp WHERE user_id=$1 AND account_id=$2 AND version=$3 AND state='ready'",
              [owner, accountId, row.smtp_version],
            );
            if (!valid.rowCount)
              throw new Error('Outgoing configuration changed');
          });
          sendStarted = true;
          const info = await smtp.send(row.sender, row.recipients, row.raw);
          const accepted = info.accepted.filter((address) =>
            row.recipients.includes(address),
          );
          const rejected = info.rejected.filter((address) =>
            row.recipients.includes(address),
          );
          if (!accepted.length) throw new Error('No acceptance receipt');
          await withLease(pool, account, async (db) => {
            // Lock order matches API writes. The draft cannot be edited during dispatch.
            await db.query(
              'SELECT id FROM mail_drafts WHERE user_id=$1 AND id=$2 FOR UPDATE',
              [owner, row.draft_id],
            );
            const result = await db.query(
              `UPDATE mail_outbox SET state=$3,accepted=$4,rejected=$5,completed_at=clock_timestamp(),error_code=NULL
              WHERE user_id=$1 AND id=$2 AND state='sending' RETURNING id`,
              [
                owner,
                row.id,
                rejected.length ? 'partial' : 'accepted',
                JSON.stringify(accepted),
                JSON.stringify(rejected),
              ],
            );
            if (result.rowCount && !rejected.length)
              await db.query(
                'DELETE FROM mail_drafts WHERE user_id=$1 AND id=$2 AND revision=$3',
                [owner, row.draft_id, row.draft_revision],
              );
          });
          sending = undefined;
        }
      }
    }
    smtp?.close();
    smtp = undefined;
    const copy = (
      await pool.query(
        `SELECT * FROM mail_outbox WHERE user_id=$1 AND account_id=$2 AND state IN ('accepted','partial','unknown')
      AND sent_copy IN ('pending','unknown') AND next_attempt_at<=clock_timestamp() ORDER BY seq LIMIT 1`,
        [owner, accountId],
      )
    ).rows[0];
    if (copy) {
      // An unknown delivery is only searched, never sent or appended again.
      const client = await imapConnect(
        account,
        decryptCredential(account.credential, owner, accountId, keys),
      );
      const timeout = setTimeout(() => client.close(), 30000);
      try {
        const folders = (await client.list()).filter(
          (box) => box.specialUse === '\\Sent' && !box.flags.has('\\Noselect'),
        );
        const folder = folders[0];
        if (!folder) {
          await withLease(pool, account, (db) =>
            db.query(
              "UPDATE mail_outbox SET sent_copy='unavailable' WHERE user_id=$1 AND id=$2",
              [owner, copy.id],
            ),
          );
          return;
        }
        const lock = await client.getMailboxLock(folder.path);
        try {
          const uids = await client.search(
            { header: { 'Message-ID': copy.message_id } },
            { uid: true },
          );
          let found = false;
          if (Array.isArray(uids))
            for (const uid of uids.slice(0, 20)) {
              const message = await client.fetchOne(
                String(uid),
                { envelope: true },
                { uid: true },
              );
              if (message && message.envelope?.messageId === copy.message_id) {
                found = true;
                break;
              }
            }
          if (found) {
            await withLease(pool, account, (db) =>
              db.query(
                "UPDATE mail_outbox SET sent_copy='saved',next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE user_id=$1 AND id=$2",
                [owner, copy.id],
              ),
            );
          } else if (
            copy.sent_copy === 'pending' &&
            copy.state !== 'unknown' &&
            copy.save_sent_copy
          ) {
            await withLease(pool, account, (db) =>
              db.query(
                "UPDATE mail_outbox SET sent_copy='appending' WHERE user_id=$1 AND id=$2",
                [owner, copy.id],
              ),
            );
            try {
              const appended = await client.append(folder.path, copy.raw, [
                '\\Seen',
              ]);
              if (!appended) throw new Error('Append not acknowledged');
              await withLease(pool, account, (db) =>
                db.query(
                  "UPDATE mail_outbox SET sent_copy='saved' WHERE user_id=$1 AND id=$2",
                  [owner, copy.id],
                ),
              );
            } catch {
              await withLease(pool, account, (db) =>
                db.query(
                  "UPDATE mail_outbox SET sent_copy='unknown',next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE user_id=$1 AND id=$2",
                  [owner, copy.id],
                ),
              );
            }
          } else {
            await withLease(pool, account, (db) =>
              db.query(
                "UPDATE mail_outbox SET next_attempt_at=clock_timestamp()+interval '5 minutes',sent_copy=CASE WHEN completed_at<clock_timestamp()-interval '1 day' THEN 'failed' ELSE 'unknown' END WHERE user_id=$1 AND id=$2",
                [owner, copy.id],
              ),
            );
          }
          await withLease(pool, account, async (db) => {
            await db.query(
              'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1 AND account_id=$2 AND path=$3',
              [owner, accountId, folder.path],
            );
            await db.query(
              'UPDATE mail_accounts SET next_sync_at=clock_timestamp() WHERE user_id=$1 AND id=$2',
              [owner, accountId],
            );
          });
        } finally {
          lock.release();
        }
      } finally {
        clearTimeout(timeout);
        client.close();
      }
    }
  } catch (error) {
    if (sending) {
      const status = (error as { responseCode?: number }).responseCode;
      const known =
        !sendStarted ||
        (typeof status === 'number' && status >= 400 && status < 600);
      const temporary = known && (!status || status < 500);
      await withLease(pool, account, async (db) => {
        await db.query(
          `UPDATE mail_outbox SET state=CASE WHEN $3 AND attempts<3 THEN 'queued' WHEN $4 THEN 'failed' ELSE 'unknown' END,
          error_code=CASE WHEN $4 THEN $5 ELSE 'delivery_unknown' END,
          next_attempt_at=clock_timestamp()+interval '15 seconds',completed_at=CASE WHEN $3 AND attempts<3 THEN NULL ELSE clock_timestamp() END
          WHERE user_id=$1 AND id=$2 AND state='sending'`,
          [
            owner,
            sending,
            temporary,
            known,
            sendStarted ? 'smtp_rejected' : 'smtp_unavailable',
          ],
        );
      }).catch(() => {});
    } else {
      // Provider failure while copying never changes SMTP acceptance or resends.
      await withLease(pool, account, (db) =>
        db.query(
          `UPDATE mail_outbox SET next_attempt_at=clock_timestamp()+interval '5 minutes'
        WHERE user_id=$1 AND account_id=$2 AND state IN ('accepted','partial','unknown') AND sent_copy IN ('pending','unknown')`,
          [owner, accountId],
        ),
      ).catch(() => {});
    }
  } finally {
    smtp?.close();
    await releaseLease(pool, account);
  }
}
