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
import { startMailWorker } from '../../server/src/mail/worker.js';
import { testApp, testConfig } from '../../server/test/auth-fixture.js';
import {
  imapFixture,
  imapPassword,
  rawMail,
} from '../../server/test/imap-fixture.js';

test('browser connects IMAP, receives background mail, pages and disconnects', {
  timeout: 90000,
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
  const config = {
    ...testConfig,
    appUrl: `http://127.0.0.1:${port}`,
    registrationMode: 'public',
  };
  const pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 43).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys);
  const password = 'synthetic browser password 123!';
  const signup = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: config.appUrl },
    payload: {
      email: 'mail-browser@example.test',
      name: 'Mail browser',
      password,
    },
  });
  assert.equal(signup.statusCode, 200, signup.body);
  await pool.query(
    "UPDATE users SET email_verified=true WHERE email='mail-browser@example.test'",
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
  const { server, port: imapPort } = await imapFixture(t);
  for (let i = 0; i < 51; i++)
    server.control.addMessage('INBOX', {
      raw: rawMail(
        i === 0 ? '<img src=x onerror=alert(1)>' : `Browser mail ${i}`,
      ),
      internaldate: new Date(Date.now() + i * 1000),
      flags: [],
    });
  server.control.addMessage('Archive', {
    raw: rawMail('Browser archived mail'),
    internaldate: new Date(),
    flags: [],
  });
  const boss = new PgBoss({ connectionString });
  boss.on('error', () => {});
  let stop: (() => void) | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await boss.start();
    stop = await startMailWorker(boss, pool, keys);
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(config.appUrl);
    await page.getByLabel('Email address').fill('mail-browser@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page
      .getByRole('heading', { name: 'All inboxes', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('button', { name: 'Connect IMAP account', exact: true })
      .click();
    await page.getByLabel('Account name', { exact: true }).fill('Browser IMAP');
    await page.getByLabel('IMAP server', { exact: true }).fill('localhost');
    await page.getByLabel('Port', { exact: true }).fill(String(imapPort));
    await page.getByLabel('IMAP username', { exact: true }).fill('testuser');
    await page
      .getByLabel('IMAP password or app password', { exact: true })
      .fill(imapPassword);
    await page
      .getByRole('button', { name: 'Save and sync', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page.getByText('Browser mail 50', { exact: true }).waitFor();
    assert.equal(await page.locator('.message-list > li').count(), 50);
    await page
      .getByRole('button', { name: 'Older messages', exact: true })
      .click();
    await page
      .getByText('<img src=x onerror=alert(1)>', { exact: true })
      .waitFor();
    assert.equal(await page.locator('.message-list img').count(), 0);
    await page
      .getByRole('button', { name: 'Newest messages', exact: true })
      .click();
    await page.getByText('Browser mail 50', { exact: true }).waitFor();
    await page.getByRole('button', { name: /^Archive \(/ }).click();
    await page.getByText('Browser archived mail', { exact: true }).waitFor();
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page.getByText('Browser mail 50', { exact: true }).waitFor();
    // Account folder lists collapse in the drawer and stay collapsed.
    const archiveFolder = page.getByRole('button', { name: /^Archive \(/ });
    await page
      .getByRole('button', { name: 'Hide folders for Browser IMAP' })
      .click();
    await archiveFolder.waitFor({ state: 'hidden' });
    await page.reload();
    await page
      .getByRole('button', { name: 'Show folders for Browser IMAP' })
      .click();
    await archiveFolder.waitFor();
    server.control.addMessage('INBOX', {
      raw: rawMail('Delivered while browser is open'),
      internaldate: new Date(Date.now() + 60000),
      flags: [],
    });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page
      .getByText('Delivered while browser is open', { exact: true })
      .waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page
      .getByRole('button', { name: 'Open navigation', exact: true })
      .click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page
      .getByLabel('Confirm your Spindle password', { exact: true })
      .fill(password);
    await page
      .getByRole('button', { name: 'Confirm disconnect', exact: true })
      .click();
    await page
      .getByText('Connect an IMAP account to see your mail here.', {
        exact: true,
      })
      .waitFor();
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM mail_accounts WHERE user_id=(SELECT id FROM users WHERE email='mail-browser@example.test')",
        )
      ).rows[0].n,
      0,
    );
    assert.equal(server.control.getMailbox('INBOX').messages, 52);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    stop?.();
    await boss.stop({ graceful: true, timeout: 10000 });
    await vite.close();
    await app.close();
  }
});
