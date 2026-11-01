import assert from 'node:assert/strict';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { Pool } from 'pg';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('account security forms preserve edits, verify replacement email and revoke owned device sessions', {
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
  const config = { ...testConfig, appUrl: `http://127.0.0.1:${address.port}` };
  const pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const messages: { to: string; text: string }[] = [];
  const mailer = nodemailer.createTransport({ jsonTransport: true });
  t.mock.method(mailer, 'sendMail', async (mail: SendMailOptions) => {
    messages.push({ to: String(mail.to), text: String(mail.text) });
    return { messageId: 'synthetic-account-browser' };
  });
  const app = testApp(pool, config, mailer);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'account-browser@example.test',
  );
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: address.port,
      strictPort: true,
      proxy: { '/api': api },
    },
  });
  const browser = await chromium.launch({ headless: true });
  try {
    await vite.listen();
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: 'light',
    });
    await context.addCookies(
      owner.cookie.split('; ').map((item) => {
        const at = item.indexOf('=');
        return {
          name: item.slice(0, at),
          value: item.slice(at + 1),
          url: config.appUrl,
        };
      }),
    );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const settings = async () => {
      await page.goto(`${config.appUrl}/inbox#view=settings`);
      await page.getByRole('button', { name: 'Security', exact: true }).click();
      await page.getByLabel('Profile name', { exact: true }).waitFor();
    };
    const loginDevice = async (
      email = owner.email,
      password = owner.password,
    ) => {
      const device = await browser.newContext();
      const response = await device.request.post(
        `${config.appUrl}/api/auth/sign-in/email`,
        {
          headers: { origin: config.appUrl },
          data: { email, password },
        },
      );
      assert.equal(response.status(), 200, await response.text());
      return device;
    };
    const clearLimits = async () => {
      await pool.query('DELETE FROM auth_rate_limits');
      await pool.query(
        "DELETE FROM mail_request_limits WHERE action LIKE 'account-%'",
      );
    };
    const device = await loginDevice();
    await settings();
    const profile = page.locator('section[aria-labelledby="profile-title"]');
    const password = page.locator('section[aria-labelledby="password-title"]');
    const email = page.locator('section[aria-labelledby="login-email-title"]');
    const sessions = page.locator('section[aria-labelledby="sessions-title"]');

    await t.test(
      'profile save failures preserve edits, successful saves refresh the menu and survive reload',
      async () => {
        await profile.getByLabel('Profile name').fill('Synthetic New Name');
        await page.route('**/api/auth/account/profile', (route) =>
          route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ message: 'Synthetic save failure.' }),
          }),
        );
        await profile
          .getByRole('button', { name: 'Save profile name', exact: true })
          .click();
        await profile
          .getByRole('alert')
          .filter({ hasText: 'Synthetic save failure' })
          .waitFor();
        assert.equal(
          await profile.getByLabel('Profile name').inputValue(),
          'Synthetic New Name',
        );
        await page.unroute('**/api/auth/account/profile');
        await profile
          .getByRole('button', { name: 'Save profile name', exact: true })
          .click();
        await profile
          .getByRole('status')
          .filter({ hasText: 'Profile name saved' })
          .waitFor();
        await page.reload();
        await page.getByLabel('Profile name', { exact: true }).waitFor();
        assert.equal(
          await profile.getByLabel('Profile name').inputValue(),
          'Synthetic New Name',
        );
        assert.equal(
          (await pool.query('SELECT name FROM users WHERE id=$1', [owner.id]))
            .rows[0].name,
          'Synthetic New Name',
        );
      },
    );
    await t.test(
      'forms reject mismatching new passwords and wrong current passwords',
      async () => {
        await password
          .getByLabel('Current password', { exact: true })
          .fill(owner.password);
        await password
          .getByLabel('New password', { exact: true })
          .fill('a changed synthetic password 42!');
        await password
          .getByLabel('Confirm new password')
          .fill('another synthetic password 42!');
        await password
          .getByRole('button', { name: 'Change password', exact: true })
          .click();
        await password
          .getByRole('alert')
          .filter({ hasText: 'do not match' })
          .waitFor();
        await password
          .getByLabel('Current password', { exact: true })
          .fill('incorrect password');
        await password
          .getByLabel('Confirm new password')
          .fill('a changed synthetic password 42!');
        await password
          .getByRole('button', { name: 'Change password', exact: true })
          .click();
        await password
          .getByRole('alert')
          .filter({ hasText: 'current password is incorrect' })
          .waitFor();
      },
    );
    await clearLimits();
    await t.test(
      'device revocation is confirmed, leaves this device active and signs out the selected other session',
      async () => {
        await sessions.getByText('Other device', { exact: true }).waitFor();
        await sessions
          .getByLabel('Current password for device sign-out')
          .fill(owner.password);
        await sessions
          .getByRole('button', { name: /Sign out session from/ })
          .click();
        await sessions
          .getByRole('status')
          .filter({ hasText: 'Device signed out' })
          .waitFor();
        assert.equal(
          (await device.request.get(`${config.appUrl}/api/me`)).status(),
          401,
        );
        assert.equal(
          (await context.request.get(`${config.appUrl}/api/me`)).status(),
          200,
        );
        await device.close();
        const second = await loginDevice();
        const third = await loginDevice();
        await page.reload();
        await sessions
          .getByLabel('Current password for device sign-out')
          .fill(owner.password);
        await sessions
          .getByRole('button', { name: 'Sign out other devices', exact: true })
          .click();
        await sessions
          .getByRole('status')
          .filter({ hasText: 'Other devices signed out' })
          .waitFor();
        for (const item of [second, third]) {
          assert.equal(
            (await item.request.get(`${config.appUrl}/api/me`)).status(),
            401,
          );
          await item.close();
        }
        assert.equal(
          await sessions.getByText('This device', { exact: true }).count(),
          1,
        );
        assert.equal(
          await sessions
            .getByRole('button', { name: /Sign out session from/ })
            .count(),
          0,
        );
      },
    );
    await clearLimits();
    await t.test(
      'cards fit desktop light and phone dark, preserve typed values on refresh and retain keyboard focus',
      async () => {
        await profile.getByLabel('Profile name').fill('Unsaved synthetic name');
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForResponse((response) =>
          response.url().endsWith('/api/auth/account/sessions'),
        );
        assert.equal(
          await profile.getByLabel('Profile name').inputValue(),
          'Unsaved synthetic name',
        );
        await profile.getByLabel('Profile name').focus();
        await page.keyboard.press('Tab');
        assert.equal(
          await profile
            .getByRole('button', { name: 'Save profile name', exact: true })
            .evaluate((node) => node === document.activeElement),
          true,
        );
        await page.locator('.settings-body').evaluate((node) => {
          node.scrollTop = 0;
        });
        await page.screenshot({
          path: '/tmp/spindle-account-security-desktop-light.png',
          animations: 'disabled',
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() => {
          localStorage.setItem('spindle-theme', 'dark');
        });
        await page.emulateMedia({ colorScheme: 'dark' });
        await page.reload();
        await profile.getByLabel('Profile name').waitFor();
        assert.equal(
          await page
            .locator('body')
            .evaluate((node) => node.scrollWidth <= window.innerWidth),
          true,
        );
        assert.equal(
          await page
            .locator('.settings-body')
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
          true,
        );
        await page.screenshot({
          path: '/tmp/spindle-account-security-phone-dark.png',
          animations: 'disabled',
        });
        assert.equal(
          await sessions
            .getByRole('button', {
              name: 'Sign out other devices',
              exact: true,
            })
            .evaluate((node) => getComputedStyle(node).backgroundColor),
          'rgba(0, 0, 0, 0)',
        );
        await sessions.scrollIntoViewIfNeeded();
        await page.screenshot({
          path: '/tmp/spindle-account-security-sessions-phone-dark.png',
          animations: 'disabled',
        });
        await page.setViewportSize({ width: 1280, height: 900 });
      },
    );
    await clearLimits();
    await t.test(
      'replacement links require explicit confirmation and new email preserves identity and revokes all devices',
      async () => {
        await email
          .getByLabel('New sign-in email')
          .fill('replacement-browser@example.test');
        await email
          .getByLabel('Current password', { exact: true })
          .fill(owner.password);
        await email
          .getByRole('button', { name: 'Send verification link', exact: true })
          .click();
        await email
          .getByRole('status')
          .filter({ hasText: 'Awaiting verification' })
          .waitFor();
        assert.equal(
          (await pool.query('SELECT email FROM users WHERE id=$1', [owner.id]))
            .rows[0].email,
          owner.email,
        );
        const message = messages.findLast(
          (item) => item.to === 'replacement-browser@example.test',
        );
        assert.ok(message);
        const href = message.text.match(/https?:\/\/\S+/)?.[0];
        assert.ok(href);
        const other = await loginDevice();
        await page.goto(href);
        await page
          .getByRole('heading', {
            name: 'Confirm new sign-in email',
            exact: true,
          })
          .waitFor();
        assert.equal(new URL(page.url()).searchParams.has('token'), false);
        assert.equal(
          (await pool.query('SELECT email FROM users WHERE id=$1', [owner.id]))
            .rows[0].email,
          owner.email,
        );
        await page
          .getByRole('button', {
            name: 'Confirm new sign-in email',
            exact: true,
          })
          .click();
        await page.waitForURL('**/login?emailChanged=1');
        assert.equal(
          (await other.request.get(`${config.appUrl}/api/me`)).status(),
          401,
        );
        await other.close();
        assert.equal(
          (
            await pool.query(
              'SELECT email,email_verified,name FROM users WHERE id=$1',
              [owner.id],
            )
          ).rows[0].email,
          'replacement-browser@example.test',
        );
        await page
          .getByLabel('Email address', { exact: true })
          .fill('replacement-browser@example.test');
        await page.getByLabel('Password', { exact: true }).fill(owner.password);
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .click();
        await page.waitForURL('**/inbox**');
        assert.equal(
          (await (await context.request.get(`${config.appUrl}/api/me`)).json())
            .user.id,
          owner.id,
        );
      },
    );
    await clearLimits();
    await t.test(
      'changing password signs out all devices and only the new password works',
      async () => {
        const other = await loginDevice('replacement-browser@example.test');
        await settings();
        await password
          .getByLabel('Current password', { exact: true })
          .fill(owner.password);
        await password
          .getByLabel('New password', { exact: true })
          .fill('a changed synthetic password 42!');
        await password
          .getByLabel('Confirm new password')
          .fill('a changed synthetic password 42!');
        await password
          .getByRole('button', { name: 'Change password', exact: true })
          .click();
        await page.waitForURL('**/login?passwordChanged=1');
        assert.equal(
          (await other.request.get(`${config.appUrl}/api/me`)).status(),
          401,
        );
        await other.close();
        assert.equal(
          (
            await context.request.post(
              `${config.appUrl}/api/auth/sign-in/email`,
              {
                headers: { origin: config.appUrl },
                data: {
                  email: 'replacement-browser@example.test',
                  password: owner.password,
                },
              },
            )
          ).status(),
          401,
        );
        const signed = await loginDevice(
          'replacement-browser@example.test',
          'a changed synthetic password 42!',
        );
        assert.equal(
          (await signed.request.get(`${config.appUrl}/api/me`)).status(),
          200,
        );
        await signed.close();
        assert.deepEqual(errors, []);
      },
    );
  } finally {
    await browser.close();
    await vite.close();
    // Browser files share the proxy's loopback IP in the disposable database.
    await pool.query('DELETE FROM auth_rate_limits');
    await app.close();
  }
});
