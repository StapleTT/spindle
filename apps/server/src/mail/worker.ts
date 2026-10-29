import type { Pool } from 'pg';
import type { PgBoss } from 'pg-boss';
import { logger } from '../logger.js';
import { applyMailActions } from './actions.js';
import { type ContentJob, fetchMessageContent } from './content-worker.js';
import { wakeSnoozedConversations } from './conversation-state.js';
import type { MailKeys } from './credentials.js';
import { cleanupUploads, fetchForwardFile, scanUpload } from './file-worker.js';
import { watchInbox } from './idle.js';
import { MAX_ATTACHMENTS } from './media.js';
import { processOutgoing } from './outgoing-worker.js';
import { syncProviderDrafts } from './provider-drafts.js';
import { syncAccount } from './sync.js';
import { contentPending } from './work-pending.js';

type ActionJob = {
  kind: 'actions' | 'outgoing' | 'draft-attachment' | 'provider-drafts';
  userId: string;
  accountId: string;
  fileId?: string;
};

export async function startMailWorker(
  boss: PgBoss,
  pool: Pool,
  keys: MailKeys,
) {
  const shutdown = new AbortController();
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
  await boss.createQueue('mail-file', {
    policy: 'exclusive',
    retryLimit: 2,
    retryDelay: 15,
    expireInSeconds: 120,
  });
  // next_sync_at is a transactional outbox: committed connect/sync requests survive
  // API/queue outages. The dispatcher can safely replay them after a restart.
  async function dispatch() {
    await wakeSnoozedConversations(pool);
    await cleanupUploads(pool);
    await pool.query(`UPDATE mail_uploads f SET state='failed',error_code='source_unavailable',reserved_bytes=0
      WHERE f.state='pending_fetch' AND NOT EXISTS(SELECT 1 FROM mail_accounts a WHERE a.user_id=f.user_id AND a.id::text=f.source->>'accountId')`);
    for (const row of (
      await pool.query(`SELECT f.user_id,f.id FROM mail_uploads f JOIN users u ON u.id=f.user_id
      WHERE u.email_verified AND (f.state='pending_scan' OR (f.state='scanning' AND f.lease_until<clock_timestamp())) LIMIT 100`)
    ).rows)
      await boss.send(
        'mail-file',
        { userId: row.user_id, fileId: row.id },
        { singletonKey: row.id },
      );
    if (!keys.keys.size) return;
    await pool.query(`INSERT INTO mail_draft_imports(user_id,account_id,path,uid_validity,uid,subject)
      SELECT m.user_id,m.account_id,b.path,mm.uid_validity::text,mm.uid::text,left(m.subject,1000)
      FROM mail_memberships mm JOIN mail_messages m ON m.user_id=mm.user_id AND m.id=mm.message_id
      JOIN mailboxes b ON b.user_id=mm.user_id AND b.id=mm.mailbox_id JOIN users u ON u.id=m.user_id
      WHERE b.role='\\Drafts' AND u.email_verified AND NOT('\\Deleted'=ANY(mm.flags))
      AND NOT EXISTS(SELECT 1 FROM mail_draft_imports i WHERE i.user_id=m.user_id AND i.account_id=m.account_id AND i.path=b.path AND i.uid_validity=mm.uid_validity::text AND i.uid=mm.uid::text)
      AND NOT EXISTS(SELECT 1 FROM mail_draft_copies c JOIN mail_draft_links l ON l.user_id=c.user_id AND l.id=c.link_id
        WHERE l.user_id=m.user_id AND l.account_id=m.account_id AND ((c.path=b.path AND c.uid_validity=mm.uid_validity::text AND c.uid=mm.uid::text) OR (c.message_id IS NOT NULL AND c.message_id=m.message_id)))
      LIMIT 20 ON CONFLICT DO NOTHING`);
    for (const row of (
      await pool.query(`SELECT p.user_id,p.account_id FROM mail_draft_links p JOIN users u ON u.id=p.user_id WHERE p.state NOT IN ('conflict','removed','unknown') AND p.next_attempt_at<=clock_timestamp() AND u.email_verified
      UNION SELECT i.user_id,i.account_id FROM mail_draft_imports i JOIN users u ON u.id=i.user_id WHERE i.state='pending' AND i.next_attempt_at<=clock_timestamp() AND u.email_verified LIMIT 100`)
    ).rows)
      await boss.send(
        'mail-content',
        {
          kind: 'provider-drafts',
          userId: row.user_id,
          accountId: row.account_id,
        },
        { singletonKey: `drafts:${row.account_id}` },
      );
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
    for (const row of (
      await pool.query(`SELECT f.user_id,f.id,f.source->>'accountId' AS account_id FROM mail_uploads f JOIN users u ON u.id=f.user_id
      WHERE f.state='pending_fetch' AND u.email_verified LIMIT 100`)
    ).rows)
      await boss.send(
        'mail-content',
        {
          kind: 'draft-attachment',
          userId: row.user_id,
          accountId: row.account_id,
          fileId: row.id,
        },
        { singletonKey: `file:${row.id}` },
      );
    const pending =
      await pool.query(`SELECT user_id,account_id,message_id,version FROM mail_content
      WHERE (state='pending' OR reply_headers_pending) AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at LIMIT 100`);
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
    // IDLE rotates through ready inboxes after real sync work, using the same slot.
    const idle =
      await pool.query(`SELECT a.id,a.user_id FROM mail_accounts a JOIN users u ON u.id=a.user_id
      WHERE u.email_verified AND a.status='ready' AND a.next_idle_at<=clock_timestamp() AND a.next_sync_at>clock_timestamp()
      AND (a.lease_until IS NULL OR a.lease_until<clock_timestamp())
      AND EXISTS(SELECT 1 FROM mailboxes b WHERE b.user_id=a.user_id AND b.account_id=a.id AND b.role='inbox' AND b.initial_complete)
      ORDER BY a.next_idle_at,a.id LIMIT 100`);
    for (const account of idle.rows)
      await boss.send(
        'mail-sync',
        { kind: 'idle', userId: account.user_id, accountId: account.id },
        { singletonKey: `idle:${account.id}` },
      );
  }
  await boss.work('mail-dispatch', { pollingIntervalSeconds: 1 }, async () =>
    dispatch(),
  );
  await boss.work<{ accountId: string; userId: string; kind?: 'idle' }>(
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
        data.userId.length > 128 ||
        (data.kind !== undefined && data.kind !== 'idle')
      )
        throw new Error('Invalid mail job');
      if (shutdown.signal.aborted) return;
      if (
        (await pool.query(contentPending, [data.userId, data.accountId]))
          .rowCount
      )
        return;
      if (data.kind === 'idle') {
        const changed = await watchInbox(
          pool,
          keys,
          data.userId,
          data.accountId,
          shutdown.signal,
        );
        if (
          !changed ||
          shutdown.signal.aborted ||
          (await pool.query(contentPending, [data.userId, data.accountId]))
            .rowCount
        )
          return;
      }
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
          ![
            'actions',
            'outgoing',
            'draft-attachment',
            'provider-drafts',
          ].includes(data.kind) ||
          typeof userId !== 'string' ||
          !userId ||
          userId.length > 128 ||
          typeof accountId !== 'string' ||
          !uuid.test(accountId) ||
          (data.kind === 'draft-attachment' &&
            (typeof data.fileId !== 'string' || !uuid.test(data.fileId)))
        )
          throw new Error('Invalid action job');
        if (data.kind === 'draft-attachment')
          return fetchForwardFile(
            pool,
            keys,
            userId,
            accountId,
            data.fileId ?? '',
          );
        if (data.kind === 'provider-drafts')
          return syncProviderDrafts(pool, keys, userId, accountId);
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
  await boss.work<{ userId: string; fileId: string }>(
    'mail-file',
    { localConcurrency: 1, pollingIntervalSeconds: 1 },
    async ([job]) => {
      if (
        !job?.data ||
        typeof job.data.userId !== 'string' ||
        !job.data.userId ||
        job.data.userId.length > 128 ||
        !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(job.data.fileId)
      )
        throw new Error('Invalid file job');
      await scanUpload(pool, job.data.userId, job.data.fileId);
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
  return () => {
    clearInterval(timer);
    shutdown.abort();
  };
}
