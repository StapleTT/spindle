import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('authenticated commit-only SSE invalidation, isolation, reconnect, bounded connections and revocation', {
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
      v1: Buffer.alloc(32, 67).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'events-owner@example.test',
      '203.0.113.223',
    ),
    other = await createTestUser(
      app,
      pool,
      testConfig,
      'events-admin@example.test',
      '203.0.113.223',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const secondPool = new Pool({ connectionString, max: 5 }),
    secondApp = testApp(secondPool, testConfig, undefined, keys);
  const secondApi = await secondApp.listen({ host: '127.0.0.1', port: 0 });
  const connections: AbortController[] = [];
  t.after(async () => {
    for (const controller of connections) controller.abort();
    await secondApp.close();
    await app.close();
  });
  const headers = (cookie = owner.cookie) => ({
    cookie,
    origin: testConfig.appUrl,
    accept: 'text/event-stream',
  });
  type Frame = { event: string; id: string; data: { topics?: string[] } };
  async function stream(cookie = owner.cookie, base = api, last?: string) {
    const controller = new AbortController();
    connections.push(controller);
    const response = await fetch(`${base}/api/mail/events`, {
      headers: {
        ...headers(cookie),
        ...(last ? { 'last-event-id': last } : {}),
      },
      signal: controller.signal,
    });
    assert.equal(
      response.status,
      200,
      await (response.status === 200 ? Promise.resolve('') : response.text()),
    );
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/event-stream/,
    );
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    assert.ok(response.headers.get('x-content-type-options'));
    assert.ok(response.body);
    const reader = response.body.getReader();
    const frames: Frame[] = [];
    let closed = false,
      buffer = '';
    const read = (async () => {
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          buffer += new TextDecoder().decode(part.value);
          let split = buffer.indexOf('\n\n');
          while (split >= 0) {
            const text = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            if (text.includes('data:')) {
              const lines = text.split('\n');
              frames.push({
                event:
                  lines
                    .find((line) => line.startsWith('event:'))
                    ?.slice(6)
                    .trim() ?? '',
                id:
                  lines
                    .find((line) => line.startsWith('id:'))
                    ?.slice(3)
                    .trim() ?? '',
                data: JSON.parse(
                  lines.find((line) => line.startsWith('data:'))?.slice(5) ??
                    '{}',
                ),
              });
            }
            split = buffer.indexOf('\n\n');
          }
        }
      } catch {
        /* Client abort/server close is part of the lifecycle proof. */
      } finally {
        closed = true;
      }
    })();
    await waitFor(() => frames.some((frame) => frame.event === 'reset'));
    return {
      response,
      frames,
      close: () => controller.abort(),
      get closed() {
        return closed;
      },
      read,
    };
  }
  async function waitFor(check: () => boolean | Promise<boolean>, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail('Expected SSE state was not reached');
  }
  async function quiet() {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const primary = await stream(),
    foreign = await stream(other.cookie),
    replica = await stream(owner.cookie, secondApi);
  async function addSaved(user = owner, name: string = randomUUID()) {
    await pool.query(
      'INSERT INTO mail_saved_searches(id,user_id,name,query) VALUES($1,$2,$3,$4)',
      [randomUUID(), user.id, name, 'secret query'],
    );
  }
  t.beforeEach(() =>
    pool.query('DELETE FROM mail_request_limits').then(() => {}),
  );
  await t.test(
    'anonymous, unverified, cross-origin, malformed cursor and owner-selector requests are denied',
    async () => {
      for (const [path, extra, status] of [
        ['', { cookie: '' }, 401],
        ['', { origin: 'https://evil.test' }, 403],
        ['', { 'sec-fetch-site': 'cross-site' }, 403],
        [`?userId=${other.id}`, {}, 400],
        ['', { 'last-event-id': 'malformed' }, 400],
      ] as const) {
        const response = await fetch(`${api}/api/mail/events${path}`, {
          headers: { ...headers(), ...extra },
        });
        const body =
          response.status === 200 ? 'Unexpected stream' : await response.text();
        if (response.status === 200) await response.body?.cancel();
        assert.equal(response.status, status, body);
      }
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        other.id,
      ]);
      const unverified = await fetch(`${api}/api/mail/events`, {
        headers: headers(other.cookie),
      });
      assert.equal(unverified.status, 403);
      await waitFor(() => foreign.closed);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        other.id,
      ]);
    },
  );
  await t.test(
    'only committed changes reach the correct owner across API instances, with no mail/query/credential payload',
    async () => {
      const stranger = await stream(other.cookie);
      const before = primary.frames.length,
        otherBefore = stranger.frames.length,
        replicaBefore = replica.frames.length;
      const db = await pool.connect();
      try {
        await db.query('BEGIN');
        await db.query(
          'INSERT INTO mail_saved_searches(id,user_id,name,query) VALUES($1,$2,$3,$4)',
          [randomUUID(), owner.id, 'Not committed', 'private subject:password'],
        );
        await quiet();
        assert.equal(primary.frames.length, before);
        await db.query('ROLLBACK');
        await quiet();
        assert.equal(primary.frames.length, before);
        await db.query('BEGIN');
        for (let index = 0; index < 10; index++)
          await db.query(
            'INSERT INTO mail_saved_searches(id,user_id,name,query) VALUES($1,$2,$3,$4)',
            [randomUUID(), owner.id, `Committed ${index}`, 'private query'],
          );
        await db.query('COMMIT');
      } finally {
        db.release();
      }
      await waitFor(
        () =>
          primary.frames.length > before &&
          replica.frames.length > replicaBefore,
      );
      assert.equal(primary.frames.length, before + 1);
      assert.equal(stranger.frames.length, otherBefore);
      const frame = primary.frames.at(-1);
      assert.deepEqual(frame?.data, { topics: ['searches'] });
      assert.doesNotMatch(
        JSON.stringify(frame),
        /private|password|Committed|user_id|token|credential/,
      );
      assert.equal(Number(frame?.id.split(':')[1]), 2);
      stranger.close();
    },
  );
  await t.test(
    'reads and lease/retry bookkeeping are quiet while visible mail changes invalidate once',
    async () => {
      const accountResponse = await app.inject({
        method: 'POST',
        url: '/api/mail/accounts',
        headers: { cookie: owner.cookie, origin: testConfig.appUrl },
        payload: {
          name: 'SSE account',
          host: 'mail.example.test',
          port: 993,
          transport: 'tls',
          username: 'owner@example.test',
          password: 'synthetic-only-password',
          history: 'all',
        },
      });
      assert.equal(accountResponse.statusCode, 202, accountResponse.body);
      const account = accountResponse.json().account.id;
      const box = (
        await pool.query(
          "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
          [owner.id, account],
        )
      ).rows[0].id;
      const id = randomUUID();
      await pool.query(
        'INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,clock_timestamp())',
        [
          id,
          owner.id,
          account,
          'Private content',
          JSON.stringify([]),
          JSON.stringify({ to: [], cc: [] }),
        ],
      );
      await pool.query(
        "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',1)",
        [owner.id, account, box, id],
      );
      await pool.query(
        'INSERT INTO mail_content(user_id,account_id,message_id) VALUES($1,$2,$3)',
        [owner.id, account, id],
      );
      await quiet();
      const before = primary.frames.length;
      await pool.query(
        "UPDATE mail_accounts SET next_idle_at=clock_timestamp(),lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1",
        [account],
      );
      await pool.query(
        'UPDATE mail_content SET accessed_at=clock_timestamp(),next_attempt_at=clock_timestamp() WHERE message_id=$1',
        [id],
      );
      await pool.query('UPDATE mail_messages SET subject=subject WHERE id=$1', [
        id,
      ]);
      await quiet();
      assert.equal(primary.frames.length, before);
      await pool.query('UPDATE mail_messages SET subject=$2 WHERE id=$1', [
        id,
        'Changed locally',
      ]);
      await waitFor(() => primary.frames.length > before);
      assert.deepEqual(primary.frames.at(-1)?.data.topics, ['mail']);
    },
  );
  await t.test(
    'reconnect always resets current state despite old, future or foreign transport cursors',
    async () => {
      const id = primary.frames.at(-1)?.id;
      assert.ok(id);
      primary.close();
      await primary.read;
      await addSaved();
      const resumed = await stream(owner.cookie, api, id);
      assert.equal(resumed.frames[0]?.event, 'reset');
      assert.ok(resumed.frames[0]?.data.topics?.includes('mail'));
      assert.notEqual(resumed.frames[0]?.id.split(':')[0], id.split(':')[0]);
      resumed.close();
      const foreignCursor = foreign.frames[0]?.id;
      assert.ok(foreignCursor);
      const own = await stream(owner.cookie, api, foreignCursor);
      assert.equal(own.frames[0]?.event, 'reset');
      own.close();
    },
  );
  await t.test(
    'a lost database listener closes streams and reconnect refetches changes committed during the gap',
    async () => {
      await pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND query='LISTEN spindle_mail_changed'",
      );
      await waitFor(() => replica.closed);
      await addSaved(owner, 'During listener outage');
      const resumed = await stream(owner.cookie, secondApi);
      assert.equal(resumed.frames[0]?.event, 'reset');
      assert.equal(
        (
          await secondPool.query(
            "SELECT 1 FROM mail_saved_searches WHERE user_id=$1 AND name='During listener outage'",
            [owner.id],
          )
        ).rowCount,
        1,
      );
      resumed.close();
      await resumed.read;
    },
  );
  await t.test(
    'connection limits recover slots on disconnect and session deletion closes a live stream',
    async () => {
      const live = await stream();
      const extras = [await stream(), await stream(), await stream()];
      const limited = await fetch(`${api}/api/mail/events`, {
        headers: headers(),
      });
      assert.equal(limited.status, 429);
      await limited.body?.cancel();
      extras[0]?.close();
      await extras[0]?.read;
      await quiet();
      const replacement = await stream();
      replacement.close();
      extras[1]?.close();
      const storm = setInterval(() => {
        void pool
          .query("SELECT pg_notify('spindle_mail_changed',$1)", [
            JSON.stringify([owner.id, 'mail']),
          ])
          .catch(() => {});
      }, 20);
      try {
        await quiet();
        await pool.query('DELETE FROM auth_sessions WHERE user_id=$1', [
          owner.id,
        ]);
        await waitFor(() => live.closed && replica.closed);
      } finally {
        clearInterval(storm);
      }
      assert.ok(live.frames.some((frame) => frame.event === 'session-ended'));
      const denied = await fetch(`${api}/api/mail/events`, {
        headers: headers(),
      });
      assert.equal(denied.status, 401);
    },
  );
  await t.test(
    'expiry and verification removal close already authorized streams while idle',
    async () => {
      const sessions = await pool.query(
        'SELECT id,expires_at FROM auth_sessions WHERE user_id=$1',
        [other.id],
      );
      const expired = await stream(other.cookie);
      try {
        await pool.query(
          "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1",
          [other.id],
        );
        await waitFor(() => expired.closed);
        assert.ok(
          expired.frames.some((frame) => frame.event === 'session-ended'),
        );
      } finally {
        for (const session of sessions.rows)
          await pool.query(
            'UPDATE auth_sessions SET expires_at=$2 WHERE id=$1',
            [session.id, session.expires_at],
          );
      }
      const unverified = await stream(other.cookie);
      try {
        await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
          other.id,
        ]);
        await waitFor(() => unverified.closed);
        assert.ok(
          unverified.frames.some((frame) => frame.event === 'session-ended'),
        );
      } finally {
        await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
          other.id,
        ]);
      }
    },
  );
  await t.test(
    'API shutdown closes streams and the reserved LISTEN connection without hanging',
    async () => {
      const live = await stream(other.cookie);
      await secondApp.close();
      await app.close();
      await waitFor(() => live.closed);
    },
  );
});
