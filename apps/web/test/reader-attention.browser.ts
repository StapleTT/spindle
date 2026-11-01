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
import { SANITIZER_VERSION } from '../../server/src/mail/sanitize.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('foreground reader dwell and quiet read feedback preserve explicit choices, failures and move toasts', {
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
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${address.port}` };
  const pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const app = testApp(
    pool,
    config,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 91).toString('base64'),
      }),
    }),
  );
  const owner = await createTestUser(
    app,
    pool,
    config,
    'attention-browser@example.test',
    '203.0.113.237',
  );
  const connection = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie, origin: config.appUrl },
    payload: {
      name: 'Attention mail',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: owner.email,
      password: 'synthetic-password',
      history: 'all',
    },
  });
  assert.equal(connection.statusCode, 202, connection.body);
  const account = connection.json().account.id;
  const inbox = (
    await pool.query(
      "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
      [owner.id, account],
    )
  ).rows[0].id;
  await pool.query(
    "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'Archive','Archive','\\Archive')",
    [owner.id, account],
  );
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  for (const [index, id] of ids.entries()) {
    await pool.query(
      `INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at,message_id,reference_ids)
      VALUES($1::uuid,$2,$3,$1::text,$4,'[]','{"to":[],"cc":[]}',clock_timestamp(),$5,'{}')`,
      [
        id,
        owner.id,
        account,
        `Attention ${index}`,
        `<attention-${index}@example.test>`,
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',$5)",
      [owner.id, account, inbox, id, index + 1],
    );
    await pool.query(
      "INSERT INTO mail_content(user_id,account_id,message_id,state,plain_text,sanitizer_version) VALUES($1,$2,$3,'ready',$4,$5)",
      [owner.id, account, id, `Readable attention ${index}`, SANITIZER_VERSION],
    );
  }
  const apiUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: address.port,
      strictPort: true,
      proxy: { '/api': apiUrl },
    },
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(
      owner.cookie.split('; ').map((cookie) => {
        const n = cookie.indexOf('=');
        return {
          name: cookie.slice(0, n),
          value: cookie.slice(n + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const now = Date.now();
    await page.clock.install({ time: new Date(now) });
    const freeze = async () =>
      page.clock.pauseAt(
        new Date((await page.evaluate(() => Date.now())) + 20),
      );
    const count = async (id?: string) =>
      Number(
        (
          await pool.query(
            'SELECT count(*) FROM mail_actions WHERE user_id=$1 AND ($2::uuid IS NULL OR message_id=$2)',
            [owner.id, id ?? null],
          )
        ).rows[0].count,
      );
    const open = async (index: number, query = '') => {
      await page.clock.resume();
      await page.goto(
        `${config.appUrl}/inbox#${query ? `q=${encodeURIComponent(query)}&` : ''}message=${ids[index]}`,
      );
      await page
        .getByText(`Readable attention ${index}`, { exact: true })
        .waitFor();
      await page.bringToFront();
      await freeze();
    };
    const waitCount = async (n: number, id?: string) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if ((await count(id)) === n) return;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      assert.equal(await count(id), n);
    };
    await t.test(
      'brief visits and background tabs do not mark read; a continuous foreground second queues one quiet action',
      async () => {
        await open(0);
        await page.clock.runFor(500);
        assert.equal(await count(), 0);
        await page
          .getByRole('link', { name: 'Back to message list', exact: true })
          .click({ force: true });
        await page.clock.runFor(2000);
        assert.equal(await count(), 0);
        await open(1);
        await page.clock.runFor(500);
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.clock.runFor(3000);
        assert.equal(await count(), 0);
        await page.evaluate(() => {
          Reflect.deleteProperty(document, 'visibilityState');
          document.dispatchEvent(new Event('visibilitychange'));
        });
        await page.clock.runFor(900);
        assert.equal(await count(), 0);
        await page.clock.runFor(200);
        await waitCount(1);
        await page
          .getByRole('button', { name: /^All recent actions/ })
          .waitFor();
        assert.equal(
          await page
            .getByRole('list', { name: 'Recent actions' })
            .getByRole('listitem')
            .count(),
          0,
        );
        assert.equal(
          await page
            .locator('.reader-status')
            .getByText(/Marking as read|Marked as read/)
            .count(),
          0,
        );
        await page.clock.runFor(5000);
        assert.equal(await count(), 1);
      },
    );
    await t.test(
      'history retains undo and a manual unread choice is never automatically reversed',
      async () => {
        await page
          .getByRole('button', { name: /^All recent actions/ })
          .click({ force: true });
        await page.getByRole('button', { name: /^Undo: Marked/ }).waitFor();
        await pool.query(
          "UPDATE mail_actions SET state='applied',completed_at=clock_timestamp() WHERE user_id=$1",
          [owner.id],
        );
        await page.clock.runFor(2500);
        await page
          .getByRole('button', { name: 'Mark as unread', exact: true })
          .waitFor({ state: 'visible' });
        await page.waitForFunction(
          () =>
            !(
              document.querySelector(
                '[data-mail-command="toggle"]',
              ) as HTMLButtonElement
            )?.disabled,
        );
        await page
          .getByRole('button', { name: 'Show fewer actions', exact: true })
          .click({ force: true });
        await page
          .getByRole('button', { name: 'Mark as unread', exact: true })
          .click({ force: true });
        await waitCount(2);
        await page.clock.runFor(5000);
        assert.equal(await count(), 2);
        assert.equal(
          await page
            .getByRole('list', { name: 'Recent actions' })
            .getByRole('listitem')
            .count(),
          0,
        );
        await page
          .getByRole('button', { name: 'Mark as read', exact: true })
          .waitFor();
      },
    );
    await t.test(
      'read failures remain visible and folder moves still produce pending toasts',
      async () => {
        await pool.query(
          "UPDATE mail_actions SET state='failed',error_code='provider_unavailable',completed_at=clock_timestamp() WHERE user_id=$1 AND kind='unread'",
          [owner.id],
        );
        const status = await app.inject({
          url: '/api/mail/actions',
          headers: { cookie: owner.cookie },
        });
        assert.equal(status.statusCode, 200, status.body);
        assert.ok(
          status
            .json()
            .actions.some(
              (action: { kind: string; state: string }) =>
                action.kind === 'unread' && action.state === 'failed',
            ),
          status.body,
        );
        await open(1);
        await page.clock.runFor(500);
        const failed = page
          .getByRole('list', { name: 'Recent actions' })
          .getByText('Failed:', { exact: true });
        for (let n = 0; n < 30 && !(await failed.isVisible()); n++) {
          await page.clock.runFor(100);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(await failed.isVisible(), true);
        await open(0);
        await page
          .locator('.reader')
          .getByRole('button', { name: 'Archive', exact: true })
          .click({ force: true });
        await waitCount(1, ids[0]);
        const moved = page
          .getByRole('list', { name: 'Recent actions' })
          .getByRole('listitem')
          .filter({ hasText: 'Attention 0' });
        await moved.getByText('Pending:', { exact: true }).waitFor();
        await moved.getByRole('button', { name: /^Undo: Archived/ }).waitFor();
      },
    );
    await t.test(
      'loading content never starts the timer, and read status remains quiet after reload',
      async () => {
        await pool.query(
          "UPDATE mail_content SET state='pending' WHERE user_id=$1 AND message_id=$2",
          [owner.id, ids[2]],
        );
        await page.clock.resume();
        await page.goto(`${config.appUrl}/inbox#message=${ids[2]}`);
        await page
          .getByText('Fetching message content…', { exact: true })
          .waitFor();
        await freeze();
        await page.clock.runFor(10000);
        assert.equal(await count(ids[2]), 0);
        await pool.query(
          "UPDATE mail_content SET state='ready' WHERE user_id=$1 AND message_id=$2",
          [owner.id, ids[2]],
        );
        await page.clock.runFor(1500);
        await page.locator('.plain-message').waitFor();
        await page.bringToFront();
        await page.clock.runFor(900);
        assert.equal(await count(ids[2]), 0);
        await page.clock.runFor(200);
        await waitCount(1, ids[2]);
        await page.clock.resume();
        await page.reload();
        await page.locator('.plain-message').waitFor();
        await freeze();
        await page.clock.runFor(5000);
        assert.equal(await count(ids[2]), 1);
        assert.equal(
          await page
            .getByRole('list', { name: 'Recent actions' })
            .getByRole('listitem')
            .filter({ hasText: 'Attention 2' })
            .count(),
          0,
        );
      },
    );
    await t.test(
      'auto-reading an unread search returns to results without marking its next result',
      async () => {
        await open(3, 'is:unread');
        const before = await count();
        await page.clock.runFor(1100);
        await waitCount(1, ids[3]);
        await page.locator('.reader').waitFor({ state: 'detached' });
        await page.clock.runFor(5000);
        assert.equal(await count(), before + 1);
      },
    );
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
