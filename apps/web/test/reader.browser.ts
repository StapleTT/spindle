import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { applyMailActions } from '../../server/src/mail/actions.js';
import { readContentConfig } from '../../server/src/mail/content-config.js';
import { buildContentApp } from '../../server/src/mail/content-server.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { syncAccount } from '../../server/src/mail/sync.js';
import { startMailWorker } from '../../server/src/mail/worker.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { imapFixture, imapPassword } from '../../server/test/imap-fixture.js';
import {
  attachmentBytes,
  attachmentMail,
  newsletterHtml,
  readerMail,
  tinyPng,
} from '../../server/test/reader-fixture.js';

test('browser reader navigation, isolated HTML, image controls, caching and stale responses', {
  timeout: 120000,
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
  const contentConfig = readContentConfig(config, {});
  assert.ok(contentConfig);
  let imageCalls = 0;
  const contentApp = buildContentApp(pool, contentConfig, async () => {
    imageCalls++;
    return { type: 'image/png', data: tinyPng };
  });
  contentApp.log.level = 'silent';
  const contentAddress = await contentApp.listen({
    host: '127.0.0.1',
    port: 0,
  });
  contentConfig.origin = `http://localhost:${new URL(contentAddress).port}`;
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 45).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys, contentConfig);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'reader-browser@example.test',
  );
  const { server, port: imapPort } = await imapFixture(t, true, true, [
    'MOVE',
    'UIDPLUS',
  ]);
  for (let i = 0; i < 51; i++)
    server.control.addMessage('INBOX', {
      raw: readerMail(
        `Reader message ${i}`,
        newsletterHtml(i),
        `Plain body ${i}`,
      ),
      internaldate: new Date(Date.now() + i * 1000),
      flags: [],
    });
  server.control.addMessage('Receipts', {
    raw: attachmentMail(),
    internaldate: new Date(),
    flags: [],
  });
  server.control.addMessage('Archive', {
    raw: readerMail('Archived reader'),
    internaldate: new Date(),
    flags: [],
  });
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { origin: config.appUrl, cookie: owner.cookie },
    payload: {
      name: 'Reader IMAP',
      host: 'localhost',
      port: imapPort,
      transport: 'tls',
      username: 'testuser',
      password: imapPassword,
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const accountId = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, accountId);
  const newest = (
    await pool.query(
      'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
      [owner.id, 'Reader message 50'],
    )
  ).rows[0].id;
  const next = (
    await pool.query(
      'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
      [owner.id, 'Reader message 49'],
    )
  ).rows[0].id;
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
  const boss = new PgBoss({ connectionString });
  boss.on('error', () => {});
  let stop: (() => void) | undefined;
  let workerStopped = false;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let releaseSlow = () => {};
  try {
    await boss.start();
    stop = await startMailWorker(boss, pool, keys);
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addCookies(
      owner.cookie.split('; ').map((item) => {
        const position = item.indexOf('=');
        return {
          name: item.slice(0, position),
          value: item.slice(position + 1),
          url: config.appUrl,
          httpOnly: true,
          sameSite: 'Lax' as const,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    const errors: string[] = [];
    const leakedCookies: string[] = [];
    const headerChecks: Promise<void>[] = [];
    const directImages: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (request.url().startsWith(contentConfig.origin))
        headerChecks.push(
          request.allHeaders().then((headers) => {
            if (headers.cookie)
              leakedCookies.push(request.url().split('?')[0] ?? '');
          }),
        );
      if (request.url().startsWith('https://images.example.test/'))
        directImages.push(request.url());
    });
    await page.goto(`${config.appUrl}/inbox`);
    await page
      .getByRole('link', { name: 'Reader message 50', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Reader message 50', exact: true })
      .waitFor();
    const frame = () => page.frameLocator('iframe[title="Message body"]');
    await frame().getByText('Formatted body 50', { exact: true }).waitFor();
    assert.equal(await frame().locator('img').count(), 0);
    assert.equal(imageCalls, 0);
    assert.equal(await frame().locator('#preheader').isVisible(), false);
    const title = frame().locator('.newsletter-title');
    assert.equal(
      await title.evaluate((element) => getComputedStyle(element).fontSize),
      '28px',
    );
    assert.equal(
      await title.evaluate((element) => getComputedStyle(element).color),
      'rgb(18, 52, 86)',
    );
    assert.equal(
      await frame()
        .locator('.newsletter')
        .evaluate((element) =>
          Math.round(element.getBoundingClientRect().width),
        ),
      600,
    );
    assert.equal(
      await frame()
        .locator('.newsletter-content')
        .evaluate((element) => getComputedStyle(element).paddingTop),
      '24px',
    );
    assert.equal(
      await frame()
        .locator('.newsletter-hero')
        .evaluate((element) => getComputedStyle(element).backgroundImage),
      'none',
    );
    const sandbox = await page.locator('iframe').getAttribute('sandbox');
    assert.ok(!sandbox?.includes('allow-scripts'));
    assert.ok(!sandbox?.includes('allow-same-origin'));
    assert.equal(
      await page.evaluate(() =>
        Boolean((window as Window & { readerPwned?: boolean }).readerPwned),
      ),
      false,
    );
    await page
      .getByRole('button', { name: 'Display images', exact: true })
      .click();
    await frame().locator('img').nth(1).waitFor();
    await page.waitForFunction(() =>
      document.querySelector('iframe')?.getAttribute('src')?.includes('token='),
    );
    const documentFrame = page
      .frames()
      .find((item) => item.url().startsWith(contentConfig.origin));
    assert.ok(documentFrame);
    assert.equal(await documentFrame.evaluate(() => window.origin), 'null');
    await documentFrame.waitForFunction(
      () =>
        [...document.images].length === 2 &&
        [...document.images].every(
          (image) => image.complete && image.naturalWidth > 0,
        ),
    );
    assert.equal(imageCalls, 2);
    assert.equal(
      await frame()
        .locator('.newsletter-logo')
        .evaluate((element) => getComputedStyle(element).height),
      '40px',
    );
    assert.match(
      await frame()
        .locator('.newsletter-hero')
        .evaluate((element) => getComputedStyle(element).backgroundImage),
      /\/image\?token=/,
    );
    await Promise.all(headerChecks);
    assert.deepEqual(leakedCookies, []);
    assert.deepEqual(directImages, []);
    await page
      .getByRole('button', { name: 'Hide images', exact: true })
      .click();
    await frame().getByText('Formatted body 50', { exact: true }).waitFor();
    assert.equal(await frame().locator('img').count(), 0);
    await page.getByRole('link', { name: 'Next message', exact: true }).click();
    await frame().getByText('Formatted body 49', { exact: true }).waitFor();
    assert.equal(await frame().locator('img').count(), 0);
    await page.getByRole('button', { name: 'Plain text', exact: true }).click();
    await page.getByText('Plain body 49', { exact: true }).waitFor();
    await page.goBack();
    await frame().getByText('Formatted body 50', { exact: true }).waitFor();
    assert.equal(await frame().locator('img').count(), 0);
    await page
      .getByRole('link', { name: 'Back to message list', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Older messages', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Reader message 0', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Previous message', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Reader message 1', exact: true })
      .waitFor();
    await page
      .getByRole('link', { name: 'Back to message list', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Reader message 0', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Newest messages', exact: true })
      .click();
    let startedSlow: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      startedSlow = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const pattern = `**/api/mail/messages/${newest}*`;
    await page.route(pattern, async (route) => {
      startedSlow();
      await gate;
      try {
        await route.fulfill({ response: await route.fetch() });
      } catch {
        await route.abort().catch(() => {});
      }
    });
    await page
      .getByRole('link', { name: 'Reader message 50', exact: true })
      .click();
    await started;
    await page.evaluate((id) => {
      window.location.hash = `message=${id}`;
    }, next);
    await page
      .getByRole('heading', { name: 'Reader message 49', exact: true })
      .waitFor();
    releaseSlow();
    await page.unroute(pattern);
    await page.getByRole('button', { name: 'Plain text', exact: true }).click();
    await page.getByText('Plain body 49', { exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    const attached = (
      await pool.query(
        `SELECT m.id,b.id AS mailbox FROM mail_messages m JOIN mail_memberships mm ON mm.message_id=m.id
        JOIN mailboxes b ON b.id=mm.mailbox_id WHERE m.user_id=$1 AND m.subject='Attachment mail'`,
        [owner.id],
      )
    ).rows[0];
    await page.evaluate(({ id, mailbox }) => {
      window.location.hash = `mailbox=${mailbox}&message=${id}`;
    }, attached);
    await page
      .getByRole('heading', { name: 'Attachment mail', exact: true })
      .waitFor();
    const attachments = page.getByRole('region', { name: 'Attachments' });
    await attachments.getByText('résumé__evil.pdf', { exact: true }).waitFor();
    await attachments.getByText(/^application\/pdf, /).waitFor();
    await page.route(
      '**/attachments/0',
      (route) =>
        route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{"message":"Simulated outage."}',
        }),
      { times: 1 },
    );
    await attachments
      .getByRole('button', { name: 'Download résumé__evil.pdf' })
      .click();
    await attachments.getByText('Simulated outage.').waitFor();
    const downloaded = page.waitForEvent('download');
    await attachments.getByRole('button', { name: 'Retry download' }).click();
    await attachments.getByText('Fetching attachment…').waitFor();
    const download = await downloaded;
    assert.equal(download.suggestedFilename(), 'résumé__evil.pdf');
    assert.deepEqual(await readFile(await download.path()), attachmentBytes);
    await attachments
      .getByRole('button', { name: 'Download résumé__evil.pdf' })
      .waitFor();
    assert.equal(
      await page.evaluate(() => window.location.origin),
      new URL(config.appUrl).origin,
    );
    await page.evaluate((id) => {
      window.location.hash = `message=${id}`;
    }, next);
    await page
      .getByRole('heading', { name: 'Reader message 49', exact: true })
      .waitFor();
    const inboxCount = (unread: number) =>
      page
        .getByRole('button', { name: `INBOX (${unread} unread / 51)` })
        .waitFor();
    await inboxCount(51);
    await page
      .getByRole('button', { name: 'Mark as read', exact: true })
      .click();
    await inboxCount(50);
    await page.getByText('Marked as read.', { exact: true }).waitFor();
    assert.ok(server.control.getMessage('INBOX', 50).flags.includes('\\Seen'));
    await page
      .getByRole('link', { name: 'Back to message list', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Mark “Reader message 48” as read' })
      .click();
    await page
      .getByRole('button', { name: 'Mark “Reader message 48” as unread' })
      .waitFor();
    await inboxCount(49);
    const deadline = Date.now() + 15000;
    while (
      Date.now() < deadline &&
      !server.control.getMessage('INBOX', 49).flags.includes('\\Seen')
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(server.control.getMessage('INBOX', 49).flags.includes('\\Seen'));
    const waitFor = async (check: () => boolean) => {
      const until = Date.now() + 15000;
      while (Date.now() < until && !check())
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(check());
    };
    const subjectId = async (subject: string) =>
      (
        await pool.query(
          'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
          [owner.id, subject],
        )
      ).rows[0].id;
    await page.evaluate(
      (id) => {
        window.location.hash = `message=${id}`;
      },
      await subjectId('Reader message 47'),
    );
    await page
      .getByRole('heading', { name: 'Reader message 47', exact: true })
      .waitFor();
    await page
      .locator('.reader')
      .getByRole('button', { name: 'Archive', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Reader message 46', exact: true })
      .waitFor();
    await page.getByText('Archived “Reader message 47”.').waitFor();
    await page
      .getByRole('button', { name: 'INBOX (48 unread / 50)' })
      .waitFor();
    await page
      .getByRole('button', { name: 'Archive (2 unread / 2)' })
      .waitFor();
    await waitFor(() => server.control.getMailbox('Archive').messages === 2);
    await page
      .getByRole('link', { name: 'Back to message list', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Move “Reader message 45” to trash' })
      .click();
    await page
      .getByRole('link', { name: 'Reader message 45', exact: true })
      .waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Trash (1 unread / 1)' }).waitFor();
    await waitFor(() => server.control.getMailbox('Trash').messages === 1);
    await page.getByRole('button', { name: 'Trash (1 unread / 1)' }).click();
    await page
      .getByRole('button', { name: 'Restore “Reader message 45”' })
      .click();
    await page.getByText('Restored “Reader message 45” to INBOX.').waitFor();
    await page.getByRole('button', { name: 'Trash (0 unread / 0)' }).waitFor();
    await waitFor(() => server.control.getMailbox('Trash').messages === 0);
    await page.evaluate(
      async (id) => {
        window.location.hash = `message=${id}`;
      },
      await subjectId('Reader message 44'),
    );
    await page
      .getByRole('heading', { name: 'Reader message 44', exact: true })
      .waitFor();
    const receipts = server.control.getMailbox('Receipts').messages;
    await page.getByLabel('Move to folder').selectOption({ label: 'Receipts' });
    await page.getByRole('button', { name: 'Move', exact: true }).click();
    await page.getByText('Moved “Reader message 44” to Receipts.').waitFor();
    await page
      .getByRole('button', {
        name: new RegExp(`^Receipts \\(\\d+ unread / ${receipts + 1}\\)`),
      })
      .waitFor();
    await waitFor(
      () => server.control.getMailbox('Receipts').messages === receipts + 1,
    );
    // Undo survives a reload until its server-side five-second deadline.
    await page
      .getByRole('heading', { name: 'Reader message 43', exact: true })
      .waitFor();
    await page
      .locator('.reader')
      .getByRole('button', { name: 'Archive', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Reader message 42', exact: true })
      .waitFor();
    await page.reload();
    await page
      .getByRole('button', { name: 'Undo: Archived “Reader message 43”.' })
      .click();
    await page
      .getByText('Undone: Archived “Reader message 43”.', { exact: true })
      .waitFor();
    assert.equal(
      (
        await pool.query(
          `SELECT a.state FROM mail_actions a JOIN mail_messages m ON m.id=a.message_id
          WHERE m.subject='Reader message 43' ORDER BY a.seq DESC LIMIT 1`,
        )
      ).rows[0].state,
      'cancelled',
    );
    await page
      .getByRole('link', { name: 'Back to message list', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Reader message 43', exact: true })
      .waitFor();
    assert.equal(server.control.getMailbox('Archive').messages, 2);
    await page.evaluate((id) => {
      window.location.hash = `message=${id}`;
    }, next);
    await page
      .getByRole('heading', { name: 'Reader message 49', exact: true })
      .waitFor();
    stop?.();
    stop = undefined;
    await boss.stop({ graceful: true, timeout: 10000 });
    workerStopped = true;
    // A provider failure arrives after leaving the reader, survives a reload,
    // and can be retried from the persistent shell without reopening the mail.
    await pool.query('DELETE FROM mail_request_limits WHERE user_id=$1', [
      owner.id,
    ]);
    const feedbackMessage = await subjectId('Reader message 42');
    await page.evaluate((id) => {
      window.location.hash = `message=${id}`;
    }, feedbackMessage);
    await page
      .getByRole('heading', { name: 'Reader message 42', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Mark as read', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Back to message list', exact: true })
      .click();
    const feedbackRow = page
      .getByRole('list', { name: 'Recent actions' })
      .getByRole('listitem')
      .filter({ hasText: 'Reader message 42' });
    await feedbackRow.getByText('Pending:', { exact: true }).waitFor();
    const applyFeedback = async (offline = false) => {
      await pool.query(
        "UPDATE mail_actions SET next_attempt_at=now(),undo_until=now() WHERE user_id=$1 AND state='pending'",
        [owner.id],
      );
      await applyMailActions(
        pool,
        keys,
        owner.id,
        accountId,
        offline
          ? async () => {
              throw new Error('Synthetic outage');
            }
          : undefined,
      );
    };
    for (let attempt = 0; attempt < 5; attempt++) await applyFeedback(true);
    await feedbackRow.getByText('Failed:', { exact: true }).waitFor();
    await page.reload();
    await feedbackRow.getByText('Failed:', { exact: true }).waitFor();
    await feedbackRow.getByRole('button', { name: /^Retry:/ }).click();
    await feedbackRow.getByText('Pending:', { exact: true }).waitFor();
    await applyFeedback();
    await feedbackRow.getByText('Completed:', { exact: true }).waitFor();
    const local = (
      await pool.query('SELECT uid FROM mail_memberships WHERE message_id=$1', [
        feedbackMessage,
      ])
    ).rows[0];
    assert.ok(
      server.control
        .getMessage('INBOX', Number(local.uid))
        .flags.includes('\\Seen'),
    );
    await feedbackRow.getByRole('button', { name: /^Dismiss:/ }).click();
    await feedbackRow.waitFor({ state: 'detached' });
    await page.reload();
    assert.equal(await feedbackRow.count(), 0);

    // A change made in another mail client is retained as a conflict in the bar.
    await page
      .getByRole('button', { name: 'Archive “Reader message 41”', exact: true })
      .click();
    server.control.moveMessages('INBOX', [42], 'Receipts');
    await applyFeedback();
    const conflictRow = page
      .getByRole('list', { name: 'Recent actions' })
      .getByRole('listitem')
      .filter({ hasText: 'Reader message 41' });
    await conflictRow.getByText('Conflict:', { exact: true }).waitFor();
    assert.equal(
      await conflictRow.getByRole('button', { name: /^Retry:/ }).count(),
      0,
    );
    await page.reload();
    await conflictRow.getByText('Conflict:', { exact: true }).waitFor();
    await conflictRow.getByRole('button', { name: /^Dismiss:/ }).click();
    await conflictRow.waitFor({ state: 'detached' });
    await page.evaluate((id) => {
      window.location.hash = `message=${id}`;
    }, next);
    await page
      .getByRole('heading', { name: 'Reader message 49', exact: true })
      .waitFor();
    server.control.updateUser('testuser', {
      password: 'provider-now-unavailable',
    });
    // Cached newsletters keep their phone layout in a narrow reader.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await frame().getByText('Formatted body 49', { exact: true }).waitFor();
    assert.equal(
      await frame()
        .locator('.newsletter-title')
        .evaluate((element) => getComputedStyle(element).fontSize),
      '20px',
    );
    assert.equal(
      await frame()
        .locator('.newsletter-content')
        .evaluate((element) => getComputedStyle(element).paddingTop),
      '12px',
    );
    assert.ok(
      await frame()
        .locator('.newsletter')
        .evaluate(
          (element) =>
            element.getBoundingClientRect().width <= window.innerWidth,
        ),
    );
    assert.equal(
      await page.evaluate(() =>
        Boolean((window as Window & { readerPwned?: boolean }).readerPwned),
      ),
      false,
    );
    await Promise.all(headerChecks);
    assert.deepEqual(errors, []);
    assert.deepEqual(leakedCookies, []);
    assert.deepEqual(directImages, []);
  } finally {
    releaseSlow();
    await browser?.close();
    stop?.();
    if (!workerStopped) await boss.stop({ graceful: true, timeout: 10000 });
    await vite.close();
    await contentApp.close();
    await app.close();
  }
});
