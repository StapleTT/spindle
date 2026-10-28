import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { logger } from '../logger.js';
import type { MailKeys } from './credentials.js';
import { syncAccount } from './sync.js';

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
  // next_sync_at is a transactional outbox: committed connect/sync requests survive
  // API/queue outages. The dispatcher can safely replay them after a restart.
  async function dispatch() {
    if (!keys.keys.size) return;
    const due =
      await pool.query(`SELECT a.id,a.user_id FROM mail_accounts a JOIN users u ON u.id=a.user_id
      WHERE a.next_sync_at<=clock_timestamp() AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp())
      AND u.email_verified ORDER BY a.next_sync_at LIMIT 100`);
    for (const account of due.rows) {
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
    { localConcurrency: 2, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (
        !job ||
        typeof job.data?.userId !== 'string' ||
        typeof job.data?.accountId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
          job.data.accountId,
        ) ||
        job.data.userId.length === 0 ||
        job.data.userId.length > 128
      )
        throw new Error('Invalid mail job');
      await syncAccount(pool, keys, job.data.userId, job.data.accountId);
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
