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
import { wakeSnoozedConversations } from '../../server/src/mail/conversation-state.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { SANITIZER_VERSION } from '../../server/src/mail/sanitize.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('conversation controls persist, update private tabs, preserve focus and recover snoozes', {
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
  const pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  const app = testApp(
    pool,
    config,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 76).toString('base64'),
      }),
    }),
  );
  const owner = await createTestUser(
    app,
    pool,
    config,
    'state-browser@example.test',
    '203.0.113.226',
  );
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie, origin: config.appUrl },
    payload: {
      name: 'Local settings account',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: 'owner@example.test',
      password: 'synthetic-only-password',
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  const inbox = (
    await pool.query(
      "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
      [owner.id, account],
    )
  ).rows[0].id;
  let uid = 0;
  async function mail(subject: string, parent: string | null = null) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,message_id,in_reply_to,reference_ids,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,'[]','{\"to\":[],\"cc\":[]}',$5,$6,'{}',$7)",
      [
        id,
        owner.id,
        account,
        subject,
        `<${id}@browser.test>`,
        parent,
        new Date(Date.UTC(2026, 9, 29, 12, 0, ++uid)),
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',$5)",
      [owner.id, account, inbox, id, uid],
    );
    await pool.query(
      "INSERT INTO mail_content(user_id,account_id,message_id,state,plain_text,sanitizer_version) VALUES($1,$2,$3,'ready','Cached plain body',$4)",
      [owner.id, account, id, SANITIZER_VERSION],
    );
    return id;
  }
  const root = await mail('Older conversation'),
    latest = await mail('Newer conversation');
  const api = await app.listen({ host: '127.0.0.1', port: 0 }),
    vite = await createServer({
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
    const context = await browser.newContext({ timezoneId: 'America/Chicago' });
    await context.addCookies(
      owner.cookie.split('; ').map((value) => {
        const n = value.indexOf('=');
        return {
          name: value.slice(0, n),
          value: value.slice(n + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage(),
      second = await context.newPage(),
      errors: string[] = [];
    for (const tab of [page, second]) {
      tab.setDefaultTimeout(12000);
      tab.on('pageerror', (e) => errors.push(e.message));
      await tab.goto(`${config.appUrl}/inbox`);
      await tab.locator(`[data-message-row="${root}"]`).waitFor();
    }
    const open = async () => {
      await page.locator(`[data-message-row="${root}"] .message-open`).click();
      await page
        .getByRole('button', { name: 'Pin conversation', exact: true })
        .waitFor();
    };
    const waitFor = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 9000;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('Conversation update did not arrive');
    };
    const stored = async () =>
      (
        await pool.query(
          'SELECT local_pinned,local_muted,local_snoozed_until FROM mail_messages WHERE id=$1',
          [root],
        )
      ).rows[0];
    await t.test(
      'pin reorders another tab while preserving typed search and focus; mute leaves unread mail visible',
      async () => {
        assert.equal(
          await second
            .locator('[data-message-row]')
            .first()
            .getAttribute('data-message-row'),
          latest,
        );
        await open();
        const search = second.getByRole('searchbox', {
          name: 'Search mail',
          exact: true,
        });
        await second.bringToFront();
        await search.fill('unfinished query');
        await page
          .getByRole('button', { name: 'Pin conversation', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Unpin conversation', exact: true })
          .waitFor();
        await waitFor(
          async () =>
            (await second
              .locator('[data-message-row]')
              .first()
              .getAttribute('data-message-row')) === root,
        );
        assert.equal(await search.inputValue(), 'unfinished query');
        assert.equal(
          await search.evaluate((el) => el === document.activeElement),
          true,
        );
        await page
          .getByRole('button', { name: 'Mute conversation', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Unmute conversation', exact: true })
          .waitFor();
        await second
          .locator(`[data-message-row="${root}"]`)
          .getByText(/Muted/)
          .waitFor();
        assert.equal(
          await second
            .locator(`[data-message-row="${root}"]`)
            .getByRole('button', { name: /as read$/ })
            .count(),
          1,
        );
        await page.reload();
        await page
          .getByRole('button', { name: 'Unpin conversation', exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: 'Unmute conversation', exact: true })
          .waitFor();
      },
    );
    await t.test(
      'snooze removes inbox rows across tabs, offers a discoverable view and rejects nonexistent local times',
      async () => {
        await page
          .getByRole('button', { name: 'Snooze conversation', exact: true })
          .click();
        await page.getByRole('button', { name: 'Snooze', exact: true }).click();
        await waitFor(
          async () =>
            (await second.locator(`[data-message-row="${root}"]`).count()) ===
            0,
        );
        await page
          .getByRole('button', { name: 'Snoozed', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Snoozed', exact: true })
          .waitFor();
        await page
          .locator(`[data-message-row="${root}"] .message-open`)
          .click();
        await page
          .getByRole('button', { name: 'Reschedule snooze', exact: true })
          .click();
        const impossible = await page.evaluate(() => {
          let year = new Date().getFullYear();
          const now = new Date();
          if (now >= new Date(year, 2, 1)) year++;
          const firstSunday = 1 + ((7 - new Date(year, 2, 1).getDay()) % 7);
          return `${year}-03-${String(firstSunday + 7).padStart(2, '0')}T02:30`;
        });
        await page.getByLabel('Snooze until', { exact: true }).fill(impossible);
        await page
          .getByRole('button', { name: 'Save snooze time', exact: true })
          .click();
        await page
          .getByRole('alert')
          .filter({ hasText: 'Some local times do not exist' })
          .waitFor();
        await page
          .getByRole('button', { name: 'Cancel snooze', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Unsnooze conversation', exact: true })
          .click();
        await second.locator(`[data-message-row="${root}"]`).waitFor();
        assert.equal((await stored()).local_snoozed_until, null);
      },
    );
    await t.test(
      'durable wakeup reaches the inbox through SSE and preserves pin/mute through reload',
      async () => {
        await page.getByRole('button', { name: 'Pinned', exact: true }).click();
        await page
          .locator(`[data-message-row="${root}"] .message-open`)
          .click();
        await page
          .getByRole('button', { name: 'Snooze conversation', exact: true })
          .click();
        await page.getByRole('button', { name: 'Snooze', exact: true }).click();
        await waitFor(
          async () =>
            (await second.locator(`[data-message-row="${root}"]`).count()) ===
            0,
        );
        await pool.query(
          "UPDATE mail_messages SET local_snoozed_until=clock_timestamp()-interval '1 second' WHERE id=$1",
          [root],
        );
        await wakeSnoozedConversations(pool);
        await second.locator(`[data-message-row="${root}"]`).waitFor();
        await page
          .getByRole('button', { name: 'All inboxes', exact: true })
          .click();
        await page
          .locator(`[data-message-row="${root}"] .message-open`)
          .click();
        await page
          .getByRole('button', { name: 'Unpin conversation', exact: true })
          .click();
        await waitFor(
          async () =>
            (await second
              .locator('[data-message-row]')
              .first()
              .getAttribute('data-message-row')) === latest,
        );
        await page.reload();
        await page
          .getByRole('button', { name: 'Pin conversation', exact: true })
          .waitFor();
        await page
          .getByRole('button', { name: 'Unmute conversation', exact: true })
          .waitFor();
        assert.deepEqual(errors, []);
      },
    );
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
