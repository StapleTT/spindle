import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { decryptCredential, readMailKeys } from '../src/mail/credentials.js';
import { syncGmailAccount } from '../src/mail/gmail.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { fakeGoogle, type Identity } from './google-fixture.js';

test('Gmail OAuth connection and read-only metadata sync', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 180000,
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
      v1: Buffer.alloc(32, 77).toString('base64'),
    }),
  });
  const google = await fakeGoogle();
  t.after(() => google.app.close());
  const app = testApp(
    pool,
    testConfig,
    undefined,
    keys,
    undefined,
    google.config,
  );
  t.after(() => app.close());
  let ip = 0;
  const call = async (
    cookie: string,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
  ) => {
    await pool.query('DELETE FROM mail_request_limits');
    return app.inject({
      method,
      url,
      remoteAddress: `198.51.100.${(ip++ % 200) + 1}`,
      headers: { cookie, origin: testConfig.appUrl },
      ...(payload ? { payload } : {}),
    });
  };
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'gmail-owner@example.test',
    '203.0.113.31',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'gmail-other@example.test',
    '203.0.113.32',
  );
  const subjectA = { sub: 'google-sub-a', email: 'owner@gmail.test' };
  const subjectB = { sub: 'google-sub-b', email: 'second@gmail.test' };
  const full = `openid email https://www.googleapis.com/auth/gmail.modify`;

  // Starts authorization and returns the state plus PKCE challenge from the URL.
  const start = async (cookie: string, body: object = { history: 'all' }) => {
    const response = await call(cookie, 'POST', '/api/mail/oauth/google', body);
    assert.equal(response.statusCode, 200, response.body);
    const url = new URL(response.json().url);
    return {
      url,
      state: url.searchParams.get('state') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
    };
  };
  const callback = async (cookie: string, query: Record<string, string>) => {
    const response = await call(
      cookie,
      'GET',
      `/api/mail/oauth/google/callback?${new URLSearchParams(query)}`,
    );
    assert.equal(response.statusCode, 303, response.body);
    const location = String(response.headers.location);
    assert.ok(
      location.startsWith(`${testConfig.appUrl}/inbox#view=settings&gmail=`),
    );
    assert.doesNotMatch(location, /access-|refresh-|code/);
    return location.split('gmail=')[1];
  };
  const connect = async (
    cookie: string,
    identity: Identity,
    options: { scope?: string; refresh?: string | null; body?: object } = {},
  ) => {
    const begun = await start(cookie, options.body);
    const code = `code-${randomUUID()}`;
    google.codes.set(code, {
      identity,
      scope: options.scope ?? full,
      challenge: begun.challenge,
      ...(options.refresh === null
        ? {}
        : { refresh: options.refresh ?? `refresh-${randomUUID()}` }),
    });
    return {
      result: await callback(cookie, { state: begun.state, code }),
      ...begun,
      code,
    };
  };
  const account = async (user: string, sub: string) =>
    (
      await pool.query(
        "SELECT * FROM mail_accounts WHERE user_id=$1 AND provider='gmail' AND provider_account=$2",
        [user, sub],
      )
    ).rows[0];

  await t.test(
    'authorization URL uses PKCE, exact redirect and minimal scopes',
    async () => {
      const { url, state } = await start(owner.cookie);
      assert.equal(url.origin + url.pathname, google.config.authUrl);
      assert.equal(
        url.searchParams.get('redirect_uri'),
        `${testConfig.appUrl}/api/mail/oauth/google/callback`,
      );
      assert.equal(url.searchParams.get('scope'), full);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(url.searchParams.get('access_type'), 'offline');
      assert.equal(url.searchParams.get('prompt'), 'consent');
      assert.equal(url.searchParams.get('response_type'), 'code');
      assert.ok(state.length >= 43);
      const saved = (
        await pool.query('SELECT state_hash FROM mail_oauth_states')
      ).rows.map((row) => row.state_hash);
      assert.ok(
        saved.includes(createHash('sha256').update(state).digest('hex')),
      );
      assert.ok(!saved.includes(state), 'only the state hash is stored');
    },
  );

  let accountA = '';
  let refreshA = '';
  await t.test(
    'connect, then refuse replayed, foreign-session, foreign-user and expired states',
    async () => {
      refreshA = 'refresh-owner-a';
      const connected = await connect(owner.cookie, subjectA, {
        refresh: refreshA,
      });
      assert.equal(connected.result, 'connected');
      const row = await account(owner.id, subjectA.sub);
      accountA = row.id;
      assert.equal(row.username, subjectA.email);
      assert.equal(row.name, subjectA.email);
      assert.equal(row.host, null);
      assert.equal(row.history_since, null);
      assert.equal(
        decryptCredential(row.credential, owner.id, row.id, keys),
        refreshA,
      );
      assert.ok(!row.credential.includes(refreshA));
      // Replay of a consumed state.
      assert.equal(
        await callback(owner.cookie, {
          state: connected.state,
          code: 'replay',
        }),
        'expired',
      );
      // Another sign-in session of the same user.
      const second = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        remoteAddress: '203.0.113.33',
        headers: { origin: testConfig.appUrl },
        payload: { email: owner.email, password: owner.password },
      });
      assert.equal(second.statusCode, 200, second.body);
      const secondCookie = [second.headers['set-cookie']]
        .flat()
        .map((value) => String(value).split(';')[0])
        .join('; ');
      const begun = await start(owner.cookie);
      assert.equal(
        await callback(secondCookie, { state: begun.state, code: 'x' }),
        'expired',
      );
      // Another user cannot use the owner's state; it stays valid for the owner.
      const foreign = await start(owner.cookie);
      assert.equal(
        await callback(other.cookie, { state: foreign.state, code: 'x' }),
        'expired',
      );
      // Expired state.
      const old = await start(owner.cookie);
      await pool.query(
        "UPDATE mail_oauth_states SET expires_at=now()-interval '1 second'",
      );
      assert.equal(
        await callback(owner.cookie, { state: old.state, code: 'x' }),
        'expired',
      );
      assert.equal(await callback(owner.cookie, { code: 'x' }), 'expired');
      // Provider denial consumes the state without an exchange.
      const denied = await start(owner.cookie);
      assert.equal(
        await callback(owner.cookie, {
          state: denied.state,
          error: 'access_denied',
        }),
        'denied',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM mail_accounts WHERE user_id=$1',
            [owner.id],
          )
        ).rows[0].n,
        1,
      );
    },
  );

  await t.test(
    'missing Gmail scope and account substitution are refused and revoked',
    async () => {
      const before = google.revoked.length;
      const partial = await connect(owner.cookie, subjectB, {
        scope: 'openid email',
        refresh: 'refresh-partial',
      });
      assert.equal(partial.result, 'scope');
      assert.equal(await account(owner.id, subjectB.sub), undefined);
      assert.deepEqual(google.revoked.slice(before), ['refresh-partial']);
      const swapped = await connect(owner.cookie, subjectB, {
        refresh: 'refresh-swap',
        body: { history: 'all', accountId: accountA },
      });
      assert.equal(swapped.result, 'mismatch');
      assert.equal(await account(owner.id, subjectB.sub), undefined);
      assert.ok(google.revoked.includes('refresh-swap'));
      assert.equal(
        decryptCredential(
          (await account(owner.id, subjectA.sub)).credential,
          owner.id,
          accountA,
          keys,
        ),
        refreshA,
      );
      // Reconnect targets must be owned Gmail accounts.
      const foreignTarget = await call(
        other.cookie,
        'POST',
        '/api/mail/oauth/google',
        { history: 'all', accountId: accountA },
      );
      assert.equal(foreignTarget.statusCode, 404);
    },
  );

  await t.test(
    'reconnect keeps the stored refresh token when Google omits one',
    async () => {
      await pool.query(
        "UPDATE mail_accounts SET status='error',error_code='reconnect_required',next_sync_at=now()+interval '30 days' WHERE id=$1",
        [accountA],
      );
      const again = await connect(owner.cookie, subjectA, {
        refresh: null,
        body: { history: 'all', accountId: accountA },
      });
      assert.equal(again.result, 'connected');
      assert.equal(again.url.searchParams.get('login_hint'), subjectA.email);
      const row = await account(owner.id, subjectA.sub);
      assert.equal(row.id, accountA);
      assert.equal(row.status, 'pending');
      assert.equal(row.error_code, null);
      assert.ok(row.next_sync_at <= new Date());
      assert.equal(
        decryptCredential(row.credential, owner.id, accountA, keys),
        refreshA,
      );
      // A new connection without a refresh token cannot work and is refused.
      const none = await connect(owner.cookie, subjectB, { refresh: null });
      assert.equal(none.result, 'failed');
      assert.equal(await account(owner.id, subjectB.sub), undefined);
    },
  );

  await t.test(
    'the five-account limit covers OAuth and IMAP accounts',
    async () => {
      for (let index = 0; index < 4; index++)
        await pool.query(
          `INSERT INTO mail_accounts(user_id,name,host,port,transport,username,credential) VALUES($1,'Limit','imap.example.test',993,'tls',$2,'x')`,
          [owner.id, `limit-${index}`],
        );
      const refused = await call(
        owner.cookie,
        'POST',
        '/api/mail/oauth/google',
        { history: 'all' },
      );
      assert.equal(refused.statusCode, 409);
      await pool.query(
        "DELETE FROM mail_accounts WHERE user_id=$1 AND name='Limit'",
        [owner.id],
      );
      const listed = await call(owner.cookie, 'GET', '/api/mail/accounts');
      assert.equal(listed.json().gmail, true);
      assert.equal(listed.json().accounts[0].provider, 'gmail');
    },
  );

  const day = 86400000;
  const now = Date.now();
  const add = (id: string, labels: string[], subject: string, age = 0) =>
    google.messages.set(id, {
      labels: new Set(labels),
      internalDate: now - age,
      headers: {
        From: '"Synthetic Sender" <sender@example.test>',
        To: 'owner@gmail.test',
        Subject: subject,
        Date: new Date(now - age).toUTCString(),
        'Message-Id': `<${id}@example.test>`,
      },
    });
  add(
    'm1',
    ['INBOX', 'UNREAD', 'Label_1', 'CATEGORY_PERSONAL'],
    '=?UTF-8?B?w5xuaWNvZGUgcmVjZWlwdA==?=',
  );
  add('m2', ['INBOX', 'STARRED'], 'Starred and read');
  add('m3', ['SPAM', 'UNREAD'], 'Spam message');
  add('m4', ['SENT'], 'Sent message');
  add('m5', ['DRAFT'], 'Draft message');
  add('m6', [], 'Archived message');
  add('old', ['INBOX'], 'Too old for the window', 200 * day);
  for (let index = 0; index < 100; index++)
    add(`bulk${index}`, ['INBOX'], `Bulk ${index}`, day + index * 1000);

  const local = async (remote: string) =>
    (
      await pool.query(
        `SELECT m.id,m.subject,m.notification_at,array_agg(b.path ORDER BY b.path COLLATE "C") AS paths,
         (SELECT x.flags FROM mail_memberships x WHERE x.message_id=m.id LIMIT 1) AS flags
         FROM mail_messages m JOIN mail_memberships mm ON mm.message_id=m.id JOIN mailboxes b ON b.id=mm.mailbox_id
         WHERE m.account_id=$1 AND m.remote_key=$2 GROUP BY m.id`,
        [accountA, remote],
      )
    ).rows[0];
  const count = async () =>
    (
      await pool.query(
        'SELECT count(*)::int AS n FROM mail_messages WHERE account_id=$1',
        [accountA],
      )
    ).rows[0].n;
  const sync = async () => {
    await pool.query(
      'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE id=$1',
      [accountA],
    );
    await syncGmailAccount(pool, keys, google.config, owner.id, accountA);
    return (
      await pool.query(
        'SELECT status,error_code,next_sync_at FROM mail_accounts WHERE id=$1',
        [accountA],
      )
    ).rows[0];
  };

  await t.test(
    'initial sync maps labels, flags and the 90-day window, resuming after a crash',
    async () => {
      await pool.query(
        "UPDATE mail_accounts SET history_since=now()-interval '90 days' WHERE id=$1",
        [accountA],
      );
      google.state.failPageToken = true;
      const failed = await sync();
      assert.equal(failed.status, 'error');
      assert.equal(failed.error_code, 'sync_failed');
      const checkpoint = (
        await pool.query('SELECT * FROM mail_gmail_sync WHERE account_id=$1', [
          accountA,
        ])
      ).rows[0];
      assert.equal(checkpoint.history_id, '1000');
      assert.equal(checkpoint.page_token, '100');
      assert.equal(checkpoint.initial_complete, false);
      assert.equal(await count(), 100);
      const calls = google.listCalls.length;
      const ready = await sync();
      assert.equal(ready.status, 'ready');
      // Resumed from the persisted page instead of relisting from the start.
      assert.deepEqual(google.listCalls.slice(calls), [
        { pageToken: '100', q: google.listCalls[0]?.q },
      ]);
      assert.match(google.listCalls[0]?.q ?? '', /^after:\d+$/);
      assert.equal(await count(), 106);
      assert.equal(await local('old'), undefined);
      const paths = (
        await pool.query(
          'SELECT path,name,role,initial_complete FROM mailboxes WHERE account_id=$1 ORDER BY path COLLATE "C"',
          [accountA],
        )
      ).rows;
      assert.deepEqual(
        paths.map((row) => [row.path, row.name, row.role]),
        [
          ['DRAFT', 'Drafts', '\\Drafts'],
          ['INBOX', 'Inbox', 'inbox'],
          ['Label_1', 'Receipts 日本', null],
          ['SENT', 'Sent', '\\Sent'],
          ['SPAM', 'Spam', '\\Junk'],
          ['TRASH', 'Trash', '\\Trash'],
          ['[All Mail]', 'All Mail', '\\All'],
        ],
      );
      assert.ok(paths.every((row) => row.initial_complete));
      const m1 = await local('m1');
      assert.equal(m1.subject, 'Ünicode receipt');
      assert.deepEqual(m1.paths, ['INBOX', 'Label_1', '[All Mail]']);
      assert.deepEqual(m1.flags, []);
      assert.equal(m1.notification_at, null, 'initial sync never notifies');
      assert.deepEqual((await local('m2')).flags, ['\\Seen', '\\Flagged']);
      assert.deepEqual((await local('m3')).paths, ['SPAM']);
      assert.deepEqual((await local('m5')).flags, ['\\Seen', '\\Draft']);
      assert.deepEqual((await local('m6')).paths, ['[All Mail]']);
      const m1Row = (
        await pool.query(
          "SELECT sender,message_id FROM mail_messages WHERE remote_key='m1'",
        )
      ).rows[0];
      assert.deepEqual(m1Row.sender, [
        { name: 'Synthetic Sender', address: 'sender@example.test' },
      ]);
      assert.equal(m1Row.message_id, '<m1@example.test>');
      // Lists, counts and search read the local mirror.
      const inbox = (await call(owner.cookie, 'GET', '/api/mail/mailboxes'))
        .json()
        .mailboxes.find((box: { path: string }) => box.path === 'INBOX');
      assert.equal(inbox.total, 102);
      assert.equal(inbox.unread, 1);
      const found = await call(
        owner.cookie,
        'GET',
        `/api/mail/messages?${new URLSearchParams({ q: 'Ünicode' })}`,
      );
      assert.deepEqual(
        found
          .json()
          .messages.map((message: { subject: string }) => message.subject),
        ['Ünicode receipt'],
      );
    },
  );

  await t.test(
    'history adds, label changes and deletions apply incrementally',
    async () => {
      add('new1', ['INBOX', 'UNREAD'], 'Fresh arrival');
      google.record({
        messagesAdded: [
          { message: { id: 'new1', labelIds: ['INBOX', 'UNREAD'] } },
        ],
      });
      google.messages.get('m1')?.labels.add('STARRED');
      google.messages.get('m1')?.labels.delete('UNREAD');
      google.record({
        labelsAdded: [{ message: { id: 'm1' }, labelIds: ['STARRED'] }],
      });
      google.messages.delete('m2');
      google.record({ messagesDeleted: [{ message: { id: 'm2' } }] });
      google.messages.get('m4')?.labels.add('TRASH');
      google.messages.get('m4')?.labels.delete('SENT');
      google.record({
        labelsRemoved: [{ message: { id: 'm4' }, labelIds: ['SENT'] }],
      });
      assert.equal((await sync()).status, 'ready');
      const fresh = await local('new1');
      assert.ok(fresh.notification_at, 'new unread inbox mail notifies');
      assert.deepEqual((await local('m1')).flags, ['\\Seen', '\\Flagged']);
      assert.equal(await local('m2'), undefined);
      assert.deepEqual((await local('m4')).paths, ['TRASH']);
      const checkpoint = (
        await pool.query(
          'SELECT history_id,page_token FROM mail_gmail_sync WHERE account_id=$1',
          [accountA],
        )
      ).rows[0];
      assert.deepEqual(checkpoint, {
        history_id: String(google.state.historyId),
        page_token: null,
      });
    },
  );

  await t.test(
    'expired history triggers a full resync that removes unlisted mail',
    async () => {
      // Deleted while history was unavailable: no history record exists.
      google.messages.delete('m6');
      google.state.minHistoryId = google.state.historyId + 1;
      google.state.historyId += 5;
      assert.equal((await sync()).status, 'ready');
      assert.equal(await local('m6'), undefined);
      assert.ok(await local('new1'));
      assert.equal(await count(), 105);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM mail_gmail_listed WHERE account_id=$1',
            [accountA],
          )
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test(
    'Gmail messages are read-only until their slices land',
    async () => {
      const message = (await local('m1')).id;
      for (const [url, body] of [
        [`/api/mail/messages/${message}/content`, {}],
        [
          `/api/mail/messages/${message}/actions`,
          { id: randomUUID(), kind: 'read' },
        ],
        [
          `/api/mail/messages/${message}/compose`,
          { id: randomUUID(), kind: 'reply' },
        ],
        [
          '/api/mail/batch-actions',
          { kind: 'read', items: [{ id: randomUUID(), messageId: message }] },
        ],
        [`/api/mail/accounts/${accountA}/smtp/test`, undefined],
      ] as const) {
        const response = await call(owner.cookie, 'POST', url, body);
        assert.equal(response.statusCode, 409, `${url}: ${response.body}`);
      }
      assert.equal(
        (await call(owner.cookie, 'GET', `/api/mail/accounts/${accountA}/smtp`))
          .statusCode,
        409,
      );
      // Another user's ID still receives the ordinary not-found answer.
      assert.equal(
        (
          await call(
            other.cookie,
            'POST',
            `/api/mail/messages/${message}/content`,
            {},
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM mail_content WHERE account_id=$1',
            [accountA],
          )
        ).rows[0].n,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM mail_actions WHERE account_id=$1',
            [accountA],
          )
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test('revoked consent requires reconnect', async () => {
    google.refreshTokens.delete(refreshA);
    const failed = await sync();
    assert.equal(failed.status, 'error');
    assert.equal(failed.error_code, 'reconnect_required');
    assert.ok(failed.next_sync_at > new Date(Date.now() + 29 * day));
    google.refreshTokens.set(refreshA, subjectA);
    assert.equal(
      (
        await connect(owner.cookie, subjectA, {
          refresh: null,
          body: { history: 'all', accountId: accountA },
        })
      ).result,
      'connected',
    );
    assert.equal((await sync()).status, 'ready');
  });

  await t.test(
    'the worker routes Gmail to the Gmail sync and never to IMAP jobs',
    async () => {
      const boss = new PgBoss({ connectionString });
      boss.on('error', () => undefined);
      await boss.start();
      const stop = await startMailWorker(boss, pool, keys, google.config);
      t.after(async () => {
        stop();
        await boss.stop({ graceful: false });
      });
      // IMAP-only work for a Gmail message must never be dispatched.
      const message = (await local('m1')).id;
      await pool.query(
        'INSERT INTO mail_content(user_id,account_id,message_id) VALUES($1,$2,$3)',
        [owner.id, accountA, message],
      );
      add('worker1', ['INBOX', 'UNREAD'], 'Worker arrival');
      google.record({ messagesAdded: [{ message: { id: 'worker1' } }] });
      await pool.query(
        'UPDATE mail_accounts SET next_sync_at=now(),lease_token=NULL,lease_until=NULL WHERE id=$1',
        [accountA],
      );
      for (
        let attempt = 0;
        attempt < 60 && !(await local('worker1'));
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(await local('worker1'));
      const content = (
        await pool.query(
          'SELECT state,error_code FROM mail_content WHERE message_id=$1',
          [message],
        )
      ).rows[0];
      assert.deepEqual(content, { state: 'pending', error_code: null });
      // No IMAP draft import is created for the synced Gmail draft (m5).
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM mail_draft_imports WHERE account_id=$1',
            [accountA],
          )
        ).rows[0].n,
        0,
      );
      await pool.query('DELETE FROM mail_content WHERE message_id=$1', [
        message,
      ]);

      // Scheduled deletion revokes the Gmail grant after the cascade commits.
      const leaving = await createTestUser(
        app,
        pool,
        testConfig,
        'gmail-leaving@example.test',
        '203.0.113.34',
      );
      const subjectC = { sub: 'google-sub-c', email: 'leaving@gmail.test' };
      assert.equal(
        (
          await connect(leaving.cookie, subjectC, {
            refresh: 'refresh-leaving',
          })
        ).result,
        'connected',
      );
      await pool.query(
        "UPDATE users SET suspended=true,deletion_due_at=now()-interval '1 second' WHERE id=$1",
        [leaving.id],
      );
      for (
        let attempt = 0;
        attempt < 60 && !google.revoked.includes('refresh-leaving');
        attempt++
      )
        await new Promise((resolve) => setTimeout(resolve, 500));
      assert.ok(google.revoked.includes('refresh-leaving'));
      assert.equal(
        (
          await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [
            leaving.id,
          ])
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test(
    'disconnect revokes only grants no other connection uses',
    async () => {
      // The other user connects the same Google account independently.
      assert.equal(
        (await connect(other.cookie, subjectA, { refresh: 'refresh-other-a' }))
          .result,
        'connected',
      );
      const otherAccount = (await account(other.id, subjectA.sub)).id;
      const before = google.revoked.length;
      const first = await call(
        owner.cookie,
        'DELETE',
        `/api/mail/accounts/${accountA}`,
        { password: owner.password },
      );
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(google.revoked.slice(before), [], 'shared grant kept');
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM mail_gmail_sync WHERE account_id=$1',
            [accountA],
          )
        ).rows[0].n,
        0,
      );
      const second = await call(
        other.cookie,
        'DELETE',
        `/api/mail/accounts/${otherAccount}`,
        { password: other.password },
      );
      assert.equal(second.statusCode, 200, second.body);
      assert.deepEqual(google.revoked.slice(before), ['refresh-other-a']);
    },
  );
});
