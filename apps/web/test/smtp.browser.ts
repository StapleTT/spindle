import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { simpleParser } from 'mailparser';
import { Pool } from 'pg';
import { chromium, type Route } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { processOutgoing } from '../../server/src/mail/outgoing-worker.js';
import { syncAccount } from '../../server/src/mail/sync.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { imapFixture, imapPassword } from '../../server/test/imap-fixture.js';
import { smtpFixture, smtpPassword } from '../../server/test/smtp-fixture.js';

test('SMTP setup, send/undo, failure retry and unknown outcomes survive navigation and reload', {
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
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${port}` },
    pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 53).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys),
    owner = await createTestUser(
      app,
      pool,
      config,
      'sending-browser@example.test',
      '203.0.113.215',
    );
  const imap = await imapFixture(t, true, true, [], true),
    smtp = await smtpFixture(t, imap.server);
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { origin: config.appUrl, cookie: owner.cookie },
    payload: {
      name: 'Browser send account',
      host: 'localhost',
      port: imap.port,
      transport: 'tls',
      username: 'testuser',
      password: imapPassword,
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
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
      owner.cookie.split('; ').map((item) => {
        const split = item.indexOf('=');
        return {
          name: item.slice(0, split),
          value: item.slice(split + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => void dialog.accept());
    const apply = async () => {
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
    };
    await page.goto(config.appUrl);
    await page
      .getByRole('heading', { name: 'All inboxes', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page
      .getByRole('button', { name: 'Outgoing SMTP for Browser send account' })
      .click();
    await page.getByLabel('SMTP server', { exact: true }).fill('localhost');
    assert.equal(
      await page
        .getByLabel('Sender display name', { exact: true })
        .inputValue(),
      'Reader Test',
    );
    const senderName = 'Zoë "Support", Inbox';
    await page
      .getByLabel('Sender display name', { exact: true })
      .fill(senderName);
    await page.getByLabel('SMTP port', { exact: true }).fill(String(smtp.port));
    await page.getByLabel('SMTP encryption').selectOption('tls');
    await page
      .getByLabel('SMTP login email / From address')
      .fill('writer@example.test');
    await page.getByLabel('SMTP password or app password').fill(smtpPassword);
    await page.getByLabel('Sent folder handling').selectOption('spindle');
    await page.getByRole('button', { name: 'Save and check SMTP' }).click();
    await page
      .getByText('Checking SMTP connection in the background…', { exact: true })
      .waitFor();
    assert.equal(smtp.received.length, 0);
    await processOutgoing(pool, keys, owner.id, account);
    await page
      .getByText('SMTP connection checked. Ready to send.', { exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel('SMTP password or app password').inputValue(),
      '',
    );
    await page.getByRole('button', { name: 'Close outgoing settings' }).click();
    await page.reload();
    await page
      .getByRole('button', { name: 'Outgoing SMTP for Browser send account' })
      .click();
    await page.getByLabel('Sender display name', { exact: true }).waitFor();
    assert.equal(
      await page
        .getByLabel('Sender display name', { exact: true })
        .inputValue(),
      senderName,
    );
    await page.getByRole('button', { name: 'Close outgoing settings' }).click();
    const compose = async (subject: string) => {
      await page.getByRole('button', { name: 'Compose', exact: true }).click();
      await page.getByLabel('Subject', { exact: true }).fill(subject);
      await page
        .getByLabel('To', { exact: true })
        .fill('recipient@example.test');
      await page
        .getByRole('button', { name: 'Add Bcc recipients', exact: true })
        .click();
      await page.getByLabel('Bcc', { exact: true }).fill('hidden@example.test');
      await page
        .getByRole('button', { name: 'More options', exact: true })
        .click();
      await page.getByLabel('Message format').selectOption('plain');
      await page
        .getByRole('textbox', { name: 'Message body', exact: true })
        .fill('Synthetic outgoing body');
      await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    };
    const outboxRow = (subject: string) =>
      page
        .getByRole('list', { name: 'Outgoing messages' })
        .getByRole('listitem')
        .filter({ hasText: subject });
    await compose('Browser queued mail');
    await page
      .getByText(`From: ${senderName} <writer@example.test>`, { exact: true })
      .waitFor();
    let lose = true;
    const lostResponse = async (route: Route) => {
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    };
    await page.route('**/api/mail/drafts/*/send', lostResponse);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: /fetch|queue/i })
      .waitFor();
    await page.unroute('**/api/mail/drafts/*/send', lostResponse);
    await page
      .getByRole('button', { name: 'Recover send request', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    assert.equal(
      Number(
        (
          await pool.query(
            'SELECT count(*) FROM mail_outbox WHERE user_id=$1',
            [owner.id],
          )
        ).rows[0].count,
      ),
      1,
    );
    assert.equal(smtp.received.length, 0);
    await page.reload();
    await outboxRow('Browser queued mail')
      .getByRole('button', { name: 'Cancel send', exact: true })
      .click();
    await outboxRow('Browser queued mail')
      .getByText('Cancelled: Browser queued mail', { exact: true })
      .waitFor();
    await apply();
    assert.equal(smtp.received.length, 0);
    await outboxRow('Browser queued mail')
      .getByRole('link', { name: 'Open draft', exact: true })
      .click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    await apply();
    await outboxRow('Browser queued mail')
      .getByText('Accepted by SMTP server: Browser queued mail', {
        exact: true,
      })
      .waitFor();
    assert.equal(smtp.received.length, 1);
    assert.equal(
      (await simpleParser(smtp.received[0]?.raw ?? Buffer.alloc(0))).from
        ?.value[0]?.name,
      senderName,
    );
    assert.equal(imap.server.control.listMessages('Sent').length, 1);

    await compose('Browser failure');
    await page.getByLabel('To', { exact: true }).fill('unfinished');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page
      .getByText(
        'Complete every recipient address before sending. Groups are not supported yet.',
        { exact: true },
      )
      .waitFor();
    assert.equal(smtp.received.length, 1);
    await page.getByLabel('To', { exact: true }).fill('recipient@example.test');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    smtp.controls.rejectData = true;
    await apply();
    await outboxRow('Browser failure')
      .getByText('Failed: Browser failure', { exact: true })
      .waitFor();
    smtp.controls.rejectData = false;
    await outboxRow('Browser failure')
      .getByRole('button', { name: 'Retry send', exact: true })
      .click();
    await outboxRow('Browser failure')
      .getByText('Queued: Browser failure', { exact: true })
      .waitFor();
    await apply();
    await outboxRow('Browser failure')
      .getByText('Accepted by SMTP server: Browser failure', { exact: true })
      .waitFor();
    assert.equal(smtp.received.length, 2);

    await compose('Browser unknown outcome');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    smtp.controls.dropAfterData = true;
    smtp.controls.autoSaveSent = true;
    await apply();
    await outboxRow('Browser unknown outcome')
      .getByText('Delivery status unknown: Browser unknown outcome', {
        exact: true,
      })
      .waitFor();
    assert.equal(
      await outboxRow('Browser unknown outcome')
        .getByRole('button', { name: 'Retry send', exact: true })
        .count(),
      0,
    );
    await apply();
    assert.equal(smtp.received.length, 3);
    await page.reload();
    await outboxRow('Browser unknown outcome')
      .getByText('Delivery status unknown: Browser unknown outcome', {
        exact: true,
      })
      .waitFor();
    await outboxRow('Browser unknown outcome')
      .getByRole('link', { name: 'Review preserved draft' })
      .click();
    await page
      .getByText('Draft conflict. Your edits are preserved.', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Send', exact: true })
        .isDisabled(),
      true,
    );
    await page.getByRole('button', { name: 'Outbox', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
