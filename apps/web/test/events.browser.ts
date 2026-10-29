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

test('SSE updates private tabs, preserves edits and focus, and recovers API restart and revoked sessions', {
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
  const db = new Pool({ connectionString, max: 8 });
  await migrateDatabase(db);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 68).toString('base64'),
    }),
  });
  let app = testApp(
    new Pool({ connectionString, max: 8 }),
    config,
    undefined,
    keys,
  );
  const owner = await createTestUser(
      app,
      db,
      config,
      'events-browser@example.test',
      '203.0.113.224',
    ),
    other = await createTestUser(
      app,
      db,
      config,
      'events-other@example.test',
      '203.0.113.224',
    );
  async function account(user = owner) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/mail/accounts',
      headers: { cookie: user.cookie, origin: config.appUrl },
      payload: {
        name: 'Live account',
        host: 'mail.example.test',
        port: 993,
        transport: 'tls',
        username: user.email,
        password: 'synthetic-only-password',
        history: 'all',
      },
    });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().account.id;
    const inbox = (
      await db.query(
        "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
        [user.id, id],
      )
    ).rows[0].id;
    return { id, inbox, user };
  }
  const primary = await account(),
    foreign = await account(other);
  let uid = 0;
  async function mail(subject: string, scope = primary) {
    const id = randomUUID();
    await db.query(
      'INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,message_id,reference_ids,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,$7,$8,$9)',
      [
        id,
        scope.user.id,
        scope.id,
        subject,
        JSON.stringify([{ name: 'Alice', address: 'alice@example.test' }]),
        JSON.stringify({ to: [], cc: [] }),
        `<${id}@example.test>`,
        [],
        new Date(Date.now() + uid * 1000),
      ],
    );
    await db.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',$5)",
      [scope.user.id, scope.id, scope.inbox, id, ++uid],
    );
    await db.query(
      "INSERT INTO mail_content(user_id,account_id,message_id,state,plain_text,sanitizer_version) VALUES($1,$2,$3,'ready',$4,$5)",
      [scope.user.id, scope.id, id, 'Safe cached body', SANITIZER_VERSION],
    );
    return id;
  }
  const original = await mail('Live original');
  await mail('Foreign original', foreign);
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
  type DebugWindow = Window & {
    mailSource?: EventSource;
    lastMailEvent?: string;
    mailResets?: number;
  };
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const errors: string[] = [];
    async function pageFor(user = owner) {
      const context = await browser?.newContext();
      assert.ok(context);
      await context.addCookies(
        user.cookie.split('; ').map((value) => {
          const index = value.indexOf('=');
          return {
            name: value.slice(0, index),
            value: value.slice(index + 1),
            url: config.appUrl,
          };
        }),
      );
      await context.addInitScript(() => {
        const Native = window.EventSource;
        window.EventSource = class extends Native {
          constructor(url: string | URL, init?: EventSourceInit) {
            super(url, init);
            const debug = window as DebugWindow;
            debug.mailSource = this;
            this.addEventListener('reset', (event) => {
              debug.lastMailEvent = (event as MessageEvent).lastEventId;
              debug.mailResets = (debug.mailResets ?? 0) + 1;
            });
            this.addEventListener('change', (event) => {
              if (event.isTrusted)
                debug.lastMailEvent = (event as MessageEvent).lastEventId;
            });
          }
        };
      });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(config.appUrl);
      await page.waitForFunction(() => (window as DebugWindow).mailResets);
      return page;
    }
    const page = await pageFor(),
      second = await pageFor(),
      stranger = await pageFor(other);
    const search = page.getByRole('searchbox', {
      name: 'Search mail',
      exact: true,
    });
    async function waitFor(check: () => boolean | Promise<boolean>, ms = 7000) {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('SSE browser state did not arrive');
    }
    await t.test(
      'committed mail appears in both private tabs promptly without replacing typed search or focus',
      async () => {
        await page.bringToFront();
        await search.fill('unfinished search');
        const started = Date.now();
        await mail('Pushed live');
        await page
          .getByRole('link', { name: 'Pushed live', exact: true })
          .waitFor();
        await second
          .getByRole('link', { name: 'Pushed live', exact: true })
          .waitFor();
        assert.ok(Date.now() - started < 6000);
        assert.equal(await search.inputValue(), 'unfinished search');
        assert.equal(
          await search.evaluate((node) => node === document.activeElement),
          true,
        );
        await mail('Never disclose this', foreign);
        await stranger
          .getByRole('link', { name: 'Never disclose this', exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole('link', { name: 'Never disclose this', exact: true })
            .count(),
          0,
        );
        const accountCount = await page.locator('[data-message-row]').count();
        const tx = await db.connect();
        try {
          await tx.query('BEGIN');
          await tx.query('UPDATE mail_messages SET subject=$2 WHERE id=$1', [
            original,
            'Uncommitted title',
          ]);
          await new Promise((resolve) => setTimeout(resolve, 350));
          assert.equal(
            await page
              .getByRole('link', { name: 'Uncommitted title', exact: true })
              .count(),
            0,
          );
          await tx.query('ROLLBACK');
        } finally {
          tx.release();
        }
        assert.equal(
          await page.locator('[data-message-row]').count(),
          accountCount,
        );
      },
    );
    await t.test(
      'duplicate/out-of-order or malformed frames cannot cause extra data refreshes',
      async () => {
        await waitFor(() =>
          page.evaluate(
            () => (window as DebugWindow).lastMailEvent?.includes(':') ?? false,
          ),
        );
        let requests = 0;
        const count = (request: { url: () => string }) => {
          if (request.url().includes('/api/mail/messages?')) requests++;
        };
        page.on('request', count);
        await page.evaluate(() => {
          const debug = window as DebugWindow;
          for (const data of [{ topics: ['mail'] }, { topics: ['unknown'] }])
            debug.mailSource?.dispatchEvent(
              new MessageEvent('change', {
                lastEventId: debug.lastMailEvent ?? '',
                data: JSON.stringify(data),
              }),
            );
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(requests, 0);
        page.off('request', count);
      },
    );
    await t.test(
      'cross-tab saved searches and message read state refresh through their own views',
      async () => {
        await db.query(
          'INSERT INTO mail_saved_searches(id,user_id,name,query) VALUES($1,$2,$3,$4)',
          [randomUUID(), owner.id, 'Live saved view', 'subject:live'],
        );
        await page
          .getByRole('button', { name: 'Live saved view', exact: true })
          .waitFor();
        await second
          .getByRole('button', { name: 'Live saved view', exact: true })
          .waitFor();
        await search.fill('');
        await page
          .locator(`[data-message-row="${original}"] .message-open`)
          .click();
        await page
          .locator('#reader-title')
          .filter({ hasText: 'Live original' })
          .waitFor();
        await db.query(
          'UPDATE mail_memberships SET flags=$3 WHERE user_id=$1 AND message_id=$2',
          [owner.id, original, ['\\Seen']],
        );
        await page
          .getByRole('button', { name: 'Mark as unread', exact: true })
          .waitFor();
        await second
          .locator(`[data-message-row="${original}"]`)
          .getByRole('button', { name: /as unread$/ })
          .waitFor();
        await page.locator('#reader-title').focus();
        await page.keyboard.press('u');
        await page
          .locator(`[data-message-row="${original}"] .message-open`)
          .waitFor();
      },
    );
    await t.test(
      'a remote draft update cannot replace unsaved local editor text or its recovery copy',
      async () => {
        await page
          .getByRole('button', { name: 'Compose', exact: true })
          .click();
        const body = page.getByRole('textbox', {
          name: 'Message body',
          exact: true,
        });
        await body.waitFor();
        await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
        const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
          'draft',
        );
        assert.ok(id);
        await page.route('**/api/mail/drafts/**', async (route) =>
          route.request().method() === 'PUT' ? route.abort() : route.continue(),
        );
        await body.fill('Unsaved local note');
        await page
          .getByText('Draft not saved. Retrying automatically.', {
            exact: true,
          })
          .waitFor();
        await db.query(
          "UPDATE mail_drafts SET content=jsonb_set(jsonb_set(content,'{html}',to_jsonb($3::text)),'{text}',to_jsonb($4::text)) WHERE user_id=$1 AND id=$2",
          [owner.id, id, '<p>Remote draft note</p>', 'Remote draft note'],
        );
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.match((await body.textContent()) ?? '', /Unsaved local note/);
        assert.equal(
          await page.evaluate(
            (user) =>
              Object.keys(sessionStorage).some(
                (key) =>
                  key.includes(user) &&
                  sessionStorage.getItem(key)?.includes('Unsaved local note'),
              ),
            owner.id,
          ),
          true,
        );
        await page
          .getByRole('button', { name: 'Unified inbox', exact: true })
          .click();
        await page
          .getByRole('link', { name: 'Live original', exact: true })
          .waitFor();
      },
    );
    await t.test(
      'API restart and missed notifications recover current mail with the same cookie and no manual reload',
      async () => {
        const resets = await page.evaluate(
          () => (window as DebugWindow).mailResets ?? 0,
        );
        await app.close();
        await page
          .getByText(
            'Live updates are reconnecting. Automatic refresh continues.',
            { exact: true },
          )
          .waitFor();
        assert.equal(
          await page
            .getByRole('link', { name: 'Pushed live', exact: true })
            .count(),
          1,
        );
        await mail('Committed while offline');
        app = testApp(
          new Pool({ connectionString, max: 8 }),
          config,
          undefined,
          keys,
        );
        await app.listen({
          host: '127.0.0.1',
          port: Number(new URL(apiUrl).port),
        });
        await waitFor(
          () =>
            page.evaluate(
              (before) => ((window as DebugWindow).mailResets ?? 0) > before,
              resets,
            ),
          12000,
        );
        await page
          .getByRole('link', { name: 'Committed while offline', exact: true })
          .waitFor();
        await second
          .getByRole('link', { name: 'Committed while offline', exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole('heading', { name: 'You’re signed in', exact: true })
            .count(),
          1,
        );
      },
    );
    await t.test(
      'server revocation removes mail from all affected tabs while another owner remains signed in',
      async () => {
        await db.query('DELETE FROM auth_sessions WHERE user_id=$1', [
          owner.id,
        ]);
        await page
          .getByRole('heading', { name: 'Sign in', exact: true })
          .waitFor();
        await second
          .getByRole('heading', { name: 'Sign in', exact: true })
          .waitFor();
        assert.equal(await page.locator('[data-message-row]').count(), 0);
        assert.equal(
          await stranger
            .getByRole('link', { name: 'Foreign original', exact: true })
            .count(),
          1,
        );
      },
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
    await db.end();
  }
});
