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
import { parseMessage } from '../../server/src/mail/parse.js';
import { SANITIZER_VERSION } from '../../server/src/mail/sanitize.js';
import {
  createTestUser,
  testApp,
  testConfig,
} from '../../server/test/auth-fixture.js';
import {
  newsletterHtml,
  readerMail,
  tinyPng,
} from '../../server/test/reader-fixture.js';

test('conversation timeline preserves scoped navigation, reply identity, message actions and isolated content', {
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
  const contentConfig = readContentConfig(config, {});
  assert.ok(contentConfig);
  let imageCalls = 0;
  const contentApp = buildContentApp(pool, contentConfig, async () => {
    imageCalls++;
    return { type: 'image/png', data: tinyPng };
  });
  contentApp.log.level = 'silent';
  const contentAddress = await contentApp.listen({
    host: '127.0.0.1',
    port: 0,
  });
  contentConfig.origin = `http://localhost:${new URL(contentAddress).port}`;
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 64).toString('base64'),
    }),
  });
  const app = testApp(pool, config, undefined, keys, contentConfig);
  const owner = await createTestUser(
    app,
    pool,
    config,
    'conversation-browser@example.test',
  );
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { origin: config.appUrl, cookie: owner.cookie },
    payload: {
      name: 'Thread account',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: 'owner@example.test',
      password: 'synthetic-only-password',
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  async function box(path: string, role: string) {
    return (
      await pool.query(
        'INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,$3,$3,$4) RETURNING id',
        [owner.id, account, path, role],
      )
    ).rows[0].id as string;
  }
  const inbox = await box('INBOX', 'inbox'),
    sent = await box('Sent', '\\Sent'),
    archive = await box('Archive', '\\Archive');
  await box('Trash', '\\Trash');
  let uid = 0;
  async function mail(
    subject: string,
    key: string,
    parent: string | null,
    folder = inbox,
    seen = false,
  ) {
    const id = randomUUID(),
      mid = `<${key}@example.test>`;
    const source = readerMail(subject, newsletterHtml(uid), `Body ${key}`)
      .replace('<same-reader-id@example.test>', mid)
      .replace(
        'MIME-Version:',
        `${parent ? `In-Reply-To: ${parent}\r\nReferences: ${parent}\r\n` : ''}MIME-Version:`,
      );
    const parsed = await parseMessage(Buffer.from(source));
    await pool.query(
      'INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,message_id,in_reply_to,reference_ids,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,$7,$8,$9,$10)',
      [
        id,
        owner.id,
        account,
        subject,
        JSON.stringify(parsed.reply.from),
        JSON.stringify({ to: parsed.reply.to, cc: parsed.reply.cc }),
        mid,
        parent,
        parsed.reply.references,
        new Date(Date.UTC(2026, 9, 28, 12, 0, uid)),
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags) VALUES($1,$2,$3,$4,'1',$5,$6)",
      [owner.id, account, folder, id, ++uid, seen ? ['\\Seen'] : []],
    );
    await pool.query(
      "INSERT INTO mail_content(user_id,account_id,message_id,state,plain_text,html,resources,reply_metadata,sanitizer_version,byte_size) VALUES($1,$2,$3,'ready',$4,$5,$6,$7,$8,$9)",
      [
        owner.id,
        account,
        id,
        parsed.plain,
        parsed.html,
        JSON.stringify(parsed.resources),
        JSON.stringify(parsed.reply),
        SANITIZER_VERSION,
        parsed.bytes,
      ],
    );
    for (const image of parsed.images)
      await pool.query(
        'INSERT INTO mail_content_images(user_id,account_id,message_id,position,content_type,data) VALUES($1,$2,$3,$4,$5,$6)',
        [owner.id, account, id, image.position, image.type, image.data],
      );
    return id;
  }
  const root = await mail('Project original', 'root', null),
    child = await mail('Sent reply', 'sent', '<root@example.test>', sent, true),
    archived = await mail(
      'Archived response',
      'archived',
      '<sent@example.test>',
      archive,
    ),
    unrelated = await mail('Other message', 'other', null);
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
    page.setDefaultTimeout(12000);
    const errors: string[] = [];
    const contentRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => {
      if (
        /\/api\/mail\/messages\/[^/]+\/content$/.test(request.url()) &&
        request.method() === 'POST'
      )
        contentRequests.push(request.url());
    });
    const timeline = page.getByRole('region', {
      name: 'Conversation',
      exact: true,
    });
    const title = page.locator('#reader-title');
    const search = page.getByRole('searchbox', {
      name: 'Search mail',
      exact: true,
    });
    async function waitFor(check: () => Promise<boolean>) {
      const end = Date.now() + 12000;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.fail('Conversation did not reach expected state');
    }
    async function openRoot() {
      await page.goto(
        `${config.appUrl}/inbox#q=subject%3Aoriginal&message=${root}`,
      );
      await title.filter({ hasText: 'Project original' }).waitFor();
      await timeline.getByRole('listitem').first().waitFor();
    }
    await t.test(
      'related Sent/archive messages are chronological local context and bodies stay opt-in',
      async () => {
        await openRoot();
        assert.deepEqual(
          await timeline.getByRole('listitem').locator('a').allTextContents(),
          ['Project original', 'Sent reply', 'Archived response'],
        );
        assert.equal(
          await timeline
            .getByRole('link', { name: 'Other message', exact: true })
            .count(),
          0,
        );
        assert.equal(
          await timeline.getByText(/Outside current view/).count(),
          2,
        );
        assert.equal(imageCalls, 0);
        assert.deepEqual(contentRequests, []);
        const cached = Number(
          (
            await pool.query(
              'SELECT count(*) FROM mail_content WHERE user_id=$1',
              [owner.id],
            )
          ).rows[0].count,
        );
        assert.equal(cached, 4);
        await timeline
          .getByRole('link', { name: 'Sent reply', exact: true })
          .click();
        await title.filter({ hasText: 'Sent reply' }).waitFor();
        await page
          .getByRole('button', { name: 'Mark as unread', exact: true })
          .waitFor();
        assert.equal(
          new URLSearchParams(new URL(page.url()).hash.slice(1)).get(
            'conversation',
          ),
          root,
        );
        assert.equal(
          await timeline
            .getByRole('link', { name: 'Sent reply', exact: true })
            .getAttribute('aria-current'),
          'true',
        );
        await page.locator('iframe').waitFor();
        assert.equal(
          await page.locator('iframe').getAttribute('sandbox'),
          'allow-popups allow-popups-to-escape-sandbox',
        );
        assert.equal(
          await page.evaluate(
            () => !!(window as Window & { readerPwned?: boolean }).readerPwned,
          ),
          false,
        );
        await page
          .getByRole('button', { name: 'Display images', exact: true })
          .click();
        await waitFor(async () => imageCalls > 0);
        await timeline
          .getByRole('link', { name: 'Archived response', exact: true })
          .click();
        await title.filter({ hasText: 'Archived response' }).waitFor();
        await page
          .getByRole('button', { name: 'Display images', exact: true })
          .waitFor();
        await page.reload();
        await title.filter({ hasText: 'Archived response' }).waitFor();
        await waitFor(async () =>
          title.evaluate((node) => node === document.activeElement),
        );
        await page.keyboard.press('u');
        const rootLink = page.locator(
          `[data-message-row="${root}"] .message-open`,
        );
        await rootLink.waitFor();
        await waitFor(async () =>
          rootLink.evaluate((node) => node === document.activeElement),
        );
        assert.equal(await search.inputValue(), 'subject:original');
        assert.equal(await page.locator('[data-message-row]').count(), 1);
      },
    );
    await t.test(
      'SSE metadata updates preserve formatted-body image consent and input focus',
      async () => {
        await openRoot();
        await timeline
          .getByRole('link', { name: 'Sent reply', exact: true })
          .click();
        await title.filter({ hasText: 'Sent reply' }).waitFor();
        await page
          .getByRole('button', { name: 'Display images', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Hide images', exact: true })
          .waitFor();
        const source = await page.locator('iframe').getAttribute('src');
        await search.fill('unfinished query');
        await pool.query(
          'UPDATE mail_messages SET subject=$2 WHERE user_id=$1 AND id=$3',
          [owner.id, 'Sent reply updated', child],
        );
        await title.filter({ hasText: 'Sent reply updated' }).waitFor();
        assert.equal(await page.locator('iframe').getAttribute('src'), source);
        assert.equal(await search.inputValue(), 'unfinished query');
        assert.equal(
          await search.evaluate((node) => node === document.activeElement),
          true,
        );
        await page
          .getByRole('button', { name: 'Hide images', exact: true })
          .waitFor();
        await pool.query(
          'UPDATE mail_messages SET subject=$2 WHERE user_id=$1 AND id=$3',
          [owner.id, 'Sent reply', child],
        );
        await title.filter({ hasText: 'Sent reply' }).waitFor();
        await search.fill('subject:original');
      },
    );
    await t.test(
      'actions and reply headers belong to the opened member, and composer returns to its conversation',
      async () => {
        await openRoot();
        await timeline
          .getByRole('link', { name: 'Sent reply', exact: true })
          .click();
        await title.filter({ hasText: 'Sent reply' }).waitFor();
        await waitFor(async () =>
          title.evaluate((node) => node === document.activeElement),
        );
        await page.keyboard.press('m');
        await waitFor(
          async () =>
            !!(
              await pool.query(
                'SELECT 1 FROM mail_actions WHERE user_id=$1 AND message_id=$2 AND kind=$3',
                [owner.id, child, 'unread'],
              )
            ).rowCount,
        );
        assert.equal(
          Number(
            (
              await pool.query(
                'SELECT count(*) FROM mail_actions WHERE user_id=$1 AND message_id<>$2',
                [owner.id, child],
              )
            ).rows[0].count,
          ),
          0,
        );
        await page.keyboard.press('z');
        await waitFor(
          async () =>
            (
              await pool.query(
                'SELECT state FROM mail_actions WHERE user_id=$1 AND message_id=$2',
                [owner.id, child],
              )
            ).rows[0].state === 'cancelled',
        );
        await title.focus();
        await page.keyboard.press('r');
        await page
          .getByRole('textbox', { name: 'Message body', exact: true })
          .waitFor();
        const draftId = new URLSearchParams(
          new URL(page.url()).hash.slice(1),
        ).get('draft');
        assert.ok(draftId);
        const draft = (
          await pool.query(
            'SELECT account_id,reply_context FROM mail_drafts WHERE user_id=$1 AND id=$2',
            [owner.id, draftId],
          )
        ).rows[0];
        assert.equal(draft.account_id, account);
        assert.equal(draft.reply_context.sourceMessageId, child);
        assert.equal(draft.reply_context.inReplyTo, '<sent@example.test>');
        await page
          .getByRole('link', { name: 'Back to original message', exact: true })
          .click();
        await title.filter({ hasText: 'Sent reply' }).waitFor();
        assert.equal(await search.inputValue(), 'subject:original');
        await timeline
          .getByRole('link', { name: 'Archived response', exact: true })
          .waitFor();
      },
    );
    await t.test(
      'older pages and delayed timeline responses preserve the current reader and keyboard result navigation',
      async () => {
        for (let i = 0; i < 51; i++)
          await mail(
            `Older ${i}`,
            `older${i}`,
            '<root@example.test>',
            archive,
            true,
          );
        await openRoot();
        await page
          .getByRole('button', {
            name: 'Show earlier conversation messages',
            exact: true,
          })
          .click();
        await timeline
          .getByRole('link', { name: 'Project original', exact: true })
          .waitFor();
        assert.equal(await timeline.getByRole('listitem').count(), 54);
        await timeline
          .getByRole('link', { name: 'Project original', exact: true })
          .click();
        await title.filter({ hasText: 'Project original' }).waitFor();
        await timeline
          .getByRole('link', { name: 'Sent reply', exact: true })
          .click();
        await title.filter({ hasText: 'Sent reply' }).waitFor();
        assert.equal(await timeline.getByRole('listitem').count(), 54);
        let release = () => {},
          started = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
          }),
          pending = new Promise<void>((resolve) => {
            started = resolve;
          });
        await page.route(
          '**/api/mail/messages/*/conversation?**',
          async (route) => {
            if (!route.request().url().includes(root)) return route.continue();
            const response = await route.fetch();
            started();
            await gate;
            await route.fulfill({ response }).catch(() => {});
          },
        );
        await page.goto(`${config.appUrl}/inbox#message=${root}`);
        await pending;
        await search.fill('subject:other');
        await search.press('Enter');
        await page
          .locator(`[data-message-row="${unrelated}"] .message-open`)
          .click();
        await title.filter({ hasText: 'Other message' }).waitFor();
        release();
        await page.unrouteAll({ behavior: 'wait' });
        await timeline
          .getByRole('link', { name: 'Other message', exact: true })
          .waitFor();
        assert.equal(
          await timeline
            .getByRole('link', { name: 'Sent reply', exact: true })
            .count(),
          0,
        );
        await page.setViewportSize({ width: 390, height: 844 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
          true,
        );
      },
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(contentRequests, []);
    assert.ok(archived);
  } finally {
    await browser?.close();
    await vite.close();
    await contentApp.close();
    await app.close();
  }
});
