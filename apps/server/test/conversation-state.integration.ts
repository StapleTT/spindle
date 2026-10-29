import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import {
  reconcileConversationState,
  wakeSnoozedConversations,
} from '../src/mail/conversation-state.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { transaction } from '../src/mail/store.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

test('private conversation pin/mute/snooze, inheritance and durable due-time recovery', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 75).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'state-owner@example.test',
      '203.0.113.225',
    ),
    admin = await createTestUser(
      app,
      pool,
      testConfig,
      'state-admin@example.test',
      '203.0.113.225',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
  async function account(user = owner, host = 'mail.example.test', port = 993) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mail/accounts',
      headers: { cookie: user.cookie, origin: testConfig.appUrl },
      payload: {
        name: randomUUID(),
        host,
        port,
        transport: 'tls',
        username: host === 'localhost' ? 'testuser' : randomUUID(),
        password: imapPassword,
        history: 'all',
      },
    });
    assert.equal(res.statusCode, 202, res.body);
    return res.json().account.id as string;
  }
  const own = await account(),
    other = await account(),
    foreign = await account(admin);
  async function box(accountId: string, role = 'inbox', user = owner) {
    return (
      await pool.query(
        'INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,$3,$3,$4) RETURNING id',
        [user.id, accountId, role, role],
      )
    ).rows[0].id as string;
  }
  const inbox = await box(own),
    sent = await box(own, '\\Sent'),
    drafts = await box(own, '\\Drafts'),
    otherInbox = await box(other),
    foreignInbox = await box(foreign, 'inbox', admin);
  let uid = 0;
  async function mail(
    subject: string,
    mid: string,
    parent: string | null = null,
    folder = inbox,
    acc = own,
    user = owner,
  ) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,message_id,in_reply_to,reference_ids,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,'[]','{\"to\":[],\"cc\":[]}',$5,$6,'{}',$7)",
      [
        id,
        user.id,
        acc,
        subject,
        mid,
        parent,
        new Date(Date.UTC(2026, 9, 29, 12, 0, ++uid)),
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags) VALUES($1,$2,$3,$4,'1',$5,'{}')",
      [user.id, acc, folder, id, uid],
    );
    return id;
  }
  const root = await mail('Root', '<root@state.test>'),
    reply = await mail(
      'Reply',
      '<reply@state.test>',
      '<root@state.test>',
      sent,
    ),
    latest = await mail('Latest', '<latest@state.test>'),
    second = await mail(
      'Other account',
      '<root@state.test>',
      null,
      otherInbox,
      other,
    ),
    secret = await mail(
      'Foreign',
      '<root@state.test>',
      null,
      foreignInbox,
      foreign,
      admin,
    ),
    draft = await mail('Draft', '<draft@state.test>', null, drafts);
  async function request(url: string, user = owner) {
    return app.inject({
      url: `/api/mail/${url}`,
      headers: { cookie: user.cookie },
    });
  }
  async function state(id: string = root) {
    const res = await request(`messages/${id}/conversation?q=in:anywhere`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().state as {
      pinned: boolean;
      muted: boolean;
      snoozedUntil: string | null;
      version: string;
    };
  }
  async function patch(
    id: string,
    changes: Record<string, unknown>,
    version?: string,
    user = owner,
  ) {
    return app.inject({
      method: 'PATCH',
      url: `/api/mail/messages/${id}/conversation/state`,
      headers: { cookie: user.cookie, origin: testConfig.appUrl },
      payload: { version: version ?? (await state(id)).version, ...changes },
    });
  }
  async function change(changes: Record<string, unknown>, id: string = root) {
    const res = await patch(id, changes);
    assert.equal(res.statusCode, 200, res.body);
    return res.json().state;
  }
  const rows = async (q = '') => {
    const res = await request(`messages?${q}`);
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  await t.test(
    'owner, origin, verification, active Drafts and bounded bodies are enforced',
    async () => {
      assert.equal(
        (await patch(secret, { pinned: true }, '0', owner)).statusCode,
        404,
      );
      assert.equal(
        (await patch(root, { pinned: true }, '0', admin)).statusCode,
        404,
      );
      assert.equal((await patch(draft, { pinned: true }, '0')).statusCode, 404);
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/mail/messages/${root}/conversation/state`,
            headers: { cookie: owner.cookie, origin: 'https://evil.example' },
            payload: { version: '0', pinned: true },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PATCH',
            url: `/api/mail/messages/${root}/conversation/state`,
            payload: { version: '0', pinned: true },
            headers: { origin: testConfig.appUrl },
          })
        ).statusCode,
        401,
      );
      for (const changes of [
        {},
        { pinned: true, muted: true },
        { snoozedUntil: 'invalid' },
        { snoozedUntil: new Date(Date.now() - 1000).toISOString() },
        { snoozedUntil: '2099-01-01T00:00:00Z' },
      ])
        assert.equal((await patch(root, changes, '0')).statusCode, 400);
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal((await patch(root, { muted: true }, '0')).statusCode, 403);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
    },
  );
  await t.test(
    'pin ordering and cursors agree with reader neighbors without collapsing messages or accounts',
    async () => {
      await change({ pinned: true });
      assert.equal((await state(reply)).pinned, true);
      assert.equal((await state(second)).pinned, false);
      const first = await rows(`account=${own}&limit=1`);
      assert.equal(first.messages[0].id, root);
      assert.ok(first.nextCursor);
      const next = await rows(
        `account=${own}&limit=1&cursor=${first.nextCursor}`,
      );
      assert.equal(next.messages[0].id, latest);
      const detail = await request(`messages/${root}?account=${own}`);
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().next, latest);
      assert.equal(detail.json().previous, null);
      assert.equal((await rows('q=in:pinned')).messages.length, 2); // Inbox root and related Sent reply.
      const oldCursor = Buffer.from(
        JSON.stringify([
          first.messages[0].receivedAt.replace(/\.\d{3}Z$/, '.000000Z'),
          root,
        ]),
      ).toString('base64url');
      assert.equal(
        (await request(`messages?cursor=${oldCursor}`)).statusCode,
        200,
      );
    },
  );
  await t.test(
    'mute does not change flags/counts or queue provider actions; stale tabs cannot overwrite choices',
    async () => {
      const before = (await request('mailboxes')).json();
      const old = await state();
      await change({ muted: true });
      assert.equal((await state(reply)).muted, true);
      assert.deepEqual((await request('mailboxes')).json(), before);
      assert.equal(
        (await patch(root, { muted: false }, old.version)).statusCode,
        409,
      );
      assert.equal((await rows('q=in:muted')).messages.length, 2);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT flags FROM mail_memberships WHERE message_id=$1',
            [root],
          )
        ).rows[0].flags,
        [],
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_actions WHERE user_id=$1', [
            owner.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_outbox WHERE user_id=$1', [
            owner.id,
          ])
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    'snooze hides only inbox views/counts, supports search, reschedule, cancellation and timezone instants',
    async () => {
      const first = new Date(Date.now() + 3600000).toISOString();
      await change({ snoozedUntil: first });
      assert.ok(
        !(await rows()).messages.some((m: { id: string }) => m.id === root),
      );
      assert.ok(
        !(await rows(`mailbox=${inbox}`)).messages.some(
          (m: { id: string }) => m.id === root,
        ),
      );
      assert.equal(
        (await rows(`q=${encodeURIComponent('subject:root')}`)).messages[0].id,
        root,
      );
      assert.equal((await rows('q=in:snoozed')).messages.length, 2);
      assert.equal(
        (await request(`messages/${root}?q=in:snoozed`)).statusCode,
        200,
      );
      const folder = (await request('mailboxes'))
        .json()
        .mailboxes.find((b: { id: string }) => b.id === inbox);
      assert.equal(folder.total, 1);
      assert.equal(folder.unread, 1);
      // Offset-bearing repeated autumn hour is one explicit UTC instant.
      const futureYear = new Date().getUTCFullYear() + 1;
      const offset = `${futureYear}-01-02T01:30:00-06:00`;
      if (Date.parse(offset) < Date.now() + 366 * 86400000) {
        await change({ snoozedUntil: offset });
        assert.equal(
          Date.parse((await state()).snoozedUntil ?? ''),
          Date.parse(offset),
        );
      }
      await change({ snoozedUntil: null });
      assert.ok(
        (await rows()).messages.some((m: { id: string }) => m.id === root),
      );
    },
  );
  await t.test(
    'new ancestry merges fields independently, explicit unpin/unmute/unsnooze win, and split members retain state',
    async () => {
      await change({
        snoozedUntil: new Date(Date.now() + 3600000).toISOString(),
      });
      const branch = await mail('Branch', '<branch@state.test>');
      await change({ pinned: true }, branch);
      await change({ muted: false }, branch);
      await change({ pinned: false });
      await change({ snoozedUntil: null });
      await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          owner.id,
        ]);
        await db.query(
          'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
          [owner.id, own],
        );
        await db.query(
          'UPDATE mail_messages SET reference_ids=$3 WHERE user_id=$1 AND id=$2',
          [owner.id, branch, ['<root@state.test>']],
        );
        await reconcileConversationState(db, owner.id, own, [branch]);
      });
      assert.equal((await state(branch)).pinned, false);
      assert.equal((await state(branch)).muted, false);
      assert.equal((await state(branch)).snoozedUntil, null);
      await change({ muted: true });
      await pool.query(
        "UPDATE mail_messages SET reference_ids='{}' WHERE user_id=$1 AND id=$2",
        [owner.id, branch],
      );
      assert.equal((await state(branch)).muted, true);
      await change({ muted: false }, branch);
      assert.equal((await state()).muted, true);
    },
  );
  await t.test(
    'oversized conversations refuse settings changes without partially pinning members',
    async () => {
      await pool.query(
        `INSERT INTO mail_messages(user_id,account_id,remote_key,subject,sender,recipients,message_id,received_at)
        SELECT $1,$2,'state-limit-'||n,'Large','[]','{"to":[],"cc":[]}','<state-limit@example.test>',clock_timestamp()
        FROM generate_series(1,1001) n`,
        [owner.id, own],
      );
      await pool.query(
        `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid)
        SELECT user_id,account_id,$3,id,'1',10000+row_number() OVER(ORDER BY id) FROM mail_messages
        WHERE user_id=$1 AND account_id=$2 AND remote_key LIKE 'state-limit-%'`,
        [owner.id, own, inbox],
      );
      const anchor = (
        await pool.query(
          "SELECT id FROM mail_messages WHERE user_id=$1 AND remote_key='state-limit-1'",
          [owner.id],
        )
      ).rows[0].id;
      assert.equal(
        (await patch(anchor, { pinned: true }, '0')).statusCode,
        413,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM mail_messages WHERE user_id=$1 AND remote_key LIKE 'state-limit-%' AND local_pinned",
            [owner.id],
          )
        ).rowCount,
        0,
      );
      await pool.query(
        "DELETE FROM mail_messages WHERE user_id=$1 AND remote_key LIKE 'state-limit-%'",
        [owner.id],
      );
    },
  );
  await t.test(
    'real IMAP sync propagates settings to new replies and physical copies without modifying provider flags',
    async () => {
      const imap = await imapFixture(t, true, true, [], true);
      imap.server.control.addMessage('INBOX', {
        raw: rawMail('Synced root', 'synced-root@state.test'),
        internaldate: new Date(),
        flags: [],
      });
      const acc = await account(owner, 'localhost', imap.port);
      await syncAccount(pool, keys, owner.id, acc);
      const anchor = (
        await pool.query(
          'SELECT id FROM mail_messages WHERE account_id=$1 AND subject=$2',
          [acc, 'Synced root'],
        )
      ).rows[0].id;
      await change({ pinned: true }, anchor);
      await change({ muted: true }, anchor);
      await change(
        { snoozedUntil: new Date(Date.now() + 3600000).toISOString() },
        anchor,
      );
      imap.server.control.addMessage('INBOX', {
        raw: rawMail('Synced reply', 'synced-reply@state.test').replace(
          'Content-Type:',
          'References: <synced-root@state.test>\r\nContent-Type:',
        ),
        internaldate: new Date(),
        flags: [],
      });
      imap.server.control.addMessage('Sent', {
        raw: rawMail('Synced root', 'synced-root@state.test'),
        internaldate: new Date(),
        flags: ['\\Seen'],
      });
      await pool.query(
        'UPDATE mail_accounts SET sync_request=gen_random_uuid() WHERE user_id=$1 AND id=$2',
        [owner.id, acc],
      );
      await syncAccount(pool, keys, owner.id, acc);
      const inherited = (
        await pool.query(
          'SELECT id,local_pinned,local_muted,local_snoozed_until FROM mail_messages WHERE account_id=$1 AND subject=$2',
          [acc, 'Synced reply'],
        )
      ).rows[0];
      assert.ok(inherited);
      assert.equal(inherited.local_pinned, true);
      assert.equal(inherited.local_muted, true);
      assert.ok(inherited.local_snoozed_until);
      assert.ok(!(await rows(`account=${acc}`)).messages.length);
      assert.equal(
        (
          await pool.query(
            'SELECT flags FROM mail_memberships WHERE message_id=$1',
            [inherited.id],
          )
        ).rows[0].flags.includes('\\Seen'),
        false,
      );
      const copies = (
        await pool.query(
          'SELECT local_pinned,local_muted FROM mail_messages WHERE account_id=$1 AND subject=$2',
          [acc, 'Synced root'],
        )
      ).rows;
      assert.equal(copies.length, 2);
      assert.ok(copies.every((copy) => copy.local_pinned && copy.local_muted));
    },
  );
  await t.test(
    'due times recover after worker startup without keys, preserve unverified owners and do not clear rescheduled choices',
    async () => {
      await change({
        snoozedUntil: new Date(Date.now() + 3600000).toISOString(),
      });
      await pool.query(
        "UPDATE mail_messages SET local_snoozed_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",
        [[root, reply]],
      );
      // Visibility recovers from the authoritative timestamp even with the worker stopped.
      assert.ok(
        (await rows()).messages.some((m: { id: string }) => m.id === root),
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      await wakeSnoozedConversations(pool);
      assert.ok(
        (
          await pool.query(
            'SELECT local_snoozed_until FROM mail_messages WHERE id=$1',
            [root],
          )
        ).rows[0].local_snoozed_until,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
      const boss = new PgBoss({ connectionString });
      await boss.start();
      let stop: (() => void) | undefined;
      try {
        stop = await startMailWorker(boss, pool, readMailKeys({}));
        const deadline = Date.now() + 10000;
        while (
          Date.now() < deadline &&
          (
            await pool.query(
              'SELECT local_snoozed_until FROM mail_messages WHERE id=$1',
              [root],
            )
          ).rows[0].local_snoozed_until
        )
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          (
            await pool.query(
              'SELECT local_snoozed_until FROM mail_messages WHERE id=$1',
              [root],
            )
          ).rows[0].local_snoozed_until,
          null,
        );
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
      await change({
        snoozedUntil: new Date(Date.now() + 3600000).toISOString(),
      });
      await wakeSnoozedConversations(pool);
      assert.ok((await state()).snoozedUntil);
      await change({ snoozedUntil: null });
      await wakeSnoozedConversations(pool);
      assert.equal((await state()).snoozedUntil, null);
    },
  );
  await t.test(
    'a due scan waiting on an account cannot clear a reschedule committed before it acquires the lock',
    async () => {
      await change({
        snoozedUntil: new Date(Date.now() + 3600000).toISOString(),
      });
      await pool.query(
        "UPDATE mail_messages SET local_snoozed_until=clock_timestamp()-interval '1 second' WHERE id=ANY($1::uuid[])",
        [[root, reply]],
      );
      const db = await pool.connect();
      let waking: Promise<void> | undefined;
      const until = new Date(Date.now() + 7200000).toISOString();
      try {
        await db.query('BEGIN');
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          owner.id,
        ]);
        waking = wakeSnoozedConversations(pool);
        const deadline = Date.now() + 3000;
        let waiting = false;
        while (Date.now() < deadline) {
          await db.query('SELECT pg_stat_clear_snapshot()');
          waiting = !!(
            await db.query(
              "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM users WHERE id=%email_verified FOR UPDATE' AND pid<>pg_backend_pid()",
            )
          ).rowCount;
          if (waiting) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(
          waiting,
          'Wakeup must have scanned the old due intent and be waiting on the user lock',
        );
        await db.query(
          `WITH version AS MATERIALIZED(SELECT nextval('mail_local_state_version') AS v)
        UPDATE mail_messages SET local_snoozed_until=$2,local_snooze_version=version.v FROM version WHERE id=ANY($1::uuid[])`,
          [[root, reply], until],
        );
        await db.query('COMMIT');
        await waking;
        assert.equal(
          Date.parse((await state()).snoozedUntil ?? ''),
          Date.parse(until),
        );
      } finally {
        await db.query('ROLLBACK');
        db.release();
        await waking;
      }
    },
  );
});
