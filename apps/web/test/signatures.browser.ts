import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { chromium, type Page, type Route } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { syncProviderDrafts } from '../../server/src/mail/provider-drafts.js';
import { syncAccount } from '../../server/src/mail/sync.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { imapFixture, imapPassword } from '../../server/test/imap-fixture.js';

test('account signatures insert once, stay editable across rich/plain, recovery and provider sync, and respect separate defaults', {
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
      v1: Buffer.alloc(32, 49).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'signatures-browser@example.test',
  );
  const imap = await imapFixture(t, true, true, ['UIDPLUS'], false, true);
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { origin: config.appUrl, cookie: owner.cookie },
    payload: {
      name: 'Composer account',
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
  const secondResponse = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie, origin: config.appUrl },
    payload: {
      name: 'Second account',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: 'second@example.test',
      password: 'synthetic-only-password',
      history: 'all',
    },
  });
  assert.equal(secondResponse.statusCode, 202, secondResponse.body);
  const second = secondResponse.json().account.id;
  const secondSig = await app.inject({
    method: 'PUT',
    url: `/api/mail/accounts/${second}/signature`,
    headers: { cookie: owner.cookie, origin: config.appUrl },
    payload: {
      revision: 0,
      html: '<p>Second account signature</p>',
      newMessages: true,
      repliesForwards: false,
    },
  });
  assert.equal(secondSig.statusCode, 200, secondSig.body);
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
  const errors: string[] = [];
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
    const watch = (tab: Page) => {
      tab.setDefaultTimeout(15000);
      tab.on('pageerror', (error) => errors.push(error.message));
      tab.on('dialog', (dialog) => void dialog.accept());
    };
    watch(page);
    await page.goto(`${config.appUrl}/inbox`);
    await page
      .getByRole('heading', { name: 'All inboxes', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Signatures', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Email signature for Composer account',
        exact: true,
      })
      .click();
    const settings = page.getByRole('region', {
      name: 'Email signature — Composer account',
      exact: true,
    });
    const signatureBody = settings.getByRole('textbox', {
      name: 'Signature body',
      exact: true,
    });
    await signatureBody.click();
    await page.keyboard.type('Ada café');
    await signatureBody.press('ControlOrMeta+a');
    await settings.getByRole('button', { name: 'Bold', exact: true }).click();
    await settings
      .getByRole('button', { name: 'Save signature', exact: true })
      .click();
    await settings.getByText('Signature saved.', { exact: true }).waitFor();
    await settings
      .getByRole('button', { name: 'Close signature settings', exact: true })
      .click();
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    const body = page.getByRole('textbox', {
      name: 'Message body',
      exact: true,
    });
    await body.waitFor();
    assert.equal(
      ((await body.textContent()) ?? '').split('Ada café').length - 1,
      1,
    );
    assert.equal(await body.locator('strong').count(), 1);
    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
      'draft',
    );
    assert.ok(id);
    const stored = async () =>
      (await pool.query('SELECT * FROM mail_drafts WHERE id=$1', [id])).rows[0];
    async function waitFor(check: () => Promise<boolean>) {
      const end = Date.now() + 15000;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail('Signed draft did not reach expected state');
    }
    await body.press('ControlOrMeta+Home');
    await page.keyboard.type('New note');
    await page.keyboard.press('Enter');
    await waitFor(
      async () => !!(await stored())?.content.text.includes('New note'),
    );
    assert.equal((await stored()).content.text.split('Ada café').length - 1, 1);
    await page
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByLabel('Message format').selectOption('plain');
    await body.fill('New note\nAda edited');
    await waitFor(
      async () => (await stored()).content.text === 'New note\nAda edited',
    );
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await pool.query(
      'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp() WHERE source_draft_id=$1',
      [id],
    );
    await syncProviderDrafts(pool, keys, owner.id, account);
    const remote = (
      await pool.query(
        'SELECT c.uid FROM mail_draft_copies c JOIN mail_draft_links l ON l.active_copy_id=c.id WHERE l.source_draft_id=$1',
        [id],
      )
    ).rows[0];
    assert.ok(remote);
    const raw = imap.server.control.getMessage(
      'Drafts',
      Number(remote.uid),
    ).raw;
    assert.ok(raw);
    assert.match(raw.toString(), /Ada edited/);
    await page.reload();
    await body.waitFor();
    assert.equal((await body.inputValue()).trimEnd(), 'New note\nAda edited');
    const blockWrites = async (route: Route) =>
      route.request().method() === 'PUT' ? route.abort() : route.continue();
    await page.route('**/api/mail/drafts/**', blockWrites);
    await body.fill('Offline edits\nAda offline');
    await page
      .getByText('Draft not saved. Retrying automatically.', { exact: true })
      .waitFor();
    await page.reload();
    await body.waitFor();
    assert.equal(await body.inputValue(), 'Offline edits\nAda offline');
    await page
      .getByText('Draft not saved. Retrying automatically.', { exact: true })
      .waitFor();
    await page.unroute('**/api/mail/drafts/**', blockWrites);
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await waitFor(
      async () =>
        (await stored()).content.text === 'Offline edits\nAda offline',
    );
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    // Keep the draft open but out of the way while editing settings.
    await page
      .getByRole('button', { name: 'Minimize composer', exact: true })
      .click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Signatures', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Email signature for Composer account',
        exact: true,
      })
      .click();
    await settings.getByLabel('Signature format').selectOption('plain');
    await settings
      .getByRole('textbox', { name: 'Signature body', exact: true })
      .fill('Updated signature');
    await settings
      .getByLabel('Use for new messages', { exact: true })
      .uncheck();
    await settings
      .getByLabel('Use for replies and forwards', { exact: true })
      .check();
    await settings
      .getByRole('button', { name: 'Save signature', exact: true })
      .click();
    await settings.getByText('Signature saved.', { exact: true }).waitFor();
    await settings
      .getByRole('button', { name: 'Close signature settings', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Expand composer', exact: true })
      .click();
    assert.equal(await body.inputValue(), 'Offline edits\nAda offline');
    await page.getByLabel('Sending account').selectOption(second);
    assert.equal(await body.inputValue(), 'Offline edits\nAda offline');
    await page
      .getByRole('button', { name: 'Save and close', exact: true })
      .click();
    await page.getByRole('link', { name: '(No subject)', exact: true }).click();
    await body.waitFor();
    assert.equal(await body.inputValue(), 'Offline edits\nAda offline');
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await body.waitFor();
    assert.doesNotMatch(
      (await body.textContent()) ?? '',
      /Ada|Updated signature/,
    );
    await page.goto(`${config.appUrl}/inbox#account=${second}`);
    await page
      .getByRole('heading', { name: 'Second account inbox', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await body.waitFor();
    assert.match((await body.textContent()) ?? '', /Second account signature/);
    await page
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByLabel('Message format').selectOption('plain');
    assert.match(await body.inputValue(), /Second account signature/);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
