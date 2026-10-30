import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { chromium, type Route } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { SANITIZER_VERSION } from '../../server/src/mail/sanitize.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('local search, saved/split views, keyboard context, page focus and replay-safe batches', {
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
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${port}` };
  const pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 62).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'search-browser@example.test',
  );
  async function account(name: string, hasArchive: boolean) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mail/accounts',
      headers: { origin: config.appUrl, cookie: owner.cookie },
      payload: {
        name,
        host: 'mail.example.test',
        port: 993,
        transport: 'tls',
        username: name,
        password: 'synthetic-only-password',
        history: 'all',
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().account.id;
    const inbox = (
      await pool.query(
        "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
        [owner.id, id],
      )
    ).rows[0].id;
    if (hasArchive)
      await pool.query(
        "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'Archive','Archive',$3),($1,$2,'Trash','Trash',$4)",
        [owner.id, id, '\\Archive', '\\Trash'],
      );
    return { id, inbox };
  }
  const primary = await account('Primary', true),
    second = await account('No archive', false);
  let uid = 0;
  async function mail(subject: string, account = primary) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,jsonb_build_object('to',jsonb_build_array(),'cc',jsonb_build_array()),$6)",
      [
        id,
        owner.id,
        account.id,
        subject,
        JSON.stringify([{ name: 'Alice', address: 'alice@example.test' }]),
        new Date(Date.UTC(2026, 9, 28, 12, 0, uid)),
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',$5)",
      [owner.id, account.id, account.inbox, id, ++uid],
    );
    await pool.query(
      "INSERT INTO mail_content(user_id,account_id,message_id,state,plain_text,sanitizer_version) VALUES($1,$2,$3,'ready',$4,$5)",
      [owner.id, account.id, id, `Cached body ${subject}`, SANITIZER_VERSION],
    );
    return id;
  }
  const alpha = await mail('Project alpha'),
    beta = await mail('Project beta'),
    gamma = await mail('Project gamma', second);
  for (let i = 0; i < 51; i++) await mail(`Page ${i}`);
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
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(
      owner.cookie.split('; ').map((value) => {
        const split = value.indexOf('=');
        return {
          name: value.slice(0, split),
          value: value.slice(split + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const rows = page.locator('[data-message-row]');
    const row = (id: string) => page.locator(`[data-message-row="${id}"]`);
    const search = page.getByRole('searchbox', {
      name: 'Search mail',
      exact: true,
    });
    async function find(q: string) {
      const response = page.waitForResponse(
        (r) =>
          r.url().includes('/api/mail/messages?') &&
          new URL(r.url()).searchParams.get('q') === q,
      );
      await search.fill(q);
      await search.press('Enter');
      await response;
      await page
        .getByText('Loading mail…', { exact: true })
        .waitFor({ state: 'hidden' });
    }
    async function actionCount() {
      return Number(
        (
          await pool.query(
            'SELECT count(*) FROM mail_actions WHERE user_id=$1',
            [owner.id],
          )
        ).rows[0].count,
      );
    }
    async function waitFor(check: () => Promise<boolean>) {
      const until = Date.now() + 12000;
      while (Date.now() < until) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('Expected search/triage state was not reached');
    }
    await page.goto(config.appUrl);
    await rows.first().waitFor();
    await t.test(
      'search persists in URL, saved views restore filters, and typing/IME/modifiers cannot mutate mail',
      async () => {
        await find('subject:Project');
        assert.equal(await rows.count(), 3);
        await page
          .getByText(
            'Body search coverage: 54 of 54 messages in this scope. Sync history limits still apply.',
            { exact: true },
          )
          .waitFor();
        const before = await actionCount();
        await search.press('e');
        assert.equal(await actionCount(), before);
        await search.fill('subject:Project');
        await page
          .getByRole('button', { name: 'Search options', exact: true })
          .click();
        await page
          .getByLabel('Saved search name', { exact: true })
          .fill('Projects');
        await page
          .getByRole('button', { name: 'Save current search', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Projects', exact: true })
          .waitFor();
        await page.reload();
        await row(alpha).waitFor();
        assert.equal(await search.inputValue(), 'subject:Project');
        await row(beta).locator('.message-open').focus();
        await page.evaluate(() =>
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'e',
              isComposing: true,
              bubbles: true,
            }),
          ),
        );
        await page.keyboard.press('Alt+e');
        assert.equal(await actionCount(), before);
        await page.keyboard.press('?');
        await page.getByRole('dialog').waitFor();
        await page.getByLabel('Find a command').fill('archive');
        await page.keyboard.press('Escape');
        assert.equal(
          await row(beta)
            .locator('.message-open')
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page
          .getByRole('button', { name: 'Clear search', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Projects', exact: true })
          .click();
        await row(alpha).waitFor();
        assert.equal(await rows.count(), 3);
      },
    );
    await t.test(
      'j/k/o/u navigate filtered rows and reader, with restored focus',
      async () => {
        await row(gamma).locator('.message-open').focus();
        await page.keyboard.press('j');
        assert.equal(
          await row(beta)
            .locator('.message-open')
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.keyboard.press('o');
        await page
          .locator('#reader-title')
          .filter({ hasText: 'Project beta' })
          .waitFor();
        await waitFor(async () =>
          page
            .locator('#reader-title')
            .evaluate((node) => node === document.activeElement),
        );
        await page.keyboard.press('j');
        await page
          .locator('#reader-title')
          .filter({ hasText: 'Project alpha' })
          .waitFor();
        await page.keyboard.press('u');
        await row(alpha).waitFor();
        await waitFor(async () =>
          row(alpha)
            .locator('.message-open')
            .evaluate((node) => node === document.activeElement),
        );
      },
    );
    await t.test(
      'side-by-side list and reader commands target the focused row rather than a different open message',
      async () => {
        await row(alpha).locator('.message-open').click();
        await page
          .locator('#reader-title')
          .filter({ hasText: 'Project alpha' })
          .waitFor();
        await row(gamma).locator('.message-open').focus();
        await page.keyboard.press('j');
        assert.equal(
          await row(beta)
            .locator('.message-open')
            .evaluate((node) => node === document.activeElement),
          true,
        );
        const before = await actionCount();
        await page.keyboard.press('r');
        assert.equal(await page.locator('.composer').count(), 0);
        await page.keyboard.press('e');
        await waitFor(async () => (await actionCount()) === before + 1);
        const latest = (
          await pool.query(
            'SELECT message_id,kind FROM mail_actions WHERE user_id=$1 ORDER BY seq DESC LIMIT 1',
            [owner.id],
          )
        ).rows[0];
        assert.equal(latest.message_id, beta);
        assert.equal(latest.kind, 'archive');
        await page.keyboard.press('z');
        await waitFor(
          async () =>
            (
              await pool.query(
                'SELECT state FROM mail_actions WHERE user_id=$1 ORDER BY seq DESC LIMIT 1',
                [owner.id],
              )
            ).rows[0].state === 'cancelled',
        );
        await page.reload();
        await row(beta).waitFor();
        await page.locator('.reader [data-mail-command="back"]').click();
      },
    );
    await t.test(
      'explicit batch selection reports mixed-account failures and retries unconfirmed requests with the same IDs',
      async () => {
        await row(alpha).locator('.message-open').focus();
        await page.keyboard.press('x');
        assert.equal(await row(alpha).getByRole('checkbox').isChecked(), true);
        await row(gamma).getByRole('checkbox').check();
        let captured = '';
        const loseResponse = async (route: Route) => {
          captured = route.request().postData() ?? '';
          const response = await route.fetch();
          assert.equal(response.status(), 202);
          await route.abort();
        };
        await page.route('**/api/mail/batch-actions', loseResponse);
        await page
          .getByRole('button', { name: 'Archive selected', exact: true })
          .click();
        await page
          .getByRole('button', {
            name: 'Retry same batch request',
            exact: true,
          })
          .waitFor();
        await waitFor(async () =>
          page
            .getByRole('button', {
              name: 'Retry same batch request',
              exact: true,
            })
            .isEnabled(),
        );
        const before = await actionCount();
        await page.reload();
        await page
          .getByRole('button', {
            name: 'Retry same batch request',
            exact: true,
          })
          .waitFor();
        await page.unroute('**/api/mail/batch-actions', loseResponse);
        let replay = '';
        await page.route('**/api/mail/batch-actions', async (route) => {
          replay = route.request().postData() ?? '';
          await route.continue();
        });
        await page
          .getByRole('button', {
            name: 'Retry same batch request',
            exact: true,
          })
          .click();
        await page
          .getByText(/1 queued or already recorded; 1 refused/)
          .waitFor();
        assert.deepEqual(JSON.parse(replay), JSON.parse(captured));
        assert.equal(await actionCount(), before);
        await page.unroute('**/api/mail/batch-actions');
        await page
          .getByText(
            'This account has no provider-designated Archive folder.',
            {
              exact: false,
            },
          )
          .waitFor();
        await page
          .getByRole('button', {
            name: 'Undo: Archived “Project alpha”.',
            exact: true,
          })
          .click();
        await waitFor(
          async () =>
            (
              await pool.query(
                'SELECT state FROM mail_actions WHERE user_id=$1 AND message_id=$2 ORDER BY seq DESC LIMIT 1',
                [owner.id, alpha],
              )
            ).rows[0].state === 'cancelled',
        );
      },
    );
    await t.test(
      'read and Trash shortcuts respect filtered results and keep undo available',
      async () => {
        await find('subject:alpha -is:read');
        await row(alpha).locator('.message-open').focus();
        await page.keyboard.press('o');
        await page
          .locator('#reader-title')
          .filter({ hasText: 'Project alpha' })
          .waitFor();
        await waitFor(async () =>
          page
            .locator('#reader-title')
            .evaluate((node) => node === document.activeElement),
        );
        await page.keyboard.press('m');
        await page.locator('.reader').waitFor({ state: 'hidden' });
        await waitFor(async () => (await rows.count()) === 0);
        await page.keyboard.press('z');
        await row(alpha).waitFor();
        await row(alpha).locator('.message-open').focus();
        await page.keyboard.press('#');
        await waitFor(
          async () =>
            (
              await pool.query(
                'SELECT kind FROM mail_actions WHERE user_id=$1 ORDER BY seq DESC LIMIT 1',
                [owner.id],
              )
            ).rows[0].kind === 'trash',
        );
        await page.keyboard.press('z');
        await row(alpha).waitFor();
        await row(alpha).locator('.message-open').focus();
        await page.keyboard.press('ControlOrMeta+k');
        await page.getByRole('dialog').waitFor();
        await page.getByLabel('Find a command').fill('Search mail');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
        assert.equal(
          await search.evaluate((node) => node === document.activeElement),
          true,
        );
      },
    );
    await t.test(
      'page shortcuts restore row focus, selection clears across searches, and narrow layout fits',
      async () => {
        await find('Page');
        assert.equal(await rows.count(), 50);
        await rows.first().locator('.message-open').focus();
        await page.keyboard.press('x');
        await page.keyboard.press('n');
        await page.getByRole('link', { name: 'Page 0', exact: true }).waitFor();
        assert.equal(await rows.count(), 1);
        await waitFor(async () =>
          rows
            .first()
            .locator('.message-open')
            .evaluate((node) => node === document.activeElement),
        );
        assert.equal(
          await rows.first().getByRole('checkbox').isChecked(),
          false,
        );
        await page.keyboard.press('p');
        await page
          .getByRole('link', { name: 'Page 50', exact: true })
          .waitFor();
        await waitFor(async () =>
          rows
            .first()
            .locator('.message-open')
            .evaluate((node) => node === document.activeElement),
        );
        await page.keyboard.press('/');
        assert.equal(
          await search.evaluate((node) => node === document.activeElement),
          true,
        );
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
        await page
          .getByRole('button', { name: 'Open navigation', exact: true })
          .click();
        await page
          .getByRole('button', {
            name: 'Remove saved search Projects',
            exact: true,
          })
          .click();
        await page
          .getByRole('button', { name: 'Projects', exact: true })
          .waitFor({ state: 'hidden' });
        await page.setViewportSize({ width: 1280, height: 720 });
      },
    );
    await t.test(
      'a delayed old search cannot replace a newer query',
      async () => {
        let release = () => {},
          started = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pending = new Promise<void>((resolve) => {
          started = resolve;
        });
        await page.route('**/api/mail/messages?**', async (route) => {
          if (
            new URL(route.request().url()).searchParams.get('q') !==
            'subject:Project'
          )
            return route.continue();
          const response = await route.fetch();
          started();
          await gate;
          await route.fulfill({ response }).catch(() => {});
        });
        await search.fill('subject:Project');
        await search.press('Enter');
        await pending;
        await find('Page');
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        assert.equal(await rows.count(), 50);
        assert.equal(await search.inputValue(), 'Page');
      },
    );
    await t.test(
      'an action response cannot navigate away from a newer search',
      async () => {
        await page.getByRole('link', { name: 'Page 50', exact: true }).click();
        await page
          .locator('#reader-title')
          .filter({ hasText: 'Page 50' })
          .waitFor();
        await waitFor(async () =>
          page
            .locator('#reader-title')
            .evaluate((node) => node === document.activeElement),
        );
        let release = () => {},
          started = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const pending = new Promise<void>((resolve) => {
          started = resolve;
        });
        await page.route('**/api/mail/messages/*/actions', async (route) => {
          const response = await route.fetch();
          started();
          await gate;
          await route.fulfill({ response }).catch(() => {});
        });
        await page.keyboard.press('#');
        await pending;
        await find('subject:beta');
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await row(beta).waitFor();
        assert.equal(await page.locator('.reader').count(), 0);
        assert.equal(await search.inputValue(), 'subject:beta');
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
