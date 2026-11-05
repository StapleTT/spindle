import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { syncGmailAccount } from '../../server/src/mail/gmail.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { fakeGoogle } from '../../server/test/google-fixture.js';

test('Gmail connects through Google consent and shows honest read-only mail', {
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
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${address.port}` };
  const pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 66).toString('base64'),
    }),
  });
  const google = await fakeGoogle(config.appUrl);
  t.after(() => google.app.close());
  const app = testApp(pool, config, undefined, keys, null, google.config);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'gmail-browser@example.test',
    '203.0.113.241',
  );
  google.consent.identity = { sub: 'browser-sub', email: 'reader@gmail.test' };
  google.messages.set('b1', {
    labels: new Set(['INBOX', 'UNREAD']),
    internalDate: Date.now(),
    headers: {
      From: 'Synthetic Sender <sender@example.test>',
      To: 'reader@gmail.test',
      Subject: 'Gmail browser message',
      'Message-ID': '<b1@example.test>',
    },
  });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: address.port,
      strictPort: true,
      proxy: { '/api': api },
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(
      owner.cookie.split('; ').map((item) => {
        const n = item.indexOf('=');
        return {
          name: item.slice(0, n),
          value: item.slice(n + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${config.appUrl}/inbox#view=settings`);

    await t.test('Connect Gmail round-trips through consent', async () => {
      await page.getByRole('button', { name: 'Connect Gmail account' }).click();
      await page.getByLabel('Mail history').selectOption('all');
      await page.getByRole('button', { name: 'Continue with Google' }).click();
      await page
        .getByText('Gmail connected. Labels and mail sync in the background')
        .waitFor();
      assert.doesNotMatch(page.url(), /gmail=|code=|state=/);
      const row = page.locator('.account-row', {
        hasText: 'reader@gmail.test',
      });
      await row.getByText('Gmail', { exact: true }).waitFor();
      assert.equal(
        await row.getByRole('button', { name: /Outgoing SMTP/ }).count(),
        0,
      );
      // Real provider marks, decorative and self-hosted.
      const logos = page.locator('img.provider-logo');
      assert.equal(await logos.count(), 2);
      for (const logo of await logos.all()) {
        assert.equal(await logo.getAttribute('alt'), '');
        assert.ok(
          await logo.evaluate(
            (image) => (image as HTMLImageElement).naturalWidth > 0,
          ),
        );
      }
      await page.screenshot({ path: '/tmp/spindle-gmail-settings.png' });
    });

    await t.test('accounts can be renamed from Settings', async () => {
      const rename = page.getByRole('button', {
        name: 'Rename reader@gmail.test',
      });
      await rename.click();
      const input = page.getByRole('textbox', {
        name: 'Display name for reader@gmail.test',
      });
      // Escape cancels without saving.
      await input.fill('Discarded');
      await input.press('Escape');
      await rename.waitFor();
      assert.equal(
        await rename.evaluate((el) => el === document.activeElement),
        true,
      );
      await rename.click();
      await input.fill('Personal Gmail');
      await input.press('Enter');
      const renamed = page.getByRole('button', {
        name: 'Rename Personal Gmail',
      });
      await renamed.waitFor();
      assert.equal(
        await renamed.evaluate((el) => el === document.activeElement),
        true,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT name FROM mail_accounts WHERE user_id=$1 AND provider='gmail'",
            [owner.id],
          )
        ).rows[0].name,
        'Personal Gmail',
      );
      await page.screenshot({ path: '/tmp/spindle-gmail-renamed.png' });
    });

    await t.test('Gmail mail lists, but opening it is honest', async () => {
      const account = (
        await pool.query(
          "SELECT id FROM mail_accounts WHERE user_id=$1 AND provider='gmail'",
          [owner.id],
        )
      ).rows[0].id;
      await syncGmailAccount(pool, keys, google.config, owner.id, account);
      await page.goto(`${config.appUrl}/inbox`);
      await page
        .getByRole('link', { name: 'Gmail browser message', exact: true })
        .click();
      await page
        .getByText('Opening Gmail messages arrives in the next update.')
        .waitFor();
      const reader = page.locator('.reader');
      const archive = reader.getByRole('button', {
        name: 'Archive',
        exact: true,
      });
      assert.equal(await archive.isDisabled(), true);
      assert.equal(
        await archive.getAttribute('title'),
        'Not available for Gmail accounts yet',
      );
      assert.equal(
        await page
          .getByRole('button', { name: 'Reply', exact: true })
          .isDisabled(),
        true,
      );
      await page.screenshot({ path: '/tmp/spindle-gmail-reader.png' });
      // Revoked consent surfaces Reconnect guidance in Settings.
      google.refreshTokens.clear();
      await pool.query(
        'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE id=$1',
        [account],
      );
      await syncGmailAccount(pool, keys, google.config, owner.id, account);
      await page.goto(`${config.appUrl}/inbox#view=settings`);
      await page
        .getByText(
          'Google access expired or was removed. Reconnect to resume sync.',
        )
        .waitFor();
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
