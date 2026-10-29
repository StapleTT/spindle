import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { watchInbox } from '../src/mail/idle.js';
import type { connectImap } from '../src/mail/imap.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

test('bounded owned IDLE wakes durable inbox sync, yields to work, and preserves fallback', {
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
      v1: Buffer.alloc(32, 65).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  const previousSchedules = (
    await pool.query('SELECT id,next_sync_at FROM mail_accounts')
  ).rows;
  t.after(async () => {
    for (const row of previousSchedules)
      await pool.query('UPDATE mail_accounts SET next_sync_at=$2 WHERE id=$1', [
        row.id,
        row.next_sync_at,
      ]);
    await app.close();
  });
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'idle-owner@example.test',
      '203.0.113.221',
    ),
    other = await createTestUser(
      app,
      pool,
      testConfig,
      'idle-admin@example.test',
      '203.0.113.221',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const fixture = await imapFixture(t, true, true, ['IDLE', 'UIDPLUS', 'MOVE']);
  const server = fixture.server;
  const commands: string[] = [];
  let idleStarts = 0;
  server.on('session', (event: { type: string; command?: string }) => {
    if (event.type === 'waiting' && event.command === 'IDLE') idleStarts++;
  });
  server.on('command', (event: { command: string }) =>
    commands.push(event.command),
  );
  server.control.addMessage('INBOX', {
    raw: rawMail('Before IDLE', 'idle-before@example.test'),
    flags: [],
    internaldate: new Date(),
  });
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie, origin: testConfig.appUrl },
    payload: {
      name: 'IDLE account',
      host: 'localhost',
      port: fixture.port,
      transport: 'tls',
      username: 'testuser',
      password: imapPassword,
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  async function prepare() {
    await pool.query('DELETE FROM mail_request_limits');
    // Other suites share this disposable DB; keep their dormant fixture accounts out of this watch's priority check.
    await pool.query(
      "UPDATE mail_accounts SET next_sync_at=clock_timestamp()+interval '5 minutes' WHERE id<>$1",
      [account],
    );
    await pool.query(
      "UPDATE mail_accounts SET status='ready',next_sync_at=clock_timestamp()+interval '5 minutes',next_idle_at=clock_timestamp()-interval '1 second',lease_until=NULL,lease_token=NULL WHERE user_id=$1 AND id=$2",
      [owner.id, account],
    );
  }
  const stored = async () =>
    (
      await pool.query(
        'SELECT * FROM mail_accounts WHERE user_id=$1 AND id=$2',
        [owner.id, account],
      )
    ).rows[0];
  async function waitFor(check: () => Promise<boolean> | boolean, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail('IDLE state did not arrive');
  }
  async function readyIdle() {
    const before = idleStarts;
    const pending = watchInbox(pool, keys, owner.id, account);
    await waitFor(() => idleStarts > before);
    return { pending };
  }
  t.beforeEach(prepare);
  await t.test(
    'foreign admins, unverified users, active leases and aborted jobs never connect',
    async () => {
      let calls = 0;
      const connect: typeof connectImap = async () => {
        calls++;
        throw new Error('Unexpected connection');
      };
      assert.equal(
        await watchInbox(pool, keys, other.id, account, undefined, connect),
        false,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal(
        await watchInbox(pool, keys, owner.id, account, undefined, connect),
        false,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
      await pool.query(
        "UPDATE mail_accounts SET lease_until=clock_timestamp()+interval '1 minute',lease_token=gen_random_uuid() WHERE id=$1",
        [account],
      );
      assert.equal(
        await watchInbox(pool, keys, owner.id, account, undefined, connect),
        false,
      );
      const controller = new AbortController();
      controller.abort();
      assert.equal(
        await watchInbox(
          pool,
          keys,
          owner.id,
          account,
          controller.signal,
          connect,
        ),
        false,
      );
      assert.equal(calls, 0);
    },
  );
  await t.test(
    'EXISTS only records an owned fenced wakeup; normal sync imports without setting Seen',
    async () => {
      const { pending } = await readyIdle();
      assert.equal(await watchInbox(pool, keys, owner.id, account), false);
      server.control.addMessage('INBOX', {
        raw: rawMail('IDLE arrival', 'idle-arrival@example.test'),
        flags: [],
        internaldate: new Date(),
      });
      assert.equal(await pending, true);
      const state = await stored();
      assert.equal(state.lease_token, null);
      assert.ok(state.next_sync_at <= new Date());
      assert.equal(state.idle_failures, 0);
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM mail_messages WHERE user_id=$1 AND subject='IDLE arrival'",
              [owner.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      const inbox = (
        await pool.query(
          "SELECT last_synced_at FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND role='inbox'",
          [owner.id, account],
        )
      ).rows[0];
      assert.equal(inbox.last_synced_at, null);
      await syncAccount(pool, keys, owner.id, account);
      const message = (
        await pool.query(
          "SELECT mm.flags FROM mail_messages m JOIN mail_memberships mm ON mm.user_id=m.user_id AND mm.message_id=m.id WHERE m.user_id=$1 AND m.subject='IDLE arrival'",
          [owner.id],
        )
      ).rows[0];
      assert.ok(message);
      assert.ok(!message.flags.includes('\\Seen'));
      assert.equal(
        commands.some((command) => /STORE|APPEND|MOVE|EXPUNGE/.test(command)),
        false,
      );
    },
  );
  await t.test(
    'external flags and expunges request reconciliation instead of trusting notifications',
    async () => {
      const { pending } = await readyIdle();
      server.control.setFlags('INBOX', [1], ['\\Seen'], 'add');
      assert.equal(await pending, true);
      await syncAccount(pool, keys, owner.id, account);
      assert.ok(
        (
          await pool.query(
            'SELECT flags FROM mail_memberships WHERE user_id=$1 AND uid=1',
            [owner.id],
          )
        ).rows[0].flags.includes('\\Seen'),
      );
      await prepare();
      const expunge = await readyIdle();
      server.control.expungeMessages('INBOX', [1]);
      assert.equal(await expunge.pending, true);
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM mail_memberships WHERE user_id=$1 AND uid=1',
            [owner.id],
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    'arrival between connections and UIDVALIDITY changes are detected on read-only selection',
    async () => {
      server.control.addMessage('INBOX', {
        raw: rawMail('Gap arrival', 'idle-gap@example.test'),
        flags: [],
        internaldate: new Date(),
      });
      assert.equal(await watchInbox(pool, keys, owner.id, account), true);
      await syncAccount(pool, keys, owner.id, account);
      await prepare();
      await pool.query(
        "UPDATE mailboxes SET uid_validity='999' WHERE user_id=$1 AND account_id=$2 AND role='inbox'",
        [owner.id, account],
      );
      assert.equal(await watchInbox(pool, keys, owner.id, account), true);
      await syncAccount(pool, keys, owner.id, account);
    },
  );
  await t.test(
    'user content and Sync now preempt IDLE and retain their durable requests',
    async () => {
      const { pending } = await readyIdle();
      const id = (
        await pool.query(
          'SELECT id FROM mail_messages WHERE user_id=$1 LIMIT 1',
          [owner.id],
        )
      ).rows[0].id;
      await pool.query(
        'INSERT INTO mail_content(user_id,account_id,message_id) VALUES($1,$2,$3)',
        [owner.id, account, id],
      );
      assert.equal(await pending, false);
      assert.equal((await stored()).lease_token, null);
      assert.equal(
        (
          await pool.query(
            'SELECT state FROM mail_content WHERE user_id=$1 AND message_id=$2',
            [owner.id, id],
          )
        ).rows[0].state,
        'pending',
      );
      await pool.query('DELETE FROM mail_content WHERE user_id=$1', [owner.id]);
      await prepare();
      const manual = await readyIdle();
      const response = await app.inject({
        method: 'POST',
        url: `/api/mail/accounts/${account}/sync`,
        headers: { cookie: owner.cookie, origin: testConfig.appUrl },
        payload: {},
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(await manual.pending, false);
      assert.ok((await stored()).next_sync_at <= new Date());
    },
  );
  await t.test(
    'verification revocation, lease replacement and shutdown promptly close connections',
    async () => {
      const { pending } = await readyIdle();
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal(await pending, false);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
      await prepare();
      const replacement = await readyIdle();
      const token = (
        await pool.query(
          "UPDATE mail_accounts SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1 RETURNING lease_token",
          [account],
        )
      ).rows[0].lease_token;
      assert.equal(await replacement.pending, false);
      assert.equal((await stored()).lease_token, token);
      await prepare();
      const controller = new AbortController();
      const before = idleStarts;
      const stopped = watchInbox(
        pool,
        keys,
        owner.id,
        account,
        controller.signal,
      );
      await waitFor(() => idleStarts > before);
      controller.abort();
      assert.equal(await stopped, false);
      assert.equal((await stored()).lease_token, null);
      await waitFor(() => server.control.sessions().length === 0);
    },
  );
  await t.test(
    'server disconnects and unsupported IDLE back off without breaking polling or cached mail',
    async () => {
      const { pending } = await readyIdle();
      for (const session of server.control.sessions())
        server.control.disconnect(session.session, { reset: true });
      assert.equal(await pending, false);
      const failed = await stored();
      assert.equal(failed.status, 'ready');
      assert.equal(failed.idle_failures, 1);
      assert.ok(failed.next_idle_at.getTime() > Date.now() + 20000);
      server.registerCapability('IDLE', () => false);
      await prepare();
      const before = idleStarts;
      assert.equal(await watchInbox(pool, keys, owner.id, account), false);
      assert.equal(idleStarts, before);
      assert.ok((await stored()).next_idle_at.getTime() > Date.now() + 3500000);
      server.control.addMessage('INBOX', {
        raw: rawMail('Polling fallback', 'idle-poll@example.test'),
        flags: [],
        internaldate: new Date(),
      });
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM mail_messages WHERE user_id=$1 AND subject='Polling fallback'",
            [owner.id],
          )
        ).rowCount,
        1,
      );
      server.registerCapability('IDLE');
      await prepare();
      server.script.add({
        on: 'command',
        command: 'IDLE',
        times: 1,
        send: '$TAG NO IDLE temporarily unavailable\r\n',
      });
      assert.equal(await watchInbox(pool, keys, owner.id, account), false);
      assert.equal((await stored()).idle_failures, 1);
      server.script.clear();
    },
  );
  await t.test(
    'reconnecting resets IDLE backoff and fences off the old watcher',
    async () => {
      const { pending } = await readyIdle();
      await pool.query(
        "UPDATE mail_accounts SET idle_failures=5,next_idle_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [account],
      );
      const response = await app.inject({
        method: 'POST',
        url: '/api/mail/accounts',
        headers: { cookie: owner.cookie, origin: testConfig.appUrl },
        payload: {
          name: 'Reconnected inbox',
          host: 'localhost',
          port: fixture.port,
          transport: 'tls',
          username: 'testuser',
          password: imapPassword,
          history: 'all',
        },
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().account.id, account);
      assert.equal(await pending, false);
      const fresh = await stored();
      assert.equal(fresh.idle_failures, 0);
      assert.ok(fresh.next_idle_at <= new Date());
      assert.equal(fresh.status, 'pending');
      await syncAccount(pool, keys, owner.id, account);
    },
  );
  await t.test(
    "another user's due metadata work preempts a watch instead of waiting for its entire duration",
    async () => {
      const { pending } = await readyIdle();
      const response = await app.inject({
        method: 'POST',
        url: '/api/mail/accounts',
        headers: { cookie: other.cookie, origin: testConfig.appUrl },
        payload: {
          name: 'Other private inbox',
          host: 'localhost',
          port: fixture.port,
          transport: 'tls',
          username: 'testuser',
          password: imapPassword,
          history: 'all',
        },
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(await pending, false);
      const otherAccount = response.json().account.id;
      await syncAccount(pool, keys, other.id, otherAccount);
      await pool.query(
        "UPDATE mail_accounts SET next_sync_at=clock_timestamp()+interval '5 minutes',next_idle_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [otherAccount],
      );
    },
  );
  await t.test(
    'a quiet watch releases its slot within the fixed time budget',
    async () => {
      const started = Date.now();
      assert.equal(await watchInbox(pool, keys, owner.id, account), false);
      assert.ok(Date.now() - started < 23000);
      assert.equal((await stored()).lease_token, null);
      assert.equal((await stored()).idle_failures, 0);
    },
  );
  await t.test(
    'durable worker dispatch syncs an IDLE arrival before the five-minute poll deadline, stays within budget and stops cleanly',
    async () => {
      const boss = new PgBoss({ connectionString });
      const errors: unknown[] = [];
      boss.on('error', (error) => errors.push(error));
      await boss.start();
      let stop: (() => void) | undefined;
      let maxConnections = 0;
      const monitor = setInterval(() => {
        maxConnections = Math.max(
          maxConnections,
          server.control.sessions().length,
        );
      }, 20);
      try {
        const before = idleStarts;
        stop = await startMailWorker(boss, pool, keys);
        await waitFor(() => idleStarts > before, 12000);
        server.control.addMessage('INBOX', {
          raw: rawMail('Worker IDLE delivery', 'idle-worker@example.test'),
          flags: [],
          internaldate: new Date(),
        });
        await waitFor(
          async () =>
            !!(
              await pool.query(
                "SELECT 1 FROM mail_messages WHERE user_id=$1 AND subject='Worker IDLE delivery'",
                [owner.id],
              )
            ).rowCount,
          12000,
        );
        assert.ok(maxConnections <= 2);
        assert.deepEqual(errors, []);
      } finally {
        clearInterval(monitor);
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
      await waitFor(() => server.control.sessions().length === 0);
    },
  );
  await t.test(
    'account deletion cannot be undone by a late notification',
    async () => {
      const { pending } = await readyIdle();
      await pool.query('DELETE FROM mail_accounts WHERE user_id=$1 AND id=$2', [
        owner.id,
        account,
      ]);
      assert.equal(await pending, false);
      assert.equal(
        (await pool.query('SELECT 1 FROM mail_accounts WHERE id=$1', [account]))
          .rowCount,
        0,
      );
    },
  );
});
