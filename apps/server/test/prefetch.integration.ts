// D042: bodies are cached before they are opened. The worker prefetches after
// each sync through the on-demand pipeline; prefetched content must equal what
// opening the message fetches, stay inside the cache budget without churn, and
// step aside for a reader's own request.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { fetchMessageContent } from '../src/mail/content-worker.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { prefetchAccount } from '../src/mail/prefetch.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, rawMail } from './imap-fixture.js';
import { attachmentMail, readerMail } from './reader-fixture.js';

test('bodies are prefetched after sync and match on-demand content', {
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
      v1: Buffer.alloc(32, 56).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'prefetch@example.test',
  );
  const { server, port } = await imapFixture(t);
  const recent = (minutes: number) => new Date(Date.now() - minutes * 60000);
  const add = (folder: string, raw: string, internaldate: Date) =>
    server.control.addMessage(folder, { raw, internaldate, flags: [] });
  add(
    'INBOX',
    readerMail(
      'Formatted',
      '<p>Private HTML body</p><img src="cid:inline@example.test">',
    ),
    recent(10),
  );
  add('INBOX', attachmentMail(), recent(9));
  for (let i = 0; i < 4; i++)
    add('INBOX', rawMail(`Plain ${i}`, `plain-${i}@example.test`), recent(i));
  // Over the 2 MiB body limit: fetching it fails for prefetch and reader alike.
  add(
    'INBOX',
    rawMail('Oversized', 'oversized@example.test').replace(
      'Synthetic mail fixture.',
      'x'.repeat(2200 * 1024),
    ),
    recent(20),
  );
  add('Trash', rawMail('Trashed', 'trashed@example.test'), recent(5));
  const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { cookie: owner.cookie, origin: testConfig.appUrl },
      ...(payload ? { payload } : {}),
    });
  // Only a reader's request wakes the worker; prefetch writes must not.
  const listener = new Client({ connectionString });
  await listener.connect();
  const heard: string[] = [];
  listener.on('notification', (message) => {
    if (message.channel === 'spindle_mail_work') heard.push(message.channel);
  });
  await listener.query('LISTEN spindle_mail_work');
  const connected = await call('POST', '/api/mail/accounts', {
    name: 'Prefetch',
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
  let stop: (() => void) | undefined = await startMailWorker(
    boss,
    pool,
    keys,
    null,
    { prefetch: true },
  );
  const stopWorker = async () => {
    stop?.();
    stop = undefined;
    await boss.stop({ graceful: false });
  };
  t.after(async () => {
    await listener.end();
    if (stop) await stopWorker();
    await pool.query('DELETE FROM users WHERE id=$1', [owner.id]);
  });
  // Registered last: closing the app also ends the shared pool.
  t.after(() => app.close());
  const until = async (check: () => Promise<boolean>, limit = 90000) => {
    const started = Date.now();
    while (!(await check())) {
      assert.ok(Date.now() - started < limit, 'timed out');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };
  const one = async (sql: string, values: unknown[] = []) =>
    (await pool.query(sql, values)).rows[0];
  const idOf = async (subject: string) =>
    (
      await one(
        'SELECT id FROM mail_messages WHERE account_id=$1 AND subject=$2',
        [account, subject],
      )
    ).id as string;
  const stateOf = async (id: string) =>
    (await one('SELECT state FROM mail_content WHERE message_id=$1', [id]))
      ?.state as string | undefined;
  const detail = async (id: string) => {
    await pool.query('DELETE FROM mail_request_limits');
    const response = await call('GET', `/api/mail/messages/${id}`);
    assert.equal(response.statusCode, 200, response.body);
    return response.json().content;
  };

  // Every inbox body is cached without being opened.
  await until(
    async () =>
      Number(
        (
          await one(
            "SELECT count(*) FROM mail_content WHERE account_id=$1 AND state IN ('ready','failed')",
            [account],
          )
        ).count,
      ) === 7,
  );
  assert.deepEqual(heard, [], 'prefetch does not wake the worker');
  const formatted = await idOf('Formatted');
  const attached = await idOf('Attachment mail');
  const plain = await idOf('Plain 0');
  const oversized = await idOf('Oversized');
  const trashed = await idOf('Trashed');
  // Ranked by received time and kept until evicted, not for seven days.
  assert.equal(
    Number(
      (
        await one(
          `SELECT count(*) FROM mail_content c JOIN mail_messages m ON m.id=c.message_id
          WHERE c.account_id=$1 AND c.state='ready' AND c.expires_at='infinity' AND c.accessed_at=m.received_at`,
          [account],
        )
      ).count,
    ),
    6,
  );
  assert.equal(await stateOf(trashed), undefined, 'Trash is not prefetched');
  // The reader shows prefetched content at once, complete.
  const shown = await detail(formatted);
  assert.equal(shown.state, 'ready');
  assert.match(shown.plainText, /Private plain body/);
  assert.equal(shown.hasHtml, true);
  assert.equal(
    Number(
      (
        await one(
          'SELECT count(*) FROM mail_content_images WHERE message_id=$1',
          [formatted],
        )
      ).count,
    ),
    1,
  );
  const files = (await detail(attached)).attachments;
  assert.equal(files.length, 2);
  assert.equal(files[0].contentType, 'application/pdf');
  const opened = await call('POST', `/api/mail/messages/${plain}/content`, {});
  assert.equal(opened.statusCode, 200, opened.body);
  assert.equal(opened.json().state, 'ready');
  assert.deepEqual(heard, []);

  // A body prefetch could not fetch is "missing" to the reader, which then
  // requests it for real and gets the real outcome.
  const failed = await one(
    "SELECT state,error_code,expires_at<clock_timestamp()+interval '25 hours' AS retried FROM mail_content WHERE message_id=$1",
    [oversized],
  );
  assert.deepEqual(failed, {
    state: 'failed',
    error_code: 'prefetch_unavailable',
    retried: true,
  });
  assert.equal((await detail(oversized)).state, 'missing');
  const retried = await call(
    'POST',
    `/api/mail/messages/${oversized}/content`,
    {},
  );
  assert.equal(retried.statusCode, 202, retried.body);
  await until(async () => (await stateOf(oversized)) === 'failed');
  const outcome = await detail(oversized);
  assert.equal(outcome.state, 'failed');
  assert.match(outcome.message, /could not be fetched/);
  assert.ok(heard.length >= 1, 'a reader request wakes the worker');

  // The speculative route (neighbours, hovered rows) fetches anything the
  // owner could open, on its own rate-limit bucket.
  await pool.query('DELETE FROM mail_request_limits');
  const hovered = await call('POST', `/api/mail/messages/${trashed}/prefetch`);
  assert.equal(hovered.statusCode, 202, hovered.body);
  assert.deepEqual(
    (
      await pool.query(
        "SELECT action FROM mail_request_limits WHERE user_id=$1 AND action IN ('prefetch','reader')",
        [owner.id],
      )
    ).rows,
    [{ action: 'prefetch' }],
  );
  await until(async () => (await stateOf(trashed)) === 'ready');
  const foreign = await call(
    'POST',
    '/api/mail/messages/00000000-0000-4000-8000-000000000000/prefetch',
  );
  assert.equal(foreign.statusCode, 404);

  // New mail is cached after the sync that discovers it.
  add('INBOX', rawMail('Arrived', 'arrived@example.test'), new Date());
  await call('POST', `/api/mail/accounts/${account}/sync`, {});
  await until(async () =>
    Boolean(
      await one(
        "SELECT 1 FROM mail_content c JOIN mail_messages m ON m.id=c.message_id WHERE m.account_id=$1 AND m.subject='Arrived' AND c.state='ready'",
        [account],
      ),
    ),
  );

  // A backlog larger than the cache: a reader's request is served while the
  // backlog downloads, and the cache settles on the newest mail.
  const base = Date.UTC(2020, 0, 1);
  for (let i = 0; i < 1200; i++)
    add(
      'Receipts',
      rawMail(`Bulk ${i}`, `bulk-${i}@example.test`),
      new Date(base + i * 60000),
    );
  await pool.query('DELETE FROM mail_request_limits');
  await call('POST', `/api/mail/accounts/${account}/sync`, {});
  const cached = async () =>
    Number(
      (
        await one('SELECT count(*) FROM mail_content WHERE account_id=$1', [
          account,
        ])
      ).count,
    );
  await until(async () => (await cached()) > 60);
  // Oldest in the backlog, so prefetch is busy with newer mail.
  const old = await idOf('Bulk 1');
  assert.equal(await stateOf(old), undefined);
  const started = Date.now();
  const requested = await call('POST', `/api/mail/messages/${old}/content`, {});
  assert.equal(requested.statusCode, 202, requested.body);
  await until(async () => (await stateOf(old)) === 'ready');
  const waited = Date.now() - started;
  assert.ok(waited < 5000, `during prefetch ${waited}ms`);
  await until(async () => (await cached()) === 1000, 180000);
  const members = async () =>
    (
      await pool.query(
        'SELECT message_id FROM mail_content WHERE account_id=$1 ORDER BY message_id',
        [account],
      )
    ).rows.map((row) => row.message_id as string);
  // Further passes change nothing: no eviction and refetch cycle.
  const settled = await members();
  await pool.query('DELETE FROM mail_request_limits');
  await call('POST', `/api/mail/accounts/${account}/sync`, {});
  await new Promise((resolve) => setTimeout(resolve, 4000));
  await until(async () =>
    Boolean(
      await one(
        "SELECT 1 FROM mail_accounts WHERE id=$1 AND status='ready' AND (lease_until IS NULL OR lease_until<clock_timestamp())",
        [account],
      ),
    ),
  );
  assert.deepEqual(await members(), settled);
  assert.equal(await stateOf(await idOf('Bulk 1199')), 'ready');
  assert.equal(await stateOf(await idOf('Bulk 0')), undefined);
  assert.equal(await stateOf(old), 'ready', 'opened mail outranks unread');
  assert.equal(await stateOf(formatted), 'ready');

  // Without the worker: prefetched rows equal what opening fetches.
  await stopWorker();
  const snapshot = async (id: string) => ({
    row: await one(
      'SELECT state,plain_text,html,resources,attachments,reply_metadata,byte_size,sanitizer_version FROM mail_content WHERE message_id=$1',
      [id],
    ),
    images: (
      await pool.query(
        'SELECT position,content_type,data FROM mail_content_images WHERE message_id=$1 ORDER BY position',
        [id],
      )
    ).rows,
  });
  // Body-cache changes reach readers on their own topic, never as 'mail'
  // changes that would make every open list refetch.
  const topics: string[] = [];
  listener.on('notification', (message) => {
    if (message.channel === 'spindle_mail_changed')
      topics.push(JSON.parse(message.payload ?? '[]')[1]);
  });
  await listener.query('LISTEN spindle_mail_changed');
  for (const id of [formatted, attached, plain]) {
    const prefetched = await snapshot(id);
    assert.equal(prefetched.row.state, 'ready');
    await pool.query('DELETE FROM mail_content WHERE message_id=$1', [id]);
    await pool.query('DELETE FROM mail_request_limits');
    const again = await call('POST', `/api/mail/messages/${id}/content`, {});
    assert.equal(again.statusCode, 202, again.body);
    const version = (
      await one('SELECT version FROM mail_content WHERE message_id=$1', [id])
    ).version;
    await fetchMessageContent(pool, keys, {
      userId: owner.id,
      accountId: account,
      messageId: id,
      version,
    });
    assert.deepEqual(await snapshot(id), prefetched);
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(topics.length >= 6);
  assert.deepEqual([...new Set(topics)], ['content']);
  // A waiting reader request is user work: a prefetch pass does not start
  // (and take the account lease) ahead of it.
  await pool.query('DELETE FROM mail_content WHERE message_id=$1', [plain]);
  await pool.query('DELETE FROM mail_request_limits');
  await call('POST', `/api/mail/messages/${plain}/prefetch`);
  assert.equal(await stateOf(plain), 'pending');
  await prefetchAccount(pool, keys, null, owner.id, account);
  assert.equal(await stateOf(plain), 'pending');
  assert.ok(
    await one(
      'SELECT 1 FROM mail_accounts WHERE id=$1 AND lease_token IS NULL',
      [account],
    ),
  );
});
