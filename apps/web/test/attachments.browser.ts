import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { simpleParser } from 'mailparser';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { fetchMessageContent } from '../../server/src/mail/content-worker.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { scanFile } from '../../server/src/mail/file-scanner.js';
import {
  fetchForwardFile,
  scanUpload,
} from '../../server/src/mail/file-worker.js';
import { processOutgoing } from '../../server/src/mail/outgoing-worker.js';
import { syncAccount } from '../../server/src/mail/sync.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { imapFixture, imapPassword } from '../../server/test/imap-fixture.js';
import {
  attachmentBytes,
  attachmentMail,
} from '../../server/test/reader-fixture.js';
import { eicar, scannerFixture } from '../../server/test/scanner-fixture.js';
import { smtpFixture, smtpPassword } from '../../server/test/smtp-fixture.js';

test('attachments survive autosave, reload and conflict copies; checks gate sending and forwards include files', {
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
      v1: Buffer.alloc(32, 62).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'attachment-browser@example.test',
    '203.0.113.219',
  );
  const imap = await imapFixture(t, true, true, [], true),
    smtp = await smtpFixture(t, imap.server),
    scanner = await scannerFixture(t);
  imap.server.control.addMessage('INBOX', {
    raw: attachmentMail(),
    flags: [],
    internaldate: new Date(),
  });
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
  const account = (
    await request('accounts', 'POST', {
      name: 'Attachment account',
      host: 'localhost',
      port: imap.port,
      transport: 'tls',
      username: 'testuser',
      password: imapPassword,
      history: 'all',
    })
  ).json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  await request(`accounts/${account}/smtp`, 'PUT', {
    host: 'localhost',
    port: smtp.port,
    transport: 'tls',
    username: 'writer@example.test',
    password: smtpPassword,
  });
  await processOutgoing(pool, keys, owner.id, account);
  const original = (
    await pool.query(
      "SELECT id FROM mail_messages WHERE user_id=$1 AND subject='Attachment mail'",
      [owner.id],
    )
  ).rows[0].id;
  await request(`messages/${original}/content`, 'POST', {});
  const version = (
    await pool.query('SELECT version FROM mail_content WHERE message_id=$1', [
      original,
    ])
  ).rows[0].version;
  await fetchMessageContent(pool, keys, {
    userId: owner.id,
    accountId: account,
    messageId: original,
    version,
  });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
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
    const scan = async () => {
      for (const row of (
        await pool.query(
          "SELECT id FROM mail_uploads WHERE user_id=$1 AND state='pending_scan'",
          [owner.id],
        )
      ).rows)
        await scanUpload(pool, owner.id, row.id, (source) =>
          scanFile(source, scanner.env),
        );
    };
    const ready = async () => {
      await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
      await page.waitForFunction(
        () =>
          !(
            Array.from(document.querySelectorAll('button')).find(
              (button) => button.textContent?.trim() === 'Send',
            )?.disabled ?? true
          ),
      );
    };
    const apply = async () => {
      await pool.query(
        "UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1 AND state='queued'",
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
    };
    await page.goto(config.appUrl);
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    // A single account is preselected, so the From row stays hidden.
    await page.getByLabel('To', { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel('Sending account').inputValue(),
      account,
    );
    await page.getByLabel('To', { exact: true }).fill('friend@example.test');
    await page
      .getByLabel('Subject', { exact: true })
      .fill('Files survive recovery');
    const bytes = Buffer.alloc(1024 * 1024 + 7, 73);
    await page.getByLabel('Add files', { exact: true }).setInputFiles({
      name: 'résumé.pdf',
      mimeType: 'application/pdf',
      buffer: bytes,
    });
    const attachments = page.getByRole('region', {
      name: 'Attachments',
      exact: true,
    });
    await attachments
      .getByText('Waiting for security check', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Send', exact: true })
        .isDisabled(),
      true,
    );
    await scan();
    await ready();
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await page.reload();
    await ready();
    assert.match((await attachments.textContent()) ?? '', /résumé.pdf/);
    // A scanner outage preserves the staged file and offers a checked retry.
    scanner.controls.unavailable = true;
    await page.getByLabel('Add files', { exact: true }).setInputFiles({
      name: 'second.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Second file'),
    });
    await attachments
      .getByText('Waiting for security check', { exact: true })
      .waitFor();
    await scan();
    await attachments
      .getByRole('button', { name: 'Retry check', exact: true })
      .waitFor();
    scanner.controls.unavailable = false;
    await attachments
      .getByRole('button', { name: 'Retry check', exact: true })
      .click();
    await attachments
      .getByText('Waiting for security check', { exact: true })
      .waitFor();
    await scan();
    await ready();
    // Malware is visibly blocked, never sent, and can be removed without losing the note.
    await page.getByLabel('Add files', { exact: true }).setInputFiles({
      name: 'eicar.txt',
      mimeType: 'text/plain',
      buffer: eicar,
    });
    await attachments
      .getByText('Waiting for security check', { exact: true })
      .waitFor();
    await scan();
    await attachments
      .getByText('Blocked by security check', { exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Send', exact: true })
        .isDisabled(),
      true,
    );
    await attachments
      .getByRole('button', { name: 'Remove eicar.txt', exact: true })
      .click();
    await ready();
    const draftId = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
      'draft',
    );
    assert.ok(draftId);
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    const saved = (await request(`drafts/${draftId}`)).json().draft;
    await request(`drafts/${draftId}`, 'PUT', {
      accountId: account,
      content: { ...saved.content, subject: 'Changed elsewhere' },
      revision: saved.revision,
      saveId: crypto.randomUUID(),
      attachmentIds: saved.attachmentIds,
    });
    await page
      .getByLabel('Subject', { exact: true })
      .fill('My attachment copy');
    await page
      .getByText('Draft conflict. Your edits are preserved.', { exact: true })
      .waitFor();
    await page
      .getByRole('button', {
        name: 'Save my edits as a new draft',
        exact: true,
      })
      .click();
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await ready();
    await page.reload();
    await ready();
    assert.match((await attachments.textContent()) ?? '', /résumé.pdf/);
    assert.match((await attachments.textContent()) ?? '', /second.txt/);
    await attachments
      .getByRole('button', { name: 'Remove second.txt', exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    await apply();
    const sent = await simpleParser(smtp.received[0]?.raw ?? Buffer.alloc(0));
    assert.equal(sent.attachments.length, 1);
    assert.deepEqual(sent.attachments[0]?.content, bytes);
    assert.equal(sent.attachments[0]?.filename, 'résumé.pdf');
    // Original file attachments appear in forwards and can be removed individually.
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page
      .getByRole('link', { name: 'Attachment mail', exact: true })
      .click();
    await page.getByRole('button', { name: 'Forward', exact: true }).click();
    await page.getByRole('heading', { name: 'Forward', exact: true }).waitFor();
    await attachments
      .getByRole('button', { name: 'Remove message.eml', exact: true })
      .waitFor();
    await attachments
      .getByRole('button', { name: 'Remove message.eml', exact: true })
      .click();
    for (const row of (
      await pool.query(
        "SELECT id FROM mail_uploads WHERE user_id=$1 AND state='pending_fetch'",
        [owner.id],
      )
    ).rows)
      await fetchForwardFile(pool, keys, owner.id, account, row.id);
    await scan();
    await page.getByLabel('To', { exact: true }).fill('friend@example.test');
    await ready();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('heading', { name: 'Outbox', exact: true }).waitFor();
    await apply();
    const forwarded = await simpleParser(
      smtp.received.at(-1)?.raw ?? Buffer.alloc(0),
    );
    assert.ok(
      forwarded.attachments.some((file) =>
        file.content.equals(attachmentBytes),
      ),
    );
    assert.equal(
      forwarded.attachments.some((file) => file.filename === 'message.eml'),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
