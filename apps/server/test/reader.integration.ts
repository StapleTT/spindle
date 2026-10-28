import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { Parser } from 'htmlparser2';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { CACHE_BYTES, trimContentCache } from '../src/mail/content-cache.js';
import { readContentConfig } from '../src/mail/content-config.js';
import { buildContentApp } from '../src/mail/content-server.js';
import {
  type ContentJob,
  fetchMessageContent,
} from '../src/mail/content-worker.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { signContentGrant } from '../src/mail/grants.js';
import { connectImap } from '../src/mail/imap.js';
import { MAX_RAW_BYTES } from '../src/mail/parse.js';
import { transaction } from '../src/mail/store.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword } from './imap-fixture.js';
import { readerMail, tinyPng } from './reader-fixture.js';

test('private cached message reader, isolated HTML and image permission', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90000,
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
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  const config = readContentConfig(testConfig, {});
  assert.ok(config);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 44).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys, config);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'reader-owner@example.test',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'reader-other@example.test',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const { server, port } = await imapFixture(t);
  server.control.addMessage('INBOX', {
    raw: readerMail(
      'Reader oldest',
      '<p>Private HTML body</p><img src="https://images.example.test/pixel.png"><img src="cid:inline@example.test"><script>parent.pwned=1</script>',
    ),
    internaldate: new Date('2026-10-27T12:00:00Z'),
    flags: [],
  });
  server.control.addMessage('INBOX', {
    raw: readerMail('Reader middle'),
    internaldate: new Date('2026-10-27T12:00:01Z'),
    flags: [],
  });
  server.control.addMessage('INBOX', {
    raw: readerMail('Reader newest'),
    internaldate: new Date('2026-10-27T12:00:02Z'),
    flags: [],
  });
  server.control.addMessage('Archive', {
    raw: readerMail('Reader archived'),
    internaldate: new Date('2026-10-27T12:00:03Z'),
    flags: [],
  });
  function request(
    path: string,
    method: 'GET' | 'POST' | 'DELETE' = 'GET',
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
    name: 'Reader account',
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
  const messages = (await request('messages')).json().messages;
  assert.equal(messages.length, 3);
  const newest = messages[0].id;
  const middle = messages[1].id;
  const oldest = messages[2].id;
  let imageCalls = 0;
  const content = buildContentApp(pool, config, async () => {
    imageCalls++;
    return { type: 'image/png', data: tinyPng };
  });
  content.log.level = 'silent';
  t.after(() => content.close());
  function contentRequest(url: string) {
    const value = new URL(url);
    return content.inject({ url: `${value.pathname}${value.search}` });
  }
  async function job(id: string): Promise<ContentJob> {
    const row = (
      await pool.query(
        'SELECT version FROM mail_content WHERE user_id=$1 AND message_id=$2',
        [owner.id, id],
      )
    ).rows[0];
    return {
      userId: owner.id,
      accountId: account,
      messageId: id,
      version: row.version,
    };
  }
  let blockedUrl = '';
  let imageUrl = '';
  t.beforeEach(async () => {
    await pool.query(
      'DELETE FROM mail_request_limits WHERE user_id=ANY($1::text[])',
      [[owner.id, other.id]],
    );
  });

  await t.test(
    'reader navigation follows the inbox across list-page boundaries and respects folder filters',
    async () => {
      const first = await request(`messages/${middle}?account=${account}`);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().previous, newest);
      assert.equal(first.json().next, oldest);
      assert.equal(first.json().content.state, 'missing');
      assert.equal(
        (await request('messages?limit=1')).json().messages[0].id,
        newest,
      );
      const archived = (await request('mailboxes'))
        .json()
        .mailboxes.find((box: { path: string }) => box.path === 'Archive');
      assert.equal(
        (await request(`messages/${oldest}?mailbox=${archived.id}`)).statusCode,
        404,
      );
      const archivedMail = (
        await request(`messages?mailbox=${archived.id}`)
      ).json().messages[0];
      const detail = (
        await request(`messages/${archivedMail.id}?mailbox=${archived.id}`)
      ).json();
      assert.equal(detail.previous, null);
      assert.equal(detail.next, null);
    },
  );

  await t.test(
    'every reader operation rejects anonymous, unverified and foreign users, including admins',
    async () => {
      for (const [path, method, payload] of [
        [`messages/${oldest}`, 'GET', undefined],
        [`messages/${oldest}/content`, 'POST', {}],
        [`messages/${oldest}/images`, 'POST', {}],
      ] as const) {
        assert.equal(
          (await request(path, method, payload, '')).statusCode,
          401,
        );
        assert.equal(
          (await request(path, method, payload, other.cookie)).statusCode,
          404,
        );
        await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
          owner.id,
        ]);
        assert.equal((await request(path, method, payload)).statusCode, 403);
        await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
          owner.id,
        ]);
        if (method === 'POST')
          assert.equal(
            (
              await request(
                path,
                method,
                payload,
                owner.cookie,
                'https://attacker.test',
              )
            ).statusCode,
            403,
          );
      }
    },
  );

  await t.test(
    'body requests deduplicate, parse safely and reuse the cache with the provider unavailable',
    async () => {
      const replies = await Promise.all([
        request(`messages/${oldest}/content`, 'POST', {}),
        request(`messages/${oldest}/content`, 'POST', {}),
      ]);
      assert.ok(replies.every((reply) => reply.statusCode === 202));
      const pending = await job(oldest);
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM mail_content WHERE message_id=$1',
              [oldest],
            )
          ).rows[0].count,
        ),
        1,
      );
      let connections = 0;
      await fetchMessageContent(pool, keys, pending, async (...args) => {
        connections++;
        return connectImap(...args);
      });
      const ready = (await request(`messages/${oldest}`)).json();
      assert.equal(ready.content.state, 'ready');
      assert.match(ready.content.plainText, /Private plain body/);
      assert.equal(ready.content.imageCount, 2);
      blockedUrl = ready.content.htmlUrl;
      assert.ok(
        !server.control.getMessage('INBOX', 1).flags.includes('\\Seen'),
      );
      await fetchMessageContent(pool, keys, pending, async () => {
        connections++;
        throw new Error('Provider offline');
      });
      assert.equal(connections, 1);
      assert.equal(
        (await request(`messages/${oldest}/content`, 'POST', {})).json().state,
        'ready',
      );
      assert.equal((await job(oldest)).version, pending.version);
    },
  );

  await t.test(
    'HTML is isolated and remote or inline images are fetched only after image permission',
    async () => {
      const blocked = await contentRequest(blockedUrl);
      assert.equal(blocked.statusCode, 200, blocked.body);
      assert.match(blocked.body, /Private HTML body/);
      assert.doesNotMatch(
        blocked.body,
        /<img|<script|parent.pwned|images.example.test/,
      );
      assert.match(
        String(blocked.headers['content-security-policy']),
        /script-src 'none'/,
      );
      assert.match(
        String(blocked.headers['content-security-policy']),
        /sandbox/,
      );
      assert.ok(
        !String(blocked.headers['content-security-policy']).includes(
          'allow-same-origin',
        ),
      );
      assert.equal(blocked.headers['referrer-policy'], 'no-referrer');
      assert.equal(blocked.headers['set-cookie'], undefined);
      assert.equal(imageCalls, 0);
      const token = new URL(blockedUrl).searchParams.get('token');
      assert.ok(token);
      assert.equal(
        (await content.inject({ url: `/image?token=${token}&index=0` }))
          .statusCode,
        403,
      );
      const allowed = await request(`messages/${oldest}/images`, 'POST', {});
      const shown = await contentRequest(allowed.json().htmlUrl);
      const sources: string[] = [];
      new Parser({
        onopentag: (tag, attrs) => {
          if (tag === 'img' && attrs.src) sources.push(attrs.src);
        },
      }).end(shown.body);
      assert.equal(sources.length, 2);
      assert.ok(sources[0] && sources[1]);
      imageUrl = sources[0];
      const simultaneous = await Promise.all([
        contentRequest(imageUrl),
        contentRequest(imageUrl),
        contentRequest(imageUrl),
      ]);
      assert.ok(simultaneous.every((response) => response.statusCode === 200));
      assert.equal((await contentRequest(imageUrl)).statusCode, 200);
      assert.equal(imageCalls, 1);
      assert.equal(
        (await contentRequest(sources[1])).headers['content-type'],
        'image/png',
      );
      assert.equal(imageCalls, 1);
      assert.doesNotMatch((await contentRequest(blockedUrl)).body, /<img/);
    },
  );

  await t.test(
    'content grants bind the owner, cache version and live session',
    async () => {
      const row = (
        await pool.query(
          'SELECT version FROM mail_content WHERE message_id=$1',
          [oldest],
        )
      ).rows[0];
      const foreign = signContentGrant(
        {
          owner: other.id,
          session: other.session,
          message: oldest,
          version: row.version,
          kind: 'body',
          images: false,
        },
        config.secret,
      );
      assert.equal(
        (await content.inject({ url: `/body?token=${foreign}` })).statusCode,
        404,
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: testConfig.appUrl },
        payload: { email: owner.email, password: owner.password },
      });
      assert.equal(login.statusCode, 200, login.body);
      const session = (
        await pool.query('SELECT id FROM auth_sessions WHERE token=$1', [
          login.json().token,
        ])
      ).rows[0].id;
      const granted = signContentGrant(
        {
          owner: owner.id,
          session,
          message: oldest,
          version: row.version,
          kind: 'body',
          images: false,
        },
        config.secret,
      );
      await pool.query('DELETE FROM auth_sessions WHERE id=$1', [session]);
      assert.equal(
        (await content.inject({ url: `/body?token=${granted}` })).statusCode,
        404,
      );
      assert.equal(
        (await content.inject({ url: `/body?token=${granted}x` })).statusCode,
        403,
      );
    },
  );

  await t.test(
    'previous sanitizer caches are refetched on demand without resetting mail metadata',
    async () => {
      await pool.query(
        'UPDATE mail_content SET sanitizer_version=1 WHERE user_id=$1 AND message_id=$2',
        [owner.id, oldest],
      );
      assert.equal(
        (await request(`messages/${oldest}`)).json().content.state,
        'missing',
      );
      assert.equal((await contentRequest(blockedUrl)).statusCode, 404);
      assert.equal(
        (await request(`messages/${oldest}/images`, 'POST', {})).statusCode,
        404,
      );
      const previous = (await job(oldest)).version;
      await request(`messages/${oldest}/content`, 'POST', {});
      const pending = await job(oldest);
      assert.notEqual(pending.version, previous);
      await fetchMessageContent(pool, keys, pending);
      const ready = (await request(`messages/${oldest}`)).json();
      assert.equal(ready.content.state, 'ready');
      assert.equal(
        (
          await pool.query(
            'SELECT sanitizer_version FROM mail_content WHERE message_id=$1',
            [oldest],
          )
        ).rows[0].sanitizer_version,
        2,
      );
      blockedUrl = ready.content.htmlUrl;
    },
  );

  await t.test(
    'expired cache is refetched with a new version and failed content has an explicit retry',
    async () => {
      await pool.query(
        "UPDATE mail_content SET expires_at=now()-interval '1 second' WHERE message_id=$1",
        [oldest],
      );
      assert.equal(
        (await request(`messages/${oldest}`)).json().content.state,
        'missing',
      );
      assert.equal((await contentRequest(imageUrl)).statusCode, 404);
      await request(`messages/${oldest}/content`, 'POST', {});
      await fetchMessageContent(pool, keys, await job(oldest));
      assert.equal((await contentRequest(blockedUrl)).statusCode, 404);
      await request(`messages/${middle}/content`, 'POST', {});
      await fetchMessageContent(pool, keys, await job(middle), async () => {
        throw new Error('private-provider-password');
      });
      const failed = await request(`messages/${middle}`);
      assert.equal(failed.json().content.state, 'failed');
      assert.ok(!failed.body.includes('private-provider-password'));
      const before = (await job(middle)).version;
      await request(`messages/${middle}/content`, 'POST', { retry: true });
      assert.notEqual((await job(middle)).version, before);
      await fetchMessageContent(pool, keys, await job(middle));
      assert.equal(
        (await request(`messages/${middle}`)).json().content.state,
        'ready',
      );
    },
  );

  await t.test(
    'an oversized advertised download is closed and fails without removing headers',
    async () => {
      await pool.query('DELETE FROM mail_content WHERE message_id=$1', [
        middle,
      ]);
      await request(`messages/${middle}/content`, 'POST', {});
      const source = Readable.from(['unused source']);
      await fetchMessageContent(
        pool,
        keys,
        await job(middle),
        async (...args) => {
          const client = await connectImap(...args);
          t.mock.method(client, 'download', async () => ({
            meta: { expectedSize: MAX_RAW_BYTES + 1 },
            content: source,
          }));
          return client;
        },
      );
      assert.equal(source.destroyed, true);
      const failed = await request(`messages/${middle}`);
      assert.equal(failed.statusCode, 200);
      assert.equal(failed.json().content.state, 'failed');
      assert.equal(failed.json().message.subject, 'Reader middle');
    },
  );

  await t.test(
    'a worker that loses its account lease cannot publish content',
    async () => {
      await request(`messages/${newest}/content`, 'POST', {});
      const pending = await job(newest);
      await fetchMessageContent(pool, keys, pending, async (...args) => {
        const client = await connectImap(...args);
        await pool.query(
          "UPDATE mail_accounts SET lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' WHERE id=$1",
          [account],
        );
        return client;
      });
      const row = (
        await pool.query(
          'SELECT state,html FROM mail_content WHERE message_id=$1',
          [newest],
        )
      ).rows[0];
      assert.equal(row.state, 'pending');
      assert.equal(row.html, null);
      await pool.query(
        'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE id=$1',
        [account],
      );
    },
  );

  await t.test(
    'durable pg-boss dispatch completes a pending body request',
    async () => {
      await pool.query(
        'UPDATE mail_content SET next_attempt_at=now() WHERE message_id=$1',
        [newest],
      );
      const boss = new PgBoss({ connectionString });
      const errors: unknown[] = [];
      boss.on('error', (error) => errors.push(error));
      let stop: (() => void) | undefined;
      try {
        await boss.start();
        stop = await startMailWorker(boss, pool, keys);
        const deadline = Date.now() + 15000;
        while (
          Date.now() < deadline &&
          (await request(`messages/${newest}`)).json().content.state !== 'ready'
        )
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(
          (await request(`messages/${newest}`)).json().content.state,
          'ready',
        );
        assert.deepEqual(errors, []);
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
    },
  );

  await t.test(
    'session revocation during an image download prevents caching or returning it',
    async () => {
      await pool.query(
        'DELETE FROM mail_content_images WHERE user_id=$1 AND message_id=$2 AND position=0',
        [owner.id, oldest],
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { origin: testConfig.appUrl },
        payload: { email: owner.email, password: owner.password },
      });
      assert.equal(login.statusCode, 200, login.body);
      const session = (
        await pool.query('SELECT id FROM auth_sessions WHERE token=$1', [
          login.json().token,
        ])
      ).rows[0].id;
      const version = (await job(oldest)).version;
      const token = signContentGrant(
        {
          owner: owner.id,
          session,
          message: oldest,
          version,
          kind: 'image',
          images: true,
        },
        config.secret,
      );
      let started: () => void = () => {};
      let release: () => void = () => {};
      const began = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const slow = buildContentApp(pool, config, async () => {
        started();
        await gate;
        return { type: 'image/png', data: tinyPng };
      });
      slow.log.level = 'silent';
      try {
        const pending = slow.inject({ url: `/image?token=${token}&index=0` });
        await began;
        await pool.query('DELETE FROM auth_sessions WHERE id=$1', [session]);
        release();
        assert.equal((await pending).statusCode, 404);
        assert.equal(
          (
            await pool.query(
              'SELECT 1 FROM mail_content_images WHERE user_id=$1 AND message_id=$2 AND position=0',
              [owner.id, oldest],
            )
          ).rowCount,
          0,
        );
      } finally {
        release();
        await slow.close();
      }
    },
  );

  await t.test(
    'LRU cache eviction stays within the owner boundary and preserves message metadata',
    async () => {
      const otherConnection = await request(
        'accounts',
        'POST',
        {
          name: 'Other account',
          host: 'localhost',
          port,
          transport: 'tls',
          username: 'testuser',
          password: imapPassword,
          history: 'all',
        },
        other.cookie,
      );
      assert.equal(otherConnection.statusCode, 202, otherConnection.body);
      const otherAccount = otherConnection.json().account.id;
      const ownMessage = (
        await pool.query(
          `INSERT INTO mail_messages(user_id,account_id,remote_key,subject,sender,recipients,received_at)
      VALUES($1,$2,'quota-own','Own quota fixture','[]','{}',now()) RETURNING id`,
          [owner.id, account],
        )
      ).rows[0].id;
      const foreignMessage = (
        await pool.query(
          `INSERT INTO mail_messages(user_id,account_id,remote_key,subject,sender,recipients,received_at)
      VALUES($1,$2,'quota-other','Other quota fixture','[]','{}',now()) RETURNING id`,
          [other.id, otherAccount],
        )
      ).rows[0].id;
      await pool.query(
        `INSERT INTO mail_content(user_id,account_id,message_id,state,byte_size,accessed_at)
      VALUES($1,$2,$3,'ready',$7,now()-interval '1 day'),($4,$5,$6,'ready',$7,now()-interval '1 day')`,
        [
          owner.id,
          account,
          ownMessage,
          other.id,
          otherAccount,
          foreignMessage,
          CACHE_BYTES,
        ],
      );
      await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          owner.id,
        ]);
        await trimContentCache(db, owner.id, oldest);
      });
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM mail_content WHERE user_id=$1 AND message_id=$2',
            [owner.id, ownMessage],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM mail_messages WHERE user_id=$1 AND id=$2',
            [owner.id, ownMessage],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM mail_content WHERE user_id=$1 AND message_id=$2',
            [other.id, foreignMessage],
          )
        ).rowCount,
        1,
      );
    },
  );

  await t.test(
    'disconnect during fetch cannot recreate cached content or inline images',
    async () => {
      await pool.query('DELETE FROM mail_content WHERE message_id=$1', [
        middle,
      ]);
      await request(`messages/${middle}/content`, 'POST', {});
      const pending = await job(middle);
      await fetchMessageContent(pool, keys, pending, async (...args) => {
        const client = await connectImap(...args);
        assert.equal(
          (
            await request(`accounts/${account}`, 'DELETE', {
              password: owner.password,
            })
          ).statusCode,
          200,
        );
        return client;
      });
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM mail_content WHERE user_id=$1',
              [owner.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM mail_content_images WHERE user_id=$1',
              [owner.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(server.control.getMailbox('INBOX').messages, 3);
      assert.equal((await contentRequest(imageUrl)).statusCode, 404);
    },
  );
});
