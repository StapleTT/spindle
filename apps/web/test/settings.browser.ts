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
import { readContentConfig } from '../../server/src/mail/content-config.js';
import { buildContentApp } from '../../server/src/mail/content-server.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import {
  SANITIZER_VERSION,
  sanitizeMessage,
} from '../../server/src/mail/sanitize.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import { tinyPng } from '../../server/test/reader-fixture.js';

test('settings expose honest controls and a custom color picker that persists and updates other tabs', {
  timeout: 90000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const socket = createNetServer();
  t.after(() => {
    if (socket.listening) socket.close();
  });
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${port}` },
    pool = new Pool({ connectionString });
  const contentSocket = createNetServer();
  t.after(() => {
    if (contentSocket.listening) contentSocket.close();
  });
  await new Promise<void>((resolve) =>
    contentSocket.listen(0, '127.0.0.1', resolve),
  );
  const contentAddress = contentSocket.address();
  assert.ok(contentAddress && typeof contentAddress !== 'string');
  const contentConfig = readContentConfig(config, {
    CONTENT_PORT: String(contentAddress.port),
  });
  assert.ok(contentConfig);
  await migrateDatabase(pool);
  const app = testApp(
    pool,
    config,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 84).toString('base64'),
      }),
    }),
    contentConfig,
  );
  let imageCalls = 0;
  const contentApp = buildContentApp(pool, contentConfig, async () => {
    imageCalls++;
    return { type: 'image/png', data: tinyPng };
  });
  contentApp.log.level = 'silent';
  const owner = await createTestUser(
    app,
    pool,
    config,
    'settings-browser@example.test',
    '203.0.113.234',
  );
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie, origin: config.appUrl },
    payload: {
      name: 'Personal mail',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: owner.email,
      password: 'synthetic-only-password',
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  const box = (
    await pool.query(
      "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
      [owner.id, account],
    )
  ).rows[0].id;
  const id = randomUUID();
  await pool.query(
    `INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at) VALUES($1::uuid,$2,$3,$1::text,'Color test message',$4,'{"to":[],"cc":[],"bcc":[]}',clock_timestamp())`,
    [
      id,
      owner.id,
      account,
      JSON.stringify([
        { name: 'Synthetic Sender', address: 'sender@example.test' },
      ]),
    ],
  );
  await pool.query(
    "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',1)",
    [owner.id, account, box, id],
  );
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const safe = sanitizeMessage(
    '<p>Saved preference image</p><img src="https://images.example.test/pixel.png">',
  );
  await pool.query(
    "INSERT INTO mail_content(user_id,account_id,message_id,state,html,plain_text,resources,sanitizer_version) VALUES($1,$2,$3,'ready',$4,'Saved preference image',$5,$6)",
    [
      owner.id,
      account,
      id,
      safe.html,
      JSON.stringify(safe.resources),
      SANITIZER_VERSION,
    ],
  );
  await new Promise<void>((resolve) => contentSocket.close(() => resolve()));
  await contentApp.listen({ host: '127.0.0.1', port: contentAddress.port });
  await new Promise<void>((resolve) => socket.close(() => resolve()));
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
        const n = item.indexOf('=');
        return {
          name: item.slice(0, n),
          value: item.slice(n + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage(),
      second = await context.newPage();
    page.setDefaultTimeout(12000);
    second.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await second.goto(`${config.appUrl}/inbox`);
    await second.locator(`[data-message-row="${id}"]`).waitFor();
    await page.goto(`${config.appUrl}/inbox#view=settings`);
    await page.getByRole('button', { name: 'Appearance', exact: true }).click();
    const trigger = page.getByRole('button', {
        name: 'Change color for Personal mail',
      }),
      dialog = page.getByRole('dialog', { name: 'Account color' });
    const stored = async () =>
      (
        await pool.query('SELECT color FROM mail_accounts WHERE id=$1', [
          account,
        ])
      ).rows[0].color;
    await t.test(
      'suggestions and keyboard sliders preview colors; Cancel and invalid hex never write',
      async () => {
        await page
          .getByRole('button', { name: 'Compact', exact: true })
          .click();
        assert.equal(
          await page
            .getByRole('button', { name: 'Compact', exact: true })
            .getAttribute('aria-pressed'),
          'true',
        );
        await trigger.click();
        await dialog.getByRole('button', { name: 'Blue', exact: true }).click();
        await page.screenshot({
          path: '/tmp/spindle-color-picker-light.png',
          animations: 'disabled',
        });
        assert.equal(
          await dialog.getByLabel('Hex color').inputValue(),
          '#3a74c4',
        );
        await dialog.getByRole('slider', { name: 'Hue', exact: true }).focus();
        await dialog
          .getByRole('slider', { name: 'Hue', exact: true })
          .press('ArrowRight');
        assert.notEqual(
          await dialog.getByLabel('Hex color').inputValue(),
          '#3a74c4',
        );
        await dialog.getByLabel('Hex color').fill('invalid');
        assert.equal(
          await dialog.getByRole('button', { name: 'Save color' }).isDisabled(),
          true,
        );
        assert.equal(await page.locator('input[type="color"]').count(), 0);
        await dialog
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        assert.equal(await stored(), null);
        assert.equal(
          await trigger.evaluate((node) => document.activeElement === node),
          true,
        );
      },
    );
    await t.test(
      'save reaches the database, drawer, rows, other tabs and reopened settings',
      async () => {
        await trigger.click();
        await dialog.getByLabel('Hex color').fill('#123456');
        await dialog.getByRole('button', { name: 'Save color' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await stored(), '#123456');
        await second.waitForFunction(
          (message) =>
            getComputedStyle(
              document.querySelector(
                `[data-message-row="${message}"]`,
              ) as Element,
            )
              .getPropertyValue('--accent')
              .trim() === '#123456',
          id,
        );
        const drawer = page.getByRole('region', {
          name: 'Personal mail',
          exact: true,
        });
        assert.equal(
          await drawer.evaluate((node) =>
            getComputedStyle(node).getPropertyValue('--accent').trim(),
          ),
          '#123456',
        );
        await page.reload();
        await trigger.click();
        assert.equal(
          await dialog.getByLabel('Hex color').inputValue(),
          '#123456',
        );
        await dialog.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
      },
    );
    await t.test(
      'save failures retain the edited color and can be retried; reset restores theme defaults',
      async () => {
        await trigger.click();
        await dialog.getByLabel('Hex color').fill('#aabbcc');
        await page.route('**/api/mail/accounts/*/color', (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Synthetic save unavailable.' }),
          }),
        );
        await dialog.getByRole('button', { name: 'Save color' }).click();
        await dialog.getByRole('alert').waitFor();
        assert.equal(await stored(), '#123456');
        assert.equal(
          await dialog.getByLabel('Hex color').inputValue(),
          '#aabbcc',
        );
        await page.unroute('**/api/mail/accounts/*/color');
        await dialog.getByRole('button', { name: 'Save color' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await stored(), '#aabbcc');
        await page.getByRole('button', { name: 'Dark', exact: true }).click();
        await page.setViewportSize({ width: 390, height: 844 });
        await trigger.click();
        await page.screenshot({
          path: '/tmp/spindle-color-picker-dark.png',
          animations: 'disabled',
        });
        assert.ok(
          await dialog.evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= 0 &&
              rect.top >= 0 &&
              rect.right <= window.innerWidth &&
              rect.bottom <= window.innerHeight
            );
          }),
        );
        await dialog.getByRole('button', { name: 'Use default' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(await stored(), null);
      },
    );
    await t.test(
      'privacy/send switches persist across tabs and reloads, and failed writes do not lie about state',
      async () => {
        await page
          .getByRole('button', { name: 'Security', exact: true })
          .click();
        const switches = [
          'Load images through the privacy proxy',
          'Block remote images by default',
          'Undo send',
        ];
        for (const name of switches) {
          const control = page.getByRole('switch', { name, exact: true });
          await control.waitFor();
          await page.waitForFunction(
            (label) =>
              !document.querySelector<HTMLButtonElement>(
                `button[role="switch"][aria-label="${label}"]`,
              )?.disabled,
            name,
          );
          assert.equal(await control.getAttribute('aria-checked'), 'true');
          await control.click();
          await page.waitForFunction(
            (label) =>
              document
                .querySelector(`button[role="switch"][aria-label="${label}"]`)
                ?.getAttribute('aria-checked') === 'false',
            name,
          );
        }
        assert.deepEqual(
          (
            await pool.query(
              'SELECT image_proxy,block_remote_images,undo_send FROM mail_preferences WHERE user_id=$1',
              [owner.id],
            )
          ).rows[0],
          { image_proxy: false, block_remote_images: false, undo_send: false },
        );
        await second.goto(`${config.appUrl}/inbox#view=settings`);
        await second
          .getByRole('button', { name: 'Security', exact: true })
          .click();
        for (const name of switches) {
          await second.waitForFunction(
            (label) =>
              document
                .querySelector(`button[role="switch"][aria-label="${label}"]`)
                ?.getAttribute('aria-checked') === 'false',
            name,
          );
        }
        await page.reload();
        const undo = page.getByRole('switch', {
          name: 'Undo send',
          exact: true,
        });
        await page.waitForFunction(
          () =>
            document
              .querySelector('button[aria-label="Undo send"]')
              ?.getAttribute('aria-checked') === 'false',
        );
        await page.route('**/api/mail/preferences', (route) =>
          route.request().method() === 'PATCH'
            ? route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({
                  message: 'Synthetic preference failure.',
                }),
              })
            : route.continue(),
        );
        await undo.click();
        await page
          .getByRole('alert')
          .filter({ hasText: 'Synthetic preference failure' })
          .waitFor();
        assert.equal(await undo.getAttribute('aria-checked'), 'false');
        await page.unroute('**/api/mail/preferences');
        await undo.click();
        await page.waitForFunction(
          () =>
            document
              .querySelector('button[aria-label="Undo send"]')
              ?.getAttribute('aria-checked') === 'true',
        );
        assert.equal(
          await page
            .getByRole('switch', { name: 'Two-step verification' })
            .count(),
          0,
        );
        await page.reload();
        await page
          .getByRole('button', { name: 'Appearance', exact: true })
          .click();
        assert.equal(
          await page
            .getByRole('button', { name: 'Compact', exact: true })
            .getAttribute('aria-pressed'),
          'true',
        );
        assert.equal(
          await page
            .getByRole('button', { name: 'Dark', exact: true })
            .getAttribute('aria-pressed'),
          'true',
        );
        assert.deepEqual(errors, []);
      },
    );
    await t.test(
      'turning off image blocking really loads images automatically, while Hide still overrides the default',
      async () => {
        await page
          .getByRole('button', { name: 'Security', exact: true })
          .click();
        const proxy = page.getByRole('switch', {
          name: 'Load images through the privacy proxy',
          exact: true,
        });
        await page.waitForFunction(
          () =>
            !document.querySelector<HTMLButtonElement>(
              'button[aria-label="Load images through the privacy proxy"]',
            )?.disabled,
        );
        assert.equal(await proxy.getAttribute('aria-checked'), 'false');
        await proxy.click();
        await page.waitForFunction(
          () =>
            document
              .querySelector(
                'button[aria-label="Load images through the privacy proxy"]',
              )
              ?.getAttribute('aria-checked') === 'true',
        );
        assert.equal(imageCalls, 0);
        await page.goto(`${config.appUrl}/inbox#message=${id}`);
        await page
          .getByRole('button', { name: 'Hide images', exact: true })
          .waitFor();
        const frame = () => page.frameLocator('iframe[title="Message body"]');
        await frame().locator('img').waitFor();
        await frame()
          .locator('img')
          .evaluate(
            (node) =>
              new Promise<void>((resolve) => {
                if ((node as HTMLImageElement).complete) resolve();
                else
                  node.addEventListener('load', () => resolve(), {
                    once: true,
                  });
              }),
          );
        assert.equal(imageCalls, 1);
        await page
          .getByRole('button', { name: 'Hide images', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Display images', exact: true })
          .waitFor();
        assert.equal(await frame().locator('img').count(), 0);
        assert.deepEqual(errors, []);
      },
    );
  } finally {
    await browser?.close();
    await vite.close();
    await contentApp.close();
    await app.close();
  }
});
