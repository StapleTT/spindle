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

test('admin settings match the app design and enforce private access, confirmed changes and invitation feedback', {
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
  const messages: string[] = [];
  const mailer = nodemailer.createTransport({ jsonTransport: true });
  t.mock.method(mailer, 'sendMail', async (mail: SendMailOptions) => {
    messages.push(String(mail.to));
    return { messageId: 'synthetic-admin-browser' };
  });
  const app = testApp(pool, config, mailer);
  const admin = await createTestUser(
    app,
    pool,
    config,
    'admin-browser-owner@example.test',
    '203.0.113.194',
  );
  const member = await createTestUser(
    app,
    pool,
    config,
    'admin-browser-member@example.test',
    '203.0.113.195',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
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
      viewport: { width: 1280, height: 960 },
      colorScheme: 'light',
    });
    const ordinary = await browser.newContext();
    for (const [device, user] of [
      [context, admin],
      [ordinary, member],
    ] as const)
      await device.addCookies(
        user.cookie.split('; ').map((item) => {
          const n = item.indexOf('=');
          return {
            name: item.slice(0, n),
            value: item.slice(n + 1),
            url: config.appUrl,
          };
        }),
      );
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const resetLimits = async () => {
      await pool.query('DELETE FROM auth_rate_limits');
      await pool.query(
        "DELETE FROM mail_request_limits WHERE action LIKE 'admin-%'",
      );
    };
    const other = await ordinary.newPage();
    await t.test(
      'regular users cannot reveal the tab through saved state or call admin routes',
      async () => {
        await other.goto(`${config.appUrl}/inbox#view=settings`);
        await other
          .getByRole('heading', { name: 'Settings', exact: true })
          .waitFor();
        assert.equal(
          await other
            .getByRole('button', { name: 'Admin', exact: true })
            .count(),
          0,
        );
        await other.evaluate(() =>
          sessionStorage.setItem('spindle-settings-tab', 'admin'),
        );
        await other.reload();
        assert.equal(
          await other
            .getByRole('heading', { name: 'Administration', exact: true })
            .count(),
          0,
        );
        assert.equal(
          (
            await ordinary.request.get(`${config.appUrl}/api/admin/users`)
          ).status(),
          403,
        );
      },
    );
    const protectedRequests: string[] = [];
    const unlockRequests: string[] = [];
    const mutationBodies: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (!path.startsWith('/api/admin/')) return;
      if (path === '/api/admin/unlock') unlockRequests.push(path);
      else if (path !== '/api/admin/access') protectedRequests.push(path);
      if (request.method() === 'POST' && path !== '/api/admin/unlock')
        mutationBodies.push(request.postDataJSON() as Record<string, unknown>);
    });
    await page.goto(`${config.appUrl}/inbox#view=settings`);
    await page.getByRole('button', { name: 'Admin', exact: true }).click();
    await t.test(
      'only the password gate is visible and no admin data is requested before a successful unlock',
      async () => {
        await page
          .getByRole('heading', { name: 'Unlock administration', exact: true })
          .waitFor();
        assert.equal(
          await page.getByRole('list', { name: 'Users', exact: true }).count(),
          0,
        );
        assert.equal(
          await page
            .getByRole('navigation', { name: 'Administration sections' })
            .count(),
          0,
        );
        assert.equal(await page.locator('.admin-overview').count(), 0);
        assert.deepEqual(protectedRequests, []);
        await page.screenshot({
          path: '/tmp/spindle-admin-locked-desktop.png',
          animations: 'disabled',
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({
          path: '/tmp/spindle-admin-locked-phone.png',
          animations: 'disabled',
        });
        assert.equal(
          await page
            .locator('.settings-body')
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
          true,
        );
        await page
          .getByLabel('Current password', { exact: true })
          .fill('wrong');
        await page
          .getByRole('button', { name: 'Unlock administration', exact: true })
          .click();
        await page
          .getByRole('alert')
          .filter({ hasText: 'password is incorrect' })
          .waitFor();
        assert.deepEqual(protectedRequests, []);
        const releases: Array<() => void> = [];
        await page.route('**/api/admin/access', async (route) => {
          await new Promise<void>((resolve) => releases.push(resolve));
          await route.fulfill({ json: { unlocked: false } });
        });
        const read = page.waitForRequest((request) =>
          request.url().endsWith('/api/admin/access'),
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await read;
        await page
          .getByLabel('Current password', { exact: true })
          .fill(admin.password);
        await page
          .getByRole('button', { name: 'Unlock administration', exact: true })
          .click();
        await page
          .getByRole('heading', { name: 'Administration', exact: true })
          .waitFor();
        const staleResponse = page.waitForResponse((response) =>
          response.url().endsWith('/api/admin/access'),
        );
        for (const release of releases) release();
        await (await staleResponse).finished();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await page.unroute('**/api/admin/access');
        assert.equal(
          await page
            .getByRole('heading', { name: 'Administration', exact: true })
            .isVisible(),
          true,
        );
        assert.equal(
          await page.locator('.admin-settings input[type="password"]').count(),
          0,
        );
        await page.setViewportSize({ width: 1280, height: 960 });
        await page.reload();
        await page
          .getByRole('heading', { name: 'Administration', exact: true })
          .waitFor();
        assert.equal(unlockRequests.length, 2);
      },
    );
    const users = page.getByRole('list', { name: 'Users', exact: true });
    const dialog = page.getByRole('dialog');
    const memberRow = () =>
      users
        .locator('li')
        .filter({ has: page.getByText(member.email, { exact: true }) });
    const confirm = async () => {
      assert.equal(await dialog.locator('input[type="password"]').count(), 0);
      await dialog
        .getByRole('button', { name: 'Confirm', exact: true })
        .click();
      await dialog.waitFor({ state: 'hidden' });
    };
    await t.test(
      'confirmed suspend/resume, role changes and session revocation update real data without losing mail',
      async () => {
        await page
          .getByLabel('Search users', { exact: true })
          .fill(member.email);
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await memberRow().waitFor();
        await memberRow()
          .getByRole('button', { name: 'Suspend', exact: true })
          .click();
        await confirm();
        await memberRow().getByText('Suspended', { exact: true }).waitFor();
        await other
          .getByRole('heading', { name: 'Sign in', exact: true })
          .waitFor();
        assert.equal(
          (await ordinary.request.get(`${config.appUrl}/api/me`)).status(),
          401,
        );
        await memberRow()
          .getByRole('button', { name: 'Resume', exact: true })
          .click();
        await confirm();
        await memberRow().getByText('Verified', { exact: true }).waitFor();
        assert.equal(
          (await ordinary.request.get(`${config.appUrl}/api/me`)).status(),
          401,
        );
        await memberRow()
          .getByRole('button', { name: 'Sign out devices', exact: true })
          .click();
        await confirm();
        await resetLimits();
        await memberRow()
          .getByRole('button', { name: 'Make admin', exact: true })
          .click();
        await confirm();
        await memberRow()
          .getByRole('button', { name: 'Make user', exact: true })
          .waitFor();
        assert.equal(
          (
            await pool.query('SELECT role,suspended FROM users WHERE id=$1', [
              member.id,
            ])
          ).rows[0].role,
          'admin',
        );
        await memberRow()
          .getByRole('button', { name: 'Make user', exact: true })
          .click();
        await confirm();
        await memberRow()
          .getByRole('button', { name: 'Make admin', exact: true })
          .waitFor();
      },
    );
    await resetLimits();
    await t.test(
      'invitations send through the configured transport and support revoke/resend with audit history',
      async () => {
        await page
          .getByRole('button', { name: 'Invitations', exact: true })
          .click();
        const email = 'admin-browser-invite@example.test';
        await page
          .getByLabel('Search invitations', { exact: true })
          .fill(email);
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await page.getByLabel('Invitation email', { exact: true }).fill(email);
        await page
          .getByRole('button', { name: 'Send invitation', exact: true })
          .click();
        await confirm();
        const row = page
          .getByRole('list', { name: 'Invitations', exact: true })
          .locator('li')
          .filter({
            has: page.getByRole('heading', { name: email, exact: true }),
          });
        await row.getByText('Email sent', { exact: true }).waitFor();
        assert.equal(messages.filter((to) => to === email).length, 1);
        await row.getByRole('button', { name: 'Revoke', exact: true }).click();
        await confirm();
        await row.getByText('revoked', { exact: true }).waitFor();
        await row.getByRole('button', { name: 'Resend', exact: true }).click();
        await confirm();
        await row.getByText('pending', { exact: true }).waitFor();
        assert.equal(messages.filter((to) => to === email).length, 2);
        await page
          .getByRole('button', { name: 'Activity', exact: true })
          .click();
        const activity = page.getByRole('list', { name: 'Admin activity' });
        await activity
          .getByRole('heading', { name: 'Issued invitation' })
          .first()
          .waitFor();
        assert.equal(await activity.getByText(admin.password).count(), 0);
      },
    );
    await t.test(
      'desktop light and phone dark fit the layout and confirmation dialogs retain keyboard access',
      async () => {
        await page.getByRole('button', { name: 'Users', exact: true }).click();
        await page
          .getByLabel('Search users', { exact: true })
          .fill(member.email);
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        await memberRow().waitFor();
        await page.locator('.settings-body').evaluate((node) => {
          node.scrollTop = 0;
        });
        await page.screenshot({
          path: '/tmp/spindle-admin-desktop-light.png',
          animations: 'disabled',
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.evaluate(() =>
          localStorage.setItem('spindle-theme', 'dark'),
        );
        await page.reload();
        await page
          .getByRole('heading', { name: 'Administration', exact: true })
          .waitFor();
        assert.equal(
          await page
            .locator('body')
            .evaluate((node) => node.scrollWidth <= innerWidth),
          true,
        );
        assert.equal(
          await page
            .locator('.settings-body')
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
          true,
        );
        await page.screenshot({
          path: '/tmp/spindle-admin-phone-dark.png',
          animations: 'disabled',
        });
        await page
          .getByLabel('Search users', { exact: true })
          .fill(member.email);
        await page.getByRole('button', { name: 'Search', exact: true }).click();
        const button = memberRow().getByRole('button', {
          name: 'Suspend',
          exact: true,
        });
        await button.click();
        await dialog
          .getByRole('button', { name: 'Confirm', exact: true })
          .waitFor();
        assert.equal(await dialog.locator('input[type="password"]').count(), 0);
        await page.screenshot({
          path: '/tmp/spindle-admin-confirm-phone-dark.png',
          animations: 'disabled',
        });
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        assert.equal(
          await button.evaluate((node) => node === document.activeElement),
          true,
        );
        assert.deepEqual(errors, []);
        assert.equal(unlockRequests.length, 2);
        assert.ok(
          mutationBodies.length > 1 &&
            mutationBodies.every((body) => !('currentPassword' in body)),
        );
      },
    );
    await t.test(
      'expired unlocks remove admin content and a fresh sign-in starts locked',
      async () => {
        await pool.query(
          "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
          [admin.id],
        );
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page
          .getByRole('heading', { name: 'Sign in', exact: true })
          .waitFor();
        assert.equal(
          await page.getByRole('list', { name: 'Users', exact: true }).count(),
          0,
        );
        await resetLimits();
        const signed = await context.request.post(
          `${config.appUrl}/api/auth/sign-in/email`,
          {
            headers: { origin: config.appUrl },
            data: { email: admin.email, password: admin.password },
          },
        );
        assert.equal(signed.status(), 200);
        await page.goto(`${config.appUrl}/inbox#view=settings`);
        await page
          .getByRole('heading', { name: 'Unlock administration', exact: true })
          .waitFor();
        assert.equal(
          await page.getByRole('list', { name: 'Users', exact: true }).count(),
          0,
        );
      },
    );
  } finally {
    await browser.close();
    await vite.close();
    await pool.query('DELETE FROM auth_rate_limits');
    await app.close();
  }
});
