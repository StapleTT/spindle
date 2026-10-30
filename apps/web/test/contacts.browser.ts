import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { chromium, type Route } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';

test('recipient suggestions select only the active address, preserve autosave and reject stale lookups', {
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
    pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  const app = testApp(
    pool,
    config,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 80).toString('base64'),
      }),
    }),
  );
  const owner = await createTestUser(
      app,
      pool,
      config,
      'contact-browser@example.test',
      '203.0.113.230',
    ),
    other = await createTestUser(
      app,
      pool,
      config,
      'contact-stranger@example.test',
      '203.0.113.230',
    );
  async function seed(user = owner) {
    const connected = await app.inject({
      method: 'POST',
      url: '/api/mail/accounts',
      headers: { cookie: user.cookie, origin: config.appUrl },
      payload: {
        name: 'Suggestions account',
        host: 'mail.example.test',
        port: 993,
        transport: 'tls',
        username: user.email,
        password: 'synthetic-only-password',
        history: 'all',
      },
    });
    assert.equal(connected.statusCode, 202, connected.body);
    const account = connected.json().account.id;
    const box = (
      await pool.query(
        "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
        [user.id, account],
      )
    ).rows[0].id;
    return { user, account, box };
  }
  const own = await seed(),
    foreign = await seed(other);
  let uid = 0;
  async function person(name: string, email: string, scope = own) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at) VALUES($1::uuid,$2,$3,$1::text,'Synthetic contacts',$4,$5,clock_timestamp())",
      [
        id,
        scope.user.id,
        scope.account,
        JSON.stringify([{ name, address: email }]),
        JSON.stringify({
          to: [],
          cc: [],
          bcc: [
            { name: 'Hidden private', address: 'private-bcc@example.test' },
          ],
        }),
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',$5)",
      [scope.user.id, scope.account, scope.box, id, ++uid],
    );
  }
  await person('Doe, Jane "Support"', 'jane@example.test');
  await person('Jane Work', 'jane+work@example.test');
  await person('Bob Contact', 'bob@example.test');
  await person('<img src=x> Mallory', 'mallory@example.test');
  await person('Foreign Jane', 'foreign-jane@example.test', foreign);
  const api = await app.listen({ host: '127.0.0.1', port: 0 }),
    vite = await createServer({
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
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (dialog) => void dialog.accept());
    await page.goto(config.appUrl);
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await page
      .getByRole('button', { name: 'Add Cc recipients', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Add Bcc recipients', exact: true })
      .click();
    const to = page.getByRole('combobox', { name: 'To', exact: true }),
      cc = page.getByRole('combobox', { name: 'Cc', exact: true }),
      bcc = page.getByRole('combobox', { name: 'Bcc', exact: true });
    await to.waitFor();
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
      'draft',
    );
    assert.ok(id);
    const options = () => page.getByRole('option');
    const saved = async () =>
      (await pool.query('SELECT content FROM mail_drafts WHERE id=$1', [id]))
        .rows[0].content;
    const waitFor = async (check: () => Promise<boolean>) => {
      const end = Date.now() + 10000;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('Contact browser state did not arrive');
    };
    await t.test(
      'keyboard selection quotes names safely, keeps existing recipients, excludes foreign/Bcc sources and autosaves',
      async () => {
        await to.fill('existing@example.test, jane');
        await page
          .getByRole('listbox', { name: 'To recipient suggestions' })
          .waitFor();
        assert.equal(
          await options()
            .filter({ hasText: 'foreign-jane@example.test' })
            .count(),
          0,
        );
        await to.press('ArrowDown');
        assert.ok(await to.getAttribute('aria-activedescendant'));
        await to.press('Enter');
        assert.match(await to.inputValue(), /^existing@example\.test, "/);
        assert.match(
          await to.inputValue(),
          /jane(?:\+work)?@example\.test>, $/,
        );
        await page
          .getByLabel('Subject', { exact: true })
          .fill('Autocomplete autosave');
        await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
        assert.equal((await saved()).to, await to.inputValue());
        await bcc.fill('private-bcc');
        await waitFor(
          async () =>
            (await page
              .getByText('No matching recipients.', { exact: true })
              .count()) === 1,
        );
        assert.equal(await page.getByRole('listbox').count(), 0);
      },
    );
    await t.test(
      'pointer selection replaces a middle quoted token without changing the following recipient or Bcc',
      async () => {
        await bcc.fill('manual-private@example.test');
        const value =
          'existing@example.test, "Doe, Jane" <ja>, following@example.test';
        await to.fill(value);
        await to.press('Home');
        for (let i = 0; i < value.indexOf('<ja') + 3; i++)
          await to.press('ArrowRight');
        const list = page.getByRole('listbox', {
          name: 'To recipient suggestions',
        });
        await list.waitFor();
        await list
          .getByRole('option')
          .filter({ hasText: 'jane@example.test' })
          .click();
        assert.match(
          await to.inputValue(),
          /^existing@example\.test, "Doe, Jane/,
        );
        assert.match(await to.inputValue(), /, following@example\.test$/);
        assert.equal(await bcc.inputValue(), 'manual-private@example.test');
        await cc.fill('jane');
        await page
          .getByRole('listbox', { name: 'Cc recipient suggestions' })
          .waitFor();
        assert.equal(
          await page
            .getByRole('option')
            .filter({ hasText: 'jane@example.test' })
            .count(),
          0,
        );
        assert.equal(
          await page
            .getByRole('option')
            .filter({ hasText: 'jane+work@example.test' })
            .count(),
          1,
        );
        await cc.press('Escape');
        assert.equal(await cc.getAttribute('aria-expanded'), 'false');
        await cc.fill('jane');
        await cc.press('Tab');
        assert.equal(await cc.inputValue(), 'jane');
      },
    );
    await t.test(
      'stale responses, IME composition, unsafe names and lookup failure cannot replace user text or trigger sends',
      async () => {
        let release!: () => void, saw!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
          }),
          started = new Promise<void>((resolve) => {
            saw = resolve;
          });
        const delay = async (route: Route) => {
          if (new URL(route.request().url()).searchParams.get('q') === 'bo') {
            const response = await route.fetch();
            saw();
            await held;
            await route.fulfill({ response }).catch(() => {});
          } else await route.continue();
        };
        await page.route('**/api/mail/contacts?*', delay);
        await cc.fill('bo');
        await started;
        await cc.fill('mall');
        await page
          .getByRole('option')
          .filter({ hasText: 'mallory@example.test' })
          .waitFor();
        release();
        await page.waitForTimeout(200);
        assert.equal(await cc.inputValue(), 'mall');
        assert.equal(
          await page
            .getByRole('option')
            .filter({ hasText: 'bob@example.test' })
            .count(),
          0,
        );
        assert.equal(
          await page.locator('.recipient-suggestions img').count(),
          0,
        );
        await page.unroute('**/api/mail/contacts?*', delay);
        await cc.dispatchEvent('compositionstart');
        await cc.fill('bob');
        await page.waitForTimeout(400);
        assert.equal(await page.getByRole('listbox').count(), 0);
        await cc.dispatchEvent('compositionend');
        await page
          .getByRole('option')
          .filter({ hasText: 'bob@example.test' })
          .waitFor();
        await page.route('**/api/mail/contacts?*', (route) => route.abort());
        await cc.fill('unavailable');
        await page
          .getByText(
            'Suggestions unavailable. You can still type an address.',
            { exact: true },
          )
          .waitFor();
        await cc.fill('manual@example.test');
        await page.getByLabel('Subject', { exact: true }).focus();
        await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
        assert.equal((await saved()).cc, 'manual@example.test');
        await page.reload();
        await to.waitFor();
        assert.match(await to.inputValue(), /following@example\.test$/);
        assert.equal(await cc.inputValue(), 'manual@example.test');
        assert.deepEqual(errors, []);
      },
    );
    await t.test(
      'Bcc selection remains private and committed source deletion refreshes an open suggestion list',
      async () => {
        await page.unroute('**/api/mail/contacts?*');
        await bcc.fill('bob');
        await page
          .getByRole('listbox', { name: 'Bcc recipient suggestions' })
          .waitFor();
        await bcc.press('ArrowDown');
        await bcc.press('Enter');
        assert.match(await bcc.inputValue(), /bob@example\.test/);
        assert.ok(!(await to.inputValue()).includes('bob@example.test'));
        await cc.fill('mall');
        await page
          .getByRole('option')
          .filter({ hasText: 'mallory@example.test' })
          .waitFor();
        await pool.query(
          'DELETE FROM mail_messages WHERE user_id=$1 AND sender @> $2::jsonb',
          [owner.id, JSON.stringify([{ address: 'mallory@example.test' }])],
        );
        await page
          .getByText('No matching recipients.', { exact: true })
          .waitFor();
        assert.equal(
          await page
            .getByRole('option')
            .filter({ hasText: 'mallory@example.test' })
            .count(),
          0,
        );
        await page.getByLabel('Subject', { exact: true }).focus();
        await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
        assert.match((await saved()).bcc, /bob@example\.test/);
      },
    );
    await t.test(
      'choosing a suggestion cannot overflow the recipient field or discard existing text',
      async () => {
        const value = `${'x'.repeat(3994)}, ja`;
        await to.fill(value);
        await page
          .getByRole('listbox', { name: 'To recipient suggestions' })
          .waitFor();
        await page
          .getByRole('option')
          .filter({ hasText: 'jane@example.test' })
          .click();
        await page
          .getByRole('alert')
          .filter({ hasText: 'exceed the field limit' })
          .waitFor();
        assert.equal(await to.inputValue(), value);
        assert.deepEqual(errors, []);
      },
    );
  } finally {
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
