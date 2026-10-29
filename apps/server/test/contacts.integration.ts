import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('private derived contact suggestions, ranking, export and source deletion', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 30000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString, max: 5 });
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  const app = testApp(
    pool,
    testConfig,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 79).toString('base64'),
      }),
    }),
  );
  t.after(() => app.close());
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'contacts-owner@example.test',
      '203.0.113.229',
    ),
    admin = await createTestUser(
      app,
      pool,
      testConfig,
      'contacts-admin@example.test',
      '203.0.113.229',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
  async function account(user = owner) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/mail/accounts',
      headers: { cookie: user.cookie, origin: testConfig.appUrl },
      payload: {
        name: randomUUID(),
        host: 'mail.example.test',
        port: 993,
        transport: 'tls',
        username: randomUUID(),
        password: 'synthetic-only-password',
        history: 'all',
      },
    });
    assert.equal(res.statusCode, 202, res.body);
    return res.json().account.id as string;
  }
  const a = await account(),
    b = await account(),
    foreign = await account(admin);
  async function box(account: string, role: string, user = owner) {
    return (
      await pool.query(
        'INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,$3,$3,$4) RETURNING id',
        [user.id, account, role, role],
      )
    ).rows[0].id as string;
  }
  const inbox = await box(a, 'inbox'),
    second = await box(b, 'inbox'),
    foreignInbox = await box(foreign, 'inbox', admin),
    drafts = await box(a, '\\Drafts'),
    trash = await box(a, '\\Trash'),
    junk = await box(a, '\\Junk');
  let uid = 0;
  async function mail(
    sender: object[],
    recipients: object = { to: [], cc: [] },
    folder = inbox,
    account = a,
    user = owner,
  ) {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at) VALUES($1::uuid,$2,$3,$1::text,'Contact source',$4,$5,$6)",
      [
        id,
        user.id,
        account,
        JSON.stringify(sender),
        JSON.stringify(recipients),
        new Date(Date.UTC(2026, 9, 29, 12, 0, ++uid)),
      ],
    );
    await pool.query(
      "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',$5)",
      [user.id, account, folder, id, uid],
    );
    return id;
  }
  const person = (name: string, address: string) => ({ name, address });
  await mail([person('Jane Z', 'Jane+work@example.test')], {
    to: [person('John Private', 'john@example.test')],
    cc: [person('Zoë Support', 'zoe@example.test')],
    bcc: [person('Secret Bcc', 'secret-bcc@example.test')],
  });
  await mail([person('Jane Preferred', 'jane@example.test')]);
  await mail([person('Jane Other', 'jane.other@example.test')], {}, second, b);
  await mail(
    [person('Foreign Jane', 'foreign-jane@example.test')],
    {},
    foreignInbox,
    foreign,
    admin,
  );
  await mail([person('Draft Jane', 'draft-jane@example.test')], {}, drafts);
  await mail([person('Trash Jane', 'trash-jane@example.test')], {}, trash);
  await mail([person('Spam Jane', 'spam-jane@example.test')], {}, junk);
  const request = (path: string, cookie = owner.cookie) =>
    app.inject({ url: `/api/mail/${path}`, headers: { cookie } });
  const suggest = async (q: string, account?: string) => {
    const res = await request(
      `contacts?${new URLSearchParams({ q, ...(account ? { account } : {}) })}`,
    );
    assert.equal(res.statusCode, 200, res.body);
    return res.json();
  };
  await t.test(
    'verified owner boundaries exclude foreign admins, hidden Bcc, active Drafts, Trash and Spam',
    async () => {
      assert.equal((await request('contacts?q=ja', '')).statusCode, 401);
      assert.equal((await request('contacts/export', '')).statusCode, 401);
      const list = await suggest('jane', a);
      assert.equal(list.contacts.length, 3);
      assert.ok(
        list.contacts.every(
          (c: { address: string }) =>
            !/(foreign|draft|trash|spam)/.test(c.address),
        ),
      );
      assert.equal((await suggest('secret')).contacts.length, 0);
      assert.equal(
        (await suggest('zoë')).contacts[0].address,
        'zoe@example.test',
      );
      assert.deepEqual(
        (await request(`contacts?q=jane&account=${foreign}`)).statusCode,
        404,
      );
      const ownAsAdmin = (
        await request('contacts?q=jane', admin.cookie)
      ).json();
      assert.equal(ownAsAdmin.contacts.length, 1);
      assert.equal(ownAsAdmin.contacts[0].address, 'foreign-jane@example.test');
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal((await request('contacts?q=ja')).statusCode, 403);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
    },
  );
  await t.test(
    'prefix matches rank preferred account, deduplicate casing and retain plus aliases and safe names',
    async () => {
      await mail([person('Jane latest', 'JANE@example.test')]);
      const rows = (await suggest('jane', a)).contacts;
      assert.equal(rows[0].address, 'jane@example.test');
      assert.equal(rows[0].name, 'Jane latest');
      assert.equal(
        rows.filter(
          (c: { address: string }) => c.address === 'jane@example.test',
        ).length,
        1,
      );
      assert.ok(
        rows.some(
          (c: { address: string }) => c.address === 'jane+work@example.test',
        ),
      );
      await mail(
        [person('Old high frequency', 'jane.freq@example.test')],
        {},
        second,
        b,
      );
      await mail(
        [person('Old high frequency', 'jane.freq@example.test')],
        {},
        second,
        b,
      );
      const preferred = (await suggest('jane', a)).contacts;
      assert.ok(
        preferred.findIndex(
          (c: { address: string }) => c.address === 'jane+work@example.test',
        ) <
          preferred.findIndex(
            (c: { address: string }) => c.address === 'jane.freq@example.test',
          ),
      );
      await mail([
        person('Bad\r\nName <img>', 'clean@example.test'),
        person('Invalid', 'broken@@example.test'),
        person('No domain', 'local@host'),
        person('Header', 'evil\n@example.test'),
      ]);
      assert.ok(!(await suggest('broken')).contacts.length);
      assert.ok(!(await suggest('evil')).contacts.length);
      assert.ok(!(await suggest('local')).contacts.length);
      assert.equal(
        (await suggest('clean')).contacts[0].name,
        'Bad  Name <img>',
      );
      await pool.query('UPDATE mail_accounts SET username=$2 WHERE id=$1', [
        a,
        'self@example.test',
      ]);
      await mail([person('Self', 'SELF@example.test')]);
      assert.equal((await suggest('self')).contacts.length, 0);
    },
  );
  await t.test(
    'incomplete/malicious prefixes are bounded, parameterized and cannot select arbitrary owners',
    async () => {
      for (const q of ['x', 'a'.repeat(101), 'ja\n'])
        assert.equal(
          (await request(`contacts?q=${encodeURIComponent(q)}`)).statusCode,
          400,
        );
      assert.equal((await suggest("' | ! & :*")).contacts.length, 0);
      assert.equal((await suggest("' OR 1=1 --")).contacts.length, 0);
      const forged = await request(`contacts?q=jane&user=${admin.id}`);
      assert.equal(forged.statusCode, 200);
      assert.ok(
        !forged
          .json()
          .contacts.some(
            (c: { address: string }) =>
              c.address === 'foreign-jane@example.test',
          ),
      );
    },
  );
  await t.test(
    'source removal/moves and account deletion remove suggestions without a retained address book',
    async () => {
      const id = await mail([person('Delete Me', 'delete-me@example.test')]);
      assert.equal((await suggest('delete-me')).contacts.length, 1);
      await pool.query(
        'UPDATE mail_memberships SET pending_mailbox_id=$2 WHERE message_id=$1',
        [id, trash],
      );
      assert.equal((await suggest('delete-me')).contacts.length, 0);
      await pool.query(
        'UPDATE mail_memberships SET pending_mailbox_id=NULL WHERE message_id=$1',
        [id],
      );
      assert.equal((await suggest('delete-me')).contacts.length, 1);
      await pool.query('DELETE FROM mail_messages WHERE id=$1', [id]);
      assert.equal((await suggest('delete-me')).contacts.length, 0);
      const extra = await account(),
        folder = await box(extra, 'inbox');
      await mail(
        [person('Disconnected', 'disconnected@example.test')],
        {},
        folder,
        extra,
      );
      assert.equal((await suggest('disconnect')).contacts.length, 1);
      await pool.query('DELETE FROM mail_accounts WHERE user_id=$1 AND id=$2', [
        owner.id,
        extra,
      ]);
      assert.equal((await suggest('disconnect')).contacts.length, 0);
    },
  );
  await t.test(
    'large matching histories remain bounded and expose the coverage limit',
    async () => {
      await pool.query(
        `INSERT INTO mail_messages(user_id,account_id,remote_key,subject,sender,recipients,received_at)
        SELECT $1,$2,'contact-limit-'||n,'Bounded','[{"name":"Cap Person","address":"cap@example.test"}]','{}',clock_timestamp()
        FROM generate_series(1,2001) n`,
        [owner.id, a],
      );
      await pool.query(
        `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid)
        SELECT user_id,account_id,$3,id,'1',10000+row_number() OVER(ORDER BY id) FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key LIKE 'contact-limit-%'`,
        [owner.id, a, inbox],
      );
      const result = await suggest('cap');
      assert.equal(result.limited, true);
      assert.equal(result.contacts[0].address, 'cap@example.test');
      assert.ok(result.contacts.length <= 8);
    },
  );
  await t.test(
    'export pages contain the same private visible participants, with stable cursors and no mail bodies',
    async () => {
      for (let i = 0; i < 105; i++)
        await mail([
          person(
            `Export ${i}`,
            `export${String(i).padStart(3, '0')}@example.test`,
          ),
        ]);
      const first = await request('contacts/export');
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.headers['cache-control'], 'no-store');
      assert.ok(first.json().nextCursor);
      const next = await request(
        `contacts/export?after=${encodeURIComponent(first.json().nextCursor)}`,
      );
      assert.equal(next.statusCode, 200, next.body);
      const contacts = [...first.json().contacts, ...next.json().contacts];
      assert.equal(
        contacts.filter((c: { address: string }) =>
          c.address.startsWith('export'),
        ).length,
        105,
      );
      assert.equal(
        new Set(contacts.map((c: { address: string }) => c.address)).size,
        contacts.length,
      );
      assert.ok(!JSON.stringify(contacts).includes('secret-bcc'));
      assert.ok(!JSON.stringify(contacts).includes('foreign-jane'));
      assert.deepEqual(Object.keys(contacts[0]).sort(), ['address', 'name']);
    },
  );
});
