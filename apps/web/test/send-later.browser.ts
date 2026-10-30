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

test('Send later recovers lost responses, persists schedules, supports edit/cancel and refreshes across tabs', {
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
      'scheduled-browser@example.test',
      '203.0.113.228',
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
    const context = await browser.newContext({ timezoneId: 'America/Chicago' });
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
    const settings = await app.inject({
      method: 'PUT',
      url: `/api/mail/accounts/${account}/smtp`,
      headers: { cookie: owner.cookie, origin: config.appUrl },
      payload: {
        host: 'localhost',
        port: smtp.port,
        transport: 'tls',
        username: 'writer@example.test',
        password: smtpPassword,
        saveSentCopy: true,
      },
    });
    assert.equal(settings.statusCode, 202, settings.body);
    await processOutgoing(pool, keys, owner.id, account);
    const waitFor = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('Scheduled state did not arrive');
    };
    const stored = async (subject = 'Browser send later') =>
      (
        await pool.query(
          'SELECT * FROM mail_outbox WHERE user_id=$1 AND subject=$2 ORDER BY seq DESC LIMIT 1',
          [owner.id, subject],
        )
      ).rows[0];
    const outboxRow = (tab: typeof page, subject = 'Browser send later') =>
      tab
        .getByRole('list', { name: 'Outgoing messages' })
        .getByRole('listitem')
        .filter({ hasText: subject });
    const time = () =>
      page.evaluate(() =>
        new Date(Date.now() + 7200000)
          .toLocaleString('sv-SE', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          })
          .replace(' ', 'T'),
      );
    await page.goto(`${config.appUrl}/inbox`);
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await page.getByLabel('To', { exact: true }).fill('recipient@example.test');
    await page
      .getByLabel('Subject', { exact: true })
      .fill('Browser send later');
    await page
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByLabel('Message format').selectOption('plain');
    await page
      .getByRole('textbox', { name: 'Message body', exact: true })
      .fill('Scheduled browser body');
    await page.getByRole('button', { name: 'Send later', exact: true }).click();
    const initial = await time();
    await page.getByLabel('Send at', { exact: true }).fill(initial);
    assert.match(
      (await page.getByText(/Timezone:/).textContent()) ?? '',
      /America\/Chicago/,
    );
    const submitted: { id: string; revision: number; scheduledAt: string }[] =
      [];
    let lose = true;
    const lost = async (route: Route) => {
      submitted.push(route.request().postDataJSON());
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    };
    await page.route('**/api/mail/drafts/*/send', lost);
    await page
      .getByRole('button', { name: 'Schedule send', exact: true })
      .click();
    await page
      .getByRole('alert')
      .filter({ hasText: /fetch|queue/i })
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Send', exact: true })
        .isDisabled(),
      true,
    );
    await page.reload();
    await page
      .getByRole('button', { name: 'Recover send request', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    assert.equal(submitted.length, 2);
    assert.deepEqual(submitted[0], submitted[1]);
    assert.ok(submitted[0]?.scheduledAt);
    const first = await stored();
    assert.equal(
      first.scheduled_at.getTime(),
      Date.parse(submitted[0]?.scheduledAt ?? ''),
    );
    assert.equal(smtp.received.length, 0);
    await outboxRow(page)
      .getByText('Scheduled: Browser send later', { exact: true })
      .waitFor();
    const second = await context.newPage();
    second.setDefaultTimeout(15000);
    await second.goto(`${config.appUrl}/inbox#view=outbox`);
    await outboxRow(second)
      .getByText('Scheduled: Browser send later', { exact: true })
      .waitFor();
    await outboxRow(page)
      .getByRole('button', { name: 'Reschedule send', exact: true })
      .click();
    const later = await page.evaluate(() =>
      new Date(Date.now() + 10800000)
        .toLocaleString('sv-SE', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        })
        .replace(' ', 'T'),
    );
    await page.getByLabel('New send time', { exact: true }).fill(later);
    await page
      .getByRole('button', { name: 'Save send time', exact: true })
      .click();
    await waitFor(async () => (await stored()).schedule_revision === 2);
    const rescheduled = await stored();
    assert.deepEqual(rescheduled.raw, first.raw);
    await second.waitForFunction(
      (stamp: string) =>
        document.querySelector(`time[datetime="${stamp}"]`) !== null,
      rescheduled.scheduled_at.toISOString(),
    );
    await page.reload();
    await outboxRow(page)
      .getByRole('button', { name: 'Cancel and edit', exact: true })
      .click();
    await page.getByLabel('Send at', { exact: true }).waitFor();
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Message body', exact: true })
        .inputValue(),
      'Scheduled browser body',
    );
    assert.equal(
      await page.getByLabel('Send at', { exact: true }).inputValue(),
      later,
    );
    assert.equal((await stored()).state, 'cancelled');
    assert.equal(
      await page
        .getByRole('button', { name: 'Send', exact: true })
        .isDisabled(),
      true,
    );
    await page
      .getByLabel('Subject', { exact: true })
      .fill('Edited scheduled mail');
    await page
      .getByRole('button', { name: 'Schedule send', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    const edited = await stored('Edited scheduled mail');
    assert.notEqual(edited.id, first.id);
    assert.equal(
      edited.scheduled_at.getTime(),
      rescheduled.scheduled_at.getTime(),
    );
    await processOutgoing(pool, keys, owner.id, account);
    assert.equal(smtp.received.length, 0);
    await pool.query(
      "UPDATE mail_outbox SET scheduled_at=clock_timestamp()-interval '1 second',next_attempt_at=clock_timestamp() WHERE id=$1",
      [edited.id],
    );
    await processOutgoing(pool, keys, owner.id, account);
    await outboxRow(page, 'Edited scheduled mail')
      .getByText('Accepted by SMTP server: Edited scheduled mail', {
        exact: true,
      })
      .waitFor();
    assert.equal(smtp.received.length, 1);
    const parsed = await simpleParser(smtp.received[0]?.raw ?? Buffer.alloc(0));
    assert.equal(parsed.subject, 'Edited scheduled mail');
    assert.match(parsed.text ?? '', /Scheduled browser body/);
    await processOutgoing(pool, keys, owner.id, account);
    assert.equal(smtp.received.length, 1);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
