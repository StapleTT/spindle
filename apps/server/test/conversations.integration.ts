import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import {
  ConversationLimitError,
  conversationIds,
} from '../src/mail/conversations.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { syncAccount } from '../src/mail/sync.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

test('account-scoped local conversation graph, context authorization, pagination and IMAP reference sync', {
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
      v1: Buffer.alloc(32, 63).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'threads-owner@example.test',
  );
  const admin = await createTestUser(
    app,
    pool,
    testConfig,
    'threads-admin@example.test',
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
    second = await account(),
    foreign = await account(admin);
  async function folder(
    accountId: string,
    path: string,
    role: string,
    user = owner,
  ) {
    return (
      await pool.query(
        'INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,$3,$3,$4) RETURNING id',
        [user.id, accountId, path, role],
      )
    ).rows[0].id as string;
  }
  const inbox = await folder(own, 'INBOX', 'inbox'),
    sent = await folder(own, 'Sent', '\\Sent'),
    archive = await folder(own, 'Archive', '\\Archive'),
    drafts = await folder(own, 'Drafts', '\\Drafts'),
    trash = await folder(own, 'Trash', '\\Trash');
  const secondInbox = await folder(second, 'INBOX', 'inbox'),
    foreignInbox = await folder(foreign, 'INBOX', 'inbox', admin);
  let uid = 0;
  async function mail(
    subject: string,
    mid: string,
    parent: string | null = null,
    refs: string[] | null = [],
    box = inbox,
    accountId = own,
    user = owner,
    flags: string[] = [],
  ) {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,message_id,in_reply_to,reference_ids,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,$7,$8,$9,$10)',
      [
        id,
        user.id,
        accountId,
        subject,
        JSON.stringify([{ name: 'Alice', address: 'alice@example.test' }]),
        JSON.stringify({
          to: [{ name: 'Bob', address: 'bob@example.test' }],
          cc: [],
        }),
        mid,
        parent,
        refs,
        new Date(Date.UTC(2026, 9, 28, 12, 0, uid)),
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags) VALUES($1,$2,$3,$4,'1',$5,$6)",
      [user.id, accountId, box, id, ++uid, flags],
    );
    return id;
  }
  const root = await mail('Original', '<root@example.test>'),
    reply = await mail(
      'Re: Original',
      '<reply@example.test>',
      '<root@example.test>',
      [],
      sent,
      own,
      owner,
      ['\\Seen'],
    ),
    orphan = await mail(
      'Unrelated subject allowed',
      '<leaf@example.test>',
      null,
      ['<root@example.test>', '<missing@example.test>'],
      archive,
    ),
    sameSubject = await mail('Original', '<unrelated@example.test>'),
    duplicate = await mail(
      'Original',
      '<root@example.test>',
      null,
      [],
      archive,
    );
  const foreignId = await mail(
    'Private',
    '<foreign@example.test>',
    '<root@example.test>',
    [],
    foreignInbox,
    foreign,
    admin,
  );
  const otherAccount = await mail(
    'Separate account',
    '<second@example.test>',
    '<root@example.test>',
    [],
    secondInbox,
    second,
  );
  const draft = await mail(
    'Unsent',
    '<draft@example.test>',
    '<root@example.test>',
    [],
    drafts,
  );
  const flaggedDraft = await mail(
    'Unsent virtual copy',
    '<draftcopy@example.test>',
    '<root@example.test>',
    [],
    inbox,
    own,
    owner,
    ['\\Draft'],
  );
  const request = (path: string, cookie = owner.cookie) =>
    app.inject({
      method: 'GET',
      url: `/api/mail/${path}`,
      headers: { cookie },
    });
  const conversation = (id: string = root, extra = '', cookie = owner.cookie) =>
    request(`messages/${id}/conversation${extra}`, cookie);
  t.beforeEach(() =>
    pool.query('DELETE FROM mail_request_limits').then(() => {}),
  );
  await t.test(
    'grouping follows header links across folders, keeps copies distinct and never uses subjects/accounts/roles as identities',
    async () => {
      const lookup = t.mock.method(dns, 'lookup', async () => {
        throw new Error('Conversation queried provider');
      });
      const response = await conversation();
      assert.equal(response.statusCode, 200, response.body);
      const body = response.json();
      assert.equal(body.total, 4);
      assert.deepEqual(
        new Set(body.messages.map((m: { id: string }) => m.id)),
        new Set([root, reply, orphan, duplicate]),
      );
      assert.ok(
        body.messages
          .find((m: { id: string }) => m.id === reply)
          .folders.some((f: { role: string }) => f.role === '\\Sent'),
      );
      assert.equal(
        body.messages.find((m: { id: string }) => m.id === reply).unread,
        false,
      );
      assert.equal(
        body.messages.find((m: { id: string }) => m.id === reply).matchesView,
        false,
      );
      assert.equal(lookup.mock.callCount(), 0);
      t.mock.restoreAll();
      for (const id of [sameSubject, otherAccount])
        assert.equal((await conversation(id)).json().total, 1);
      assert.equal((await conversation(draft)).statusCode, 404);
      assert.equal((await conversation(flaggedDraft)).statusCode, 404);
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM mail_content')).rows[0].count,
        ),
        0,
      );
    },
  );
  await t.test(
    'foreign admins, anonymous/unverified users and forged source/context/cursors cannot disclose mail',
    async () => {
      assert.equal(
        (await conversation(root, '', admin.cookie)).statusCode,
        404,
      );
      assert.equal((await conversation(root, '', '')).statusCode, 401);
      assert.equal(
        (await conversation(root, `?account=${second}`)).statusCode,
        404,
      );
      assert.equal(
        (await conversation(root, `?cursor=${foreignId}`)).statusCode,
        400,
      );
      assert.equal(
        (await request(`messages/${foreignId}?conversation=${root}`))
          .statusCode,
        404,
      );
      assert.equal(
        (await request(`messages/${sameSubject}?conversation=${root}`))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            `messages/${reply}?conversation=${root}&account=${second}`,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (await request(`messages/${draft}?conversation=${root}`)).statusCode,
        404,
      );
      assert.equal(
        (await conversation(root, '?q=bad:operator')).statusCode,
        400,
      );
      assert.equal(
        (await conversation(root, '?q=subject:absent')).statusCode,
        404,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        admin.id,
      ]);
      assert.equal(
        (await conversation(foreignId, '', admin.cookie)).statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        admin.id,
      ]);
    },
  );
  await t.test(
    'contextual reader opens related Sent mail outside a search without changing result navigation or flags',
    async () => {
      const normal = await request(
        `messages/${root}?q=subject:Original&mailbox=${inbox}`,
      );
      assert.equal(
        (await request(`messages/${reply}?q=subject:Original&mailbox=${inbox}`))
          .statusCode,
        404,
      );
      const context = await request(
        `messages/${reply}?conversation=${root}&q=subject:Original&mailbox=${inbox}`,
      );
      assert.equal(context.statusCode, 200, context.body);
      assert.equal(context.json().message.unread, false);
      assert.equal(context.json().previous, normal.json().previous);
      assert.equal(context.json().next, normal.json().next);
      assert.equal(
        (await request(`messages/${otherAccount}?conversation=${root}`))
          .statusCode,
        404,
      );
    },
  );
  await t.test(
    'cycles, absent parents, malformed IDs and newly arriving/replaced ancestry are bounded and recomputed',
    async () => {
      const removed = await mail(
        'Removed reply',
        '<removed@example.test>',
        '<root@example.test>',
        [],
        trash,
      );
      assert.ok(
        (await conversationIds(pool, owner.id, root)).includes(removed),
      );
      const a = await mail('Cycle A', '<a@example.test>', '<b@example.test>'),
        b = await mail('Cycle B', '<b@example.test>', '<a@example.test>');
      assert.deepEqual(
        new Set(await conversationIds(pool, owner.id, a)),
        new Set([a, b]),
      );
      const orphanA = await mail('Orphan A', '<oa@example.test>', null, [
          '<absent@example.test>',
        ]),
        orphanB = await mail('Orphan B', '<ob@example.test>', null, [
          '<absent@example.test>',
        ]);
      assert.deepEqual(
        new Set(await conversationIds(pool, owner.id, orphanA)),
        new Set([orphanA, orphanB]),
      );
      const late = await mail('Late parent', '<absent@example.test>');
      assert.equal((await conversationIds(pool, owner.id, orphanA)).length, 3);
      await pool.query('DELETE FROM mail_messages WHERE user_id=$1 AND id=$2', [
        owner.id,
        late,
      ]);
      assert.equal((await conversationIds(pool, owner.id, orphanA)).length, 2);
      await pool.query(
        "UPDATE mail_messages SET reference_ids='{}' WHERE user_id=$1 AND id=$2",
        [owner.id, orphanB],
      );
      assert.deepEqual(await conversationIds(pool, owner.id, orphanA), [
        orphanA,
      ]);
      for (const invalid of [
        '<no-at>',
        '<x@é.test>',
        '<bad @example.test>',
        '<a@example.test> trailing',
        `<${'x'.repeat(513)}@x>`,
      ]) {
        const id = await mail('Original', invalid);
        assert.deepEqual(await conversationIds(pool, owner.id, id), [id]);
      }
    },
  );
  await t.test(
    'tied-date paging is stable and oversized graphs refuse context without breaking individual reads',
    async () => {
      const ids = [];
      for (let i = 0; i < 55; i++)
        ids.push(
          await mail(
            'Long thread',
            `<page${i}@example.test>`,
            '<paging@example.test>',
          ),
        );
      await pool.query(
        'UPDATE mail_messages SET received_at=$2 WHERE user_id=$1 AND id=ANY($3::uuid[])',
        [owner.id, new Date('2026-10-28T12:00:00Z'), ids],
      );
      const first = await conversation(ids[0]);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().messages.length, 50);
      assert.ok(first.json().nextCursor);
      const next = await conversation(
        ids[0],
        `?cursor=${first.json().nextCursor}`,
      );
      assert.equal(next.statusCode, 200, next.body);
      assert.equal(next.json().messages.length, 5);
      assert.equal(
        new Set(
          [...first.json().messages, ...next.json().messages].map(
            (m: { id: string }) => m.id,
          ),
        ).size,
        55,
      );
      await pool.query(
        "INSERT INTO mail_messages(user_id,account_id,remote_key,subject,sender,recipients,message_id,received_at) SELECT $1,$2,'large-'||n,'Large','[]','{\"to\":[],\"cc\":[]}', '<oversized@example.test>',clock_timestamp() FROM generate_series(1,1001) n",
        [owner.id, own],
      );
      await pool.query(
        "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) SELECT user_id,account_id,$3,id,'1',10000+row_number() OVER(ORDER BY id) FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key LIKE 'large-%'",
        [owner.id, own, inbox],
      );
      const large = (
        await pool.query(
          "SELECT id FROM mail_messages WHERE user_id=$1 AND remote_key='large-1'",
          [owner.id],
        )
      ).rows[0].id;
      await assert.rejects(
        () => conversationIds(pool, owner.id, large),
        ConversationLimitError,
      );
      assert.equal((await conversation(large)).statusCode, 413);
      assert.equal((await request(`messages/${large}`)).statusCode, 200);
    },
  );
  await t.test(
    'provider metadata sync retains References without bodies and backfills existing envelopes',
    async () => {
      const imap = await imapFixture(t, true, true, [], true);
      imap.server.control.addMessage('INBOX', {
        raw: rawMail('Header root', 'provider-root@example.test'),
        internaldate: new Date(),
        flags: [],
      });
      imap.server.control.addMessage('Sent', {
        raw: rawMail('Header reply', 'provider-reply@example.test').replace(
          'Content-Type:',
          'References: <provider-root@example.test>\r\nContent-Type:',
        ),
        internaldate: new Date(),
        flags: ['\\Seen'],
      });
      const id = await account(owner, 'localhost', imap.port);
      await syncAccount(pool, keys, owner.id, id);
      const messages = (
        await pool.query(
          'SELECT id,reference_ids FROM mail_messages WHERE user_id=$1 AND account_id=$2 ORDER BY subject',
          [owner.id, id],
        )
      ).rows;
      assert.equal(messages.length, 2);
      assert.equal(
        (await conversationIds(pool, owner.id, messages[0].id)).length,
        2,
      );
      assert.ok(
        messages.every((message) => Array.isArray(message.reference_ids)),
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM mail_content WHERE user_id=$1 AND account_id=$2',
              [owner.id, id],
            )
          ).rows[0].count,
        ),
        0,
      );
      await pool.query(
        'UPDATE mail_messages SET reference_ids=NULL WHERE user_id=$1 AND account_id=$2',
        [owner.id, id],
      );
      await pool.query(
        'UPDATE mail_accounts SET next_sync_at=clock_timestamp(),sync_request=gen_random_uuid() WHERE user_id=$1 AND id=$2',
        [owner.id, id],
      );
      await syncAccount(pool, keys, owner.id, id);
      assert.equal(
        (await conversationIds(pool, owner.id, messages[0].id)).length,
        2,
      );
    },
  );
});
