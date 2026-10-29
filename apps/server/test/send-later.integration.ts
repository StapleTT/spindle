import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { processOutgoing } from '../src/mail/outgoing-worker.js';
import { connectSmtp } from '../src/mail/smtp.js';
import { syncAccount } from '../src/mail/sync.js';
import { contentPending } from '../src/mail/work-pending.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword } from './imap-fixture.js';
import { smtpFixture, smtpPassword } from './smtp-fixture.js';

test('scheduled immutable sends survive restarts, reschedule safely and preserve uncertain-delivery protections', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 77).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'schedule-owner@example.test',
      '203.0.113.227',
    ),
    admin = await createTestUser(
      app,
      pool,
      testConfig,
      'schedule-admin@example.test',
      '203.0.113.227',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
  const imap = await imapFixture(t, true, true, [], true),
    smtp = await smtpFixture(t, imap.server);
  function request(
    path: string,
    method: 'GET' | 'PUT' | 'POST' | 'PATCH' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) {
    return app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { cookie, origin },
      ...(payload ? { payload } : {}),
    });
  }
  const connected = await request('accounts', 'POST', {
    name: 'Send later',
    host: 'localhost',
    port: imap.port,
    transport: 'tls',
    username: 'testuser',
    password: imapPassword,
    history: 'all',
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  const setup = async () => {
    const res = await request(`accounts/${account}/smtp`, 'PUT', {
      host: 'localhost',
      port: smtp.port,
      transport: 'tls',
      username: 'writer@example.test',
      password: smtpPassword,
      saveSentCopy: true,
    });
    assert.equal(res.statusCode, 202, res.body);
    await processOutgoing(pool, keys, owner.id, account);
  };
  const future = (ms = 3600000) => new Date(Date.now() + ms).toISOString();
  const draft = async () => {
    const id = randomUUID();
    const res = await request(`drafts/${id}`, 'PUT', {
      revision: 0,
      saveId: randomUUID(),
      accountId: account,
      content: {
        to: 'recipient@example.test',
        cc: '',
        bcc: 'hidden@example.test',
        subject: 'Scheduled synthetic mail',
        format: 'plain',
        html: '',
        text: 'Frozen scheduled body',
      },
    });
    assert.equal(res.statusCode, 200, res.body);
    return id;
  };
  async function enqueue(at = future()) {
    const id = await draft(),
      operation = randomUUID();
    const result = await request(`drafts/${id}/send`, 'POST', {
      id: operation,
      revision: 1,
      scheduledAt: at,
    });
    assert.equal(result.statusCode, 202, result.body);
    return { id, operation, at };
  }
  const row = async (id: string) =>
    (await pool.query('SELECT * FROM mail_outbox WHERE id=$1', [id])).rows[0];
  const due = async (id: string) =>
    pool.query(
      "UPDATE mail_outbox SET scheduled_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() WHERE id=$1",
      [id],
    );
  const reschedule = (
    id: string,
    revision = 1,
    scheduledAt = future(7200000),
  ) => request(`outbox/${id}/reschedule`, 'PATCH', { revision, scheduledAt });
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_outbox');
    await pool.query('DELETE FROM mail_drafts');
    await pool.query('DELETE FROM mail_request_limits');
    smtp.received.length = 0;
    Object.assign(smtp.controls, {
      dropAfterData: false,
      rejectData: false,
      rejectRecipient: false,
      authFail: false,
      autoSaveSent: false,
    });
    await setup();
  });
  await t.test(
    'private/verified ownership, origin, future bounds and schema validation protect scheduling and rescheduling',
    async () => {
      const d = await draft(),
        id = randomUUID();
      for (const at of ['bad', '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z'])
        assert.ok(
          [400, 409].includes(
            (
              await request(`drafts/${d}/send`, 'POST', {
                id,
                revision: 1,
                scheduledAt: at,
              })
            ).statusCode,
          ),
        );
      const queued = await enqueue();
      assert.equal(
        (
          await request(
            `outbox/${queued.operation}/reschedule`,
            'PATCH',
            { revision: 1, scheduledAt: future() },
            admin.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            `outbox/${queued.operation}/reschedule`,
            'PATCH',
            { revision: 1, scheduledAt: future() },
            '',
            testConfig.appUrl,
          )
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await request(
            `outbox/${queued.operation}/reschedule`,
            'PATCH',
            { revision: 1, scheduledAt: future() },
            owner.cookie,
            'https://evil.example',
          )
        ).statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal((await reschedule(queued.operation)).statusCode, 403);
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 0);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
      assert.equal(
        (await reschedule(queued.operation, 1, '2020-01-01T00:00:00Z'))
          .statusCode,
        409,
      );
    },
  );
  await t.test(
    'enqueue/replay freezes one snapshot, retains long dates without overflow and does not starve metadata work',
    async () => {
      const q = await enqueue(future(300 * 86400000));
      const initial = await row(q.operation);
      assert.equal(initial.state, 'queued');
      assert.equal(initial.scheduled_at.getTime(), Date.parse(q.at));
      assert.equal(initial.next_attempt_at.getTime(), Date.parse(q.at));
      assert.equal(
        (await pool.query(contentPending, [owner.id, account])).rowCount,
        0,
      );
      const replay = await request(`drafts/${q.id}/send`, 'POST', {
        id: q.operation,
        revision: 1,
        scheduledAt: future(),
      });
      assert.equal(replay.statusCode, 202, replay.body);
      assert.equal(
        new Date(replay.json().outbox.scheduledAt).getTime(),
        Date.parse(q.at),
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_outbox WHERE user_id=$1', [
            owner.id,
          ])
        ).rowCount,
        1,
      );
      const list = await request('outbox');
      assert.equal(list.statusCode, 200, list.body);
      assert.equal(list.json().messages[0].undoMs, 0);
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE id=$1',
        [q.operation],
      );
      assert.equal(
        (await row(q.operation)).next_attempt_at.getTime(),
        Date.parse(q.at),
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 0);
      assert.equal((await row(q.operation)).state, 'queued');
      const frozen = await request(`drafts/${q.id}`, 'PUT', {
        revision: 1,
        saveId: randomUUID(),
        accountId: account,
        content: {
          to: 'changed@example.test',
          cc: '',
          bcc: '',
          subject: 'changed',
          format: 'plain',
          html: '',
          text: 'changed',
        },
      });
      assert.equal(frozen.statusCode, 409);
      assert.deepEqual((await row(q.operation)).raw, initial.raw);
    },
  );
  await t.test(
    'reschedule is guarded and replayable, preserves bytes and cancellation safely releases editing',
    async () => {
      const q = await enqueue(),
        raw = (await row(q.operation)).raw,
        at = future(7200000);
      assert.equal((await reschedule(q.operation, 1, at)).statusCode, 200);
      assert.equal((await row(q.operation)).schedule_revision, 2);
      assert.equal((await reschedule(q.operation, 1, at)).statusCode, 200);
      assert.equal(
        (await reschedule(q.operation, 1, future(10800000))).statusCode,
        409,
      );
      assert.deepEqual((await row(q.operation)).raw, raw);
      const cancelled = await request(
        `outbox/${q.operation}/cancel`,
        'POST',
        {},
      );
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.json().draftId, q.id);
      assert.equal(Date.parse(cancelled.json().scheduledAt), Date.parse(at));
      assert.equal(
        (await request(`outbox/${q.operation}/cancel`, 'POST', {})).statusCode,
        200,
      );
      assert.equal((await reschedule(q.operation, 2)).statusCode, 409);
      await due(q.operation);
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 0);
      const d = (await request(`drafts/${q.id}`)).json().draft;
      assert.equal(d.outbox, null);
      assert.equal(d.content.text, 'Frozen scheduled body');
    },
  );
  await t.test(
    'past-due persisted intent is dispatched once by worker startup and keeps Bcc private in SMTP and Sent',
    async () => {
      const q = await enqueue();
      await due(q.operation);
      const frozen = (await row(q.operation)).raw;
      const boss = new PgBoss({ connectionString });
      await boss.start();
      let stop: (() => void) | undefined;
      try {
        stop = await startMailWorker(boss, pool, keys);
        const deadline = Date.now() + 15000;
        while (
          Date.now() < deadline &&
          (await row(q.operation)).state !== 'accepted'
        )
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal((await row(q.operation)).state, 'accepted');
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
      assert.equal(smtp.received.length, 1);
      assert.deepEqual(smtp.received[0]?.raw, frozen);
      const parsed = await simpleParser(
        smtp.received[0]?.raw ?? Buffer.alloc(0),
      );
      assert.equal(parsed.bcc, undefined);
      assert.ok(smtp.received[0]?.recipients.includes('hidden@example.test'));
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 1);
    },
  );
  await t.test(
    'rescheduling while a worker is waiting preserves the new deadline',
    async () => {
      const q = await enqueue();
      await due(q.operation);
      // Hold the shared account/user lock at the final claim boundary.
      const db = await pool.connect();
      await db.query('BEGIN');
      await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner.id]);
      const processing = processOutgoing(pool, keys, owner.id, account);
      const at = future(7200000);
      await db.query(
        'UPDATE mail_outbox SET scheduled_at=$2,next_attempt_at=$2,schedule_revision=schedule_revision+1 WHERE id=$1',
        [q.operation, at],
      );
      await db.query('COMMIT');
      db.release();
      await processing;
      assert.equal((await row(q.operation)).state, 'queued');
      assert.equal(smtp.received.length, 0);
      assert.equal(
        (await row(q.operation)).scheduled_at.getTime(),
        Date.parse(at),
      );
    },
  );
  await t.test(
    'dispatch claim wins cancellation/reschedule races, and uncertain scheduled delivery is never resent',
    async () => {
      const q = await enqueue();
      await due(q.operation);
      let ready!: () => void, release!: () => void;
      const claimed = new Promise<void>((resolve) => {
          ready = resolve;
        }),
        gate = new Promise<void>((resolve) => {
          release = resolve;
        });
      const processing = processOutgoing(
        pool,
        keys,
        owner.id,
        account,
        async (...args) => {
          ready();
          await gate;
          return connectSmtp(...args);
        },
      );
      try {
        await claimed;
        assert.equal(
          (await request(`outbox/${q.operation}/cancel`, 'POST', {}))
            .statusCode,
          409,
        );
        assert.equal((await reschedule(q.operation)).statusCode, 409);
      } finally {
        release();
        await processing;
      }
      assert.equal(smtp.received.length, 1);
      const unknown = await enqueue();
      await due(unknown.operation);
      smtp.controls.dropAfterData = true;
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal((await row(unknown.operation)).state, 'unknown');
      assert.equal(
        (await request(`outbox/${unknown.operation}/retry`, 'POST', {}))
          .statusCode,
        409,
      );
      assert.equal((await reschedule(unknown.operation)).statusCode, 409);
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 2);
    },
  );
  await t.test(
    'scheduled attachment snapshots remain streamed and unchanged, and dispatch rechecks file readiness',
    async () => {
      const d = await draft(),
        file = randomUUID(),
        bytes = Buffer.from('Synthetic scheduled attachment');
      await pool.query(
        "INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state) VALUES($1,$2,'scheduled.txt',$3,$3,'ready')",
        [file, owner.id, bytes.length],
      );
      await pool.query(
        'INSERT INTO mail_upload_chunks(user_id,file_id,position,data) VALUES($1,$2,0,$3)',
        [owner.id, file, bytes],
      );
      const value = (await request(`drafts/${d}`)).json().draft;
      const saved = await request(`drafts/${d}`, 'PUT', {
        revision: 1,
        saveId: randomUUID(),
        accountId: account,
        content: value.content,
        attachmentIds: [file],
      });
      assert.equal(saved.statusCode, 200, saved.body);
      const op = randomUUID();
      const queued = await request(`drafts/${d}/send`, 'POST', {
        id: op,
        revision: saved.json().draft.revision,
        scheduledAt: future(),
      });
      assert.equal(queued.statusCode, 202, queued.body);
      const before = (
        await pool.query(
          'SELECT data FROM mail_outbox_chunks WHERE outbox_id=$1 ORDER BY position',
          [op],
        )
      ).rows.map((r) => r.data);
      assert.equal((await reschedule(op)).statusCode, 200);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT data FROM mail_outbox_chunks WHERE outbox_id=$1 ORDER BY position',
            [op],
          )
        ).rows.map((r) => r.data),
        before,
      );
      await pool.query(
        "UPDATE mail_uploads SET state='quarantined' WHERE id=$1",
        [file],
      );
      await due(op);
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal((await row(op)).error_code, 'attachments_unavailable');
      assert.equal(smtp.received.length, 0);
      await pool.query("UPDATE mail_uploads SET state='ready' WHERE id=$1", [
        file,
      ]);
      assert.equal(
        (await request(`outbox/${op}/retry`, 'POST', {})).statusCode,
        200,
      );
      await due(op);
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 1);
      const parsed = await simpleParser(
        smtp.received[0]?.raw ?? Buffer.alloc(0),
      );
      assert.deepEqual(parsed.attachments[0]?.content, bytes);
    },
  );
  await t.test(
    'current SMTP changes, per-day dispatch limits and account removal cannot submit a stale scheduled snapshot',
    async () => {
      const q = await enqueue();
      await due(q.operation);
      await pool.query(
        'UPDATE mail_smtp SET version=gen_random_uuid() WHERE account_id=$1',
        [account],
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal((await row(q.operation)).error_code, 'settings_changed');
      assert.equal(smtp.received.length, 0);
      await setup();
      const limited = await enqueue();
      await due(limited.operation);
      await pool.query(
        `INSERT INTO mail_outbox(id,user_id,source_draft_id,draft_revision,smtp_version,sender,recipients,subject,message_id,raw,state,started_at,completed_at)
      SELECT gen_random_uuid(),$1,gen_random_uuid(),1,gen_random_uuid(),'writer@example.test','["used@example.test"]','Quota','<'||gen_random_uuid()||'@quota.test>',decode('00','hex'),'accepted',clock_timestamp(),clock_timestamp() FROM generate_series(1,100)`,
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal((await row(limited.operation)).error_code, 'send_limit');
      assert.equal(smtp.received.length, 0);
      await pool.query("DELETE FROM mail_outbox WHERE subject='Quota'");
      const removed = await enqueue();
      await pool.query('DELETE FROM mail_accounts WHERE user_id=$1 AND id=$2', [
        owner.id,
        account,
      ]);
      assert.equal((await row(removed.operation)).state, 'failed');
      assert.equal(
        (await row(removed.operation)).error_code,
        'account_removed',
      );
      assert.equal(smtp.received.length, 0);
    },
  );
});
