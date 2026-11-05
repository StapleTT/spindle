import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { fetchMessageContent } from '../src/mail/content-worker.js';
import { decryptCredential, readMailKeys } from '../src/mail/credentials.js';
import { syncGmailAccount } from '../src/mail/gmail.js';
import { applyGmailActions } from '../src/mail/gmail-mail.js';
import { connectImap } from '../src/mail/imap.js';
import { processOutgoing } from '../src/mail/outgoing-worker.js';
import { connectSmtp } from '../src/mail/smtp.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { fakeGoogle, type Identity } from './google-fixture.js';

test('Gmail OAuth connection, sync, reader, actions and sending', {
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

  await t.test('display names are editable and survive reconnect', async () => {
    const rename = (cookie: string, name: unknown) =>
      app.inject({
        method: 'PATCH',
        url: `/api/mail/accounts/${accountA}/name`,
        remoteAddress: '198.51.100.250',
        headers: { cookie, origin: testConfig.appUrl },
        payload: { name },
      });
    await pool.query('DELETE FROM mail_request_limits');
    const renamed = await rename(owner.cookie, '  Personal Gmail  ');
    assert.equal(renamed.statusCode, 200, renamed.body);
    assert.equal(renamed.json().account.name, 'Personal Gmail');
    for (const bad of ['   ', '', 'x'.repeat(101), 'tab\there'])
      assert.equal((await rename(owner.cookie, bad)).statusCode, 400, bad);
    await pool.query('DELETE FROM mail_request_limits');
    assert.equal((await rename(other.cookie, 'Hijack')).statusCode, 404);
    const again = await connect(owner.cookie, subjectA, {
      refresh: null,
      body: { history: 'all', accountId: accountA },
    });
    assert.equal(again.result, 'connected');
    const row = await account(owner.id, subjectA.sub);
    assert.equal(row.name, 'Personal Gmail');
    assert.equal(row.username, subjectA.email);
  });

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
      // Paced under Gmail's per-user quota: no request was rate limited.
      assert.ok(
        google.state.peakPerSecond <= 50,
        String(google.state.peakPerSecond),
      );
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
          ['[All Mail]', 'Archive', '\\Archive'],
        ],
      );
      assert.ok(paths.every((row) => row.initial_complete));
      const m1 = await local('m1');
      assert.equal(m1.subject, 'Ünicode receipt');
      assert.deepEqual(m1.paths, ['INBOX', 'Label_1']);
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
      google.record({
        labelsRemoved: [{ message: { id: 'm1' }, labelIds: ['UNREAD'] }],
      });
      google.messages.delete('m2');
      google.record({ messagesDeleted: [{ message: { id: 'm2' } }] });
      google.messages.get('m4')?.labels.add('TRASH');
      google.messages.get('m4')?.labels.delete('SENT');
      google.record({
        labelsRemoved: [{ message: { id: 'm4' }, labelIds: ['SENT'] }],
        labelsAdded: [{ message: { id: 'm4' }, labelIds: ['TRASH'] }],
      });
      const gets = google.state.gets;
      assert.equal((await sync()).status, 'ready');
      // Only the new message is fetched; label changes apply as deltas.
      assert.equal(google.state.gets - gets, 1);
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
    'bulk label changes apply locally without refetching or size caps',
    async () => {
      const bulk = Array.from({ length: 100 }, (_, index) => `bulk${index}`);
      for (const remote of bulk)
        google.messages.get(remote)?.labels.add('STARRED');
      // One record far larger than any per-page fetch budget, including
      // messages outside the 90-day window that are not mirrored locally.
      google.record({
        labelsAdded: [
          ...bulk,
          ...Array.from({ length: 1500 }, (_, index) => `elsewhere${index}`),
        ].map((remote) => ({ message: { id: remote }, labelIds: ['STARRED'] })),
      });
      const gets = google.state.gets;
      assert.equal((await sync()).status, 'ready');
      assert.equal(google.state.gets, gets);
      assert.deepEqual((await local('bulk7')).flags, ['\\Seen', '\\Flagged']);
      assert.equal(await local('elsewhere1'), undefined);
    },
  );

  await t.test(
    'quota exhaustion pauses without an error state and then resumes',
    async () => {
      add('quota1', ['INBOX'], 'Arrived during quota exhaustion');
      google.record({ messagesAdded: [{ message: { id: 'quota1' } }] });
      google.state.exhausted = true;
      const paused = await sync();
      assert.equal(paused.status, 'syncing');
      assert.equal(paused.error_code, null);
      assert.ok(paused.next_sync_at > new Date(Date.now() + 50000));
      assert.equal(await local('quota1'), undefined);
      google.state.exhausted = false;
      assert.equal((await sync()).status, 'ready');
      assert.ok(await local('quota1'));
      assert.equal(
        (
          await pool.query('SELECT failures FROM mail_accounts WHERE id=$1', [
            accountA,
          ])
        ).rows[0].failures,
        0,
      );
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
      assert.equal(await count(), 106);
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
    'pre-D040 All Mail is recomputed locally; leaving Trash refetches labels',
    async () => {
      // Simulate the slice-1 folder: inbox mail also had an All Mail copy.
      const m1 = (await local('m1')).id;
      await pool.query(
        "UPDATE mailboxes SET role='\\All',name='All Mail' WHERE account_id=$1 AND path='[All Mail]'",
        [accountA],
      );
      await pool.query(
        `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,flags)
         SELECT $1,$2,b.id,$3,'{\\Seen}' FROM mailboxes b WHERE b.account_id=$2 AND b.path='[All Mail]'`,
        [owner.id, accountA, m1],
      );
      const gets = google.state.gets;
      assert.equal((await sync()).status, 'ready');
      assert.equal(google.state.gets, gets, 'no refetch for the recompute');
      assert.deepEqual((await local('m1')).paths, ['INBOX', 'Label_1']);
      assert.ok(await local('bulk3'));
      // Trashed elsewhere with its labels kept; restored elsewhere later.
      google.messages.get('bulk3')?.labels.add('TRASH');
      google.record({
        labelsAdded: [{ message: { id: 'bulk3' }, labelIds: ['TRASH'] }],
      });
      assert.equal((await sync()).status, 'ready');
      assert.deepEqual((await local('bulk3')).paths, ['TRASH']);
      google.messages.get('bulk3')?.labels.delete('TRASH');
      google.record({
        labelsRemoved: [{ message: { id: 'bulk3' }, labelIds: ['TRASH'] }],
      });
      assert.equal((await sync()).status, 'ready');
      assert.deepEqual((await local('bulk3')).paths, ['INBOX']);
    },
  );

  const cleared = () =>
    pool.query(
      'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE id=$1',
      [accountA],
    );
  let rich = '';
  await t.test(
    'the reader caches sanitized Gmail bodies and attachments without changing flags',
    async () => {
      add('rich', ['INBOX', 'UNREAD'], 'Rich message');
      const message = google.messages.get('rich');
      assert.ok(message);
      message.raw = [
        'From: Rich Sender <rich@example.test>',
        'To: owner@gmail.test',
        'Subject: Rich message',
        'Message-ID: <rich@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Gmail body</p><script>alert(1)</script>',
        '--b1',
        'Content-Type: text/plain; name="report.txt"',
        'Content-Disposition: attachment; filename="report.txt"',
        '',
        'Synthetic attachment',
        '--b1--',
        '',
      ].join('\r\n');
      google.record({ messagesAdded: [{ message: { id: 'rich' } }] });
      assert.equal((await sync()).status, 'ready');
      rich = (await local('rich')).id;
      const opened = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${rich}/content`,
        {},
      );
      assert.ok(opened.statusCode < 300, opened.body);
      const version = (
        await pool.query(
          'SELECT version FROM mail_content WHERE message_id=$1',
          [rich],
        )
      ).rows[0].version;
      await cleared();
      await fetchMessageContent(
        pool,
        keys,
        { userId: owner.id, accountId: accountA, messageId: rich, version },
        connectImap,
        google.config,
      );
      const cached = (
        await pool.query(
          'SELECT state,html,attachments FROM mail_content WHERE message_id=$1',
          [rich],
        )
      ).rows[0];
      assert.equal(cached.state, 'ready');
      assert.match(cached.html, /Gmail body/);
      assert.doesNotMatch(cached.html, /<script/);
      assert.deepEqual(cached.attachments, [
        {
          part: '0',
          filename: 'report.txt',
          contentType: 'text/plain',
          size: 20,
        },
      ]);
      const detail = (
        await call(owner.cookie, 'GET', `/api/mail/messages/${rich}`)
      ).json();
      assert.equal(detail.content.state, 'ready');
      assert.equal(detail.content.attachments[0].state, 'missing');
      const download = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${rich}/attachments/0`,
        {},
      );
      assert.ok(download.statusCode < 300, download.body);
      await cleared();
      await fetchMessageContent(
        pool,
        keys,
        {
          userId: owner.id,
          accountId: accountA,
          messageId: rich,
          version,
          attachment: 0,
        },
        connectImap,
        google.config,
      );
      const file = (
        await pool.query(
          'SELECT state,data FROM mail_content_attachments WHERE message_id=$1',
          [rich],
        )
      ).rows[0];
      assert.equal(file.state, 'ready');
      assert.equal(file.data.toString(), 'Synthetic attachment');
      // Opening and downloading never mark mail read at Gmail.
      assert.ok(google.messages.get('rich')?.labels.has('UNREAD'));
      assert.deepEqual(google.state.modifies, []);
      // Replies work from the cached reply headers.
      const reply = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${rich}/compose`,
        { id: randomUUID(), kind: 'reply' },
      );
      assert.equal(reply.statusCode, 201, reply.body);
    },
  );

  // Queues an action, skips its five-second undo grace and applies it.
  const act = async (message: string, body: object) => {
    const id = randomUUID();
    const queued = await call(
      owner.cookie,
      'POST',
      `/api/mail/messages/${message}/actions`,
      { id, ...body },
    );
    assert.ok(queued.statusCode < 300, queued.body);
    await pool.query(
      "UPDATE mail_actions SET next_attempt_at=now() WHERE id=$1 AND state='pending'",
      [id],
    );
    await cleared();
    await applyGmailActions(pool, keys, google.config, owner.id, accountA);
    return (
      await pool.query(
        'SELECT state,error_code FROM mail_actions WHERE id=$1',
        [id],
      )
    ).rows[0];
  };
  const box = async (path: string) =>
    (
      await pool.query(
        'SELECT id FROM mailboxes WHERE account_id=$1 AND path=$2',
        [accountA, path],
      )
    ).rows[0].id;
  const labels = (remote: string) =>
    [...(google.messages.get(remote)?.labels ?? [])].sort();

  await t.test(
    'actions change Gmail labels and local folders through durable intents',
    async () => {
      const applied = { state: 'applied', error_code: null };
      // Every job below reuses the worker's cached access token.
      const refreshes = google.refreshCount();
      assert.deepEqual(await act(rich, { kind: 'read' }), applied);
      assert.deepEqual(labels('rich'), ['INBOX']);
      assert.deepEqual((await local('rich')).flags, ['\\Seen']);
      assert.deepEqual(await act(rich, { kind: 'unread' }), applied);
      assert.deepEqual(labels('rich'), ['INBOX', 'UNREAD']);
      assert.deepEqual(await act(rich, { kind: 'archive' }), applied);
      assert.deepEqual(labels('rich'), ['UNREAD']);
      assert.deepEqual((await local('rich')).paths, ['[All Mail]']);
      assert.deepEqual(await act(rich, { kind: 'restore' }), applied);
      assert.deepEqual(labels('rich'), ['INBOX', 'UNREAD']);
      assert.deepEqual((await local('rich')).paths, ['INBOX']);
      assert.deepEqual(await act(rich, { kind: 'trash' }), applied);
      assert.deepEqual((await local('rich')).paths, ['TRASH']);
      // Restoring from Trash untrashes and returns to the original folder.
      assert.deepEqual(await act(rich, { kind: 'restore' }), applied);
      assert.deepEqual(labels('rich'), ['INBOX', 'UNREAD']);
      assert.deepEqual((await local('rich')).paths, ['INBOX']);
      // Moving out of the inbox into a label, as Gmail's "Move to" does.
      assert.deepEqual(
        await act(rich, { kind: 'move', mailbox: await box('Label_1') }),
        applied,
      );
      assert.deepEqual(labels('rich'), ['Label_1', 'UNREAD']);
      assert.deepEqual((await local('rich')).paths, ['Label_1', '[All Mail]']);
      assert.deepEqual(
        await act(rich, { kind: 'move', mailbox: await box('SENT') }),
        { state: 'failed', error_code: 'label_unsupported' },
      );
      assert.deepEqual(labels('rich'), ['Label_1', 'UNREAD']);
      // Mail deleted in Gmail is a conflict, never a blind retry.
      add('gone', ['INBOX'], 'Deleted elsewhere');
      google.record({ messagesAdded: [{ message: { id: 'gone' } }] });
      await sync();
      const gone = (await local('gone')).id;
      google.messages.delete('gone');
      assert.deepEqual(await act(gone, { kind: 'archive' }), {
        state: 'conflict',
        error_code: 'message_missing',
      });
      assert.equal(google.refreshCount(), refreshes);
    },
  );

  await t.test(
    'undo inside the grace period never reaches Gmail; quota pauses keep attempts',
    async () => {
      const before = google.state.modifies.length;
      const id = randomUUID();
      const queued = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${rich}/actions`,
        { id, kind: 'trash' },
      );
      assert.ok(queued.statusCode < 300, queued.body);
      const undone = await call(
        owner.cookie,
        'POST',
        `/api/mail/actions/${id}/undo`,
        {},
      );
      assert.equal(undone.statusCode, 200, undone.body);
      await cleared();
      await applyGmailActions(pool, keys, google.config, owner.id, accountA);
      assert.equal(google.state.modifies.length, before);
      assert.deepEqual((await local('rich')).paths, ['Label_1', '[All Mail]']);
      // Rate-limited actions wait without spending an attempt.
      google.state.exhausted = true;
      const pausedId = randomUUID();
      await call(owner.cookie, 'POST', `/api/mail/messages/${rich}/actions`, {
        id: pausedId,
        kind: 'read',
      });
      await pool.query(
        'UPDATE mail_actions SET next_attempt_at=now() WHERE id=$1',
        [pausedId],
      );
      await cleared();
      await applyGmailActions(pool, keys, google.config, owner.id, accountA);
      const paused = (
        await pool.query(
          "SELECT state,attempts,next_attempt_at>now()+interval '50 seconds' AS deferred FROM mail_actions WHERE id=$1",
          [pausedId],
        )
      ).rows[0];
      assert.deepEqual(paused, {
        state: 'pending',
        attempts: 0,
        deferred: true,
      });
      // Until applied, the optimistic read state stays local.
      assert.deepEqual((await local('rich')).flags, ['\\Seen']);
      google.state.exhausted = false;
      await pool.query(
        'UPDATE mail_actions SET next_attempt_at=now() WHERE id=$1',
        [pausedId],
      );
      await cleared();
      await applyGmailActions(pool, keys, google.config, owner.id, accountA);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT state,attempts FROM mail_actions WHERE id=$1',
            [pausedId],
          )
        ).rows[0],
        { state: 'applied', attempts: 0 },
      );
      assert.deepEqual(labels('rich'), ['Label_1']);
    },
  );

  await t.test(
    'sending uses messages.send with the Gmail sender name, Bcc and outcome rules',
    async () => {
      const accounts = (await call(owner.cookie, 'GET', '/api/mail/accounts'))
        .json()
        .accounts.find((item: { id: string }) => item.id === accountA);
      assert.equal(accounts.smtpState, 'ready');
      assert.equal(accounts.sender, subjectA.email);
      assert.equal(accounts.senderName, 'Synthetic Owner');
      const draft = async (subject: string) => {
        const id = randomUUID();
        const saved = await app.inject({
          method: 'PUT',
          url: `/api/mail/drafts/${id}`,
          remoteAddress: '198.51.100.251',
          headers: { cookie: owner.cookie, origin: testConfig.appUrl },
          payload: {
            revision: 0,
            saveId: randomUUID(),
            accountId: accountA,
            content: {
              to: 'friend@example.test',
              cc: '',
              bcc: 'hidden@example.test',
              subject,
              format: 'plain',
              html: '',
              text: 'Hello from Spindle',
            },
          },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        return id;
      };
      const send = async (subject: string) => {
        const id = await draft(subject);
        const operation = randomUUID();
        await pool.query('DELETE FROM mail_request_limits');
        const queued = await call(
          owner.cookie,
          'POST',
          `/api/mail/drafts/${id}/send`,
          { id: operation, revision: 1 },
        );
        assert.equal(queued.statusCode, 202, queued.body);
        await pool.query(
          'UPDATE mail_outbox SET next_attempt_at=now() WHERE id=$1',
          [operation],
        );
        await cleared();
        await processOutgoing(
          pool,
          keys,
          owner.id,
          accountA,
          connectSmtp,
          connectImap,
          google.config,
        );
        return { id, operation };
      };
      const outbox = async (id: string) =>
        (
          await pool.query(
            'SELECT state,error_code,sent_copy,attempts FROM mail_outbox WHERE id=$1',
            [id],
          )
        ).rows[0];
      const sent = await send('Gmail send');
      assert.deepEqual(await outbox(sent.operation), {
        state: 'accepted',
        error_code: null,
        sent_copy: 'saved',
        attempts: 1,
      });
      const raw = google.sent.at(-1) ?? '';
      assert.match(raw, /^From: Synthetic Owner <owner@gmail\.test>$/m);
      assert.match(raw, /^To: friend@example\.test$/m);
      assert.match(raw, /^Bcc: hidden@example\.test$/m);
      assert.match(raw, /^Subject: Gmail send$/m);
      assert.equal(
        (await pool.query('SELECT 1 FROM mail_drafts WHERE id=$1', [sent.id]))
          .rowCount,
        0,
      );
      // A 4xx rejection fails and keeps the draft.
      google.state.send = 'reject';
      const rejected = await send('Rejected send');
      assert.deepEqual(await outbox(rejected.operation), {
        state: 'failed',
        error_code: 'gmail_rejected',
        sent_copy: 'pending',
        attempts: 1,
      });
      // Rate limiting is temporary: queued again, nothing sent.
      google.state.send = 'rate';
      const limited = await send('Rate limited send');
      assert.equal((await outbox(limited.operation)).state, 'queued');
      // A lost response is unknown and never resent; the Sent search confirms it.
      google.state.send = 'lost';
      const count = google.sent.length;
      const lost = await send('Lost response send');
      assert.equal(google.sent.length, count + 1);
      assert.equal((await outbox(lost.operation)).state, 'unknown');
      google.state.send = 'ok';
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=now() WHERE id=$1',
        [lost.operation],
      );
      await cleared();
      await processOutgoing(
        pool,
        keys,
        owner.id,
        accountA,
        connectSmtp,
        connectImap,
        google.config,
      );
      assert.deepEqual(await outbox(lost.operation), {
        state: 'unknown',
        error_code: 'delivery_unknown',
        sent_copy: 'saved',
        attempts: 1,
      });
      // The rate-limited send goes out once on its retry; the lost one stays unsent.
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=now() WHERE id=$1',
        [limited.operation],
      );
      await cleared();
      await processOutgoing(
        pool,
        keys,
        owner.id,
        accountA,
        connectSmtp,
        connectImap,
        google.config,
      );
      assert.equal((await outbox(limited.operation)).state, 'accepted');
      assert.equal(google.sent.length, count + 2);
      // SMTP settings still do not apply to Gmail.
      assert.equal(
        (await call(owner.cookie, 'GET', `/api/mail/accounts/${accountA}/smtp`))
          .statusCode,
        409,
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
    'the worker serves Gmail content before sync and never runs IMAP jobs for it',
    async () => {
      const boss = new PgBoss({ connectionString });
      boss.on('error', () => undefined);
      await boss.start();
      const stop = await startMailWorker(boss, pool, keys, google.config);
      t.after(async () => {
        stop();
        await boss.stop({ graceful: false });
      });
      // A requested body is fetched first (user work outranks metadata), then
      // sync resumes; neither path reaches IMAP code.
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
      assert.deepEqual(content, { state: 'ready', error_code: null });
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
