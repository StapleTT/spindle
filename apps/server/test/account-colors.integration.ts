import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('account colors persist privately, validate at both boundaries and leave provider settings unchanged', {
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
  await migrateDatabase(pool);
  const app = testApp(
    pool,
    testConfig,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 83).toString('base64'),
      }),
    }),
  );
  t.after(() => app.close());
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'colors-owner@example.test',
      '203.0.113.233',
    ),
    other = await createTestUser(
      app,
      pool,
      testConfig,
      'colors-admin@example.test',
      '203.0.113.233',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const connected = await app.inject({
    method: 'POST',
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie, origin: testConfig.appUrl },
    payload: {
      name: 'Colors account',
      host: 'mail.example.test',
      port: 993,
      transport: 'tls',
      username: owner.email,
      password: 'synthetic-only-password',
      history: 'all',
    },
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const id = connected.json().account.id;
  assert.equal(connected.json().account.color, null);
  const before = (
    await pool.query(
      "SELECT to_jsonb(a)-'color' AS data FROM mail_accounts a WHERE id=$1",
      [id],
    )
  ).rows[0].data;
  const patch = (
    color: unknown,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) =>
    app.inject({
      method: 'PATCH',
      url: `/api/mail/accounts/${id}/color`,
      headers: { cookie, origin },
      payload: { color },
    });
  assert.equal((await patch('#Aa11Cc')).statusCode, 200);
  const list = await app.inject({
    url: '/api/mail/accounts',
    headers: { cookie: owner.cookie },
  });
  assert.equal(
    list.json().accounts.find((a: { id: string }) => a.id === id).color,
    '#aa11cc',
  );
  assert.equal((await patch('#123456', '')).statusCode, 401);
  assert.equal((await patch('#123456', other.cookie)).statusCode, 404);
  assert.equal(
    (await patch('#123456', owner.cookie, 'https://foreign.example.test'))
      .statusCode,
    403,
  );
  for (const value of ['red', '#abc', '#12345g', 'url(https://example.test)'])
    assert.equal((await patch(value)).statusCode, 400);
  await assert.rejects(
    pool.query("UPDATE mail_accounts SET color='red' WHERE id=$1", [id]),
    /check constraint/,
  );
  assert.equal((await patch(null)).statusCode, 200);
  const after = (
    await pool.query(
      "SELECT to_jsonb(a)-'color' AS data,color FROM mail_accounts a WHERE id=$1",
      [id],
    )
  ).rows[0];
  assert.equal(after.color, null);
  assert.deepEqual(after.data, before);
  await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
    owner.id,
  ]);
  assert.equal((await patch('#123456')).statusCode, 403);
});
