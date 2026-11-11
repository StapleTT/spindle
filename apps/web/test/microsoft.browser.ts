import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { fetchMessageContent } from '../../server/src/mail/content-worker.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { syncGraphAccount } from '../../server/src/mail/graph.js';
import { applyGraphActions } from '../../server/src/mail/graph-mail.js';
import { connectImap } from '../../server/src/mail/imap.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { fakeMicrosoft } from '../../server/test/microsoft-fixture.js';

test('Microsoft connects through consent, reads and archives Graph mail, then reconnects', {
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
      v1: Buffer.alloc(32, 92).toString('base64'),
    }),
  });
  const microsoft = await fakeMicrosoft(config.appUrl);
  t.after(() => microsoft.app.close());
  const app = testApp(
    pool,
    config,
    undefined,
    keys,
    null,
    null,
    microsoft.config,
  );
  const owner = await createTestUser(
    app,
    pool,
    config,
    'microsoft-browser@example.test',
    '203.0.113.242',
  );
  microsoft.consent.identity = {
    sub: 'microsoft-browser-sub',
    email: 'reader@outlook.test',
    name: 'Microsoft Browser Reader',
  };
  microsoft.messages.set('browser-graph', {
    folder: 'inbox',
    subject: 'Microsoft browser message',
    received: Date.now(),
    read: false,
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
        const at = item.indexOf('=');
        return {
          name: item.slice(0, at),
          value: item.slice(at + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const until = async (check: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 40 && !(await check()); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 250));
      assert.ok(await check());
    };
    let accountId = '';
    await page.goto(`${config.appUrl}/inbox#view=settings`);

    await t.test(
      'configured Microsoft card completes consent without SMTP setup',
      async () => {
        const connect = page.getByRole('button', {
          name: 'Connect Microsoft account',
        });
        await connect.waitFor();
        assert.equal(await connect.isDisabled(), false);
        await connect.click();
        await page.getByLabel('Mail history').selectOption('all');
        await page
          .getByRole('button', { name: 'Continue with Microsoft' })
          .click();
        await page
          .getByText(
            'Microsoft connected. Folders and mail sync in the background',
          )
          .waitFor();
        assert.doesNotMatch(page.url(), /microsoft=|code=|state=/);
        const row = page.locator('.account-row', {
          hasText: 'reader@outlook.test',
        });
        await row
          .getByText('Outlook / Microsoft 365', { exact: true })
          .waitFor();
        assert.equal(
          await row.getByRole('button', { name: /Outgoing SMTP/ }).count(),
          0,
        );
        accountId = (
          await pool.query(
            "SELECT id FROM mail_accounts WHERE user_id=$1 AND provider='microsoft'",
            [owner.id],
          )
        ).rows[0].id;
        for (const width of [1280, 375]) {
          await page.setViewportSize({ width, height: 800 });
          assert.equal(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
            true,
          );
          await page.screenshot({
            path: `/tmp/spindle-microsoft-settings-${width}.png`,
            animations: 'disabled',
          });
        }
        await page.setViewportSize({ width: 1280, height: 800 });
      },
    );

    await t.test(
      'Graph mail opens through the shared reader and archives durably',
      async () => {
        assert.ok(
          await syncGraphAccount(
            pool,
            keys,
            microsoft.config,
            owner.id,
            accountId,
          ),
        );
        await page.goto(`${config.appUrl}/inbox`);
        await page
          .getByRole('link', { name: 'Microsoft browser message', exact: true })
          .click();
        const body = async () =>
          (
            await pool.query(
              "SELECT message_id,version FROM mail_content WHERE account_id=$1 AND state='pending'",
              [accountId],
            )
          ).rows[0];
        await until(async () => Boolean(await body()));
        const job = await body();
        await fetchMessageContent(
          pool,
          keys,
          {
            userId: owner.id,
            accountId,
            messageId: job.message_id,
            version: job.version,
          },
          connectImap,
          null,
          microsoft.config,
        );
        const reader = page.locator('.reader');
        await reader
          .getByText('Synthetic Microsoft body for browser-graph')
          .waitFor();
        assert.equal(
          await reader
            .getByRole('button', { name: 'Reply', exact: true })
            .isDisabled(),
          false,
        );
        await reader
          .getByRole('button', { name: 'Archive', exact: true })
          .click();
        await until(async () =>
          Boolean(
            (
              await pool.query(
                "SELECT 1 FROM mail_actions WHERE account_id=$1 AND kind='archive' AND state='pending'",
                [accountId],
              )
            ).rowCount,
          ),
        );
        // Bypass only the test's undo deadlines, including any preceding auto-read intent.
        await pool.query(
          "UPDATE mail_actions SET next_attempt_at=clock_timestamp() WHERE account_id=$1 AND state='pending'",
          [accountId],
        );
        await applyGraphActions(
          pool,
          keys,
          microsoft.config,
          owner.id,
          accountId,
        );
        assert.equal(
          microsoft.messages.get('browser-graph')?.folder,
          'archive',
        );
        assert.equal(
          (
            await pool.query(
              "SELECT state FROM mail_actions WHERE account_id=$1 AND kind='archive'",
              [accountId],
            )
          ).rows[0].state,
          'applied',
        );
      },
    );

    await t.test(
      'revoked Microsoft access reconnects through the Microsoft provider',
      async () => {
        microsoft.refreshTokens.clear();
        await syncGraphAccount(
          pool,
          keys,
          microsoft.config,
          owner.id,
          accountId,
        );
        await page.goto(`${config.appUrl}/inbox#view=settings`);
        await page
          .getByText(
            'Microsoft access expired or was removed. Reconnect to resume sync.',
          )
          .waitFor();
        const authorization = page.waitForRequest((request) =>
          request.url().startsWith(microsoft.config.authUrl),
        );
        const callback = page.waitForResponse((response) =>
          response.url().includes('/api/mail/oauth/microsoft/callback'),
        );
        await page
          .locator('.account-row', { hasText: 'reader@outlook.test' })
          .getByRole('button', { name: 'Reconnect', exact: true })
          .click();
        const request = await authorization;
        assert.equal(
          new URL(request.url()).searchParams.get('login_hint'),
          'reader@outlook.test',
        );
        await callback;
        await page
          .getByText(
            'Microsoft connected. Folders and mail sync in the background',
          )
          .waitFor();
        assert.equal(
          (
            await pool.query(
              'SELECT count(*)::int AS count FROM mail_accounts WHERE user_id=$1',
              [owner.id],
            )
          ).rows[0].count,
          1,
        );
        assert.equal(
          (
            await pool.query(
              'SELECT status,error_code FROM mail_accounts WHERE id=$1',
              [accountId],
            )
          ).rows[0].error_code,
          null,
        );
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
