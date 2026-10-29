import type { FetchMessageObject } from 'imapflow';
import type { Pool, PoolClient } from 'pg';
import { pendingKind, withSeen } from './actions.js';
import { reconcileConversationState } from './conversation-state.js';
import { decryptCredential, type MailKeys } from './credentials.js';
import { connectImap } from './imap.js';
import { parseReplyHeaders } from './parse.js';
import {
  claimAccount,
  type MailAccount,
  type Mailbox,
  withLease,
} from './store.js';

const UID_BATCH = 500;

function text(value: string | undefined, length = 2000) {
  return (value ?? '').replace(/\0/g, '').slice(0, length);
}

function participants(
  values:
    | { name?: string | undefined; address?: string | undefined }[]
    | undefined,
) {
  return (values ?? []).slice(0, 100).map((value) => ({
    name: text(value.name, 200),
    address: text(value.address, 320),
  }));
}

function validDate(value: unknown) {
  return value instanceof Date &&
    Number.isFinite(value.getTime()) &&
    value.getUTCFullYear() >= 1 &&
    value.getUTCFullYear() <= 9999
    ? value
    : null;
}

async function saveMessage(
  client: PoolClient,
  account: MailAccount,
  box: Mailbox,
  validity: string,
  mail: FetchMessageObject,
) {
  const envelope = mail.envelope;
  const received = validDate(mail.internalDate) ?? new Date(0);
  if (account.history_since && received < account.history_since) return null;
  const sent = validDate(envelope?.date);
  // Retain bounded References independently of the expiring body cache.
  let references: string[] | null = null;
  if (Buffer.isBuffer(mail.headers) && mail.headers.length <= 64 * 1024) {
    try {
      references = (await parseReplyHeaders(mail.headers)).references;
    } catch {
      // Invalid reply headers cannot prevent ordinary metadata synchronization.
    }
  }
  const result = await client.query(
    `INSERT INTO mail_messages(user_id,account_id,remote_key,message_id,subject,sender,recipients,sent_at,received_at,in_reply_to,size_bytes,reference_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (account_id,remote_key) DO UPDATE SET subject=EXCLUDED.subject,
       sender=EXCLUDED.sender, recipients=EXCLUDED.recipients, sent_at=EXCLUDED.sent_at,
       received_at=EXCLUDED.received_at, size_bytes=EXCLUDED.size_bytes,
       reference_ids=COALESCE(EXCLUDED.reference_ids,mail_messages.reference_ids)
     RETURNING id`,
    [
      account.user_id,
      account.id,
      `${box.id}:${validity}:${mail.uid}`,
      text(envelope?.messageId),
      text(envelope?.subject),
      JSON.stringify(participants(envelope?.from)),
      JSON.stringify({
        to: participants(envelope?.to),
        cc: participants(envelope?.cc),
      }),
      sent,
      received,
      text(envelope?.inReplyTo),
      mail.size ?? 0,
      references,
    ],
  );
  await client.query(
    `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags)
     VALUES ($1,$2,$3,$4,$5,$6,${withSeen('$7::text[]', pendingKind('$1', '$4'))})
     ON CONFLICT (mailbox_id,uid_validity,uid) DO UPDATE SET flags=EXCLUDED.flags`,
    [
      account.user_id,
      account.id,
      box.id,
      result.rows[0].id,
      validity,
      mail.uid,
      [...(mail.flags ?? [])].slice(0, 100).map((flag) => text(flag, 200)),
    ],
  );
  return { uid: mail.uid, id: result.rows[0].id as string };
}

export async function syncAccount(
  pool: Pool,
  keys: MailKeys,
  owner: string,
  id: string,
  connect = connectImap,
) {
  const account = await claimAccount(pool, owner, id);
  if (!account) return;
  let client: Awaited<ReturnType<typeof connectImap>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const password = decryptCredential(account.credential, owner, id, keys);
    client = await connect(account, password);
    timer = setTimeout(() => client?.close(), 45000);
    const discovered = (await client.list()).filter(
      (box) => !box.flags.has('\\Noselect'),
    );
    if (discovered.length > 1000) throw new Error('Too many folders');
    await withLease(pool, account, async (db) => {
      if (account.sync_request !== account.sync_completed) {
        await db.query(
          'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1 AND account_id=$2',
          [owner, id],
        );
      }
      for (const folder of discovered) {
        if (folder.path.length > 1000 || folder.path.includes('\0'))
          throw new Error('Invalid folder');
        await db.query(
          `INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT(account_id,path) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role`,
          [
            owner,
            id,
            folder.path,
            text(folder.name, 1000),
            folder.path.toUpperCase() === 'INBOX'
              ? 'inbox'
              : (folder.specialUse ?? null),
          ],
        );
      }
      // Folder disappearance only removes the local mirror; no provider mutation is sent.
      await db.query(
        `DELETE FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND NOT(path=ANY($3::text[]))`,
        [owner, id, discovered.map((folder) => folder.path)],
      );
    });
    const deadline = Date.now() + 30000;
    for (let batch = 0; batch < 10 && Date.now() < deadline; batch++) {
      const box = (
        await pool.query<Mailbox>(
          `SELECT * FROM mailboxes WHERE user_id=$1 AND account_id=$2
           AND (NOT initial_complete OR scan_uid IS NOT NULL OR last_synced_at IS NULL
             OR last_synced_at<clock_timestamp()-interval '60 seconds')
         ORDER BY initial_complete, last_synced_at ASC NULLS FIRST,
           CASE WHEN role='inbox' THEN 0 ELSE 1 END, path LIMIT 1`,
          [owner, id],
        )
      ).rows[0];
      if (!box) break;
      const lock = await client.getMailboxLock(box.path, { readOnly: true });
      try {
        const selected = client.mailbox;
        if (!selected) throw new Error('Mailbox unavailable');
        const validity = String(selected.uidValidity);
        const end = selected.uidNext - 1;
        if (
          !/^[1-9]\d{0,9}$/.test(validity) ||
          Number(validity) > 4294967295 ||
          !Number.isSafeInteger(end) ||
          end < 0 ||
          end > 4294967295
        )
          throw new Error('Invalid IMAP checkpoint');
        const reset = box.uid_validity !== validity;
        const high = reset ? end : Number(box.high_uid);
        const empty = selected.exists === 0;
        const newMail = !empty && !reset && end > high;
        const upper = empty
          ? 0
          : newMail
            ? Math.min(end, high + UID_BATCH)
            : Math.min(end, reset ? end : Number(box.scan_uid ?? end));
        const lower = newMail ? high + 1 : Math.max(1, upper - UID_BATCH + 1);
        const messages: FetchMessageObject[] = [];
        let batchBytes = 0;
        if (upper >= lower) {
          for await (const message of client.fetch(
            account.history_since
              ? { since: account.history_since, uid: `${lower}:${upper}` }
              : `${lower}:${upper}`,
            {
              uid: true,
              envelope: true,
              flags: true,
              internalDate: true,
              size: true,
              headers: ['references'],
            },
            { uid: true },
          )) {
            if (
              message.uid < lower ||
              message.uid > upper ||
              messages.length >= UID_BATCH
            )
              throw new Error('Invalid IMAP batch');
            batchBytes +=
              Buffer.byteLength(JSON.stringify(message.envelope ?? {})) +
              Buffer.byteLength(JSON.stringify([...(message.flags ?? [])])) +
              (message.headers?.length ?? 0);
            if (batchBytes > 8 * 1024 * 1024)
              throw new Error('Mail metadata batch exceeds limit');
            messages.push(message);
          }
        }
        await withLease(pool, account, async (db) => {
          if (reset || empty) {
            await db.query(
              'DELETE FROM mail_memberships WHERE user_id=$1 AND account_id=$2 AND mailbox_id=$3',
              [owner, id, box.id],
            );
          }
          const retained: number[] = [];
          const anchors: string[] = [];
          for (const message of messages) {
            const saved = await saveMessage(
              db,
              account,
              box,
              validity,
              message,
            );
            if (saved !== null) {
              retained.push(saved.uid);
              anchors.push(saved.id);
            }
          }
          await reconcileConversationState(db, owner, id, anchors);
          await db.query(
            `DELETE FROM mail_memberships WHERE user_id=$1 AND account_id=$2 AND mailbox_id=$3
             AND uid_validity=$4 AND uid BETWEEN $5 AND $6 AND NOT(uid=ANY($7::bigint[]))`,
            [owner, id, box.id, validity, lower, upper, retained],
          );
          await db.query(
            `UPDATE mailboxes SET uid_validity=$4,high_uid=$5,scan_uid=$6,
             initial_complete=$7,last_synced_at=CASE WHEN $5::bigint<$8::bigint THEN NULL ELSE clock_timestamp() END WHERE user_id=$1 AND account_id=$2 AND id=$3`,
            [
              owner,
              id,
              box.id,
              validity,
              empty ? end : newMail ? upper : high,
              newMail ? box.scan_uid : lower <= 1 ? null : lower - 1,
              reset
                ? lower <= 1
                : box.initial_complete || (!newMail && lower <= 1),
              end,
            ],
          );
        });
      } finally {
        lock.release();
      }
    }
    await withLease(pool, account, async (db) => {
      await db.query(
        `DELETE FROM mail_messages m WHERE user_id=$1 AND account_id=$2
         AND NOT EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=$1 AND mm.message_id=m.id)`,
        [owner, id],
      );
      await db.query(
        `UPDATE mail_accounts SET status=CASE WHEN EXISTS(
           SELECT 1 FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND (NOT initial_complete
             OR scan_uid IS NOT NULL OR last_synced_at IS NULL OR last_synced_at<clock_timestamp()-interval '60 seconds'))
           THEN 'syncing' ELSE 'ready' END,
         next_sync_at=clock_timestamp()+CASE WHEN sync_request<>$3 OR EXISTS(
           SELECT 1 FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND (NOT initial_complete
             OR scan_uid IS NOT NULL OR last_synced_at IS NULL OR last_synced_at<clock_timestamp()-interval '60 seconds'))
           THEN interval '1 second' ELSE interval '60 seconds' END,
         sync_completed=$3,
         error_code=NULL,failures=0,last_synced_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
         WHERE user_id=$1 AND id=$2`,
        [owner, id, account.sync_request],
      );
    });
  } catch {
    // Retry scheduling is durable and provider errors never enter logs or queue payloads.
    await pool.query(
      `UPDATE mail_accounts SET status='error',error_code='sync_failed',failures=LEAST(failures+1,10),
       next_sync_at=clock_timestamp()+make_interval(secs=>$4),lease_token=NULL,lease_until=NULL
       WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
      [
        owner,
        id,
        account.lease_token,
        Math.min(3600, 30 * 2 ** Math.min(account.failures, 7)) +
          Math.floor(Math.random() * 15),
      ],
    );
  } finally {
    if (timer) clearTimeout(timer);
    client?.close();
  }
}
