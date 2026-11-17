// D049: Gmail and Outlook push. Notifications only wake the ordinary sync;
// watches and subscriptions are created and renewed by the worker, and
// failures never fail a sync. Synthetic providers only.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { test } from 'node:test';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { encryptCredential, readMailKeys } from '../src/mail/credentials.js';
import { syncGmailAccount } from '../src/mail/gmail.js';
import { readGoogleConfig } from '../src/mail/google.js';
import { syncGraphAccount } from '../src/mail/graph.js';
import { readMicrosoftConfig } from '../src/mail/microsoft.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { fakeGoogle } from './google-fixture.js';
import { fakeMicrosoft } from './microsoft-fixture.js';

test('push configuration is optional, https-only and complete', () => {
  const base = { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' };
  assert.equal(readGoogleConfig(base)?.push, null);
  const push = {
    ...base,
    PUSH_URL: 'https://mail.example.test',
    GMAIL_PUSH_TOPIC: 'projects/spindle-test/topics/mail',
    GMAIL_PUSH_SERVICE_ACCOUNT: 'push@spindle-test.iam.gserviceaccount.com',
  };
  assert.equal(
    readGoogleConfig(push)?.push?.audience,
    'https://mail.example.test/api/push/google',
  );
  assert.throws(() => readGoogleConfig({ ...push, PUSH_URL: '' }));
  assert.throws(() =>
    readGoogleConfig({ ...push, GMAIL_PUSH_SERVICE_ACCOUNT: '' }),
  );
  assert.throws(() =>
    readGoogleConfig({ ...push, GMAIL_PUSH_TOPIC: 'topics/mail' }),
  );
  assert.throws(() =>
    readGoogleConfig({ ...push, PUSH_URL: 'http://mail.example.test' }),
  );
  assert.throws(() =>
    readGoogleConfig({ ...push, PUSH_URL: 'https://mail.example.test/x' }),
  );
  const microsoft = {
    MICROSOFT_CLIENT_ID: 'id',
    MICROSOFT_CLIENT_SECRET: 'secret',
  };
  assert.equal(readMicrosoftConfig(microsoft)?.pushUrl, null);
  assert.equal(
    readMicrosoftConfig({
      ...microsoft,
      PUSH_URL: 'https://mail.example.test/',
    })?.pushUrl,
    'https://mail.example.test/api/push/microsoft',
  );
});

test('Gmail and Outlook push wake sync, renew and ignore forgeries', {
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
      v1: Buffer.alloc(32, 93).toString('base64'),
    }),
  });
  // Google's signing keys, served like the real certs endpoint.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const certs = Fastify();
  let certRequests = 0;
  certs.get('/certs', async (_request, reply) => {
    certRequests++;
    return reply.header('cache-control', 'public, max-age=3600').send({
      keys: [
        { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' },
      ],
    });
  });
  await certs.listen({ host: '127.0.0.1', port: 0 });
  const certsAddress = certs.server.address();
  assert.ok(certsAddress && typeof certsAddress === 'object');
  const google = await fakeGoogle();
  const microsoft = await fakeMicrosoft();
  const audience = 'https://push.example.test/api/push/google';
  google.config.push = {
    topic: 'projects/spindle-test/topics/mail',
    serviceAccount: 'push@spindle-test.iam.gserviceaccount.com',
    audience,
    certsUrl: `http://127.0.0.1:${certsAddress.port}/certs`,
  };
  microsoft.config.pushUrl = 'https://push.example.test/api/push/microsoft';
  const app = testApp(
    pool,
    testConfig,
    undefined,
    keys,
    undefined,
    google.config,
    microsoft.config,
  );
  t.after(async () => {
    await app.close();
    await google.app.close();
    await microsoft.app.close();
    await certs.close();
  });
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'push-owner@example.test',
    '203.0.113.161',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'push-other@example.test',
    '203.0.113.162',
  );
  const account = async (
    user: string,
    provider: 'gmail' | 'microsoft',
    address: string,
  ) => {
    const id = randomUUID();
    const refresh = `refresh-${randomUUID()}`;
    const identity = { sub: `sub-${address}`, email: address };
    if (provider === 'gmail') google.refreshTokens.set(refresh, identity);
    else microsoft.refreshTokens.set(refresh, identity);
    await pool.query(
      `INSERT INTO mail_accounts(id,user_id,provider,provider_account,name,username,credential)
      VALUES($1,$2,$3,$4,$5,$5,$6)`,
      [
        id,
        user,
        provider,
        identity.sub,
        address,
        encryptCredential(refresh, user, id, keys),
      ],
    );
    return id;
  };
  // One Gmail address connected by two Spindle users, plus an Outlook account.
  const gmailA = await account(owner.id, 'gmail', 'shared@gmail.test');
  const gmailB = await account(other.id, 'gmail', 'shared@gmail.test');
  const outlook = await account(owner.id, 'microsoft', 'owner@outlook.test');
  const one = async (sql: string, params: unknown[]) =>
    (await pool.query(sql, params)).rows[0];
  const pushRow = (id: string) =>
    one(
      'SELECT subscription_id,error_code,renew_at>clock_timestamp() AS later FROM mail_push WHERE account_id=$1',
      [id],
    );
  const status = async (id: string) =>
    (await one('SELECT status FROM mail_accounts WHERE id=$1', [id])).status;

  // The first successful pass watches; a second pass before the daily
  // renewal does not call Google again.
  assert.equal(
    await syncGmailAccount(pool, keys, google.config, owner.id, gmailA),
    true,
  );
  assert.deepEqual(google.watches, [{ topicName: google.config.push.topic }]);
  assert.equal((await pushRow(gmailA)).later, true);
  await pool.query('UPDATE mail_accounts SET next_sync_at=now() WHERE id=$1', [
    gmailA,
  ]);
  await syncGmailAccount(pool, keys, google.config, owner.id, gmailA);
  assert.equal(google.watches.length, 1);
  await pool.query(
    "UPDATE mail_push SET renew_at=now()-interval '1 second' WHERE account_id=$1",
    [gmailA],
  );
  await syncGmailAccount(pool, keys, google.config, owner.id, gmailA);
  assert.equal(google.watches.length, 2);

  // A refused watch leaves the sync successful and retries later.
  google.state.watchFails = true;
  assert.equal(
    await syncGmailAccount(pool, keys, google.config, other.id, gmailB),
    true,
  );
  assert.notEqual(await status(gmailB), 'error');
  assert.equal((await pushRow(gmailB)).error_code, '403');
  assert.equal((await pushRow(gmailB)).later, true);
  google.state.watchFails = false;
  await pool.query(
    "UPDATE mail_push SET renew_at=now()-interval '1 second' WHERE account_id=$1",
    [gmailB],
  );
  await pool.query('UPDATE mail_accounts SET next_sync_at=now() WHERE id=$1', [
    gmailB,
  ]);
  await syncGmailAccount(pool, keys, google.config, other.id, gmailB);
  assert.equal((await pushRow(gmailB)).error_code, null);

  // Wake state: due now with a new sync request.
  const asleep = async () => {
    await pool.query(
      "UPDATE mail_accounts SET next_sync_at=now()+interval '1 hour',status='ready' WHERE id=ANY($1::uuid[])",
      [[gmailA, gmailB, outlook]],
    );
    return Object.fromEntries(
      (
        await pool.query(
          'SELECT id,sync_request FROM mail_accounts WHERE id=ANY($1::uuid[])',
          [[gmailA, gmailB, outlook]],
        )
      ).rows.map((row) => [row.id, row.sync_request]),
    );
  };
  const woken = async (before: Record<string, string>) =>
    (
      await pool.query(
        'SELECT id FROM mail_accounts WHERE id=ANY($1::uuid[]) AND next_sync_at<=now() AND sync_request::text<>($2::jsonb->>id::text) ORDER BY id',
        [[gmailA, gmailB, outlook], JSON.stringify(before)],
      )
    ).rows.map((row) => row.id);
  const jwt = (claims: Record<string, unknown> = {}) => {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url');
    const head = encode({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
    const body = encode({
      iss: 'https://accounts.google.com',
      aud: audience,
      email: google.config.push?.serviceAccount,
      email_verified: true,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...claims,
    });
    return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
  };
  const gmailPush = (address: string, token?: string) =>
    app.inject({
      method: 'POST',
      url: '/api/push/google',
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: {
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: address, historyId: '1' }),
          ).toString('base64'),
          messageId: '1',
        },
        subscription: 'projects/spindle-test/subscriptions/mail',
      },
    });
  let before = await asleep();
  assert.equal((await gmailPush('shared@gmail.test')).statusCode, 401);
  assert.equal(
    (await gmailPush('shared@gmail.test', jwt({ aud: 'https://evil.test' })))
      .statusCode,
    401,
  );
  assert.equal(
    (await gmailPush('shared@gmail.test', jwt({ email: 'x@evil.test' })))
      .statusCode,
    401,
  );
  assert.equal((await gmailPush('nobody@gmail.test', jwt())).statusCode, 204);
  assert.deepEqual(await woken(before), []);
  // Both users' accounts for the address wake; each syncs its own grant.
  assert.equal((await gmailPush('Shared@gmail.test', jwt())).statusCode, 204);
  assert.deepEqual(await woken(before), [gmailA, gmailB].sort());
  assert.equal(certRequests, 1, 'signing keys are cached');
  // Accounts waiting for reconnect stay asleep.
  before = await asleep();
  await pool.query("UPDATE mail_accounts SET status='error' WHERE id=$1", [
    gmailB,
  ]);
  await gmailPush('shared@gmail.test', jwt());
  assert.deepEqual(await woken(before), [gmailA]);

  // Outlook: the first pass subscribes to all messages.
  assert.equal(
    await syncGraphAccount(pool, keys, microsoft.config, owner.id, outlook),
    true,
  );
  assert.equal(microsoft.subscriptions.size, 1);
  const [first, created] = [...microsoft.subscriptions][0] ?? [];
  assert.ok(first && created);
  assert.equal(created.body.resource, 'me/messages');
  assert.equal(created.body.changeType, 'created,updated,deleted');
  assert.equal(created.body.notificationUrl, microsoft.config.pushUrl);
  assert.equal(created.body.lifecycleNotificationUrl, microsoft.config.pushUrl);
  assert.equal((await pushRow(outlook)).subscription_id, first);
  const clientState = String(created.body.clientState);
  assert.match(clientState, /^[\w-]{64}$/);
  const validation = await app.inject({
    method: 'POST',
    url: '/api/push/microsoft?validationToken=Validation%3A%20token%3Cb%3E',
    headers: { 'content-type': 'text/plain' },
    payload: '',
  });
  assert.equal(validation.statusCode, 200);
  assert.equal(validation.body, 'Validation: token<b>');
  assert.match(String(validation.headers['content-type']), /^text\/plain/);
  const graphPush = (items: Record<string, unknown>[]) =>
    app.inject({
      method: 'POST',
      url: '/api/push/microsoft',
      payload: { value: items },
    });
  before = await asleep();
  for (const items of [
    [{ subscriptionId: first, clientState: 'wrong', changeType: 'created' }],
    [{ subscriptionId: 'unknown', clientState, changeType: 'created' }],
    [{ subscriptionId: first, changeType: 'created' }],
  ])
    assert.equal((await graphPush(items)).statusCode, 202);
  assert.deepEqual(await woken(before), []);
  assert.equal(
    (
      await graphPush([
        { subscriptionId: first, clientState, changeType: 'created' },
      ])
    ).statusCode,
    202,
  );
  assert.deepEqual(await woken(before), [outlook]);

  // A due renewal extends the same subscription.
  await pool.query(
    "UPDATE mail_push SET renew_at=now()-interval '1 second' WHERE account_id=$1",
    [outlook],
  );
  const expires = created.expires;
  await syncGraphAccount(pool, keys, microsoft.config, owner.id, outlook);
  assert.equal((await pushRow(outlook)).subscription_id, first);
  assert.notEqual(microsoft.subscriptions.get(first)?.expires, expires);

  // Graph removed it: the lifecycle event forces renewal, which recreates it
  // with a new client state; the old one no longer wakes the account.
  before = await asleep();
  microsoft.subscriptions.delete(first);
  await graphPush([
    {
      subscriptionId: first,
      clientState,
      lifecycleEvent: 'subscriptionRemoved',
    },
  ]);
  assert.deepEqual(await woken(before), [outlook]);
  assert.equal((await pushRow(outlook)).later, false);
  await syncGraphAccount(pool, keys, microsoft.config, owner.id, outlook);
  const [second, replaced] = [...microsoft.subscriptions][0] ?? [];
  assert.ok(second && replaced && second !== first);
  assert.equal((await pushRow(outlook)).subscription_id, second);
  before = await asleep();
  await graphPush([{ subscriptionId: first, clientState }]);
  await graphPush([{ subscriptionId: second, clientState }]);
  assert.deepEqual(await woken(before), []);
  await graphPush([
    { subscriptionId: second, clientState: replaced.body.clientState },
  ]);
  assert.deepEqual(await woken(before), [outlook]);

  // Disconnect removes the local push state with the account.
  await pool.query('DELETE FROM mail_accounts WHERE id=$1', [outlook]);
  assert.equal(await pushRow(outlook), undefined);
});
