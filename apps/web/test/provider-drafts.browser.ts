import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { Pool } from 'pg';
import { chromium, type Page, type Route } from 'playwright';
import { createServer } from 'vite';
import { migrateDatabase } from '../../server/src/db/migrate.js';
import { readMailKeys } from '../../server/src/mail/credentials.js';
import { connectImap } from '../../server/src/mail/imap.js';
import { syncProviderDrafts } from '../../server/src/mail/provider-drafts.js';
import { syncAccount } from '../../server/src/mail/sync.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import {
  imapFixture,
  imapPassword,
  rawMail,
} from '../../server/test/imap-fixture.js';

test('provider drafts show status, reconcile clean editors, preserve recovery and expose cleanup conflicts', {
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
    'provider-browser@example.test',
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
  const native = imap.server.control.addMessage('Drafts', {
    raw: rawMail('Native provider draft', 'editable-native@example.test'),
    flags: ['\\Draft'],
    internaldate: new Date(),
  });
  await pool.query(
    'UPDATE mailboxes SET last_synced_at=NULL WHERE account_id=$1',
    [account],
  );
  await syncAccount(pool, keys, owner.id, account);
  const folder = (
    await pool.query(
      "SELECT uid_validity FROM mailboxes WHERE account_id=$1 AND role='\\Drafts'",
      [account],
    )
  ).rows[0];
  await pool.query(
    'INSERT INTO mail_draft_imports(user_id,account_id,path,uid_validity,uid) VALUES($1,$2,$3,$4,$5)',
    [
      owner.id,
      account,
      'Drafts',
      String(folder.uid_validity),
      String(native.uid),
    ],
  );
  await syncProviderDrafts(pool, keys, owner.id, account);
  await pool.query(
    'INSERT INTO mail_drafts(id,user_id,content) VALUES($1,$2,$3)',
    [
      randomUUID(),
      owner.id,
      {
        to: '',
        cc: '',
        bcc: '',
        subject: 'Unassigned local draft',
        format: 'plain',
        text: 'Local text',
        html: '',
      },
    ],
  );
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
  let releasePoll = () => {};
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
    await page.goto(config.appUrl);
    await page
      .getByRole('heading', { name: 'All inboxes', exact: true })
      .waitFor();
    await page.getByRole('button', { name: /^Drafts / }).click();
    await page
      .getByRole('heading', { name: 'Local drafts', exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole('link', { name: 'Unassigned local draft', exact: true })
        .count(),
      0,
    );
    await page
      .getByRole('link', { name: 'Native provider draft', exact: true })
      .click();
    await page
      .getByLabel('Subject', { exact: true })
      .fill('Edited provider draft in composer');
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await pool.query(
      'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp()',
    );
    await syncProviderDrafts(pool, keys, owner.id, account);
    assert.equal(imap.server.control.listMessages('Drafts').length, 1);
    const savedNative = imap.server.control.listMessages('Drafts')[0];
    assert.ok(savedNative);
    const edited = imap.server.control.getMessage(
      'Drafts',
      savedNative.uid,
    ).raw;
    assert.ok(edited);
    assert.match(
      edited.toString(),
      /Subject: Edited provider draft in composer/,
    );
    await page
      .locator('.composer')
      .getByText('Saved to provider Drafts.', { exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'Discard draft', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm discard draft', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Local drafts', exact: true })
      .waitFor();
    await pool.query(
      'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp()',
    );
    await syncProviderDrafts(pool, keys, owner.id, account);
    assert.equal(imap.server.control.listMessages('Drafts').length, 0);
    await page.getByRole('button', { name: 'Drafts', exact: true }).click();
    await page
      .getByRole('link', { name: 'Unassigned local draft', exact: true })
      .waitFor();
    await page
      .getByRole('button', { name: 'All inboxes', exact: true })
      .click();
    await page.getByRole('button', { name: 'Compose', exact: true }).click();
    await page
      .getByRole('heading', { name: 'New message', exact: true })
      .waitFor();
    const id = new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
      'draft',
    );
    assert.ok(id);
    const subject = page.getByLabel('Subject', { exact: true });
    async function waitFor(check: () => Promise<boolean>) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail('Expected draft state was not reached');
    }
    const stored = async () =>
      (await pool.query('SELECT * FROM mail_drafts WHERE id=$1', [id])).rows[0];
    async function sync() {
      await pool.query(
        'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
        [owner.id],
      );
      await syncProviderDrafts(pool, keys, owner.id, account);
    }
    async function native(subject: string) {
      const copy = (
        await pool.query(
          'SELECT c.* FROM mail_draft_copies c JOIN mail_draft_links l ON l.active_copy_id=c.id WHERE l.source_draft_id=$1',
          [id],
        )
      ).rows[0];
      const raw = imap.server.control.getMessage(
        'Drafts',
        Number(copy.uid),
      ).raw;
      assert.ok(raw);
      imap.server.control.expungeMessages('Drafts', [Number(copy.uid)]);
      imap.server.control.addMessage('Drafts', {
        raw: raw.toString().replace(/^Subject:.*$/m, `Subject: ${subject}\r`),
        flags: ['\\Draft'],
      });
    }
    await subject.fill('Browser provider draft');
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await sync();
    await page
      .locator('.composer')
      .getByText('Saved to provider Drafts.', { exact: true })
      .waitFor();
    // A provider-added header must not make this tab's next autosave stale.
    await subject.fill('Typing before provider normalization');
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    const beforeEcho = (await stored()).revision;
    await pool.query(
      'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
      [owner.id],
    );
    await syncProviderDrafts(pool, keys, owner.id, account, async (...args) => {
      const client = await connectImap(...args),
        append = client.append.bind(client);
      client.append = async (...values) => {
        values[1] = Buffer.from(
          values[1]
            .toString()
            .replace('\r\n\r\n', '\r\nX-Provider-Normalized: browser\r\n\r\n'),
        );
        return append(...values);
      };
      return client;
    });
    assert.equal((await stored()).revision, beforeEcho);
    await subject.fill('Typing after provider normalization');
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    assert.equal(
      (await stored()).content.subject,
      'Typing after provider normalization',
    );
    assert.equal(
      await page
        .getByText('Draft conflict. Your edits are preserved.', { exact: true })
        .count(),
      0,
    );
    // A delayed poll from before a successful save must not roll the editor back.
    let sawPoll = () => {};
    const started = new Promise<void>((resolve) => {
      sawPoll = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let holdNext = true;
    const delayPoll = async (route: Route) => {
      if (holdNext && route.request().method() === 'GET') {
        holdNext = false;
        const response = await route.fetch();
        sawPoll();
        await held;
        await route.fulfill({ response });
      } else await route.continue();
    };
    await page.route(`**/api/mail/drafts/${id}`, delayPoll);
    await started;
    await subject.fill('Saved while an earlier poll was in flight');
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    releasePoll();
    await page.waitForTimeout(500);
    assert.equal(
      await subject.inputValue(),
      'Saved while an earlier poll was in flight',
    );
    await page.unroute(`**/api/mail/drafts/${id}`, delayPoll);
    await sync();
    await native('Changed in native client');
    await sync();
    await waitFor(
      async () => (await subject.inputValue()) === 'Changed in native client',
    );

    // Provider updates cannot replace unsaved edits or an unacknowledged save.
    const blockWrites = async (route: Route) =>
      route.request().method() === 'PUT' ? route.abort() : route.continue();
    await page.route('**/api/mail/drafts/**', blockWrites);
    await subject.fill('Unsaved browser recovery');
    await page
      .getByText('Draft not saved. Retrying automatically.', { exact: true })
      .waitFor();
    await native('New native work');
    await sync();
    await page.waitForTimeout(5500);
    assert.equal(await subject.inputValue(), 'Unsaved browser recovery');
    await page.unroute('**/api/mail/drafts/**', blockWrites);
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await page
      .getByText('Draft conflict. Your edits are preserved.', { exact: true })
      .waitFor();
    await page.reload();
    await subject.waitFor();
    assert.equal(await subject.inputValue(), 'Unsaved browser recovery');
    await page
      .getByRole('button', { name: 'Discard my edits and load saved version' })
      .click();
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    assert.equal(await subject.inputValue(), 'New native work');

    await subject.fill('Local conflicting work');
    await page.getByText('Saved to Spindle.', { exact: true }).waitFor();
    await native('Other client conflicting work');
    await sync();
    await page
      .locator('.composer')
      .getByText(
        'Provider draft conflict. Both versions are preserved for review.',
        { exact: true },
      )
      .waitFor();
    await page
      .getByRole('button', { name: 'Compare provider version' })
      .click();
    await page
      .getByText('Provider version: Other client conflicting work', {
        exact: true,
      })
      .waitFor();
    await page
      .getByRole('button', { name: 'Keep local as a separate provider draft' })
      .click();
    await waitFor(
      async () =>
        !(
          await pool.query(
            "SELECT 1 FROM mail_draft_links WHERE source_draft_id=$1 AND state='conflict'",
            [id],
          )
        ).rowCount,
    );
    await sync();
    await page
      .locator('.composer')
      .getByText('Saved to provider Drafts.', { exact: true })
      .waitFor();
    assert.equal(imap.server.control.listMessages('Drafts').length, 2);
    assert.equal((await stored()).content.subject, 'Local conflicting work');

    // Explicit recovery of a removed copy resumes synchronization without touching retained versions.
    const removed = (
      await pool.query(
        'SELECT c.uid FROM mail_draft_copies c JOIN mail_draft_links l ON l.active_copy_id=c.id WHERE l.source_draft_id=$1',
        [id],
      )
    ).rows[0];
    imap.server.control.expungeMessages('Drafts', [Number(removed.uid)]);
    await sync();
    await page
      .getByRole('button', {
        name: 'Save to provider Drafts again',
        exact: true,
      })
      .click();
    await waitFor(
      async () =>
        !(
          await pool.query(
            "SELECT 1 FROM mail_draft_links WHERE source_draft_id=$1 AND state='conflict'",
            [id],
          )
        ).rowCount,
    );
    await sync();
    await page
      .locator('.composer')
      .getByText('Saved to provider Drafts.', { exact: true })
      .waitFor();
    assert.equal(imap.server.control.listMessages('Drafts').length, 2);
    // A failed cleanup remains visible after navigating away from its deleted draft.
    await native('Native change before discard');
    await page
      .getByRole('button', { name: 'Discard draft', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm discard draft', exact: true })
      .click();
    await page
      .getByRole('heading', { name: 'Local drafts', exact: true })
      .waitFor();
    await sync();
    await page.reload();
    await page
      .getByRole('heading', { name: 'Provider Drafts needs attention' })
      .waitFor();
    await page
      .getByRole('button', { name: 'Leave original provider copy' })
      .click();
    await waitFor(
      async () =>
        (await page
          .getByRole('heading', { name: 'Provider Drafts needs attention' })
          .count()) === 0,
    );
    assert.equal(imap.server.control.listMessages('Drafts').length, 2);
    assert.deepEqual(errors, []);
  } finally {
    releasePoll();
    await browser?.close();
    await vite.close();
    await app.close();
  }
});
