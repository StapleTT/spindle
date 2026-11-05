// D041: time from a reader requesting a body to its cached copy, with IMAP
// IDLE holding the account lease and during a large metadata sync. Before
// D041 these took ~5 s and ~9 s (5-second dispatch timer, no sync yield).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, rawMail } from './imap-fixture.js';

test('requested bodies are fetched promptly, even during IDLE and sync', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 300000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 55).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'latency@example.test',
  );
  const { server, port } = await imapFixture(t);
  for (let i = 0; i < 6; i++)
    server.control.addMessage('INBOX', {
      raw: rawMail(`Quiet ${i}`, `quiet-${i}@example.test`),
      internaldate: new Date(),
      flags: [],
    });
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { cookie: owner.cookie, origin: testConfig.appUrl },
      ...(payload ? { payload } : {}),
    });
  const connected = await call('POST', '/api/mail/accounts', {
    name: 'Latency',
    host: 'localhost',
    port,
    transport: 'tls',
    username: 'testuser',
    password: 'synthetic-imap-password',
    history: 'all',
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  const boss = new PgBoss({ connectionString, useListenNotify: true });
  boss.on('error', () => undefined);
  await boss.start();
  const stop = await startMailWorker(boss, pool, keys);
  // Later suites share this database: stop the worker, then remove the
  // synthetic owner (cascading its account, mirror and cached bodies).
  t.after(async () => {
    stop();
    await boss.stop({ graceful: false });
    await pool.query('DELETE FROM users WHERE id=$1', [owner.id]);
  });
  // Registered last: closing the app also ends the shared pool.
  t.after(() => app.close());
  const until = async (check: () => Promise<boolean>, limit = 60000) => {
    const started = Date.now();
    while (!(await check())) {
      assert.ok(Date.now() - started < limit, 'timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  await until(
    async () =>
      (
        await pool.query(
          "SELECT 1 FROM mail_accounts WHERE id=$1 AND status='ready'",
          [account],
        )
      ).rowCount === 1,
  );
  const open = async (subject: string) => {
    await pool.query('DELETE FROM mail_request_limits');
    const id = (
      await pool.query(
        'SELECT id FROM mail_messages WHERE account_id=$1 AND subject=$2',
        [account, subject],
      )
    ).rows[0].id;
    const started = Date.now();
    const requested = await call(
      'POST',
      `/api/mail/messages/${id}/content`,
      {},
    );
    assert.ok(requested.statusCode < 300, requested.body);
    await until(
      async () =>
        (
          await pool.query(
            "SELECT 1 FROM mail_content WHERE message_id=$1 AND state='ready'",
            [id],
          )
        ).rowCount === 1,
    );
    return Date.now() - started;
  };
  // Only a new request (or retry) notifies the worker; worker-side writes do not.
  const listener = new Client({ connectionString });
  await listener.connect();
  t.after(() => listener.end());
  const heard: string[] = [];
  listener.on('notification', (message) => heard.push(message.channel));
  await listener.query('LISTEN spindle_mail_work');
  const quiet: number[] = [];
  for (let i = 0; i < 5; i++) quiet.push(await open(`Quiet ${i}`));
  assert.ok(heard.length >= 5, 'each request notified the worker');
  // Worker-side writes to existing rows (claims, cache access) stay silent.
  heard.length = 0;
  await pool.query(
    "UPDATE mail_content SET next_attempt_at=now(),accessed_at=now() WHERE account_id=$1 AND state='ready'",
    [account],
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(heard, []);
  // A large backfill keeps metadata sync busy for many batches.
  for (let i = 0; i < 4000; i++)
    server.control.addMessage('Receipts', {
      raw: rawMail(`Bulk ${i}`, `bulk-${i}@example.test`),
      internaldate: new Date(),
      flags: [],
    });
  await call('POST', `/api/mail/accounts/${account}/sync`, {});
  await until(
    async () =>
      (
        await pool.query(
          'SELECT 1 FROM mail_accounts WHERE id=$1 AND lease_until>now()',
          [account],
        )
      ).rowCount === 1,
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const busy = await open('Quiet 5');
  const median = [...quiet].sort((a, b) => a - b)[2] ?? Infinity;
  // Generous bounds for loaded CI; measured locally ~0.4 s and ~1.2–1.8 s.
  assert.ok(median < 2500, `quiet median ${median}ms (${quiet})`);
  assert.ok(busy < 5000, `during sync ${busy}ms`);
});
