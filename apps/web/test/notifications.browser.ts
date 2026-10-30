import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('opt-in open-app notifications handle privacy, tabs, permissions and page/session lifecycle', {
  timeout: 90000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const socket = createNetServer();
  t.after(() => {
    if (socket.listening) socket.close();
  });
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${port}` },
    pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  const app = testApp(
    pool,
    config,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 82).toString('base64'),
      }),
    }),
  );
  const owner = await createTestUser(
      app,
      pool,
      config,
      'notify-browser@example.test',
      '203.0.113.232',
    ),
    other = await createTestUser(
      app,
      pool,
      config,
      'notify-browser-other@example.test',
      '203.0.113.232',
    );
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie, origin: config.appUrl },
    payload: {
      name: 'Notification account',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: owner.email,
      password: 'synthetic-only-password',
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  const box = (
    await pool.query(
      "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
      [owner.id, account],
    )
  ).rows[0].id;
  let uid = 0;
  async function arrival(subject: string, notify = true) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at,notification_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,'{"to":[],"cc":[],"bcc":[]}'::jsonb,clock_timestamp(),CASE WHEN $6 THEN clock_timestamp() ELSE NULL END)`,
      [
        id,
        owner.id,
        account,
        subject,
        JSON.stringify([
          { name: 'Private Sender', address: 'private@example.test' },
        ]),
        notify,
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',$5)",
      [owner.id, account, box, id, ++uid],
    );
    return id;
  }
  await arrival('Historical mail', false);
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      proxy: { '/api': api },
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    async function login(cookie: string) {
      await context.clearCookies();
      await context.addCookies(
        cookie.split('; ').map((item) => {
          const n = item.indexOf('=');
          return {
            name: item.slice(0, n),
            value: item.slice(n + 1),
            url: config.appUrl,
          };
        }),
      );
    }
    await login(owner.cookie);
    // Use real browser storage/locks and API data, but never send desktop popups from tests.
    await context.addInitScript(`
      const state = { permission: 'default', next: 'granted', requests: 0, alerts: [] };
      window.notificationTest = state;
      class MockNotification {
        static get permission() { return state.permission; }
        static async requestPermission() { state.requests++; state.permission = state.next; return state.permission; }
        constructor(_title, options) { this.body = options.body; this.closed = false; state.alerts.push(this); }
        close() { this.closed = true; }
      }
      Object.defineProperty(window, 'Notification', { value: MockNotification });
    `);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.setDefaultTimeout(12000);
    const settings = (p = page) =>
      p.getByRole('region', { name: 'Notifications', exact: true });
    const state = (p = page) =>
      p.evaluate(
        () =>
          (
            window as unknown as {
              notificationTest: {
                requests: number;
                alerts: { body: string; closed: boolean }[];
              };
            }
          ).notificationTest,
      );
    async function refresh(p = page) {
      const response = p.waitForResponse(
        (r) =>
          r.url().includes('/api/mail/notifications') && r.status() === 200,
      );
      await p.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('spindle:mail-changed', { detail: ['mail'] }),
        ),
      );
      await response;
      await p.waitForTimeout(150);
    }
    async function opened(p = page) {
      await p.goto(config.appUrl);
      await settings(p)
        .getByText(/unread in inbox/)
        .waitFor();
      await settings(p).locator('summary').click();
    }
    await opened();
    await t.test(
      'permission is user-initiated, denial is explained and initial unread mail never alerts',
      async () => {
        assert.equal((await state()).requests, 0);
        assert.equal((await state()).alerts.length, 0);
        await page.evaluate(() =>
          Object.assign(
            (window as unknown as { notificationTest: object })
              .notificationTest,
            { next: 'denied' },
          ),
        );
        await settings()
          .getByRole('button', { name: 'Enable notifications' })
          .click();
        await settings()
          .getByRole('status')
          .filter({ hasText: 'Notifications are blocked' })
          .waitFor();
        assert.equal((await state()).requests, 1);
        await page.evaluate(() =>
          Object.assign(
            (window as unknown as { notificationTest: object })
              .notificationTest,
            { permission: 'default', next: 'granted' },
          ),
        );
        await settings()
          .getByRole('button', { name: 'Enable notifications' })
          .click();
        await settings()
          .getByRole('button', { name: 'Disable notifications' })
          .waitFor();
        await refresh();
        assert.equal((await state()).alerts.length, 0);
      },
    );
    const second = await context.newPage();
    second.setDefaultTimeout(12000);
    await opened(second);
    await second.evaluate(() =>
      Object.assign(
        (window as unknown as { notificationTest: object }).notificationTest,
        { permission: 'granted' },
      ),
    );
    await t.test(
      'shared receipts produce one private alert across tabs and read/mute changes close it',
      async () => {
        const id = await arrival('Confidential first arrival');
        await Promise.all([refresh(), refresh(second)]);
        const a = await state(),
          b = await state(second);
        assert.equal(a.alerts.length + b.alerts.length, 1);
        assert.equal(
          [...a.alerts, ...b.alerts][0]?.body,
          'New mail is available in your inbox.',
        );
        await pool.query(
          'UPDATE mail_memberships SET flags=$2 WHERE message_id=$1',
          [id, ['\\Seen']],
        );
        await Promise.all([refresh(), refresh(second)]);
        assert.ok(
          [...(await state()).alerts, ...(await state(second)).alerts].every(
            (n) => n.closed,
          ),
        );
        const quiet = await arrival('Muted before delivery');
        await pool.query(
          'UPDATE mail_messages SET local_muted=true WHERE id=$1',
          [quiet],
        );
        await Promise.all([refresh(), refresh(second)]);
        assert.equal(
          (await state()).alerts.length + (await state(second)).alerts.length,
          1,
        );
        await page.waitForFunction(() => document.title.startsWith('(2)'));
      },
    );
    await second.close();
    await t.test(
      'preview opt-in, authorized click navigation and disabling are effective',
      async () => {
        await settings()
          .getByLabel('Show sender and subject in notifications')
          .check();
        await refresh();
        const id = await arrival('Preview subject');
        await refresh();
        assert.equal(
          (await state()).alerts.at(-1)?.body,
          'Private Sender — Preview subject',
        );
        await page.evaluate(() => {
          const s = (
            window as unknown as {
              notificationTest: { alerts: { onclick?: () => void }[] };
            }
          ).notificationTest;
          s.alerts.at(-1)?.onclick?.();
        });
        await page.waitForURL(
          (url) => new URLSearchParams(url.hash.slice(1)).get('message') === id,
        );
        const beforeDisable = (await state()).alerts.length;
        await settings()
          .getByRole('button', { name: 'Disable notifications' })
          .click();
        await arrival('Disabled arrival');
        await refresh();
        assert.equal((await state()).alerts.length, beforeDisable);
        assert.ok((await state()).alerts.every((n) => n.closed));
      },
    );
    await t.test(
      'pagehide closes alerts and pageshow/reopening establish a new baseline',
      async () => {
        await settings()
          .getByRole('button', { name: 'Enable notifications' })
          .click();
        await refresh();
        await arrival('Before closing');
        await refresh();
        assert.equal((await state()).alerts.at(-1)?.closed, false);
        await page.evaluate(() =>
          window.dispatchEvent(new PageTransitionEvent('pagehide')),
        );
        assert.ok((await state()).alerts.every((n) => n.closed));
        const before = (await state()).alerts.length;
        await arrival('While closed');
        await page.evaluate(() =>
          window.dispatchEvent(
            new PageTransitionEvent('pageshow', { persisted: true }),
          ),
        );
        await refresh();
        assert.equal((await state()).alerts.length, before);
        await page.reload();
        await settings()
          .getByText(/unread in inbox/)
          .waitFor();
        await refresh();
        assert.equal((await state()).alerts.length, 0);
        assert.equal((await state()).requests, 0);
      },
    );
    await t.test(
      'permission revocation closes previews and another user never inherits opt-in or click access',
      async () => {
        await page.evaluate(() =>
          Object.assign(
            (window as unknown as { notificationTest: object })
              .notificationTest,
            { permission: 'granted' },
          ),
        );
        await arrival('Permission revoked');
        await refresh();
        await page.evaluate(() =>
          Object.assign(
            (window as unknown as { notificationTest: object })
              .notificationTest,
            { permission: 'denied' },
          ),
        );
        await refresh();
        assert.ok((await state()).alerts.every((n) => n.closed));
        await page.evaluate(() =>
          Object.assign(
            (window as unknown as { notificationTest: object })
              .notificationTest,
            { permission: 'granted' },
          ),
        );
        await arrival('Session changed');
        await refresh();
        const previousUrl = page.url();
        await login(other.cookie);
        await page.evaluate(() => {
          const s = (
            window as unknown as {
              notificationTest: { alerts: { onclick?: () => void }[] };
            }
          ).notificationTest;
          s.alerts.at(-1)?.onclick?.();
        });
        await page.waitForTimeout(300);
        assert.equal(page.url(), previousUrl);
        await refresh();
        await settings()
          .getByText('Notifications off', { exact: false })
          .waitFor();
        assert.ok((await state()).alerts.every((n) => n.closed));
        assert.deepEqual(errors, []);
      },
    );
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
