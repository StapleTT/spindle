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
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('composer autosaves rich/plain drafts and recovers safely across navigation, outages and tabs', {
  timeout: 90000,
}, async () => {
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
    'composer-browser@example.test',
  );
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { origin: config.appUrl, cookie: owner.cookie },
    payload: {
      name: 'Composer account',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: 'writer@example.test',
      password: 'synthetic-only-password',
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
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
    let releaseAccounts!: () => void;
    const accountsReady = new Promise<void>((resolve) => {
      releaseAccounts = resolve;
    });
    await page.route('**/api/mail/accounts', async (route) => {
      await accountsReady;
      await route.continue();
    });
    await page.goto(config.appUrl);
    await page
      .getByRole('heading', { name: 'All inboxes', exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole('button', { name: 'Compose', exact: true })
        .isDisabled(),
      true,
    );
    releaseAccounts();
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await page
      .getByRole('heading', { name: 'New message', exact: true })
      .waitFor();
    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
      'draft',
    );
    assert.ok(id);
    const stored = async (draft = id) =>
      (
        await pool.query(
          'SELECT revision,content,account_id FROM mail_drafts WHERE id=$1',
          [draft],
        )
      ).rows[0];
    const waitForSaved = async (
      check: (row: Awaited<ReturnType<typeof stored>>) => boolean,
      draft = id,
    ) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const row = await stored(draft);
        if (row && check(row)) return row;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail('Draft did not reach expected saved state');
    };
    await page
      .getByLabel('To', { exact: true })
      .fill('Recipient <recipient@example.test>, unfinished');
    await page
      .getByRole('button', { name: 'Add Cc recipients', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Add Bcc recipients', exact: true })
      .click();
    await page.getByLabel('Cc', { exact: true }).fill('copy@example.test');
    await page.getByLabel('Bcc', { exact: true }).fill('private@example.test');
    await page
      .getByLabel('Subject', { exact: true })
      .fill('Browser draft — café');
    const rich = page.getByRole('textbox', {
      name: 'Message body',
      exact: true,
    });
    await rich.click();
    await page.keyboard.type('Rich body');
    await rich.press('ControlOrMeta+a');
    await page
      .getByRole('button', { name: 'Formatting options', exact: true })
      .click();
    await page.getByRole('button', { name: 'Bold', exact: true }).click();
    await page
      .getByRole('button', { name: 'Insert link', exact: true })
      .click();
    await page.getByLabel('Link URL').fill('javascript:alert(1)');
    await page
      .getByRole('button', { name: 'Apply link to selected text' })
      .click();
    await page
      .getByText('Use a complete http, https or mailto link.')
      .waitFor();
    await page.getByLabel('Link URL').fill('https://example.test/safe');
    await page
      .getByRole('button', { name: 'Apply link to selected text' })
      .click();
    assert.match(await rich.innerHTML(), /<strong>/);
    await rich.click();
    await rich.press('ControlOrMeta+End');
    const saved = await waitForSaved(
      (row) =>
        row.content.text.includes('Rich body') &&
        row.content.subject === 'Browser draft — café',
    );
    assert.match(saved.content.html, /<strong>/);
    assert.match(saved.content.html, /href="https:\/\/example.test\/safe"/);
    assert.doesNotMatch(saved.content.html, /img|script|tracker|onerror/);
    assert.equal(saved.account_id, account);
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await page.reload();
    await page.getByLabel('Subject', { exact: true }).waitFor();
    assert.equal(
      await page.getByLabel('Bcc', { exact: true }).inputValue(),
      'private@example.test',
    );
    assert.equal(
      await page.getByLabel('Sending account').inputValue(),
      account,
    );
    assert.equal((await rich.locator('strong').count()) > 0, true);
    await rich.evaluate((element) => {
      const data = new DataTransfer();
      data.setData('text/plain', ' safe paste');
      data.setData(
        'text/html',
        '<img src="https://tracker.example.test/" onerror="window.draftPwned=true"><script>window.draftPwned=true</script>',
      );
      element.dispatchEvent(
        new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: data,
        }),
      );
    });
    await waitForSaved((row) => row.content.text.includes('safe paste'));
    assert.doesNotMatch(
      (await stored()).content.html,
      /img|script|tracker|onerror/,
    );
    await page
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByLabel('Message format').selectOption('plain');
    const plain = page.getByRole('textbox', {
      name: 'Message body',
      exact: true,
    });
    await plain.fill('Plain <not HTML>\nSecond line 😀');
    await waitForSaved(
      (row) =>
        row.content.format === 'plain' && row.content.text.endsWith('😀'),
    );
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();

    // Leaving immediately flushes the save and preserves a tab recovery buffer.
    await page
      .getByLabel('Subject', { exact: true })
      .fill('Draft after navigation');
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page.getByRole('button', { name: 'Drafts', exact: true }).click();
    await page
      .getByRole('link', { name: 'Draft after navigation', exact: true })
      .click();
    assert.equal(await plain.inputValue(), 'Plain <not HTML>\nSecond line 😀');
    await waitForSaved(
      (row) => row.content.subject === 'Draft after navigation',
    );
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();

    // Reload while writes are offline, recover text, then explicitly retry.
    const blockWrites = async (route: Route) =>
      route.request().method() === 'PUT' ? route.abort() : route.continue();
    await page.route('**/api/mail/drafts/**', blockWrites);
    await plain.fill('Recovered from offline reload');
    await page
      .getByText('Draft not saved. Retrying automatically.', { exact: true })
      .waitFor();
    await page.reload();
    await plain.waitFor();
    assert.equal(await plain.inputValue(), 'Recovered from offline reload');
    await page
      .getByText('Draft not saved. Retrying automatically.', { exact: true })
      .waitFor();
    await page.unroute('**/api/mail/drafts/**', blockWrites);
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await waitForSaved(
      (row) => row.content.text === 'Recovered from offline reload',
    );
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();

    // Edits made while an earlier save is in flight are saved afterwards.
    let releaseSave = () => {};
    let sawSave = () => {};
    const held = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const started = new Promise<void>((resolve) => {
      sawSave = resolve;
    });
    let holdNext = true;
    const holdSave = async (route: Route) => {
      if (holdNext && route.request().method() === 'PUT') {
        holdNext = false;
        sawSave();
        await held;
      }
      await route.continue();
    };
    await page.route('**/api/mail/drafts/**', holdSave);
    await plain.fill('Earlier request');
    await started;
    await plain.fill('Newer edits made during save');
    releaseSave();
    await waitForSaved(
      (row) => row.content.text === 'Newer edits made during save',
    );
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await page.unroute('**/api/mail/drafts/**', holdSave);

    // The server commits but its response is lost. Reload acknowledges that
    // exact save token, without creating an extra revision or losing newer text.
    const beforeLost = (await stored()).revision;
    let drop = true;
    const loseResponse = async (route: Route) => {
      if (drop && route.request().method() === 'PUT') {
        drop = false;
        await route.fetch();
        await route.abort();
      } else await route.continue();
    };
    await page.route('**/api/mail/drafts/**', loseResponse);
    await plain.fill('Response lost, text retained');
    await page
      .getByText('Draft not saved. Retrying automatically.', { exact: true })
      .waitFor();
    assert.equal((await stored()).revision, beforeLost + 1);
    await page
      .getByRole('button', { name: 'Discard draft', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm discard draft', exact: true })
      .click();
    await page
      .getByText(
        'Confirm the last save before discarding. Use Retry save when the connection is restored.',
        { exact: true },
      )
      .waitFor();
    assert.ok(await stored());
    await page
      .getByRole('button', { name: 'Keep editing', exact: true })
      .click();
    await page.reload();
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    assert.equal(await plain.inputValue(), 'Response lost, text retained');
    assert.equal((await stored()).revision, beforeLost + 1);
    await page.unroute('**/api/mail/drafts/**', loseResponse);

    // Two tabs cannot overwrite each other's revision. Recovery must keep its
    // original base even when a conflicted tab reloads and continues editing.
    const otherTab = await context.newPage();
    watch(otherTab);
    await otherTab.goto(page.url());
    await otherTab.getByLabel('Subject', { exact: true }).waitFor();
    await page.getByLabel('Subject', { exact: true }).fill('First tab wins');
    await waitForSaved((row) => row.content.subject === 'First tab wins');
    await otherTab
      .getByLabel('Subject', { exact: true })
      .fill('Second tab work');
    await otherTab
      .getByText('Draft conflict. Your edits are preserved.', { exact: true })
      .waitFor();
    assert.equal((await stored()).content.subject, 'First tab wins');
    await otherTab.reload();
    await otherTab
      .getByText('Draft conflict. Your edits are preserved.', { exact: true })
      .waitFor();
    assert.equal(
      await otherTab.getByLabel('Subject', { exact: true }).inputValue(),
      'Second tab work',
    );
    await otherTab
      .getByRole('button', { name: 'Discard my edits and load saved version' })
      .click();
    await otherTab.getByText('Saved to Spindle.', { exact: true }).waitFor();
    assert.equal(
      await otherTab.getByLabel('Subject', { exact: true }).inputValue(),
      'First tab wins',
    );
    await page
      .getByLabel('Subject', { exact: true })
      .fill('First tab wins again');
    await waitForSaved((row) => row.content.subject === 'First tab wins again');
    await otherTab
      .getByLabel('Subject', { exact: true })
      .fill('Keep as a separate draft');
    await otherTab
      .getByText('Draft conflict. Your edits are preserved.', { exact: true })
      .waitFor();
    await otherTab
      .getByRole('button', { name: 'Save my edits as a new draft' })
      .click();
    await otherTab.getByText('Saved to Spindle.', { exact: true }).waitFor();
    const copyId = new URLSearchParams(
      new URL(otherTab.url()).hash.slice(1),
    ).get('draft');
    assert.ok(copyId && copyId !== id);
    assert.equal(
      (await stored(copyId)).content.subject,
      'Keep as a separate draft',
    );
    assert.equal((await stored()).content.subject, 'First tab wins again');
    await otherTab
      .getByRole('button', { name: 'Save and close', exact: true })
      .click();
    await otherTab
      .getByRole('link', { name: 'Keep as a separate draft', exact: true })
      .click();
    await otherTab
      .getByRole('button', { name: 'Discard draft', exact: true })
      .click();
    await otherTab
      .getByRole('button', { name: 'Keep editing', exact: true })
      .click();
    assert.ok(await stored(copyId));
    await otherTab
      .getByRole('button', { name: 'Discard draft', exact: true })
      .click();
    await otherTab
      .getByRole('button', { name: 'Confirm discard draft', exact: true })
      .click();
    // Drafts stay visible behind the composer sheet; wait for it to close.
    await otherTab.locator('.composer').waitFor({ state: 'detached' });
    await otherTab
      .getByRole('heading', { name: 'Local drafts', exact: true })
      .waitFor();
    assert.equal(await stored(copyId), undefined);

    await page.setViewportSize({ width: 390, height: 844 });
    await page
      .getByRole('button', { name: 'More options', exact: true })
      .click();
    await page.getByLabel('Message format').selectOption('rich');
    await rich.waitFor();
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.equal(
      await page.evaluate(() =>
        Boolean((window as Window & { draftPwned?: boolean }).draftPwned),
      ),
      false,
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
