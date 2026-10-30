import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { syncAccount } from '../../server/src/mail/sync.js';
import { startMailWorker } from '../../server/src/mail/worker.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import {
  imapFixture,
  imapPassword,
  rawMail,
} from '../../server/test/imap-fixture.js';

test('IDLE-triggered inbox arrival appears automatically and cached mail survives worker shutdown', {
  timeout: 60000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const socket = createNetServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${port}` };
  const pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 66).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'idle-browser@example.test',
    '203.0.113.222',
  );
  const fixture = await imapFixture(t, true, true, ['IDLE']);
  let idleStarts = 0;
  fixture.server.on('session', (event: { type: string; command?: string }) => {
    if (event.type === 'waiting' && event.command === 'IDLE') idleStarts++;
  });
  fixture.server.control.addMessage('INBOX', {
    raw: rawMail('Before notifications', 'idle-browser-before@example.test'),
    flags: [],
    internaldate: new Date(),
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { origin: config.appUrl, cookie: owner.cookie },
    payload: {
      name: 'IDLE inbox',
      host: 'localhost',
      port: fixture.port,
      transport: 'tls',
      username: 'testuser',
      password: imapPassword,
      history: 'all',
    },
  });
  assert.equal(response.statusCode, 202, response.body);
  const account = response.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  await pool.query(
    "UPDATE mail_accounts SET next_sync_at=clock_timestamp()+interval '10 minutes' WHERE user_id=$1 AND id=$2",
    [owner.id, account],
  );
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: { '/api': apiUrl },
    },
  });
  const boss = new PgBoss({ connectionString });
  const errors: unknown[] = [];
  boss.on('error', (error) => errors.push(error));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined,
    stop: (() => void) | undefined,
    workerStopped = false;
  try {
    await boss.start();
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(
      owner.cookie.split('; ').map((value) => {
        const index = value.indexOf('=');
        return {
          name: value.slice(0, index),
          value: value.slice(index + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(18000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${config.appUrl}/inbox`);
    await page
      .getByRole('link', { name: 'Before notifications', exact: true })
      .waitFor();
    stop = await startMailWorker(boss, pool, keys);
    const end = Date.now() + 15000;
    while (!idleStarts && Date.now() < end)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(idleStarts > 0, 'Worker entered real IMAP IDLE');
    await page
      .getByText(
        'Live updates are reconnecting. Automatic refresh continues.',
        { exact: true },
      )
      .waitFor({ state: 'hidden' });
    const search = page.getByRole('searchbox', {
      name: 'Search mail',
      exact: true,
    });
    await search.fill('unfinished search');
    const started = Date.now();
    fixture.server.control.addMessage('INBOX', {
      raw: rawMail('Arrived through IDLE', 'idle-browser-arrived@example.test'),
      flags: [],
      internaldate: new Date(),
    });
    await page
      .getByRole('link', { name: 'Arrived through IDLE', exact: true })
      .waitFor();
    assert.ok(
      Date.now() - started < 6000,
      'IDLE plus SSE updates the UI before the former ten-second poll',
    );
    assert.equal(await search.inputValue(), 'unfinished search');
    assert.equal(
      await search.evaluate((node) => node === document.activeElement),
      true,
    );
    assert.equal(await page.locator('[data-message-row]').count(), 2);
    const flags = (
      await pool.query(
        "SELECT mm.flags FROM mail_memberships mm JOIN mail_messages m ON m.user_id=mm.user_id AND m.id=mm.message_id WHERE m.user_id=$1 AND m.subject='Arrived through IDLE'",
        [owner.id],
      )
    ).rows[0].flags;
    assert.ok(!flags.includes('\\Seen'));
    stop();
    await boss.stop({ graceful: true, timeout: 10000 });
    workerStopped = true;
    await page.reload();
    await page
      .getByRole('link', { name: 'Arrived through IDLE', exact: true })
      .waitFor();
    assert.equal(fixture.server.control.sessions().length, 0);
    assert.deepEqual(errors, []);
  } finally {
    stop?.();
    if (!workerStopped) await boss.stop({ graceful: true, timeout: 10000 });
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
