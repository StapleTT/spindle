import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { connectImap } from '../src/mail/imap.js';
import { claimAccount, withLease } from '../src/mail/store.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

test('private IMAP storage, synchronization and local inbox', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 120000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({
    connectionString,
    max: 8,
    query_timeout: 15000,
    connectionTimeoutMillis: 5000,
  });
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 42).toString('base64'),
    }),
  });
  const config = { ...testConfig, registrationMode: 'public' };
  const app = testApp(pool, config, undefined, keys);
  t.after(() => app.close());
  let ip = 0;
  function request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
    payload?: object,
    cookie = '',
    origin = config.appUrl,
  ) {
    return app.inject({
      method,
      url: `/api/mail/${path}`,
      remoteAddress: `198.51.100.${++ip}`,
      headers: { cookie, origin },
      ...(payload ? { payload } : {}),
    });
  }
  async function user(email: string, role = 'user') {
    const password = 'synthetic spindle password 123!';
    const signup = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      headers: { origin: config.appUrl },
      remoteAddress: `198.51.100.${++ip}`,
      payload: { email, name: 'Mail Test', password },
    });
    assert.equal(signup.statusCode, 200, signup.body);
    const id = (
      await pool.query(
        'UPDATE users SET email_verified=true,role=$2 WHERE email=$1 RETURNING id',
        [email, role],
      )
    ).rows[0].id;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin: config.appUrl },
      remoteAddress: `198.51.100.${++ip}`,
      payload: { email, password },
    });
    assert.equal(login.statusCode, 200, login.body);
    const headers = login.headers['set-cookie'];
    const cookie = (Array.isArray(headers) ? headers : [String(headers)])
      .map((value) => value.split(';')[0])
      .join('; ');
    return { id, cookie, password };
  }
  const owner = await user('imap-owner@example.test');
  const other = await user('imap-other@example.test', 'admin');
  t.beforeEach(async () => {
    await pool.query(
      'DELETE FROM mail_request_limits WHERE user_id=ANY($1::text[])',
      [[owner.id, other.id]],
    );
  });
  const { server, port } = await imapFixture(t);
  const setup = await connectImap(
    { host: 'localhost', port, transport: 'tls', username: 'testuser' },
    imapPassword,
  );
  await setup.mailboxCreate('Receipts 日本');
  setup.close();
  server.control.addMessage('INBOX', {
    raw: rawMail('First real protocol message'),
    internaldate: new Date(),
    flags: [],
  });
  server.control.addMessage('INBOX', {
    raw: rawMail('<img src=x onerror=alert(1)>'),
    internaldate: new Date(),
    flags: ['\\Seen'],
  });
  server.control.addMessage('Archive', {
    raw: rawMail('Archived message'),
    internaldate: new Date(),
    flags: [],
  });
  const settings = {
    name: 'Test account',
    host: 'localhost',
    port,
    transport: 'tls',
    username: 'testuser',
    password: imapPassword,
    history: 'all',
  };
  let accountId = '';
  async function pollAccount() {
    await pool.query(
      "UPDATE mailboxes SET last_synced_at=now()-interval '2 minutes' WHERE account_id=$1",
      [accountId],
    );
    await syncAccount(pool, keys, owner.id, accountId);
  }

  await t.test(
    'all mail routes require a verified session and writes require the exact origin',
    async () => {
      const missing = '00000000-0000-4000-8000-000000000001';
      for (const [path, method, payload] of [
        ['accounts', 'GET', undefined],
        ['mailboxes', 'GET', undefined],
        ['messages', 'GET', undefined],
        ['accounts', 'POST', settings],
        [`accounts/${missing}/sync`, 'POST', {}],
        [`accounts/${missing}`, 'DELETE', { password: owner.password }],
      ] as const) {
        assert.equal(
          (await request(path, method, payload)).statusCode,
          401,
          path,
        );
        await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
          owner.id,
        ]);
        assert.equal(
          (await request(path, method, payload, owner.cookie)).statusCode,
          403,
          path,
        );
        await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
          owner.id,
        ]);
      }
      assert.equal(
        (
          await request(
            'accounts',
            'POST',
            settings,
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            'accounts',
            'POST',
            { ...settings, transport: 'none' },
            owner.cookie,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request(
            'accounts',
            'POST',
            { ...settings, host: ['localhost'] },
            owner.cookie,
          )
        ).statusCode,
        400,
      );
    },
  );

  await t.test(
    'connect persists encrypted credentials, reconnect is idempotent, and ownership is enforced',
    async () => {
      const result = await request('accounts', 'POST', settings, owner.cookie);
      assert.equal(result.statusCode, 202, result.body);
      accountId = result.json().account.id;
      assert.ok(!result.body.includes(imapPassword));
      const stored = (
        await pool.query('SELECT credential FROM mail_accounts WHERE id=$1', [
          accountId,
        ])
      ).rows[0].credential;
      assert.notEqual(stored, imapPassword);
      const duplicate = await request(
        'accounts',
        'POST',
        settings,
        owner.cookie,
      );
      assert.equal(duplicate.json().account.id, accountId);
      assert.equal(
        (await request('accounts', 'GET', undefined, other.cookie)).json()
          .accounts.length,
        0,
      );
      for (const [path, method, payload] of [
        [`messages?account=${accountId}`, 'GET', undefined],
        [`accounts/${accountId}/sync`, 'POST', {}],
        [`accounts/${accountId}`, 'DELETE', { password: other.password }],
      ] as const)
        assert.equal(
          (await request(path, method, payload, other.cookie)).statusCode,
          404,
          path,
        );
      const before = (
        await pool.query('SELECT status FROM mail_accounts WHERE id=$1', [
          accountId,
        ])
      ).rows[0].status;
      await syncAccount(pool, keys, other.id, accountId);
      assert.equal(
        (
          await pool.query('SELECT status FROM mail_accounts WHERE id=$1', [
            accountId,
          ])
        ).rows[0].status,
        before,
      );
    },
  );

  await t.test(
    'real TLS IMAP sync stores metadata, folder flags and non-mutating reads',
    async () => {
      for (let i = 0; i < 3; i++) await pollAccount();
      const state = (
        await pool.query(
          'SELECT status,error_code FROM mail_accounts WHERE id=$1',
          [accountId],
        )
      ).rows[0];
      assert.equal(state.status, 'ready', JSON.stringify(state));
      const inbox = await request('messages', 'GET', undefined, owner.cookie);
      assert.equal(inbox.statusCode, 200, inbox.body);
      assert.equal(inbox.json().messages.length, 2);
      assert.ok(
        inbox
          .json()
          .messages.some((mail: { subject: string }) =>
            mail.subject.startsWith('<img'),
          ),
      );
      const folders = (
        await request('mailboxes', 'GET', undefined, owner.cookie)
      ).json().mailboxes;
      const archived = folders.find(
        (box: { path: string }) => box.path === 'Archive',
      );
      assert.ok(archived);
      assert.ok(
        folders.some((box: { path: string }) => box.path === 'Receipts 日本'),
      );
      assert.equal(
        (
          await request(
            `messages?mailbox=${archived.id}`,
            'GET',
            undefined,
            owner.cookie,
          )
        ).json().messages.length,
        1,
      );
      assert.equal(
        (
          await request(
            `messages?mailbox=${archived.id}`,
            'GET',
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        folders.find((box: { path: string }) => box.path === 'INBOX').unread,
        1,
      );
      assert.ok(
        !server.control.getMessage('INBOX', 1).flags.includes('\\Seen'),
      );
      const ids = inbox
        .json()
        .messages.map((mail: { id: string }) => mail.id)
        .sort();
      for (let i = 0; i < 3; i++) await pollAccount();
      assert.deepEqual(
        (await request('messages', 'GET', undefined, owner.cookie))
          .json()
          .messages.map((mail: { id: string }) => mail.id)
          .sort(),
        ids,
      );
    },
  );

  await t.test(
    'external new mail, read flags and expunges reconcile without duplicates',
    async () => {
      server.control.setFlags('INBOX', [1], ['\\Seen']);
      server.control.expungeMessages('INBOX', [2]);
      server.control.addMessage('INBOX', {
        raw: rawMail('New mail from another client'),
        internaldate: new Date(),
        flags: [],
      });
      for (let i = 0; i < 9; i++) await pollAccount();
      const messages = (
        await request('messages', 'GET', undefined, owner.cookie)
      ).json().messages;
      assert.equal(messages.length, 2);
      assert.ok(
        messages.find(
          (mail: { subject: string; unread: boolean }) =>
            mail.subject === 'First real protocol message' && !mail.unread,
        ),
      );
      assert.ok(
        messages.find(
          (mail: { subject: string; unread: boolean }) =>
            mail.subject === 'New mail from another client' && mail.unread,
        ),
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM mail_messages WHERE account_id=$1',
              [accountId],
            )
          ).rows[0].count,
        ),
        3,
      );
    },
  );

  await t.test(
    'a metadata batch survives interruption and resumes from its committed checkpoint',
    async () => {
      server.control.createMailbox('Bulk', {});
      for (let i = 0; i < 650; i++)
        server.control.addMessage('Bulk', {
          raw: rawMail(`Bulk ${i}`),
          internaldate: new Date(),
          flags: [],
        });
      await syncAccount(
        pool,
        keys,
        owner.id,
        accountId,
        async (settings, password) => {
          const client = await connectImap(settings, password);
          const lock = client.getMailboxLock.bind(client);
          let attempts = 0;
          t.mock.method(
            client,
            'getMailboxLock',
            async (...args: Parameters<typeof lock>) => {
              if (++attempts === 2)
                throw new Error('Simulated connection loss after first batch');
              return lock(...args);
            },
          );
          return client;
        },
      );
      const box = (
        await pool.query(
          "SELECT * FROM mailboxes WHERE account_id=$1 AND path='Bulk'",
          [accountId],
        )
      ).rows[0];
      assert.equal(box.initial_complete, false);
      const before = (
        await pool.query(
          'SELECT message_id FROM mail_memberships WHERE mailbox_id=$1',
          [box.id],
        )
      ).rows;
      assert.equal(before.length, 500);
      await pollAccount();
      const after = (
        await pool.query(
          'SELECT message_id FROM mail_memberships WHERE mailbox_id=$1',
          [box.id],
        )
      ).rows;
      assert.equal(after.length, 650);
      const ids = new Set(after.map((row) => row.message_id));
      assert.ok(before.every((row) => ids.has(row.message_id)));
      assert.equal(
        (
          await pool.query(
            'SELECT initial_complete FROM mailboxes WHERE id=$1',
            [box.id],
          )
        ).rows[0].initial_complete,
        true,
      );
      server.control.deleteMailbox('Bulk');
      await pollAccount();
    },
  );

  await t.test(
    'an empty mailbox with a large historic UIDNEXT completes without scanning billions of holes',
    async () => {
      server.control.createMailbox('Sparse empty');
      const source = server.getMailbox('Sparse empty');
      assert.ok(source);
      source.uidnext = 4000000000;
      await pollAccount();
      const box = (
        await pool.query(
          "SELECT initial_complete,scan_uid,high_uid FROM mailboxes WHERE account_id=$1 AND path='Sparse empty'",
          [accountId],
        )
      ).rows[0];
      assert.equal(box.initial_complete, true);
      assert.equal(box.scan_uid, null);
      assert.equal(box.high_uid, '3999999999');
    },
  );

  await t.test(
    'UIDVALIDITY replacement cannot confuse reused UIDs',
    async () => {
      const previous = (
        await request('messages', 'GET', undefined, owner.cookie)
      )
        .json()
        .messages.map((mail: { id: string }) => mail.id);
      server.control.resetUidValidity('INBOX', {
        uidvalidity: 2,
        uids: 'renumber',
      });
      for (let i = 0; i < 3; i++) await pollAccount();
      const current = (
        await request('messages', 'GET', undefined, owner.cookie)
      ).json().messages;
      assert.equal(current.length, 2);
      assert.ok(
        current.every((mail: { id: string }) => !previous.includes(mail.id)),
      );
      const validity = (
        await pool.query(
          `SELECT DISTINCT uid_validity FROM mail_memberships WHERE account_id=$1
      AND mailbox_id=(SELECT id FROM mailboxes WHERE account_id=$1 AND path='INBOX')`,
          [accountId],
        )
      ).rows;
      assert.deepEqual(validity, [{ uid_validity: '2' }]);
    },
  );

  await t.test(
    'foreign-owner references and stale worker commits fail at the database boundary',
    async () => {
      const box = (
        await pool.query(
          'SELECT * FROM mailboxes WHERE account_id=$1 LIMIT 1',
          [accountId],
        )
      ).rows[0];
      await assert.rejects(
        pool.query(
          'INSERT INTO mailboxes(user_id,account_id,path,name) VALUES($1,$2,$3,$3)',
          [other.id, accountId, 'Foreign'],
        ),
      );
      const message = (
        await pool.query(
          'SELECT id,subject FROM mail_messages WHERE account_id=$1 LIMIT 1',
          [accountId],
        )
      ).rows[0];
      await assert.rejects(
        pool.query(
          `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid)
        VALUES($1,$2,$3,$4,'1',999999)`,
          [other.id, accountId, box.id, message.id],
        ),
      );
      await pool.query(
        'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE id=$1',
        [accountId],
      );
      const first = await claimAccount(pool, owner.id, accountId);
      assert.ok(first);
      assert.equal(await claimAccount(pool, owner.id, accountId), undefined);
      await pool.query(
        `UPDATE mail_accounts SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`,
        [accountId],
      );
      const takeover = await claimAccount(pool, owner.id, accountId);
      assert.ok(takeover);
      assert.notEqual(first.lease_token, takeover.lease_token);
      await assert.rejects(
        withLease(pool, first, async (db) => {
          await db.query('UPDATE mailboxes SET high_uid=999 WHERE id=$1', [
            box.id,
          ]);
        }),
      );
      const high = (
        await pool.query('SELECT high_uid FROM mailboxes WHERE id=$1', [box.id])
      ).rows[0].high_uid;
      await assert.rejects(
        withLease(pool, takeover, async (db) => {
          await db.query('UPDATE mail_messages SET subject=$2 WHERE id=$1', [
            message.id,
            'Uncommitted subject',
          ]);
          await db.query('UPDATE mailboxes SET high_uid=123 WHERE id=$1', [
            box.id,
          ]);
          throw new Error('Simulated worker death before checkpoint commit');
        }),
      );
      assert.equal(
        (
          await pool.query('SELECT subject FROM mail_messages WHERE id=$1', [
            message.id,
          ])
        ).rows[0].subject,
        message.subject,
      );
      assert.equal(
        (
          await pool.query('SELECT high_uid FROM mailboxes WHERE id=$1', [
            box.id,
          ])
        ).rows[0].high_uid,
        high,
      );
      await pool.query(
        'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE id=$1',
        [accountId],
      );
    },
  );

  await t.test(
    'cursor pagination preserves timestamp ties, microseconds, and membership uniqueness',
    async () => {
      const duplicateBox = (
        await pool.query(
          `INSERT INTO mailboxes(user_id,account_id,path,name,role,uid_validity)
        VALUES($1,$2,'Synthetic duplicate membership','Synthetic duplicate membership','inbox','1') RETURNING id`,
          [owner.id, accountId],
        )
      ).rows[0].id;
      const message = (
        await pool.query(
          `SELECT mm.message_id FROM mail_memberships mm JOIN mailboxes b ON b.id=mm.mailbox_id
        WHERE mm.user_id=$1 AND mm.account_id=$2 AND b.role='inbox' LIMIT 1`,
          [owner.id, accountId],
        )
      ).rows[0].message_id;
      await pool.query(
        `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid)
        VALUES($1,$2,$3,$4,'1',1)`,
        [owner.id, accountId, duplicateBox, message],
      );
      await pool.query(
        `UPDATE mail_messages SET received_at='2026-10-27T12:00:00.123456Z' WHERE account_id=$1`,
        [accountId],
      );
      const seen = new Set<string>();
      let cursor = '';
      do {
        const result = await request(
          `messages?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
          'GET',
          undefined,
          owner.cookie,
        );
        assert.equal(result.statusCode, 200, result.body);
        for (const mail of result.json().messages) {
          assert.ok(!seen.has(mail.id));
          seen.add(mail.id);
        }
        cursor = result.json().nextCursor ?? '';
      } while (cursor);
      assert.equal(seen.size, 2);
      await pool.query('DELETE FROM mailboxes WHERE user_id=$1 AND id=$2', [
        owner.id,
        duplicateBox,
      ]);
      for (const invalid of [
        'garbage',
        Buffer.from(
          JSON.stringify([
            '2026-02-30T12:00:00.000000Z',
            '------------------------------------',
          ]),
        ).toString('base64url'),
      ])
        assert.equal(
          (
            await request(
              `messages?cursor=${invalid}`,
              'GET',
              undefined,
              owner.cookie,
            )
          ).statusCode,
          400,
        );
      assert.equal(
        (await request('messages?limit=10000', 'GET', undefined, owner.cookie))
          .statusCode,
        400,
      );
      assert.equal(
        (await request('messages', 'GET', undefined, other.cookie)).json()
          .messages.length,
        0,
      );
    },
  );

  await t.test(
    'provider failures keep stored mail readable and errors contain no secrets',
    async () => {
      const before = (
        await request('messages', 'GET', undefined, owner.cookie)
      ).json().messages;
      await syncAccount(pool, keys, owner.id, accountId, async () => {
        throw new Error(`provider-host:${imapPassword}`);
      });
      const state = await request('accounts', 'GET', undefined, owner.cookie);
      assert.equal(state.json().accounts[0].status, 'error');
      assert.ok(!state.body.includes(imapPassword));
      assert.deepEqual(
        (await request('messages', 'GET', undefined, owner.cookie)).json()
          .messages,
        before,
      );
      assert.ok(
        (
          await pool.query(
            'SELECT next_sync_at>now() AS later FROM mail_accounts WHERE id=$1',
            [accountId],
          )
        ).rows[0].later,
      );
    },
  );

  await t.test(
    'a manual refresh made during active sync remains pending until serviced',
    async () => {
      await pool.query(
        "UPDATE mailboxes SET last_synced_at=now()-interval '2 minutes' WHERE account_id=$1",
        [accountId],
      );
      await syncAccount(
        pool,
        keys,
        owner.id,
        accountId,
        async (settings, password) => {
          assert.equal(
            (
              await request(
                `accounts/${accountId}/sync`,
                'POST',
                {},
                owner.cookie,
              )
            ).statusCode,
            202,
          );
          return connectImap(settings, password);
        },
      );
      const pending = (
        await pool.query(
          'SELECT sync_request,sync_completed,next_sync_at FROM mail_accounts WHERE id=$1',
          [accountId],
        )
      ).rows[0];
      assert.notEqual(pending.sync_request, pending.sync_completed);
      assert.ok(pending.next_sync_at.getTime() < Date.now() + 2000);
      await syncAccount(pool, keys, owner.id, accountId);
      const completed = (
        await pool.query(
          'SELECT sync_request,sync_completed FROM mail_accounts WHERE id=$1',
          [accountId],
        )
      ).rows[0];
      assert.equal(completed.sync_request, completed.sync_completed);
    },
  );

  await t.test(
    'pg-boss worker recovers a durable sync request after queue restart',
    async () => {
      await pool.query('DELETE FROM mail_request_limits WHERE user_id=$1', [
        owner.id,
      ]);
      const synced = (
        await pool.query(
          'SELECT last_synced_at FROM mail_accounts WHERE id=$1',
          [accountId],
        )
      ).rows[0].last_synced_at.getTime();
      assert.equal(
        (await request(`accounts/${accountId}/sync`, 'POST', {}, owner.cookie))
          .statusCode,
        202,
      );
      const boss = new PgBoss({ connectionString });
      const errors: unknown[] = [];
      boss.on('error', (error) => errors.push(error));
      let stop: (() => void) | undefined;
      try {
        await boss.start();
        stop = await startMailWorker(boss, pool, keys);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const row = (
            await pool.query(
              'SELECT last_synced_at FROM mail_accounts WHERE id=$1',
              [accountId],
            )
          ).rows[0];
          if (row.last_synced_at.getTime() > synced) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(
          (
            await pool.query(
              'SELECT last_synced_at FROM mail_accounts WHERE id=$1',
              [accountId],
            )
          ).rows[0].last_synced_at.getTime() > synced,
        );
        assert.deepEqual(errors, []);
        assert.ok(
          !JSON.stringify(
            (
              await pool.query('SELECT data FROM pgboss.job WHERE name=$1', [
                'mail-sync',
              ])
            ).rows,
          ).includes(imapPassword),
        );
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
    },
  );

  await t.test(
    'two IMAP accounts retain distinct messages even with matching RFC Message-IDs',
    async () => {
      server.control.addUser('second', { password: imapPassword });
      const second = await request(
        'accounts',
        'POST',
        { ...settings, username: 'second', name: 'Second account' },
        owner.cookie,
      );
      assert.equal(second.statusCode, 202, second.body);
      const secondId = second.json().account.id;
      await syncAccount(pool, keys, owner.id, secondId);
      const inbox = (
        await request('messages', 'GET', undefined, owner.cookie)
      ).json().messages;
      assert.equal(inbox.length, 4);
      assert.equal(
        new Set(inbox.map((mail: { accountId: string }) => mail.accountId))
          .size,
        2,
      );
      assert.equal(
        new Set(inbox.map((mail: { id: string }) => mail.id)).size,
        4,
      );
      assert.equal(
        (
          await request(
            `messages?account=${secondId}`,
            'GET',
            undefined,
            owner.cookie,
          )
        ).json().messages.length,
        2,
      );
      assert.equal(
        (
          await request(
            `accounts/${secondId}`,
            'DELETE',
            { password: owner.password },
            owner.cookie,
          )
        ).statusCode,
        200,
      );
    },
  );

  await t.test(
    'history selection excludes old mail and account limits are atomic',
    async () => {
      server.control.addUser('history', { password: imapPassword });
      const old = server.control.addMessage('INBOX', {
        raw: rawMail('Old historical mail'),
        internaldate: new Date('2020-01-01T00:00:00Z'),
        flags: [],
      });
      const connected = await request(
        'accounts',
        'POST',
        { ...settings, username: 'history', history: '90d' },
        owner.cookie,
      );
      assert.equal(connected.statusCode, 202, connected.body);
      const id = connected.json().account.id;
      await syncAccount(pool, keys, owner.id, id);
      assert.equal(
        (
          await request(
            `messages?account=${id}`,
            'GET',
            undefined,
            owner.cookie,
          )
        ).json().messages.length,
        2,
      );
      assert.equal(
        (
          await request(
            `accounts/${id}`,
            'DELETE',
            { password: owner.password },
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      server.control.expungeMessages('INBOX', [old.uid]);
      const attempts = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          request(
            'accounts',
            'POST',
            { ...settings, username: `limit-${i}` },
            owner.cookie,
          ),
        ),
      );
      assert.equal(
        attempts.filter((response) => response.statusCode === 202).length,
        4,
      );
      assert.equal(
        attempts.filter((response) => response.statusCode === 409).length,
        2,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM mail_accounts WHERE user_id=$1',
            [owner.id],
          )
        ).rows[0].count,
        5,
      );
      await pool.query(
        'DELETE FROM mail_accounts WHERE user_id=$1 AND id<>$2',
        [owner.id, accountId],
      );
    },
  );

  await t.test(
    'mail connection and refresh rates are persistent per user',
    async () => {
      const missing = '00000000-0000-4000-8000-000000000001';
      for (let i = 0; i < 10; i++)
        assert.equal(
          (await request(`accounts/${missing}/sync`, 'POST', {}, other.cookie))
            .statusCode,
          404,
        );
      assert.equal(
        (await request(`accounts/${missing}/sync`, 'POST', {}, other.cookie))
          .statusCode,
        429,
      );
    },
  );

  await t.test(
    'disconnect needs password confirmation and stops stale jobs from recreating mail',
    async () => {
      assert.equal(
        (
          await request(
            `accounts/${accountId}`,
            'DELETE',
            { password: 'wrong password' },
            owner.cookie,
          )
        ).statusCode,
        403,
      );
      const lease = await claimAccount(pool, owner.id, accountId);
      assert.ok(lease);
      assert.equal(
        (
          await request(
            `accounts/${accountId}`,
            'DELETE',
            { password: owner.password },
            owner.cookie,
          )
        ).statusCode,
        200,
      );
      await assert.rejects(withLease(pool, lease, async () => {}));
      await pollAccount();
      for (const table of [
        'mail_accounts',
        'mailboxes',
        'mail_messages',
        'mail_memberships',
      ])
        assert.equal(
          Number(
            (
              await pool.query(
                `SELECT count(*) FROM ${table} WHERE user_id=$1`,
                [owner.id],
              )
            ).rows[0].count,
          ),
          0,
        );
      assert.equal(server.control.getMailbox('INBOX').messages, 2);
    },
  );
});

test('IMAP TLS transport refuses invalid certificates and STARTTLS downgrade', {
  timeout: 30000,
}, async (t) => {
  await t.test('implicit TLS validates the server certificate', async (t) => {
    const fixture = await imapFixture(t);
    fixture.trustCertificate(false);
    await assert.rejects(
      connectImap(
        {
          host: 'localhost',
          port: fixture.port,
          transport: 'tls',
          username: 'testuser',
        },
        imapPassword,
      ),
      /IMAP connection failed/,
    );
    fixture.trustCertificate(true);
    const client = await connectImap(
      {
        host: 'localhost',
        port: fixture.port,
        transport: 'tls',
        username: 'testuser',
      },
      imapPassword,
    );
    assert.equal(client.secureConnection, true);
    client.close();
  });
  await t.test(
    'required STARTTLS upgrades before authentication',
    async (t) => {
      const fixture = await imapFixture(t, false);
      const client = await connectImap(
        {
          host: 'localhost',
          port: fixture.port,
          transport: 'starttls',
          username: 'testuser',
        },
        imapPassword,
      );
      assert.equal(client.secureConnection, true);
      client.close();
    },
  );
  await t.test('a server without STARTTLS is rejected', async (t) => {
    const fixture = await imapFixture(t, false, false);
    await assert.rejects(
      connectImap(
        {
          host: 'localhost',
          port: fixture.port,
          transport: 'starttls',
          username: 'testuser',
        },
        imapPassword,
      ),
      /IMAP connection failed/,
    );
  });
});
