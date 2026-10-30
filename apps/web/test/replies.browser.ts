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
import { readContentConfig } from '../../server/src/mail/content-config.js';
import { buildContentApp } from '../../server/src/mail/content-server.js';
import { fetchMessageContent } from '../../server/src/mail/content-worker.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { processOutgoing } from '../../server/src/mail/outgoing-worker.js';
import { syncAccount } from '../../server/src/mail/sync.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { imapFixture, imapPassword } from '../../server/test/imap-fixture.js';
import {
  newsletterHtml,
  readerMail,
  tinyPng,
} from '../../server/test/reader-fixture.js';
import { replyMail } from '../../server/test/reply-fixture.js';
import { smtpFixture, smtpPassword } from '../../server/test/smtp-fixture.js';

test('reader replies and forwarding preserve recipients, draft recovery and received threading', {
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
      v1: Buffer.alloc(32, 56).toString('base64'),
    }),
  });
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
  t.after(() => contentApp.close());
  const app = testApp(pool, config, undefined, keys, contentConfig),
    owner = await createTestUser(
      app,
      pool,
      config,
      'login@example.test',
      '203.0.113.217',
    );
  const imap = await imapFixture(t, true, true, [], true),
    smtp = await smtpFixture(t, imap.server);
  const request = (
    path: string,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    payload?: object,
  ) =>
    app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { origin: config.appUrl, cookie: owner.cookie },
      ...(payload ? { payload } : {}),
    });
  const accountBody = {
    name: 'Alias mailbox',
    host: 'mail.example.test',
    port: 993,
    transport: 'tls',
    username: 'alias@example.test',
    password: imapPassword,
    history: 'all',
  };
  await request('accounts', 'POST', accountBody);
  imap.server.control.addMessage('INBOX', {
    raw: replyMail({
      plain:
        'Original response body.\n<img src=x onerror="window.replyPwned=true">',
    }),
    flags: [],
    internaldate: new Date('2026-10-28T12:00:00Z'),
  });
  imap.server.control.addMessage('INBOX', {
    raw: replyMail({
      subject: 'Other message',
      messageId: '<other-message@example.test>',
    }),
    flags: [],
    internaldate: new Date('2026-10-28T11:00:00Z'),
  });
  imap.server.control.addMessage('INBOX', {
    raw: readerMail(
      'Styled original',
      newsletterHtml(1),
      'Complete original plain alternative.',
    ),
    flags: [],
    internaldate: new Date('2026-10-28T10:00:00Z'),
  });
  const connected = await request('accounts', 'POST', {
    ...accountBody,
    name: 'Receiving mailbox',
    host: 'localhost',
    port: imap.port,
    username: 'testuser',
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  const messages = (await request('messages')).json().messages as {
    id: string;
    subject: string;
  }[];
  const source = messages.find(
    (message) => message.subject === 'Project question',
  )?.id;
  assert.ok(source);
  for (const message of messages) {
    await request(`messages/${message.id}/content`, 'POST', {});
    const version = (
      await pool.query('SELECT version FROM mail_content WHERE message_id=$1', [
        message.id,
      ])
    ).rows[0].version;
    await fetchMessageContent(pool, keys, {
      userId: owner.id,
      accountId: account,
      messageId: message.id,
      version,
    });
  }
  await request(`accounts/${account}/smtp`, 'PUT', {
    host: 'localhost',
    port: smtp.port,
    transport: 'tls',
    username: 'writer@example.test',
    password: smtpPassword,
  });
  await processOutgoing(pool, keys, owner.id, account);
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
  let releaseCompose = () => {};
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
    page.on('dialog', (dialog) => void dialog.accept());
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const openOriginal = async () => {
      await page
        .getByRole('button', { name: 'All inboxes', exact: true })
        .click();
      await page
        .getByRole('link', { name: 'Project question', exact: true })
        .click();
      await page
        .getByRole('heading', { name: 'Project question', exact: true })
        .waitFor();
    };
    const apply = async () => {
      await pool.query(
        "UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1 AND state='queued'",
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
    };
    await page.goto(config.appUrl);
    await page
      .getByRole('heading', { name: 'All inboxes', exact: true })
      .waitFor();
    await openOriginal();
    // Lost create acknowledgement is recovered with the same ID even after reload.
    let lose = true;
    const lost = async (route: Route) => {
      if (lose) {
        lose = false;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    };
    await page.route('**/api/mail/messages/*/compose', lost);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page
      .getByRole('alert')
      .filter({ hasText: /fetch|prepare/i })
      .waitFor();
    await page.unroute('**/api/mail/messages/*/compose', lost);
    await page.reload();
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await page.getByRole('heading', { name: 'Reply', exact: true }).waitFor();
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int AS count FROM mail_drafts WHERE user_id=$1',
          [owner.id],
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      await page.getByLabel('Sending account').inputValue(),
      account,
    );
    assert.match(
      await page.getByLabel('To', { exact: true }).inputValue(),
      /support@example.test/,
    );
    assert.equal(await page.getByLabel('Cc', { exact: true }).inputValue(), '');
    assert.equal(
      await page.getByLabel('Bcc', { exact: true }).inputValue(),
      '',
    );
    const body = page.getByRole('textbox', {
      name: 'Message body',
      exact: true,
    });
    await body.click();
    await body.press('ControlOrMeta+Home');
    await page.keyboard.type('My reply response.');
    assert.equal(await body.locator('img, script, style').count(), 0);
    await page
      .getByRole('button', { name: 'Save and close', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Re: Project question', exact: true })
      .click();
    await page.getByRole('heading', { name: 'Reply', exact: true }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Reply', exact: true }).waitFor();
    assert.match((await body.textContent()) ?? '', /My reply response/);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    await apply();
    const received = smtp.received[0];
    assert.ok(received);
    const parsed = await simpleParser(received.raw);
    assert.equal(parsed.inReplyTo, '<parent@example.test>');
    assert.deepEqual(parsed.references, [
      '<root@example.test>',
      '<previous@example.test>',
      '<parent@example.test>',
    ]);
    assert.equal(parsed.from?.value[0]?.address, 'writer@example.test');
    assert.match(parsed.text ?? '', /My reply response/);
    assert.equal(parsed.bcc, undefined);
    await openOriginal();
    // Existing body caches fetch only reply headers; the reader waits and resumes.
    await pool.query(
      'UPDATE mail_content SET reply_metadata=NULL WHERE message_id=$1',
      [source],
    );
    const upgrade = async (route: Route) => {
      const response = await route.fetch();
      assert.equal(response.status(), 202);
      const version = (
        await pool.query(
          'SELECT version FROM mail_content WHERE message_id=$1',
          [source],
        )
      ).rows[0].version;
      await fetchMessageContent(pool, keys, {
        userId: owner.id,
        accountId: account,
        messageId: source,
        version,
      });
      await route.fulfill({ response });
      await page.unroute(`**/api/mail/messages/${source}/compose`, upgrade);
    };
    await page.route(`**/api/mail/messages/${source}/compose`, upgrade);
    await page.getByRole('button', { name: 'Reply all', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Reply all', exact: true })
      .waitFor();
    assert.match(
      await page.getByLabel('To', { exact: true }).inputValue(),
      /other@example.test/,
    );
    assert.doesNotMatch(
      await page.getByLabel('To', { exact: true }).inputValue(),
      /writer@example|alias@example|login@example/,
    );
    assert.equal(
      await page.getByLabel('Cc', { exact: true }).inputValue(),
      'copy@example.test',
    );
    assert.equal(
      await page.getByLabel('Bcc', { exact: true }).inputValue(),
      '',
    );
    // A conflicted copy still carries server-owned threading context.
    const draftId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
      'draft',
    );
    assert.ok(draftId);
    const saved = (await request(`drafts/${draftId}`)).json().draft;
    await request(`drafts/${draftId}`, 'PUT', {
      revision: saved.revision,
      saveId: crypto.randomUUID(),
      accountId: account,
      content: { ...saved.content, subject: 'Changed in another tab' },
    });
    await page.getByLabel('Subject', { exact: true }).fill('My local copy');
    await page
      .getByText('Draft conflict. Your edits are preserved.', { exact: true })
      .waitFor();
    await page
      .getByRole('button', {
        name: 'Save my edits as a new draft',
        exact: true,
      })
      .click();
    await page
      .getByRole('heading', { name: 'Reply all', exact: true })
      .waitFor();
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await page.reload();
    await page
      .getByRole('heading', { name: 'Reply all', exact: true })
      .waitFor();
    assert.equal(
      await page.getByLabel('Subject', { exact: true }).inputValue(),
      'My local copy',
    );
    await page
      .getByRole('link', { name: 'Back to original message', exact: true })
      .click();
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await page.getByRole('heading', { name: 'Forward', exact: true }).waitFor();
    assert.equal(await page.getByLabel('To', { exact: true }).inputValue(), '');
    assert.equal(await page.getByLabel('Cc', { exact: true }).inputValue(), '');
    assert.equal(
      await page.getByLabel('Bcc', { exact: true }).inputValue(),
      '',
    );
    assert.equal(
      await page.getByLabel('Subject', { exact: true }).inputValue(),
      'Fwd: Project question',
    );
    assert.match((await body.textContent()) ?? '', /Forwarded message/);
    assert.doesNotMatch((await body.textContent()) ?? '', /never-copy/);
    assert.equal(await body.locator('img, script, style').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.getByLabel('To', { exact: true }).fill('friend@example.test');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    await apply();
    const forward = await simpleParser(
      smtp.received.at(-1)?.raw ?? Buffer.alloc(0),
    );
    assert.equal(forward.inReplyTo, undefined);
    assert.equal(forward.references, undefined);
    assert.match(forward.text ?? '', /Original response body/);
    assert.equal(smtp.received.length, 2);
    // The rich original stays outside the editor through edits, autosave and reload.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Styled original', exact: true })
      .click();
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await page.getByRole('heading', { name: 'Forward', exact: true }).waitFor();
    const forwarded = page.frameLocator(
      'iframe[title="Forwarded message body"]',
    );
    await forwarded
      .getByRole('heading', { name: 'Business newsletter', exact: true })
      .waitFor();
    assert.equal(await body.locator('style, table, img, script').count(), 0);
    assert.equal(await forwarded.locator('table.newsletter').count(), 1);
    assert.equal(await forwarded.locator('img').count(), 0);
    assert.equal(imageCalls, 0);
    assert.equal(
      await forwarded
        .locator('.newsletter-title')
        .evaluate((element) => getComputedStyle(element).fontSize),
      '28px',
    );
    await body.fill('My styled forward note.');
    await page.getByLabel('To', { exact: true }).fill('friend@example.test');
    await page
      .getByRole('button', { name: 'Save and close', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Fwd: Styled original', exact: true })
      .click();
    await page.reload();
    await page.getByRole('heading', { name: 'Forward', exact: true }).waitFor();
    await forwarded
      .getByRole('heading', { name: 'Business newsletter', exact: true })
      .waitFor();
    assert.match((await body.textContent()) ?? '', /My styled forward note/);
    await page
      .getByRole('button', { name: 'Display images', exact: true })
      .click();
    await forwarded.locator('img').first().waitFor();
    await page.waitForFunction(() =>
      Boolean(document.querySelector('iframe[title="Forwarded message body"]')),
    );
    assert.equal(await forwarded.locator('img').count(), 2);
    await page
      .getByRole('button', { name: 'Hide images', exact: true })
      .click();
    await forwarded
      .getByRole('heading', { name: 'Business newsletter', exact: true })
      .waitFor();
    assert.equal(await forwarded.locator('img').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await forwarded
        .locator('.newsletter-title')
        .evaluate((element) => getComputedStyle(element).fontSize),
      '20px',
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByLabel('Message format').selectOption('plain');
    assert.match(
      (await page
        .getByRole('region', { name: 'Forwarded original', exact: true })
        .textContent()) ?? '',
      /Complete original plain alternative/,
    );
    assert.equal(
      await page.locator('iframe[title="Forwarded message body"]').count(),
      0,
    );
    await page
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByLabel('Message format').selectOption('rich');
    await forwarded
      .getByRole('heading', { name: 'Business newsletter', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    await apply();
    const styled = await simpleParser(
      smtp.received.at(-1)?.raw ?? Buffer.alloc(0),
      { skipImageLinks: true },
    );
    assert.match(String(styled.html), /My styled forward note/);
    assert.match(String(styled.html), /<style>[\s\S]*@media/);
    assert.match(String(styled.html), /<table[^>]+width="600"/);
    assert.equal(styled.attachments.length, 1);
    assert.deepEqual(styled.attachments[0]?.content, tinyPng);
    assert.equal(styled.inReplyTo, undefined);
    // A slow response creates the draft without pulling navigation back to it.
    await page.setViewportSize({ width: 1280, height: 900 });
    await openOriginal();
    const held = new Promise<void>((resolve) => {
      releaseCompose = resolve;
    });
    let started = () => {};
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = async (route: Route) => {
      started();
      await held;
      await route.continue();
    };
    await page.route('**/api/mail/messages/*/compose', hold);
    await page.getByRole('button', { name: 'Reply', exact: true }).click();
    await pending;
    await page.getByRole('link', { name: 'Next message', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Other message', exact: true })
      .waitFor();
    releaseCompose();
    await page.waitForFunction(
      (key) => sessionStorage.getItem(key) === null,
      `spindle:respond:${owner.id}:${source}:reply`,
    );
    assert.equal(
      await page
        .getByRole('heading', { name: 'Other message', exact: true })
        .count(),
      1,
    );
    await page.unroute('**/api/mail/messages/*/compose', hold);
    assert.equal(
      await page.evaluate(() =>
        Boolean((window as Window & { replyPwned?: boolean }).replyPwned),
      ),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    releaseCompose();
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
