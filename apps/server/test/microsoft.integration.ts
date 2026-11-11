import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { fetchMessageContent } from '../src/mail/content-worker.js';
import { decryptCredential, readMailKeys } from '../src/mail/credentials.js';
import { syncGraphAccount } from '../src/mail/graph.js';
import { applyGraphActions } from '../src/mail/graph-mail.js';
import { connectImap } from '../src/mail/imap.js';
import {
  MICROSOFT_SCOPES,
  openMicrosoft,
  readMicrosoftConfig,
} from '../src/mail/microsoft.js';
import { processOutgoing } from '../src/mail/outgoing-worker.js';
import { connectSmtp } from '../src/mail/smtp.js';
import { claimAccount, releaseLease } from '../src/mail/store.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { fakeMicrosoft, type MicrosoftIdentity } from './microsoft-fixture.js';

test('Microsoft configuration is optional and requires a complete credential pair', () => {
  assert.equal(readMicrosoftConfig({}), null);
  assert.throws(() => readMicrosoftConfig({ MICROSOFT_CLIENT_ID: 'id' }));
  assert.throws(() =>
    readMicrosoftConfig({ MICROSOFT_CLIENT_SECRET: 'secret' }),
  );
  const config = readMicrosoftConfig({
    MICROSOFT_CLIENT_ID: 'id',
    MICROSOFT_CLIENT_SECRET: 'secret',
  });
  assert.equal(config?.graphUrl, 'https://graph.microsoft.com/v1.0/me');
  assert.match(config?.authUrl ?? '', /\/common\/oauth2\/v2\.0\/authorize$/);
});

test('Microsoft OAuth, Graph sync, reader, durable actions and sending', {
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
      v1: Buffer.alloc(32, 91).toString('base64'),
    }),
  });
  const microsoft = await fakeMicrosoft();
  const app = testApp(
    pool,
    testConfig,
    undefined,
    keys,
    undefined,
    null,
    microsoft.config,
  );
  t.after(async () => {
    await app.close();
    await microsoft.app.close();
  });
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'microsoft-owner@example.test',
    '203.0.113.141',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'microsoft-other@example.test',
    '203.0.113.142',
  );
  const identity = {
    sub: 'microsoft-sub-a',
    email: 'owner@outlook.test',
    name: 'Synthetic Microsoft Owner',
  };
  let ip = 0;
  const call = async (
    cookie: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  const start = async (
    cookie = owner.cookie,
    body: object = { history: 'all' },
  ) => {
    const response = await call(
      cookie,
      'POST',
      '/api/mail/oauth/microsoft',
      body,
    );
    assert.equal(response.statusCode, 200, response.body);
    const url = new URL(response.json().url);
    return {
      url,
      state: url.searchParams.get('state') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
    };
  };
  const callback = async (
    state: string,
    code: string,
    cookie = owner.cookie,
    provider = 'microsoft',
  ) => {
    const response = await call(
      cookie,
      'GET',
      `/api/mail/oauth/${provider}/callback?${new URLSearchParams({ state, code })}`,
    );
    assert.equal(response.statusCode, 303, response.body);
    const location = String(response.headers.location);
    assert.doesNotMatch(location, /access-|refresh-|code=/);
    return location.split(`${provider === 'google' ? 'gmail' : provider}=`)[1];
  };
  const connect = async (
    user: MicrosoftIdentity = identity,
    options: { scope?: string; body?: object; refresh?: string } = {},
  ) => {
    const begun = await start(owner.cookie, options.body);
    const code = `code-${randomUUID()}`;
    microsoft.codes.set(code, {
      identity: user,
      scope: options.scope ?? MICROSOFT_SCOPES,
      challenge: begun.challenge,
      refresh: options.refresh ?? `refresh-${randomUUID()}`,
    });
    return { ...begun, code, result: await callback(begun.state, code) };
  };
  let accountId = '';
  const account = async () =>
    (await pool.query('SELECT * FROM mail_accounts WHERE id=$1', [accountId]))
      .rows[0];
  const clearLease = () =>
    pool.query(
      'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE id=$1',
      [accountId],
    );
  const sync = async () => {
    await clearLease();
    await syncGraphAccount(pool, keys, microsoft.config, owner.id, accountId);
    return account();
  };
  const local = async (remote: string) =>
    (
      await pool.query(
        `SELECT m.id,m.subject,m.sender,m.notification_at,
    array_agg(b.path ORDER BY b.path) AS paths
    FROM mail_messages m JOIN mail_memberships mm ON mm.message_id=m.id AND mm.user_id=m.user_id
    JOIN mailboxes b ON b.id=mm.mailbox_id AND b.user_id=mm.user_id
    WHERE m.user_id=$1 AND m.account_id=$2 AND m.remote_key=$3 GROUP BY m.id`,
        [owner.id, accountId, remote],
      )
    ).rows[0];
  const add = (remote: string, folder = 'inbox', subject = remote) =>
    microsoft.messages.set(remote, {
      folder,
      subject,
      received: Date.now(),
      read: false,
    });

  await t.test(
    'OAuth uses PKCE, exact redirects, hashed state and encrypted refresh tokens',
    async () => {
      const connected = await connect(identity, {
        refresh: 'refresh-initial-microsoft',
      });
      assert.equal(connected.result, 'connected');
      assert.equal(
        connected.url.origin + connected.url.pathname,
        microsoft.config.authUrl,
      );
      assert.equal(connected.url.searchParams.get('scope'), MICROSOFT_SCOPES);
      assert.equal(
        connected.url.searchParams.get('code_challenge_method'),
        'S256',
      );
      assert.equal(
        connected.url.searchParams.get('redirect_uri'),
        `${testConfig.appUrl}/api/mail/oauth/microsoft/callback`,
      );
      accountId = (
        await pool.query(
          "SELECT id FROM mail_accounts WHERE user_id=$1 AND provider='microsoft' AND provider_account=$2",
          [owner.id, identity.sub],
        )
      ).rows[0].id;
      const row = await account();
      assert.equal(row.username, identity.email);
      assert.equal(row.host, null);
      assert.equal(
        decryptCredential(row.credential, owner.id, accountId, keys),
        'refresh-initial-microsoft',
      );
      assert.doesNotMatch(row.credential, /refresh-initial/);
      const begun = await start();
      const saved = (
        await pool.query(
          'SELECT state_hash,provider FROM mail_oauth_states WHERE state_hash=$1',
          [createHash('sha256').update(begun.state).digest('hex')],
        )
      ).rows[0];
      assert.equal(saved.provider, 'microsoft');
      assert.notEqual(saved.state_hash, begun.state);
      assert.equal(await callback(connected.state, connected.code), 'expired');
      assert.equal(
        await callback(begun.state, 'unused', other.cookie),
        'expired',
      );
      assert.equal(
        await callback(begun.state, 'unused', owner.cookie, 'google'),
        'expired',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM mail_oauth_states WHERE state_hash=$1',
            [saved.state_hash],
          )
        ).rowCount,
        1,
        'another user/provider cannot consume Microsoft state',
      );
      await pool.query(
        "UPDATE mail_oauth_states SET expires_at=now()-interval '1 second' WHERE state_hash=$1",
        [saved.state_hash],
      );
      assert.equal(await callback(begun.state, 'unused'), 'expired');
      const login = await call(
        owner.cookie,
        'POST',
        '/api/auth/sign-in/email',
        { email: owner.email, password: owner.password },
      );
      assert.equal(login.statusCode, 200, login.body);
      const cookie = [login.headers['set-cookie']]
        .flat()
        .map((value) => String(value).split(';')[0])
        .join('; ');
      const sessionBound = await start();
      assert.equal(
        await callback(sessionBound.state, 'unused', cookie),
        'expired',
      );
    },
  );

  await t.test(
    'missing scopes, account substitution and foreign reconnect targets are refused',
    async () => {
      assert.equal(
        (await connect(identity, { scope: 'openid profile email User.Read' }))
          .result,
        'scope',
      );
      assert.equal(
        (
          await connect(
            { sub: 'different-sub', email: 'different@outlook.test' },
            { body: { history: 'all', accountId } },
          )
        ).result,
        'mismatch',
      );
      const foreign = await call(
        other.cookie,
        'POST',
        '/api/mail/oauth/microsoft',
        { history: 'all', accountId },
      );
      assert.equal(foreign.statusCode, 404, foreign.body);
      assert.equal((await account()).provider_account, identity.sub);
      assert.equal(
        (
          await call(
            owner.cookie,
            'GET',
            `/api/mail/accounts/${accountId}/smtp`,
          )
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await call(
            other.cookie,
            'GET',
            `/api/mail/accounts/${accountId}/smtp`,
          )
        ).statusCode,
        404,
      );
    },
  );

  await t.test(
    'paged folder/message sync stores local metadata, roles and rotating tokens',
    async () => {
      add('m1', 'inbox', 'Ünicode Graph receipt');
      add('m2');
      add('m3');
      add('receipt1', 'receipts');
      microsoft.state.failPage = true;
      assert.equal((await sync()).status, 'error');
      const committed = await local('m1');
      assert.ok(committed, 'the first page committed before interruption');
      assert.equal(await local('m3'), undefined);
      assert.ok(
        (
          await pool.query(
            "SELECT next_link FROM mail_graph_sync WHERE account_id=$1 AND scope='inbox'",
            [accountId],
          )
        ).rows[0].next_link,
        'the next page survived the interrupted job',
      );
      assert.equal((await sync()).status, 'ready');
      const first = await local('m1');
      assert.equal(
        first.id,
        committed.id,
        'resuming a page preserves existing identity',
      );
      assert.equal(first.subject, 'Ünicode Graph receipt');
      assert.deepEqual(first.paths, ['inbox']);
      assert.equal(first.notification_at, null);
      assert.deepEqual(first.sender, [
        { name: 'Synthetic Sender', address: 'sender@example.test' },
      ]);
      const boxes = (
        await pool.query(
          'SELECT path,role,initial_complete FROM mailboxes WHERE account_id=$1',
          [accountId],
        )
      ).rows;
      assert.equal(boxes.find((box) => box.path === 'inbox')?.role, 'inbox');
      assert.equal(
        boxes.find((box) => box.path === 'archive')?.role,
        '\\Archive',
      );
      assert.equal(
        boxes.find((box) => box.path === 'deleteditems')?.role,
        '\\Trash',
      );
      assert.ok(boxes.every((box) => box.initial_complete));
      const credential = (await account()).credential;
      const refresh = decryptCredential(credential, owner.id, accountId, keys);
      assert.match(refresh, /^rotated-/);
      assert.ok(
        microsoft.refreshTokens.has(refresh),
        'rotated token was persisted before the next job',
      );
      const calls = microsoft.requests.length;
      const search = await call(
        owner.cookie,
        'GET',
        '/api/mail/messages?q=%C3%9Cnicode',
      );
      assert.equal(search.statusCode, 200, search.body);
      assert.equal(search.json().messages.length, 1);
      assert.equal(
        microsoft.requests.length,
        calls,
        'list/search APIs never call Graph',
      );
      assert.equal(
        (await sync()).status,
        'ready',
        'next job can use the rotated refresh token',
      );
    },
  );

  await t.test(
    'mail synchronized before the newsletter header is checked once',
    async () => {
      const m2 = microsoft.messages.get('m2');
      assert.ok(m2);
      m2.headers = [
        { name: 'Message-ID', value: '<m2@example.test>' },
        { name: 'List-Unsubscribe', value: '<mailto:leave@example.test>' },
      ];
      await pool.query(
        'UPDATE mail_messages SET list_unsubscribe=NULL WHERE account_id=$1',
        [accountId],
      );
      assert.equal((await sync()).status, 'ready');
      const flags = (
        await pool.query(
          'SELECT remote_key,list_unsubscribe FROM mail_messages WHERE account_id=$1 AND (list_unsubscribe IS NOT FALSE)',
          [accountId],
        )
      ).rows;
      assert.deepEqual(flags, [{ remote_key: 'm2', list_unsubscribe: true }]);
      const gets = microsoft.state.gets;
      await sync();
      assert.equal(microsoft.state.gets, gets, 'checked only once');
      delete m2.headers;
    },
  );

  await t.test(
    'oversized reply headers cannot block ordinary Graph metadata',
    async () => {
      microsoft.messages.set('hostile-headers', {
        folder: 'inbox',
        subject: 'Metadata survives hostile headers',
        received: Date.now(),
        read: true,
        headers: [
          'From',
          'To',
          'Cc',
          'Subject',
          'Date',
          'Message-ID',
          'In-Reply-To',
          'References',
        ].map((name) => ({ name, value: 'x'.repeat(8192) })),
      });
      microsoft.record('inbox', 'hostile-headers');
      assert.equal((await sync()).status, 'ready');
      assert.equal(
        (await local('hostile-headers')).subject,
        'Metadata survives hostile headers',
      );
    },
  );

  await t.test(
    'Graph throttling pauses without losing progress or becoming an account error',
    async () => {
      add('rate-arrival');
      microsoft.record('inbox', 'rate-arrival');
      microsoft.state.exhausted = true;
      const paused = await sync();
      assert.equal(paused.status, 'syncing');
      assert.equal(paused.error_code, null);
      assert.ok(paused.next_sync_at > new Date(Date.now() + 50000));
      assert.equal(await local('rate-arrival'), undefined);
      microsoft.state.exhausted = false;
      assert.equal((await sync()).status, 'ready');
      assert.ok(await local('rate-arrival'));
    },
  );

  let messageId = '';
  let contentVersion = '';
  await t.test(
    'reader sanitizes Graph MIME and downloads attachments without marking read',
    async () => {
      const message = microsoft.messages.get('m1');
      assert.ok(message);
      message.raw = [
        'From: Synthetic Sender <sender@example.test>',
        'To: owner@outlook.test',
        'Subject: Ünicode Graph receipt',
        'Message-ID: <m1@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="graph-b"',
        '',
        '--graph-b',
        'Content-Type: text/html; charset=utf-8',
        '',
        '<p>Microsoft Graph body</p><script>bad()</script>',
        '--graph-b',
        'Content-Type: text/plain; name="report.txt"',
        'Content-Disposition: attachment; filename="report.txt"',
        '',
        'Synthetic Graph attachment',
        '--graph-b--',
        '',
      ].join('\r\n');
      messageId = (await local('m1')).id;
      const opened = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${messageId}/content`,
        {},
      );
      assert.ok(opened.statusCode < 300, opened.body);
      contentVersion = (
        await pool.query(
          'SELECT version FROM mail_content WHERE message_id=$1',
          [messageId],
        )
      ).rows[0].version;
      await clearLease();
      await fetchMessageContent(
        pool,
        keys,
        { userId: owner.id, accountId, messageId, version: contentVersion },
        connectImap,
        null,
        microsoft.config,
      );
      const cached = (
        await pool.query(
          'SELECT state,html,attachments FROM mail_content WHERE message_id=$1',
          [messageId],
        )
      ).rows[0];
      assert.equal(cached.state, 'ready');
      assert.match(cached.html, /Microsoft Graph body/);
      assert.doesNotMatch(cached.html, /script|bad\(\)/);
      assert.equal(cached.attachments[0].filename, 'report.txt');
      assert.equal(message.read, false);
      const download = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${messageId}/attachments/0`,
        {},
      );
      assert.ok(download.statusCode < 300, download.body);
      await fetchMessageContent(
        pool,
        keys,
        {
          userId: owner.id,
          accountId,
          messageId,
          version: contentVersion,
          attachment: 0,
        },
        connectImap,
        null,
        microsoft.config,
      );
      const file = (
        await pool.query(
          'SELECT state,data FROM mail_content_attachments WHERE message_id=$1',
          [messageId],
        )
      ).rows[0];
      assert.equal(file.state, 'ready');
      assert.equal(file.data.toString(), 'Synthetic Graph attachment');
    },
  );

  await t.test(
    'cross-folder deltas preserve message/cache identity and remove genuinely deleted mail',
    async () => {
      const message = microsoft.messages.get('m1');
      assert.ok(message);
      microsoft.record(message.folder, 'm1', true);
      message.folder = 'receipts';
      microsoft.record('receipts', 'm1');
      microsoft.messages.delete('m2');
      microsoft.record('inbox', 'm2', true);
      add('arrival', 'inbox', 'New Graph arrival');
      microsoft.record('inbox', 'arrival');
      assert.equal((await sync()).status, 'ready');
      assert.equal((await local('m1')).id, messageId);
      assert.deepEqual((await local('m1')).paths, ['receipts']);
      assert.equal(
        (
          await pool.query(
            'SELECT version FROM mail_content WHERE message_id=$1',
            [messageId],
          )
        ).rows[0].version,
        contentVersion,
      );
      assert.equal(await local('m2'), undefined);
      assert.ok((await local('arrival')).notification_at);
    },
  );

  const act = async (kind: string) => {
    const id = randomUUID();
    const queued = await call(
      owner.cookie,
      'POST',
      `/api/mail/messages/${messageId}/actions`,
      { id, kind },
    );
    assert.ok(queued.statusCode < 300, queued.body);
    await pool.query(
      'UPDATE mail_actions SET next_attempt_at=now() WHERE id=$1',
      [id],
    );
    await clearLease();
    await applyGraphActions(pool, keys, microsoft.config, owner.id, accountId);
    return (
      await pool.query(
        'SELECT state,error_code FROM mail_actions WHERE id=$1',
        [id],
      )
    ).rows[0];
  };
  await t.test(
    'durable read/archive/restore/trash actions and undo use Graph',
    async () => {
      assert.equal((await act('read')).state, 'applied');
      assert.equal(microsoft.messages.get('m1')?.read, true);
      assert.equal((await act('unread')).state, 'applied');
      assert.equal((await act('archive')).state, 'applied');
      assert.equal(microsoft.messages.get('m1')?.folder, 'archive');
      assert.equal((await act('restore')).state, 'applied');
      assert.equal(microsoft.messages.get('m1')?.folder, 'receipts');
      assert.equal((await act('trash')).state, 'applied');
      assert.equal(microsoft.messages.get('m1')?.folder, 'deleteditems');
      assert.equal((await act('restore')).state, 'applied');
      const id = randomUUID();
      const before = microsoft.state.modifies;
      const queued = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${messageId}/actions`,
        { id, kind: 'read' },
      );
      assert.ok(queued.statusCode < 300, queued.body);
      assert.equal(
        (await call(owner.cookie, 'POST', `/api/mail/actions/${id}/undo`, {}))
          .statusCode,
        200,
      );
      await applyGraphActions(
        pool,
        keys,
        microsoft.config,
        owner.id,
        accountId,
      );
      assert.equal(microsoft.state.modifies, before);
    },
  );

  await t.test(
    'lost move acknowledgements and crash markers never repeat a provider move',
    async () => {
      microsoft.state.loseMoveResponse = true;
      const before = microsoft.state.moves;
      const lost = await act('archive');
      assert.equal(lost.state, 'conflict');
      assert.equal(lost.error_code, 'move_unconfirmed');
      assert.equal(microsoft.messages.get('m1')?.folder, 'archive');
      assert.equal(microsoft.state.moves, before + 1);
      microsoft.state.loseMoveResponse = false;
      await applyGraphActions(
        pool,
        keys,
        microsoft.config,
        owner.id,
        accountId,
      );
      assert.equal(microsoft.state.moves, before + 1);
      assert.equal((await sync()).status, 'ready');
      assert.deepEqual((await local('m1')).paths, ['archive']);
      assert.equal((await act('restore')).state, 'applied');
      const crashed = randomUUID();
      const queued = await call(
        owner.cookie,
        'POST',
        `/api/mail/messages/${messageId}/actions`,
        { id: crashed, kind: 'archive' },
      );
      assert.ok(queued.statusCode < 300, queued.body);
      await pool.query(
        "UPDATE mail_actions SET next_attempt_at=now(),error_code='move_unconfirmed' WHERE id=$1",
        [crashed],
      );
      const moves = microsoft.state.moves;
      await clearLease();
      await applyGraphActions(
        pool,
        keys,
        microsoft.config,
        owner.id,
        accountId,
      );
      const outcome = (
        await pool.query(
          'SELECT state,error_code FROM mail_actions WHERE id=$1',
          [crashed],
        )
      ).rows[0];
      assert.deepEqual(outcome, {
        state: 'conflict',
        error_code: 'move_unconfirmed',
      });
      assert.equal(microsoft.state.moves, moves);
      assert.equal(microsoft.messages.get('m1')?.folder, 'receipts');
    },
  );

  await t.test(
    'expired delta recovery retains existing mail until rescan and removes stale rows',
    async () => {
      microsoft.messages.delete('m3');
      microsoft.state.minVersion = microsoft.state.version + 1;
      microsoft.state.version += 5;
      assert.equal((await sync()).status, 'ready');
      assert.equal(await local('m3'), undefined);
      assert.equal((await local('m1')).id, messageId);
    },
  );

  await t.test(
    'expired folder hierarchy removes absent folder checkpoints',
    async () => {
      microsoft.folders.set('obsolete', 'Obsolete');
      assert.equal((await sync()).status, 'ready');
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM mail_graph_sync WHERE account_id=$1 AND scope='obsolete'",
            [accountId],
          )
        ).rowCount,
        1,
      );
      microsoft.folders.delete('obsolete');
      microsoft.state.expireFolders = true;
      assert.equal((await sync()).status, 'ready');
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM mailboxes WHERE account_id=$1 AND path='obsolete'",
            [accountId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM mail_graph_sync WHERE account_id=$1 AND scope='obsolete'",
            [accountId],
          )
        ).rowCount,
        0,
      );
    },
  );

  await t.test(
    'Graph page URLs cannot send bearer tokens to another host or mailbox',
    async () => {
      await clearLease();
      const claimed = await claimAccount(pool, owner.id, accountId, false);
      assert.ok(claimed);
      try {
        const api = await openMicrosoft(
          pool,
          microsoft.config,
          keys,
          claimed,
          Date.now() + 10000,
        );
        await assert.rejects(api('https://attacker.example/v1.0/me/messages'));
        await assert.rejects(
          api(
            `${new URL(microsoft.config.graphUrl).origin}/v1.0/users/foreign/messages`,
          ),
        );
      } finally {
        await releaseLease(pool, claimed);
      }
      microsoft.state.externalNextLink = true;
      assert.equal((await sync()).status, 'error');
      microsoft.state.externalNextLink = false;
      assert.equal((await sync()).status, 'ready');
    },
  );

  await t.test(
    'MIME sending preserves Bcc; accepted and unknown outcomes never resend',
    async () => {
      const runOutgoing = () =>
        processOutgoing(
          pool,
          keys,
          owner.id,
          accountId,
          connectSmtp,
          connectImap,
          null,
          microsoft.config,
        );
      const send = async (subject: string) => {
        const id = randomUUID();
        const saved = await call(
          owner.cookie,
          'PUT',
          `/api/mail/drafts/${id}`,
          {
            revision: 0,
            saveId: randomUUID(),
            accountId,
            content: {
              to: 'friend@example.test',
              cc: '',
              bcc: 'hidden@example.test',
              subject,
              format: 'plain',
              html: '',
              text: 'Hello from Graph',
            },
          },
        );
        assert.equal(saved.statusCode, 200, saved.body);
        const operation = randomUUID();
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
        await clearLease();
        await runOutgoing();
        return { id, operation };
      };
      const outbox = async (id: string) =>
        (
          await pool.query(
            'SELECT state,sent_copy,attempts,next_attempt_at FROM mail_outbox WHERE id=$1',
            [id],
          )
        ).rows[0];
      const accepted = await send('Microsoft send');
      assert.equal((await outbox(accepted.operation)).state, 'accepted');
      assert.match(microsoft.sent.at(-1) ?? '', /^Bcc: hidden@example\.test$/m);
      assert.match(
        microsoft.sent.at(-1) ?? '',
        /^From: Synthetic Microsoft Owner <owner@outlook\.test>$/m,
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_drafts WHERE id=$1', [
            accepted.id,
          ])
        ).rowCount,
        0,
      );
      microsoft.state.send = 'reject';
      const rejected = await send('Rejected Graph send');
      assert.equal((await outbox(rejected.operation)).state, 'failed');
      microsoft.state.send = 'lost';
      const lost = await send('Unknown Graph send');
      assert.equal((await outbox(lost.operation)).state, 'unknown');
      const sent = microsoft.sent.length;
      microsoft.state.send = 'ok';
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=now() WHERE id=$1',
        [lost.operation],
      );
      await clearLease();
      await runOutgoing();
      assert.equal(
        microsoft.sent.length,
        sent,
        'a lost send response is search-only',
      );
      assert.equal((await outbox(lost.operation)).state, 'unknown');
      assert.equal((await outbox(lost.operation)).sent_copy, 'saved');
      assert.equal((await outbox(lost.operation)).attempts, 1);
      microsoft.state.send = 'rate';
      const limited = await send('Rate-limited Graph send');
      const deferred = await outbox(limited.operation);
      assert.equal(deferred.state, 'queued');
      assert.ok(
        deferred.next_attempt_at >= new Date(Date.now() + 119000),
        'Graph Retry-After survives the shared Outbox retry policy',
      );
      assert.equal(microsoft.sent.length, sent);
      microsoft.state.send = 'ok';
      await clearLease();
      await runOutgoing();
      assert.equal((await outbox(limited.operation)).state, 'queued');
      assert.equal(
        (await outbox(limited.operation)).attempts,
        deferred.attempts,
      );
      assert.equal(
        microsoft.sent.length,
        sent,
        'an immediate dispatch respects the provider deadline',
      );
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=now() WHERE id=$1',
        [limited.operation],
      );
      await clearLease();
      await runOutgoing();
      assert.equal((await outbox(limited.operation)).state, 'accepted');
      assert.equal(microsoft.sent.length, sent + 1);
    },
  );

  await t.test(
    'migration replay preserves existing mail, credentials, cached bodies and Outbox snapshots',
    async () => {
      const snapshot = async () => {
        const result: [string, number, string][] = [];
        for (const table of [
          'users',
          'auth_sessions',
          'mail_accounts',
          'mailboxes',
          'mail_messages',
          'mail_memberships',
          'mail_content',
          'mail_content_attachments',
          'mail_drafts',
          'mail_outbox',
          'mail_graph_sync',
          'mail_graph_listed',
        ]) {
          const rows = (
            await pool.query(
              `SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows;
          result.push([
            table,
            rows.length,
            createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
          ]);
        }
        return result;
      };
      const before = await snapshot();
      assert.ok(
        before.find(([table, count]) => table === 'mail_accounts' && count > 0),
      );
      assert.ok(
        before.find(([table, count]) => table === 'mail_content' && count > 0),
      );
      assert.ok(
        before.find(([table, count]) => table === 'mail_outbox' && count > 0),
      );
      await migrateDatabase(pool);
      assert.deepEqual(await snapshot(), before);
    },
  );

  await t.test(
    'revoked consent keeps the mirror and requires reconnect',
    async () => {
      microsoft.refreshTokens.clear();
      const failed = await sync();
      assert.equal(failed.status, 'error');
      assert.equal(failed.error_code, 'reconnect_required');
      assert.ok(await local('m1'));
    },
  );

  await t.test(
    'disconnect removes only the owned local mirror and credentials',
    async () => {
      const remoteCount = microsoft.messages.size;
      assert.equal(
        (
          await call(
            other.cookie,
            'DELETE',
            `/api/mail/accounts/${accountId}`,
            { password: other.password },
          )
        ).statusCode,
        404,
      );
      const removed = await call(
        owner.cookie,
        'DELETE',
        `/api/mail/accounts/${accountId}`,
        { password: owner.password },
      );
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_accounts WHERE id=$1', [
            accountId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_messages WHERE account_id=$1', [
            accountId,
          ])
        ).rowCount,
        0,
      );
      assert.equal(microsoft.messages.size, remoteCount);
    },
  );
});
