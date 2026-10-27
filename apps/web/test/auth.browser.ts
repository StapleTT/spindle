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
import { testApp, testConfig } from '../../server/test/auth-fixture.js';

test('browser signup, verification, sessions, recovery and phone layout', {
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
  await pool.query(
    "INSERT INTO invites(email, expires_at) VALUES ('browser@example.test', now()+interval '1 day')",
  );
  const messages: { subject: string; text: string }[] = [];
  const mailer = nodemailer.createTransport({ jsonTransport: true });
  t.mock.method(mailer, 'sendMail', async (options: SendMailOptions) => {
    messages.push({
      subject: String(options.subject),
      text: String(options.text),
    });
    return { messageId: 'test' };
  });
  const app = testApp(pool, config, mailer);
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
  try {
    await vite.listen();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    const password = 'browser test long password 123!';
    const changed = 'browser changed long password 456!';
    const heading = (name: string) =>
      page.getByRole('heading', { name, exact: true }).waitFor();
    const click = (name: string) =>
      page.getByRole('button', { name, exact: true }).click();
    const link = (subject: string) => {
      const message = messages.findLast((item) =>
        item.subject.includes(subject),
      );
      assert.ok(message);
      const value = message.text.match(/https?:\/\/\S+/)?.[0];
      assert.ok(value);
      return value;
    };

    await page.goto(config.appUrl);
    await heading('Sign in');
    await click('Create an account');
    await page.getByLabel('Email address').fill('browser@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm password').fill(password);
    await click('Create your account');
    await heading('Sign in');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await click('Sign in');
    await page.getByRole('alert').waitFor();
    assert.match(
      (await page.getByRole('alert').textContent()) ?? '',
      /Verify your email/,
    );
    await click('Resend verification email');
    await page
      .getByRole('status')
      .filter({ hasText: 'new email has been sent' })
      .waitFor();
    await page.goto(link('Verify'));
    await heading('Sign in');
    await page
      .getByRole('status')
      .filter({ hasText: 'Email verified' })
      .waitFor();
    await page.getByLabel('Email address').fill('browser@example.test');
    await page.getByLabel('Password', { exact: true }).fill(password);
    await click('Sign in');
    await heading('You’re signed in');
    assert.equal(
      (await page.request.get(`${config.appUrl}/api/me`)).status(),
      200,
    );
    await page.reload();
    await heading('You’re signed in');

    const recoveryContext = await browser.newContext();
    const recovery = await recoveryContext.newPage();
    await recovery.goto(config.appUrl);
    await recovery.getByRole('button', { name: 'Forgot password?' }).click();
    await recovery.getByLabel('Email address').fill('browser@example.test');
    await recovery.getByRole('button', { name: 'Send reset link' }).click();
    await recovery
      .getByRole('status')
      .filter({ hasText: 'If an account exists' })
      .waitFor();
    await recovery.goto(link('Reset'));
    await recovery
      .getByRole('heading', { name: 'Choose a new password' })
      .waitFor();
    assert.ok(!recovery.url().includes('token='));
    await recovery.getByLabel('Password', { exact: true }).fill(changed);
    await recovery.getByLabel('Confirm password').fill(changed);
    await recovery.getByRole('button', { name: 'Update password' }).click();
    await recovery
      .getByRole('heading', { name: 'Sign in', exact: true })
      .waitFor();
    await page.reload();
    await heading('Sign in');
    assert.equal(
      (await page.request.get(`${config.appUrl}/api/me`)).status(),
      401,
    );
    await page.getByLabel('Email address').fill('browser@example.test');
    await page.getByLabel('Password', { exact: true }).fill(changed);
    await click('Sign in');
    await heading('You’re signed in');
    await click('Sign out');
    await heading('Sign in');
    await page.setViewportSize({ width: 375, height: 812 });
    await click('Create an account');
    await heading('Create your account');
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
