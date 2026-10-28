import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { applyMailActions } from '../src/mail/actions.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

test('read/unread actions are durable, owned and synchronized to IMAP', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90000,
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
      v1: Buffer.alloc(32, 46).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'actions-owner@example.test',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'actions-other@example.test',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const { server, port } = await imapFixture(t);
  for (const [subject, minute] of [
    ['First action mail', 1],
    ['Second action mail', 2],
  ] as const)
    server.control.addMessage('INBOX', {
      raw: rawMail(subject, `${minute}@example.test`),
      internaldate: new Date(`2026-10-27T12:0${minute}:00Z`),
      flags: [],
    });
  function request(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) {
    return app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { origin, cookie },
      ...(payload ? { payload } : {}),
    });
  }
  const connected = await request('accounts', 'POST', {
    name: 'Actions account',
    host: 'localhost',
    port,
    transport: 'tls',
    username: 'testuser',
    password: imapPassword,
    history: 'all',
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  const [second, first] = (await request('messages')).json().messages;
  const providerSeen = (uid: number) =>
    server.control.getMessage('INBOX', uid).flags.includes('\\Seen');
  const inboxUnread = async () =>
    (await request('mailboxes'))
      .json()
      .mailboxes.find((box: { role: string }) => box.role === 'inbox').unread;
  const mark = (id: string, kind: string, action = randomUUID()) =>
    request(`messages/${id}/actions`, 'POST', { id: action, kind });
  const apply = () => applyMailActions(pool, keys, owner.id, account);
  t.beforeEach(() =>
    pool.query('DELETE FROM mail_request_limits WHERE user_id=$1', [owner.id]),
  );

  await t.test(
    'actions reject anonymous, foreign, cross-origin and invalid requests',
    async () => {
      const payload = { id: randomUUID(), kind: 'read' };
      const path = `messages/${first.id}/actions`;
      assert.equal((await request(path, 'POST', payload, '')).statusCode, 401);
      assert.equal(
        (await request(path, 'POST', payload, other.cookie)).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            path,
            'POST',
            payload,
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      for (const invalid of [
        { id: 'not-a-uuid', kind: 'read' },
        { id: randomUUID(), kind: 'delete' },
      ])
        assert.equal((await request(path, 'POST', invalid)).statusCode, 400);
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM mail_actions')).rows[0].count,
        ),
        0,
      );
    },
  );

  await t.test(
    'mark read is immediate locally, idempotent and survives a sync before dispatch',
    async () => {
      assert.equal(await inboxUnread(), 2);
      const action = randomUUID();
      const marked = await mark(first.id, 'read', action);
      assert.equal(marked.statusCode, 202, marked.body);
      assert.deepEqual(marked.json().action, {
        id: action,
        kind: 'read',
        state: 'pending',
      });
      assert.equal((await mark(first.id, 'read', action)).statusCode, 202);
      assert.equal((await mark(first.id, 'unread', action)).statusCode, 409);
      assert.equal((await mark(second.id, 'read', action)).statusCode, 409);
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM mail_actions')).rows[0].count,
        ),
        1,
      );
      assert.equal(await inboxUnread(), 1);
      const detail = (await request(`messages/${first.id}`)).json().message;
      assert.equal(detail.unread, false);
      assert.equal(detail.lastAction.state, 'pending');
      assert.equal(
        (await request('messages')).json().messages[1].unread,
        false,
      );
      // A metadata pass that still sees the provider as unread keeps pending intent.
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(providerSeen(1), false);
      assert.equal(await inboxUnread(), 1);
      await apply();
      assert.equal(providerSeen(1), true);
      assert.equal(
        (await request(`messages/${first.id}`)).json().message.lastAction.state,
        'applied',
      );
      assert.equal(await inboxUnread(), 1);
    },
  );

  await t.test(
    'consecutive intents apply in order and external changes reconcile',
    async () => {
      await mark(first.id, 'unread');
      await mark(first.id, 'read');
      await mark(first.id, 'unread');
      await apply();
      assert.equal(providerSeen(1), false);
      assert.equal(
        (await request(`messages/${first.id}`)).json().message.unread,
        true,
      );
      server.control.setFlags('INBOX', [2], ['\\Seen'], 'add');
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(
        (await request(`messages/${second.id}`)).json().message.unread,
        false,
      );
      assert.equal(await inboxUnread(), 1);
    },
  );

  await t.test(
    'provider failures retry, then fail visibly and revert the local change',
    async () => {
      await mark(first.id, 'read');
      assert.equal(await inboxUnread(), 0);
      for (let attempt = 0; attempt < 5; attempt++) {
        await applyMailActions(pool, keys, owner.id, account, async () => {
          throw new Error('Provider offline');
        });
        await pool.query(
          "UPDATE mail_actions SET next_attempt_at=now() WHERE state='pending'",
        );
      }
      const detail = (await request(`messages/${first.id}`)).json().message;
      assert.equal(detail.lastAction.state, 'failed');
      assert.equal(detail.unread, true);
      assert.equal(providerSeen(1), false);
      assert.equal(await inboxUnread(), 1);
      await mark(first.id, 'read');
      await pool.query(
        "UPDATE mail_memberships SET uid_validity='999' WHERE user_id=$1 AND message_id=$2",
        [owner.id, first.id],
      );
      await apply();
      const changed = (
        await pool.query(
          'SELECT state,error_code FROM mail_actions WHERE message_id=$1 ORDER BY seq DESC LIMIT 1',
          [first.id],
        )
      ).rows[0];
      assert.deepEqual(changed, {
        state: 'failed',
        error_code: 'message_changed',
      });
      assert.equal(providerSeen(1), false);
      assert.equal(await inboxUnread(), 1);
      await pool.query(
        "UPDATE mail_memberships SET uid_validity='1' WHERE user_id=$1 AND message_id=$2",
        [owner.id, first.id],
      );
    },
  );

  await t.test(
    'durable pg-boss dispatch applies a pending action',
    async () => {
      await mark(second.id, 'unread');
      const boss = new PgBoss({ connectionString });
      const errors: unknown[] = [];
      boss.on('error', (error) => errors.push(error));
      let stop: (() => void) | undefined;
      try {
        await boss.start();
        stop = await startMailWorker(boss, pool, keys);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && providerSeen(2))
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(providerSeen(2), false);
        assert.deepEqual(errors, []);
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
      assert.equal(
        (await request(`messages/${second.id}`)).json().message.lastAction
          .state,
        'applied',
      );
    },
  );
});
