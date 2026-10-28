import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { fetchMessageContent } from '../src/mail/content-worker.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { outgoingMessage } from '../src/mail/outgoing-message.js';
import { syncProviderDrafts } from '../src/mail/provider-drafts.js';
import { syncAccount } from '../src/mail/sync.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword } from './imap-fixture.js';
import { replyMail } from './reply-fixture.js';

test('private account signatures and one-time response insertion', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 45000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 58).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'signature-owner@example.test',
    '203.0.113.218',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'signature-admin@example.test',
    '203.0.113.218',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const imap = await imapFixture(t, true, true, ['UIDPLUS'], false, true);
  const request = (
    path: string,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) =>
    app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { cookie, origin },
      ...(payload ? { payload } : {}),
    });
  const createAccount = async (username = 'testuser') => {
    const response = await request('accounts', 'POST', {
      name: username,
      host: 'localhost',
      port: imap.port,
      transport: 'tls',
      username,
      password: imapPassword,
      history: 'all',
    });
    assert.equal(response.statusCode, 202, response.body);
    return response.json().account.id as string;
  };
  const account = await createAccount(),
    second = await createAccount('other@example.test');
  const path = `accounts/${account}/signature`;
  const settings = {
    html: '<p>Regards,<br /><strong>Writer café</strong></p>',
    newMessages: true,
    repliesForwards: true,
    revision: 0,
  };
  const saveSettings = (
    patch = {},
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) => request(path, 'PUT', { ...settings, ...patch }, cookie, origin);
  const loaded = async (id: string) =>
    (await request(`drafts/${id}`)).json().draft;
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_request_limits');
  });
  await t.test(
    'verified private ownership and exact origins protect both content and defaults',
    async () => {
      assert.equal((await request(path, 'GET', undefined, '')).statusCode, 401);
      assert.equal(
        (await request(path, 'GET', undefined, other.cookie)).statusCode,
        404,
      );
      assert.equal((await saveSettings({}, other.cookie)).statusCode, 404);
      assert.equal(
        (await saveSettings({}, owner.cookie, 'https://evil.test')).statusCode,
        403,
      );
      const defaults = (await request(path)).json().signature;
      assert.equal(defaults.revision, 0);
      assert.equal(defaults.html, '');
      const saved = await saveSettings();
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().signature.text, 'Regards,\nWriter café');
      const accounts = (await request('accounts')).json().accounts;
      assert.equal(
        accounts.find((a: { id: string }) => a.id === account).signature
          .revision,
        1,
      );
      assert.equal(
        accounts.find((a: { id: string }) => a.id === second).signature,
        null,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        other.id,
      ]);
      assert.equal(
        (await request(path, 'GET', undefined, other.cookie)).statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        other.id,
      ]);
    },
  );
  await t.test(
    'sanitization, NUL/size denial and stale settings saves preserve the current version',
    async () => {
      const saved = await saveSettings({
        revision: 1,
        html: '<script>bad()</script><img src="https://track.test"><p onclick="bad()" style="color:red">Safe <a href="javascript:bad()">link</a><a href="https://example.test">site</a></p>',
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.doesNotMatch(
        saved.json().signature.html,
        /script|img|onclick|style|javascript/,
      );
      assert.equal(
        (await saveSettings({ revision: 1, html: 'Stale' })).statusCode,
        409,
      );
      assert.equal(
        (await saveSettings({ revision: 2, html: 'Bad\0value' })).statusCode,
        400,
      );
      assert.equal(
        (await saveSettings({ revision: 2, html: 'x'.repeat(10001) }))
          .statusCode,
        400,
      );
      assert.equal((await request(path)).json().signature.revision, 2);
      const reset = await saveSettings({ revision: 2 });
      assert.equal(reset.statusCode, 200, reset.body);
    },
  );
  imap.server.control.addMessage('INBOX', {
    raw: replyMail({ htmlOnly: true }),
    flags: [],
    internaldate: new Date(),
  });
  await syncAccount(pool, keys, owner.id, account);
  const source = (await request('messages')).json().messages[0].id;
  const queued = await request(`messages/${source}/content`, 'POST', {});
  assert.equal(queued.statusCode, 202, queued.body);
  const version = (
    await pool.query('SELECT version FROM mail_content WHERE message_id=$1', [
      source,
    ])
  ).rows[0].version;
  await fetchMessageContent(pool, keys, {
    userId: owner.id,
    accountId: account,
    messageId: source,
    version,
  });
  await t.test(
    'reply/all/forward creation inserts once above originals, while autosave, provider sync and settings changes preserve edits',
    async () => {
      for (const kind of ['reply', 'replyAll', 'forward']) {
        const id = randomUUID();
        const response = await request(`messages/${source}/compose`, 'POST', {
          id,
          kind,
        });
        assert.equal(response.statusCode, 201, response.body);
        const draft = await loaded(id);
        assert.equal(
          (draft.content.html.match(/Writer café/g) ?? []).length,
          1,
        );
        if (kind !== 'forward')
          assert.ok(
            draft.content.html.indexOf('Writer café') <
              draft.content.html.indexOf('<blockquote>'),
          );
        else assert.ok(draft.forwarded);
        assert.equal(
          (await request(`messages/${source}/compose`, 'POST', { id, kind }))
            .statusCode,
          201,
        );
        assert.deepEqual((await loaded(id)).content, draft.content);
        const edited = {
          ...draft.content,
          html: draft.content.html.replace('Writer café', 'Edited signature'),
        };
        const saved = await request(`drafts/${id}`, 'PUT', {
          accountId: account,
          content: edited,
          revision: draft.revision,
          saveId: randomUUID(),
        });
        assert.equal(saved.statusCode, 200, saved.body);
        await pool.query(
          'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp() WHERE source_draft_id=$1',
          [id],
        );
        await syncProviderDrafts(pool, keys, owner.id, account);
        const copy = (
          await pool.query(
            'SELECT c.* FROM mail_draft_copies c JOIN mail_draft_links l ON l.active_copy_id=c.id WHERE l.source_draft_id=$1',
            [id],
          )
        ).rows[0];
        assert.ok(copy);
        const raw = imap.server.control.getMessage(
          'Drafts',
          Number(copy.uid),
        ).raw;
        assert.ok(raw);
        const parsed = await simpleParser(raw);
        assert.equal((parsed.text?.match(/Edited signature/g) ?? []).length, 1);
        const row = (
          await pool.query('SELECT * FROM mail_drafts WHERE id=$1', [id])
        ).rows[0];
        const outgoing = await outgoingMessage(
          randomUUID(),
          'writer@example.test',
          { ...row.content, to: 'recipient@example.test' },
          row.reply_context,
          row.forward_content,
        );
        const mime = await simpleParser(outgoing.raw);
        assert.equal((mime.text?.match(/Edited signature/g) ?? []).length, 1);
        assert.ok(
          (mime.text ?? '').indexOf('Edited signature') <
            (mime.text ?? '').indexOf('Business newsletter'),
        );
        assert.equal(
          ((mime.html || '').match(/Edited signature/g) ?? []).length,
          1,
        );
        if (kind === 'forward')
          assert.ok(
            (mime.html || '').indexOf('Edited signature') <
              (mime.html || '').indexOf('Forwarded message'),
          );
        const beforeSettingsChange = await loaded(id);
        const current = (await request(path)).json().signature;
        const changed = await saveSettings({
          revision: current.revision,
          html: '<p>Changed settings</p>',
        });
        assert.equal(changed.statusCode, 200, changed.body);
        assert.deepEqual(
          (await loaded(id)).content,
          beforeSettingsChange.content,
        );
        assert.deepEqual(
          (await loaded(id)).forwarded,
          beforeSettingsChange.forwarded,
        );
        const reset = await saveSettings({
          revision: changed.json().signature.revision,
        });
        assert.equal(reset.statusCode, 200, reset.body);
      }
    },
  );
  await t.test(
    'reply/forward default can be disabled independently and account removal cascades only its settings',
    async () => {
      const current = (await request(path)).json().signature;
      assert.equal(
        (
          await saveSettings({
            revision: current.revision,
            newMessages: true,
            repliesForwards: false,
          })
        ).statusCode,
        200,
      );
      for (const kind of ['reply', 'forward']) {
        const id = randomUUID();
        assert.equal(
          (await request(`messages/${source}/compose`, 'POST', { id, kind }))
            .statusCode,
          201,
        );
        assert.doesNotMatch((await loaded(id)).content.html, /Writer café/);
      }
      const removed = await request(`accounts/${account}`, 'DELETE', {
        password: owner.password,
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal((await request(path)).statusCode, 404);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM mail_signatures WHERE account_id=$1',
            [account],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (await request(`accounts/${second}/signature`)).statusCode,
        200,
      );
    },
  );
});
