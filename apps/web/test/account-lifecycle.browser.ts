import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import react from '@vitejs/plugin-react';
import nodemailer from 'nodemailer';
import { Pool } from 'pg';
import { type BrowserContext, chromium } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('security activity, data export, scheduled deletion with sign-in cancellation and admin deletion', {
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
  const app = testApp(
    pool,
    config,
    nodemailer.createTransport({ jsonTransport: true }),
  );
  const owner = await createTestUser(
    app,
    pool,
    config,
    'lifecycle-browser@example.test',
  );
  const admin = await createTestUser(
    app,
    pool,
    config,
    'lifecycle-browser-admin@example.test',
    '203.0.113.213',
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
  const signedIn = async (cookie: string) => {
    const context: BrowserContext = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
    });
    await context.addCookies(
      cookie.split('; ').map((item) => {
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
    return page;
  };
  try {
    await vite.listen();
    const page = await signedIn(owner.cookie);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${config.appUrl}/inbox#view=settings`);
    await page.getByRole('button', { name: 'Security', exact: true }).click();

    await t.test('security activity lists own sign-ins', async () => {
      const activity = page.getByRole('list', { name: 'Security activity' });
      await activity.getByText('Signed in', { exact: true }).first().waitFor();
      await activity.getByText('Account created', { exact: true }).waitFor();
    });

    await t.test('export downloads a gzipped JSON file', async () => {
      const section = page.locator('section[aria-labelledby="export-title"]');
      await section.getByLabel('Current password').fill('wrong password');
      await section.getByRole('button', { name: 'Download export' }).click();
      await section
        .getByRole('alert')
        .getByText('Your current password is incorrect.')
        .waitFor();
      await section.getByLabel('Current password').fill(owner.password);
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        section.getByRole('button', { name: 'Download export' }).click(),
      ]);
      assert.match(
        download.suggestedFilename(),
        /^spindle-export-\d{4}-\d{2}-\d{2}\.json\.gz$/,
      );
      const path = await download.path();
      const data = JSON.parse(gunzipSync(await readFile(path)).toString());
      assert.equal(data.profile.email, owner.email);
      await section.getByText('Export downloaded.').waitFor();
      await page
        .getByRole('list', { name: 'Security activity' })
        .getByText('Data export downloaded')
        .waitFor();
    });

    await t.test(
      'deletion requires typed confirmation and is cancelled by signing in',
      async () => {
        const section = page.locator('section[aria-labelledby="delete-title"]');
        await section.getByLabel('Current password').fill(owner.password);
        await section.getByLabel('Type DELETE to confirm').fill('delete');
        await section
          .getByRole('button', { name: 'Schedule account deletion' })
          .click();
        assert.equal(
          (
            await pool.query('SELECT deletion_due_at FROM users WHERE id=$1', [
              owner.id,
            ])
          ).rows[0].deletion_due_at,
          null,
        );
        await section.getByLabel('Type DELETE to confirm').fill('DELETE');
        await section
          .getByRole('button', { name: 'Schedule account deletion' })
          .click();
        await page.waitForURL(/\/login/);
        await page.getByText(/scheduled for deletion in seven days/).waitFor();
        await page.getByLabel('Email address').fill(owner.email);
        await page.getByLabel('Password', { exact: true }).fill(owner.password);
        await page
          .getByRole('button', { name: 'Sign in', exact: true })
          .click();
        await page
          .getByRole('alert')
          .getByText(/scheduled for deletion. Cancel/)
          .waitFor();
        await page
          .getByRole('button', { name: 'Cancel deletion and sign in' })
          .click();
        await page.waitForURL(/\/inbox/);
        assert.deepEqual(
          (
            await pool.query(
              'SELECT suspended,deletion_due_at FROM users WHERE id=$1',
              [owner.id],
            )
          ).rows[0],
          { suspended: false, deletion_due_at: null },
        );
      },
    );

    await t.test('administrators delete suspended users', async () => {
      await pool.query('UPDATE users SET suspended=true WHERE id=$1', [
        owner.id,
      ]);
      const adminPage = await signedIn(admin.cookie);
      await adminPage.goto(`${config.appUrl}/inbox#view=settings`);
      await adminPage
        .getByRole('button', { name: 'Admin', exact: true })
        .click();
      await adminPage
        .getByLabel('Current password', { exact: true })
        .fill(admin.password);
      await adminPage
        .getByRole('button', { name: 'Unlock administration', exact: true })
        .click();
      const row = adminPage
        .getByRole('list', { name: 'Users', exact: true })
        .getByRole('listitem')
        .filter({ hasText: owner.email });
      await row.getByRole('button', { name: 'Delete', exact: true }).click();
      const dialog = adminPage.getByRole('dialog');
      await dialog.getByText(/cannot be undone/).waitFor();
      await dialog
        .getByRole('button', { name: 'Confirm', exact: true })
        .click();
      await adminPage.getByText('Change saved.').waitFor();
      assert.equal(
        (await pool.query('SELECT 1 FROM users WHERE id=$1', [owner.id]))
          .rowCount,
        0,
      );
      await adminPage
        .getByRole('navigation', { name: 'Administration sections' })
        .getByRole('button', { name: 'Sign-ins', exact: true })
        .click();
      await adminPage
        .getByRole('list', { name: 'Sign-in and account events' })
        .getByText('Account deleted', { exact: true })
        .waitFor();
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await vite.close();
    await app.close();
  }
});
