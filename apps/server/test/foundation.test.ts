import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

test('configuration rejects missing/invalid database URLs without exposing credentials', () => {
  assert.throws(() => readConfig({}), /DATABASE_URL is required/);
  for (const databaseUrl of [
    'not-a-url-secret',
    'https://user:secret@example.com/db',
  ]) {
    assert.throws(() => readConfig({ DATABASE_URL: databaseUrl }), {
      message: 'DATABASE_URL must be a PostgreSQL URL',
    });
  }
});

test('configuration validates ports and defaults to loopback', () => {
  const env = { DATABASE_URL: 'postgresql://localhost/spindle' };
  assert.equal(readConfig(env).host, '127.0.0.1');
  assert.equal(readConfig(env).port, 3000);
  for (const port of ['', '0', '-1', '1.5', '65536', 'abc']) {
    assert.throws(
      () => readConfig({ ...env, PORT: port }),
      /PORT must be an integer/,
    );
  }
});

test('liveness survives database outages while readiness fails without leaking details', async (t) => {
  const database = new Pool();
  t.mock.method(database, 'query', async () => {
    throw new Error('private-host:secret');
  });
  const app = buildApp(database);
  t.after(() => app.close());

  const live = await app.inject('/api/health');
  assert.equal(live.statusCode, 200);
  assert.deepEqual(live.json(), { status: 'ok' });
  assert.ok(live.headers['content-security-policy']);

  const ready = await app.inject('/api/ready');
  assert.equal(ready.statusCode, 503);
  assert.deepEqual(ready.json(), { status: 'unavailable' });
  assert.ok(!ready.body.includes('secret'));
});

test('readiness checks the database and returns success when it responds', async (t) => {
  const database = new Pool();
  const query = t.mock.method(database, 'query', async () => ({
    rows: [{ '?column?': 1 }],
  }));
  const app = buildApp(database);
  t.after(() => app.close());

  const response = await app.inject('/api/ready');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: 'ok' });
  assert.equal(query.mock.calls[0]?.arguments[0], 'SELECT 1');
});
