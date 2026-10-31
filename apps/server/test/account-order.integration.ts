import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('private persisted account ordering', {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 85).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'order-owner@example.test',
    '203.0.113.235',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'order-admin@example.test',
    '203.0.113.235',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const connect = async (name: string, user = owner) => {
    const result = await app.inject({
      method: 'POST',
      url: '/api/mail/accounts',
      headers: { cookie: user.cookie, origin: testConfig.appUrl },
      payload: {
        name,
        host: 'mail.example.test',
        port: 993,
        transport: 'tls',
        username: `${name}@example.test`,
        password: 'synthetic-only-password',
        history: 'all',
      },
    });
    assert.equal(result.statusCode, 202, result.body);
    return result.json().account.id as string;
  };
  const a = await connect('First'),
    b = await connect('Second'),
    c = await connect('Third');
  const foreign = await connect('Foreign', other);
  const ids = async (instance = app, cookie = owner.cookie) => {
    const result = await instance.inject({
      url: '/api/mail/accounts',
      headers: { cookie },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result
      .json()
      .accounts.map((account: { id: string }) => account.id) as string[];
  };
  const save = (
    accountIds: unknown,
    expectedAccountIds: unknown,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) =>
    app.inject({
      method: 'PATCH',
      url: '/api/mail/accounts/order',
      headers: { cookie, origin },
      payload: { accountIds, expectedAccountIds },
    });
  const clearLimit = () =>
    pool.query(
      "DELETE FROM mail_request_limits WHERE user_id IN ($1,$2) AND action='write'",
      [owner.id, other.id],
    );
  const snapshot = async () =>
    (
      await pool.query(
        "SELECT to_jsonb(a)-'sort_order' AS data FROM mail_accounts a WHERE user_id=$1 ORDER BY id",
        [owner.id],
      )
    ).rows;

  await t.test(
    'keeps connection order by default, persists across API instances and touches only ordering',
    async () => {
      assert.deepEqual(await ids(), [a, b, c]);
      const before = await snapshot();
      const response = await save([c, a, b], [a, b, c]);
      assert.equal(response.statusCode, 200, response.body);
      assert.deepEqual(response.json().accountIds, [c, a, b]);
      const second = testApp(
        new Pool({ connectionString }),
        testConfig,
        undefined,
        keys,
      );
      try {
        assert.deepEqual(await ids(second), [c, a, b]);
      } finally {
        await second.close();
      }
      await migrateDatabase(pool);
      assert.deepEqual(await ids(), [c, a, b]);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(await ids(app, other.cookie), [foreign]);
      await assert.rejects(
        pool.query('UPDATE mail_accounts SET sort_order=-1 WHERE id=$1', [a]),
        /check constraint/,
      );
    },
  );

  await t.test(
    'enforces verified ownership and exact origin without partial changes or admin access',
    async () => {
      await clearLimit();
      assert.equal((await save([b, c, a], [c, a, b], '')).statusCode, 401);
      assert.equal(
        (
          await save(
            [b, c, a],
            [c, a, b],
            owner.cookie,
            'https://foreign.example.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await save([b, c, a], [c, a, b], other.cookie)).statusCode,
        409,
      );
      assert.equal((await save([c, foreign, b], [c, a, b])).statusCode, 409);
      assert.equal(
        (await save([c, randomUUID(), b], [c, a, b])).statusCode,
        409,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal((await save([b, c, a], [c, a, b])).statusCode, 403);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
      assert.deepEqual(await ids(), [c, a, b]);
      assert.deepEqual(await ids(app, other.cookie), [foreign]);
    },
  );

  await t.test(
    'rejects malformed, duplicate, incomplete and oversized orders atomically',
    async () => {
      await clearLimit();
      for (const invalid of [
        [],
        [a, a, c],
        ['not-a-uuid'],
        [a, b, c, randomUUID(), randomUUID(), randomUUID()],
        'First',
      ]) {
        assert.equal((await save(invalid, [c, a, b])).statusCode, 400);
        assert.equal((await save([b, a, c], invalid)).statusCode, 400);
      }
      assert.equal((await save([a, b], [c, a, b])).statusCode, 409);
      assert.equal((await save([a, b, c], [a, b])).statusCode, 409);
      const oversized = await app.inject({
        method: 'PATCH',
        url: '/api/mail/accounts/order',
        headers: {
          cookie: owner.cookie,
          origin: testConfig.appUrl,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({
          accountIds: [a],
          expectedAccountIds: [a],
          padding: 'x'.repeat(2048),
        }),
      });
      assert.equal(oversized.statusCode, 413);
      assert.deepEqual(await ids(), [c, a, b]);
    },
  );

  await t.test(
    'concurrent stale saves cannot overwrite the winner, and lost-response replay is safe',
    async () => {
      await clearLimit();
      const expected = await ids();
      const outcomes = await Promise.all([
        save([a, b, c], expected),
        save([b, c, a], expected),
      ]);
      assert.deepEqual(
        outcomes.map((result) => result.statusCode).sort(),
        [200, 409],
      );
      const winner = outcomes
        .find((result) => result.statusCode === 200)
        ?.json().accountIds;
      assert.deepEqual(await ids(), winner);
      assert.equal((await save(winner, expected)).statusCode, 200);
      assert.deepEqual(await ids(), winner);
    },
  );

  await t.test(
    'new accounts append, reconnect preserves position, and membership changes reject stale saves',
    async () => {
      await clearLimit();
      const previous = await ids();
      assert.equal(await connect('First'), a);
      assert.deepEqual(await ids(), previous);
      const added = await connect('Fourth');
      assert.deepEqual(await ids(), [...previous, added]);
      assert.equal(
        (await save([...previous].reverse(), previous)).statusCode,
        409,
      );
      assert.deepEqual(await ids(), [...previous, added]);
      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/mail/accounts/${b}`,
        headers: { cookie: owner.cookie, origin: testConfig.appUrl },
        payload: { password: owner.password },
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(
        (await save([...previous, added].reverse(), [...previous, added]))
          .statusCode,
        409,
      );
      assert.deepEqual(await ids(), [
        ...previous.filter((id) => id !== b),
        added,
      ]);
    },
  );
});
