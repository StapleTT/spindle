import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { syncAccount } from '../src/mail/sync.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

test('open-app notification feed stays private, ignores history and respects live inbox state', {
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
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 81).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'notify-owner@example.test',
      '203.0.113.231',
    ),
    admin = await createTestUser(
      app,
      pool,
      testConfig,
      'notify-admin@example.test',
      '203.0.113.231',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
  async function account(user = owner, host = 'mail.example.test', port = 993) {
    const response = await app.inject({
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
    assert.equal(response.statusCode, 202, response.body);
    return response.json().account.id as string;
  }
  const own = await account(),
    foreign = await account(admin);
  const folder = async (accountId: string, role: string, user = owner) =>
    (
      await pool.query(
        'INSERT INTO mailboxes(user_id,account_id,path,name,role,initial_complete) VALUES($1,$2,$3,$3,$4,true) RETURNING id',
        [user.id, accountId, role, role],
      )
    ).rows[0].id as string;
  const inbox = await folder(own, 'inbox'),
    trash = await folder(own, '\\Trash'),
    sent = await folder(own, '\\Sent'),
    drafts = await folder(own, '\\Drafts'),
    foreignInbox = await folder(foreign, 'inbox', admin);
  let uid = 0;
  async function mail(
    subject: string,
    arrival = true,
    box = inbox,
    acc = own,
    user = owner,
    flags: string[] = [],
    received = new Date(),
  ) {
    const id: string = randomUUID();
    await pool.query(
      'INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at,notification_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,$7,CASE WHEN $8 THEN clock_timestamp() ELSE NULL END)',
      [
        id,
        user.id,
        acc,
        subject,
        JSON.stringify([
          { name: 'Sender\r\nPrivate', address: 'sender@example.test' },
        ]),
        JSON.stringify({
          to: [],
          cc: [],
          bcc: [{ address: 'hidden@example.test' }],
        }),
        received,
        arrival,
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags) VALUES($1,$2,$3,$4,'1',$5,$6)",
      [user.id, acc, box, id, ++uid, flags],
    );
    return id;
  }
  const request = (since?: string, cookie = owner.cookie) =>
    app.inject({
      url: `/api/mail/notifications${since ? `?since=${encodeURIComponent(since)}` : ''}`,
      headers: { cookie },
    });
  const feed = async (since?: string) => {
    const r = await request(since);
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  await mail('Historical unread', false);
  await mail('Foreign arrival', true, foreignInbox, foreign, admin);
  const initial = await feed(),
    since = initial.serverTime as string;
  await t.test(
    'verified ownership, private previews and initial baselines prevent old/foreign mail exposure',
    async () => {
      assert.equal(initial.userId, owner.id);
      assert.equal(initial.unreadCount, 1);
      assert.deepEqual(initial.arrivals, []);
      assert.equal((await request(undefined, '')).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            url: '/api/mail/notifications?since=invalid',
            headers: { cookie: owner.cookie },
          })
        ).statusCode,
        400,
      );
      const adminFeed = await request('2000-01-01T00:00:00Z', admin.cookie);
      assert.equal(adminFeed.statusCode, 200, adminFeed.body);
      assert.equal(adminFeed.json().arrivals.length, 1);
      assert.equal(adminFeed.json().arrivals[0].subject, 'Foreign arrival');
      const first = await mail('Fresh <script>alert(1)</script>');
      const data = await feed(since);
      assert.equal(data.arrivals.length, 1);
      assert.equal(data.arrivals[0].id, first);
      assert.equal(data.arrivals[0].sender, 'Sender  Private');
      assert.ok(!JSON.stringify(data).includes('hidden@example.test'));
      assert.ok(!JSON.stringify(data).includes('Foreign arrival'));
    },
  );
  await t.test(
    'read/unread, pending moves, deleted flags and non-inbox memberships never replay a consumed alert',
    async () => {
      const read = await mail('Read transition');
      await pool.query(
        'UPDATE mail_memberships SET flags=$2 WHERE message_id=$1',
        [read, ['\\Seen']],
      );
      await pool.query(
        "UPDATE mail_memberships SET flags='{}' WHERE message_id=$1",
        [read],
      );
      assert.ok(
        !(await feed(since)).arrivals.some(
          (r: { id: string }) => r.id === read,
        ),
      );
      const moved = await mail('Moved transition');
      await pool.query(
        'UPDATE mail_memberships SET pending_mailbox_id=$2 WHERE message_id=$1',
        [moved, trash],
      );
      await pool.query(
        'UPDATE mail_memberships SET pending_mailbox_id=NULL WHERE message_id=$1',
        [moved],
      );
      assert.ok(
        !(await feed(since)).arrivals.some(
          (r: { id: string }) => r.id === moved,
        ),
      );
      const removed = await mail(
        'Deleted transition',
        true,
        inbox,
        own,
        owner,
        ['\\Deleted'],
      );
      assert.ok(
        !(await feed(since)).arrivals.some(
          (r: { id: string }) => r.id === removed,
        ),
      );
      for (const box of [sent, drafts]) {
        const id = await mail('Outside inbox', true, box);
        assert.ok(
          !(await feed(since)).arrivals.some(
            (r: { id: string }) => r.id === id,
          ),
        );
      }
    },
  );
  await t.test(
    'mute/snooze suppress both pending and inherited alerts without suppressing muted unread counts',
    async () => {
      const id = await mail('Quiet conversation'),
        before = (await feed(since)).unreadCount;
      await pool.query(
        'UPDATE mail_messages SET local_muted=true WHERE id=$1',
        [id],
      );
      assert.equal((await feed(since)).unreadCount, before);
      await pool.query(
        'UPDATE mail_messages SET local_muted=false WHERE id=$1',
        [id],
      );
      assert.ok(
        !(await feed(since)).arrivals.some((r: { id: string }) => r.id === id),
      );
      const snooze = await mail('Snoozed conversation');
      await pool.query(
        "UPDATE mail_messages SET local_snoozed_until=clock_timestamp()+interval '1 hour' WHERE id=$1",
        [snooze],
      );
      const count = (await feed(since)).unreadCount;
      await pool.query(
        'UPDATE mail_messages SET local_snoozed_until=NULL WHERE id=$1',
        [snooze],
      );
      assert.equal((await feed(since)).unreadCount, count + 1);
      assert.ok(
        !(await feed(since)).arrivals.some(
          (r: { id: string }) => r.id === snooze,
        ),
      );
    },
  );
  await t.test(
    'old import dates and stale arrival windows do not notify even with an older forged cursor',
    async () => {
      const imported = await mail(
        'Old imported message',
        true,
        inbox,
        own,
        owner,
        [],
        new Date('2020-01-01'),
      );
      const expired = await mail('Old arrival');
      await pool.query(
        "UPDATE mail_messages SET notification_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
        [expired],
      );
      const data = await feed('2000-01-01T00:00:00Z');
      assert.ok(
        !data.arrivals.some((r: { id: string }) =>
          [imported, expired].includes(r.id),
        ),
      );
    },
  );
  await t.test(
    'real IMAP marks only post-backfill arrivals, inherits quiet state, and ignores UID reset history',
    async () => {
      const imap = await imapFixture(t, true, true, [], false);
      imap.server.control.addMessage('INBOX', {
        raw: rawMail('Initial history', 'notify-root@example.test'),
        internaldate: new Date(),
        flags: [],
      });
      const acc = await account(owner, 'localhost', imap.port);
      await syncAccount(pool, keys, owner.id, acc);
      const root = (
        await pool.query(
          'SELECT id,notification_at FROM mail_messages WHERE account_id=$1',
          [acc],
        )
      ).rows[0];
      assert.equal(root.notification_at, null);
      await pool.query(
        "UPDATE mail_messages SET local_muted=true,local_mute_version=nextval('mail_local_state_version') WHERE id=$1",
        [root.id],
      );
      imap.server.control.addMessage('INBOX', {
        raw: rawMail('Muted reply', 'notify-muted@example.test').replace(
          'Content-Type:',
          'References: <notify-root@example.test>\r\nContent-Type:',
        ),
        internaldate: new Date(),
        flags: [],
      });
      await pool.query(
        'UPDATE mail_accounts SET sync_request=gen_random_uuid() WHERE id=$1',
        [acc],
      );
      await syncAccount(pool, keys, owner.id, acc);
      const muted = (
        await pool.query(
          'SELECT local_muted,notification_at FROM mail_messages WHERE account_id=$1 AND subject=$2',
          [acc, 'Muted reply'],
        )
      ).rows[0];
      assert.equal(muted.local_muted, true);
      assert.equal(muted.notification_at, null);
      imap.server.control.addMessage('INBOX', {
        raw: rawMail('New unread arrival', 'notify-fresh@example.test'),
        internaldate: new Date(),
        flags: [],
      });
      await pool.query(
        'UPDATE mail_accounts SET sync_request=gen_random_uuid() WHERE id=$1',
        [acc],
      );
      await syncAccount(pool, keys, owner.id, acc);
      assert.ok(
        (await feed(since)).arrivals.some(
          (r: { subject: string }) => r.subject === 'New unread arrival',
        ),
      );
      imap.server.control.resetUidValidity('INBOX');
      await pool.query(
        'UPDATE mail_accounts SET sync_request=gen_random_uuid() WHERE id=$1',
        [acc],
      );
      await syncAccount(pool, keys, owner.id, acc);
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM mail_messages WHERE account_id=$1 AND notification_at IS NOT NULL',
            [acc],
          )
        ).rowCount,
        0,
      );
    },
  );
  await t.test(
    'bounded bursts retain accurate unread counts and verification/session denial',
    async () => {
      for (let i = 0; i < 55; i++) await mail(`Burst ${i}`);
      const data = await feed(since);
      assert.equal(data.arrivals.length, 50);
      assert.ok(data.unreadCount > 50);
      const boxes = (
        await app.inject({
          url: '/api/mail/mailboxes',
          headers: { cookie: owner.cookie },
        })
      ).json().mailboxes;
      assert.equal(
        boxes
          .filter((b: { role: string }) => b.role === 'inbox')
          .reduce((n: number, b: { unread: number }) => n + b.unread, 0),
        data.unreadCount,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal((await request(since)).statusCode, 403);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
      await pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [
        owner.id,
      ]);
      assert.equal((await request(since)).statusCode, 401);
    },
  );
});
