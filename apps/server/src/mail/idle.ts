import { hasCapability } from 'imapflow/lib/tools.js';
import type { Pool } from 'pg';
import { decryptCredential, type MailKeys } from './credentials.js';
import { connectImap } from './imap.js';
import {
  type MailAccount,
  type Mailbox,
  releaseLease,
  withLease,
} from './store.js';
import { contentPending } from './work-pending.js';

// Keep this work in mail-sync's one connection slot, never a separate watcher pool.
export async function watchInbox(
  pool: Pool,
  keys: MailKeys,
  owner: string,
  id: string,
  signal?: AbortSignal,
  connect = connectImap,
) {
  if (signal?.aborted) return false;
  const account = (
    await pool.query<MailAccount & { idle_failures: number }>(
      `UPDATE mail_accounts a
    SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '90 seconds',next_idle_at=clock_timestamp()+interval '1 minute'
    WHERE a.user_id=$1 AND a.id=$2 AND a.status='ready' AND a.next_sync_at>clock_timestamp() AND a.next_idle_at<=clock_timestamp()
    AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp())
    AND EXISTS(SELECT 1 FROM users u WHERE u.id=a.user_id AND u.email_verified)
    AND EXISTS(SELECT 1 FROM mailboxes b WHERE b.user_id=a.user_id AND b.account_id=a.id AND b.role='inbox' AND b.initial_complete)
    RETURNING a.*`,
      [owner, id],
    )
  ).rows[0];
  if (!account) return false;
  const leaseToken = account.lease_token,
    requestId = account.sync_request;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let lock:
    | Awaited<ReturnType<NonNullable<typeof client>['getMailboxLock']>>
    | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined,
    watchTimer: ReturnType<typeof setTimeout> | undefined;
  let outcome: 'changed' | 'yield' | 'unsupported' | 'error' | undefined;
  const controller = new AbortController();
  function finish(reason: NonNullable<typeof outcome>) {
    if (outcome) return;
    outcome = reason;
    controller.abort();
    client?.close();
  }
  const abort = () => finish('yield');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const deadline = setTimeout(() => finish('error'), 45000);
  deadline.unref();
  try {
    const box = (
      await pool.query<Mailbox>(
        "SELECT * FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND role='inbox' AND initial_complete",
        [owner, id],
      )
    ).rows[0];
    if (!box) {
      finish('yield');
      return false;
    }
    async function check() {
      try {
        const current = (
          await pool.query(
            `SELECT EXISTS(SELECT 1 FROM mail_accounts a JOIN users u ON u.id=a.user_id
          WHERE a.user_id=$1 AND a.id=$2 AND a.lease_token=$3 AND a.lease_until>clock_timestamp() AND a.next_sync_at>clock_timestamp()
          AND a.sync_request=$4 AND u.email_verified) AS active,
          EXISTS(SELECT 1 FROM mail_accounts a JOIN users u ON u.id=a.user_id WHERE u.email_verified AND a.next_sync_at<=clock_timestamp()
          AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp())) AS "syncDue"`,
            [owner, id, leaseToken, requestId],
          )
        ).rows[0];
        const pending = await pool.query(
          `SELECT 1 FROM (${contentPending}) requested
          UNION ALL SELECT 1 FROM mail_smtp WHERE user_id=$1 AND account_id=$2 AND state='pending'
          UNION ALL SELECT 1 FROM mail_draft_links WHERE user_id=$1 AND account_id=$2 AND state NOT IN ('conflict','removed','unknown') AND next_attempt_at<=clock_timestamp()
          UNION ALL SELECT 1 FROM mail_draft_imports WHERE user_id=$1 AND account_id=$2 AND state='pending' AND next_attempt_at<=clock_timestamp()
          UNION ALL SELECT 1 FROM mail_uploads WHERE user_id=$1 AND state='pending_fetch' AND source->>'accountId'=$2::text LIMIT 1`,
          [owner, id],
        );
        if (!current.active || current.syncDue || pending.rowCount)
          finish('yield');
      } catch {
        finish('error');
      }
    }
    async function poll() {
      await check();
      if (!outcome) {
        heartbeat = setTimeout(() => void poll(), 1000);
        heartbeat.unref();
      }
    }
    await poll();
    if (outcome) return false;
    client = await connect(
      account,
      decryptCredential(account.credential, owner, id, keys),
      controller.signal,
    );
    if (outcome) return false;
    client.once('close', () => finish('error'));
    client.once('error', () => finish('error'));
    if (!hasCapability(client, 'IDLE')) {
      finish('unsupported');
      return false;
    }
    lock = await client.getMailboxLock(box.path, { readOnly: true });
    if (outcome) return false;
    const changed = () => finish('changed');
    client.on('exists', changed);
    client.on('flags', changed);
    client.on('expunge', changed);
    const selected = client.mailbox;
    if (!selected) throw new Error('Inbox unavailable');
    if (
      String(selected.uidValidity) !== box.uid_validity ||
      selected.uidNext - 1 > Number(box.high_uid)
    ) {
      finish('changed');
    } else {
      watchTimer = setTimeout(() => finish('yield'), 20000);
      watchTimer.unref();
      const started = Date.now();
      const result = await client.idle();
      if (!outcome)
        finish(
          result === false
            ? 'error'
            : Date.now() - started < 1000
              ? 'unsupported'
              : 'yield',
        );
    }
    if (outcome === 'changed') {
      await withLease(pool, account, async (db) => {
        await db.query(
          'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1 AND account_id=$2 AND id=$3',
          [owner, id, box.id],
        );
        await db.query(
          'UPDATE mail_accounts SET next_sync_at=clock_timestamp() WHERE user_id=$1 AND id=$2',
          [owner, id],
        );
      });
      return true;
    }
    return false;
  } catch {
    if (!outcome) finish('error');
    return false;
  } finally {
    clearTimeout(deadline);
    clearTimeout(heartbeat);
    clearTimeout(watchTimer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
    client?.close();
    lock?.release();
    // Token checks preserve a replacement connection/reconnect and expired leases.
    const failures =
      outcome === 'error' ? Math.min(account.idle_failures + 1, 10) : 0;
    const delay =
      outcome === 'unsupported'
        ? 3600
        : outcome === 'error'
          ? Math.min(3600, 30 * 2 ** Math.min(failures - 1, 7)) +
            Math.floor(Math.random() * 10)
          : 1;
    try {
      await pool.query(
        `UPDATE mail_accounts SET next_idle_at=clock_timestamp()+make_interval(secs=>$4),idle_failures=$5
        WHERE user_id=$1 AND id=$2 AND lease_token=$3`,
        [owner, id, account.lease_token, delay, failures],
      );
    } finally {
      await releaseLease(pool, account);
    }
  }
}
