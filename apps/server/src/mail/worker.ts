import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { logger } from '../logger.js';
import { applyMailActions } from './actions.js';
import { type ContentJob, fetchMessageContent } from './content-worker.js';
import type { MailKeys } from './credentials.js';
import { MAX_ATTACHMENTS } from './media.js';
import { processOutgoing } from './outgoing-worker.js';
import { syncAccount } from './sync.js';

// User-requested fetches and mail actions take priority over another metadata pass.
const contentPending = `SELECT 1 FROM mail_content WHERE user_id=$1 AND account_id=$2 AND state='pending'
  UNION ALL SELECT 1 FROM mail_content_attachments WHERE user_id=$1 AND account_id=$2 AND state='pending'
  UNION ALL SELECT 1 FROM mail_actions WHERE user_id=$1 AND account_id=$2 AND state='pending'
  UNION ALL SELECT 1 FROM mail_outbox WHERE user_id=$1 AND account_id=$2 AND state IN ('queued','sending') LIMIT 1`;

type ActionJob = {
  kind: 'actions' | 'outgoing';
  userId: string;
  accountId: string;
};

export async function startMailWorker(
  boss: PgBoss,
  pool: Pool,
  keys: MailKeys,
) {
  await boss.createQueue('mail-sync', {
    policy: 'exclusive',
    retryLimit: 3,
    retryDelay: 15,
    retryBackoff: true,
    expireInSeconds: 120,
  });
  await boss.createQueue('mail-dispatch', {
    policy: 'exclusive',
    retryLimit: 3,
    retryDelay: 10,
    expireInSeconds: 60,
  });
  await boss.createQueue('mail-content', {
    policy: 'exclusive',
    retryLimit: 3,
    retryDelay: 10,
    retryBackoff: true,
    expireInSeconds: 120,
  });
  // next_sync_at is a transactional outbox: committed connect/sync requests survive
  // API/queue outages. The dispatcher can safely replay them after a restart.
  async function dispatch() {
    if (!keys.keys.size) return;
    await pool.query(
      'DELETE FROM mail_content WHERE expires_at<clock_timestamp()',
    );
    await pool.query(
      `DELETE FROM mail_actions WHERE state<>'pending' AND (state IN ('applied','cancelled') OR dismissed_at IS NOT NULL)
      AND completed_at<clock_timestamp()-interval '7 days'`,
    );
    await pool.query(`DELETE FROM mail_outbox WHERE completed_at<clock_timestamp()-interval '7 days'
      AND (state='cancelled' OR (state='accepted' AND sent_copy IN ('saved','unavailable','failed')))`);
    const outgoing =
      await pool.query(`SELECT user_id,account_id FROM mail_smtp WHERE state='pending'
      UNION SELECT user_id,account_id FROM mail_outbox WHERE account_id IS NOT NULL AND
      ((state='queued' AND next_attempt_at<=clock_timestamp()) OR state='sending' OR
       (state IN ('accepted','partial','unknown') AND sent_copy IN ('pending','appending','unknown') AND next_attempt_at<=clock_timestamp())) LIMIT 100`);
    for (const row of outgoing.rows)
      await boss.send(
        'mail-content',
        { kind: 'outgoing', userId: row.user_id, accountId: row.account_id },
        { singletonKey: `outgoing:${row.account_id}` },
      );
    const actions =
      await pool.query(`SELECT DISTINCT user_id,account_id FROM mail_actions
      WHERE state='pending' AND next_attempt_at<=clock_timestamp() LIMIT 100`);
    // Actions share the content queue so each worker keeps two provider connections at most.
    for (const row of actions.rows)
      await boss.send(
        'mail-content',
        { kind: 'actions', userId: row.user_id, accountId: row.account_id },
        { singletonKey: `actions:${row.account_id}` },
      );
    const pending =
      await pool.query(`SELECT user_id,account_id,message_id,version FROM mail_content
      WHERE state='pending' AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at LIMIT 100`);
    for (const row of pending.rows)
      await boss.send(
        'mail-content',
        {
          userId: row.user_id,
          accountId: row.account_id,
          messageId: row.message_id,
          version: row.version,
        },
        { singletonKey: row.message_id },
      );
    const attachments =
      await pool.query(`SELECT t.user_id,t.account_id,t.message_id,t.position,c.version
      FROM mail_content_attachments t JOIN mail_content c ON c.user_id=t.user_id AND c.message_id=t.message_id
      WHERE t.state='pending' AND t.next_attempt_at<=clock_timestamp() ORDER BY t.next_attempt_at LIMIT 100`);
    for (const row of attachments.rows)
      await boss.send(
        'mail-content',
        {
          userId: row.user_id,
          accountId: row.account_id,
          messageId: row.message_id,
          version: row.version,
          attachment: row.position,
        },
        { singletonKey: `${row.message_id}:${row.position}` },
      );
    const due =
      await pool.query(`SELECT a.id,a.user_id FROM mail_accounts a JOIN users u ON u.id=a.user_id
      WHERE a.next_sync_at<=clock_timestamp() AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp())
      AND u.email_verified ORDER BY a.next_sync_at LIMIT 100`);
    for (const account of due.rows) {
      if (
        (await pool.query(contentPending, [account.user_id, account.id]))
          .rowCount
      )
        continue;
      await boss.send(
        'mail-sync',
        { accountId: account.id, userId: account.user_id },
        { singletonKey: account.id },
      );
    }
  }
  await boss.work('mail-dispatch', { pollingIntervalSeconds: 1 }, async () =>
    dispatch(),
  );
  await boss.work<{ accountId: string; userId: string }>(
    'mail-sync',
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      const data = job?.data;
      if (
        !data ||
        typeof data.userId !== 'string' ||
        typeof data.accountId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          data.accountId,
        ) ||
        data.userId.length === 0 ||
        data.userId.length > 128
      )
        throw new Error('Invalid mail job');
      if (
        (await pool.query(contentPending, [data.userId, data.accountId]))
          .rowCount
      )
        return;
      await syncAccount(pool, keys, data.userId, data.accountId);
    },
  );
  await boss.work<ContentJob | ActionJob>(
    'mail-content',
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      const uuid =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
      const data = job?.data;
      if (data && 'kind' in data) {
        const { userId, accountId } = data;
        if (
          !['actions', 'outgoing'].includes(data.kind) ||
          typeof userId !== 'string' ||
          !userId ||
          userId.length > 128 ||
          typeof accountId !== 'string' ||
          !uuid.test(accountId)
        )
          throw new Error('Invalid action job');
        return data.kind === 'outgoing'
          ? processOutgoing(pool, keys, userId, accountId)
          : applyMailActions(pool, keys, userId, accountId);
      }
      if (
        !data ||
        typeof data.userId !== 'string' ||
        !data.userId ||
        data.userId.length > 128 ||
        ![data.accountId, data.messageId, data.version].every(
          (id) => typeof id === 'string' && uuid.test(id),
        ) ||
        (data.attachment !== undefined &&
          !(
            Number.isInteger(data.attachment) &&
            data.attachment >= 0 &&
            data.attachment < MAX_ATTACHMENTS
          ))
      )
        throw new Error('Invalid content job');
      await fetchMessageContent(pool, keys, data);
    },
  );
  await boss.schedule('mail-dispatch', '* * * * *');
  await boss.send('mail-dispatch');
  // Fast local feedback; the durable schedule above recovers missed timer ticks.
  const timer = setInterval(() => {
    void boss
      .send('mail-dispatch')
      .catch(() => logger.error('Mail dispatch unavailable'));
  }, 5000);
  timer.unref();
  return () => clearInterval(timer);
}
