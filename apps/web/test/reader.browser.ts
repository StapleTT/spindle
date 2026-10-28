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
  const { server, port: imapPort } = await imapFixture(t);
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
    await page.goto(config.appUrl);
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
    stop?.();
    stop = undefined;
    await boss.stop({ graceful: true, timeout: 10000 });
    workerStopped = true;
    server.control.updateUser('testuser', {
      password: 'provider-now-unavailable',
    });
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
