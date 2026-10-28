import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('private local drafts, revision control and recovery', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 30000,
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
      v1: Buffer.alloc(32, 48).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'draft-owner@example.test',
    '203.0.113.213',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'draft-admin@example.test',
    '203.0.113.213',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  function request(
    path: string,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) {
    return app.inject({
      method,
      url: `/api/mail/${path}`,
      headers: { cookie, origin },
      ...(payload ? { payload } : {}),
    });
  }
  const account = async (cookie: string, username: string) => {
    const result = await request(
      'accounts',
      'POST',
      {
        name: 'Draft test account',
        host: 'mail.example.test',
        port: 993,
        transport: 'tls',
        username,
        password: 'synthetic-only-password',
        history: 'all',
      },
      cookie,
    );
    assert.equal(result.statusCode, 202, result.body);
    return result.json().account.id as string;
  };
  const ownAccount = await account(owner.cookie, 'draft-owner@example.test');
  const foreignAccount = await account(
    other.cookie,
    'draft-admin@example.test',
  );
  const content = {
    to: 'Incomplete Recipient <',
    cc: 'cc@example.test',
    bcc: 'private@example.test',
    subject: 'Synthetic draft — café',
    format: 'rich',
    html: '<p>Hello <strong>world</strong></p><p>Second line</p>',
    text: 'not authoritative',
  };
  const initial = (patch = {}) => ({
    revision: 0,
    saveId: randomUUID(),
    accountId: ownAccount,
    content,
    ...patch,
  });
  const save = (id: string, body: object, cookie = owner.cookie) =>
    request(`drafts/${id}`, 'PUT', body, cookie);
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_drafts');
    await pool.query('DELETE FROM mail_request_limits');
  });

  await t.test(
    'drafts require verified owners; admins, foreign accounts and cross-origin writes are denied',
    async () => {
      const id = randomUUID();
      assert.equal((await save(id, initial())).statusCode, 200);
      assert.equal(
        (await request(`drafts/${id}`, 'GET', undefined, '')).statusCode,
        401,
      );
      assert.equal(
        (
          await request(
            `drafts/${id}`,
            'PUT',
            initial(),
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await request(`drafts/${id}`, 'GET', undefined, other.cookie))
          .statusCode,
        404,
      );
      assert.deepEqual(
        (await request('drafts', 'GET', undefined, other.cookie)).json().drafts,
        [],
      );
      assert.equal(
        (await request(`drafts/${id}`, 'DELETE', { revision: 1 }, other.cookie))
          .statusCode,
        404,
      );
      assert.equal((await save(id, initial(), other.cookie)).statusCode, 409);
      assert.equal(
        (await save(randomUUID(), initial({ accountId: foreignAccount })))
          .statusCode,
        409,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        other.id,
      ]);
      assert.equal(
        (await request('drafts', 'GET', undefined, other.cookie)).statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        other.id,
      ]);
      assert.equal((await request(`drafts/${id}`)).json().draft.revision, 1);
    },
  );

  await t.test(
    'drafts round-trip Unicode, partial recipients, rich and plain text across API restarts',
    async () => {
      const id = randomUUID();
      const first = await save(id, initial());
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().draft.content.text, 'Hello world\nSecond line');
      assert.equal(first.json().draft.content.bcc, 'private@example.test');
      const secondApp = testApp(
        new Pool({ connectionString }),
        testConfig,
        undefined,
        keys,
      );
      try {
        const loaded = await secondApp.inject({
          url: `/api/mail/drafts/${id}`,
          headers: { cookie: owner.cookie },
        });
        assert.deepEqual(loaded.json().draft, first.json().draft);
      } finally {
        await secondApp.close();
      }
      const plain = await save(
        id,
        initial({
          revision: 1,
          accountId: null,
          content: {
            ...content,
            format: 'plain',
            html: '<script>ignored</script>',
            text: 'Text <not HTML>\n😀',
          },
        }),
      );
      assert.equal(plain.statusCode, 200, plain.body);
      assert.equal(plain.json().draft.content.html, '');
      assert.equal(plain.json().draft.content.text, 'Text <not HTML>\n😀');
      assert.equal(plain.json().draft.accountId, null);
      const list = (await request('drafts')).json().drafts;
      assert.equal(list.length, 1);
      assert.equal(list[0].subject, content.subject);
      assert.equal(list[0].content, undefined);
    },
  );

  await t.test(
    'lost response replay is idempotent and reused save tokens cannot change content or revision',
    async () => {
      const id = randomUUID();
      const body = initial();
      const first = (await save(id, body)).json().draft;
      assert.deepEqual((await save(id, body)).json().draft, first);
      assert.equal(
        (
          await save(id, {
            ...body,
            content: { ...content, subject: 'Changed under same token' },
          })
        ).statusCode,
        409,
      );
      assert.equal((await save(id, { ...body, revision: 1 })).statusCode, 409);
      assert.equal((await request(`drafts/${id}`)).json().draft.revision, 1);
    },
  );

  await t.test(
    'concurrent saves and stale deletes preserve the winning revision',
    async () => {
      const id = randomUUID();
      await save(id, initial());
      const results = await Promise.all(
        ['First tab', 'Second tab'].map((subject) =>
          save(id, initial({ revision: 1, content: { ...content, subject } })),
        ),
      );
      assert.deepEqual(
        results.map((result) => result.statusCode).sort(),
        [200, 409],
      );
      const winner = results
        .find((result) => result.statusCode === 200)
        ?.json().draft;
      assert.deepEqual((await request(`drafts/${id}`)).json().draft, winner);
      assert.equal(winner.revision, 2);
      assert.equal(
        (await request(`drafts/${id}`, 'DELETE', { revision: 1 })).statusCode,
        409,
      );
      assert.equal(
        (await request(`drafts/${id}`, 'DELETE', { revision: 2 })).statusCode,
        200,
      );
      assert.equal((await save(id, initial({ revision: 2 }))).statusCode, 409);
      assert.equal((await request(`drafts/${id}`)).statusCode, 404);
    },
  );

  await t.test(
    'hostile rich content is sanitized and its plain alternative is derived from safe HTML',
    async () => {
      const id = randomUUID();
      const result = await save(
        id,
        initial({
          content: {
            ...content,
            html: '<script>secret()</script><style>body{background:url(https://track.test)}</style><svg>hidden</svg><p onclick="alert(1)" style="color:red">Safe <a href="javascript:alert(1)">bad</a><a href="//tracker.test">relative</a><a href="https://example.test/path">good</a><img src="https://track.test/x"></p>',
            text: 'forged alternative',
          },
        }),
      );
      assert.equal(result.statusCode, 200, result.body);
      const saved = result.json().draft.content;
      assert.doesNotMatch(
        saved.html,
        /script|style|svg|onclick|img|javascript|track/,
      );
      assert.match(saved.html, /href="https:\/\/example.test\/path"/);
      assert.equal(saved.text, 'Safe badrelativegood');
    },
  );

  await t.test(
    'header injection, invalid payloads and oversized drafts are rejected without losing saved text',
    async () => {
      const id = randomUUID();
      await save(id, initial());
      for (const patch of [
        {
          content: {
            ...content,
            subject: 'Subject\r\nBcc: injected@example.test',
          },
        },
        { content: { ...content, to: 'recipient@example.test\nInjected' } },
        { content: { ...content, bcc: 'bad\u0000value' } },
        { content: { ...content, format: 'unknown' } },
        { content: { ...content, text: 'x'.repeat(100001) } },
        { accountId: 'invalid' },
        { revision: -1 },
        { saveId: 'invalid' },
      ])
        assert.equal(
          (await save(id, initial({ revision: 1, ...patch }))).statusCode,
          400,
        );
      const large = await save(
        id,
        initial({
          revision: 1,
          content: { ...content, html: '😀'.repeat(30000), text: '' },
        }),
      );
      assert.equal(large.statusCode, 413);
      assert.equal((await request(`drafts/${id}`)).json().draft.revision, 1);
    },
  );

  await t.test(
    'autosave racing with account removal preserves text without lock inversion',
    async () => {
      const temporary = await account(owner.cookie, 'temporary@example.test');
      const id = randomUUID();
      await save(id, initial({ accountId: temporary }));
      const [saved, removed] = await Promise.all([
        save(
          id,
          initial({
            accountId: temporary,
            revision: 1,
            content: { ...content, subject: 'Latest autosave' },
          }),
        ),
        request(`accounts/${temporary}`, 'DELETE', {
          password: owner.password,
        }),
      ]);
      assert.ok([200, 409].includes(saved.statusCode), saved.body);
      assert.equal(removed.statusCode, 200, removed.body);
      const draft = (await request(`drafts/${id}`)).json().draft;
      assert.equal(draft.accountId, null);
      assert.equal(
        draft.content.subject,
        saved.statusCode === 200 ? 'Latest autosave' : content.subject,
      );
      assert.equal(draft.revision, saved.statusCode === 200 ? 3 : 2);
    },
  );

  await t.test(
    'quota is atomic and autosave has its own persistent write budget',
    async () => {
      await pool.query(
        `INSERT INTO mail_drafts(id,user_id,content) SELECT gen_random_uuid(),$1,$2 FROM generate_series(1,99)`,
        [owner.id, content],
      );
      const ids = [randomUUID(), randomUUID()];
      const results = await Promise.all(ids.map((id) => save(id, initial())));
      assert.deepEqual(
        results.map((result) => result.statusCode).sort(),
        [200, 409],
      );
      assert.equal((await request('drafts')).json().drafts.length, 100);
      await pool.query('DELETE FROM mail_drafts');
      await pool.query('DELETE FROM mail_request_limits');
      const id = randomUUID();
      const body = initial();
      for (let i = 0; i < 120; i++)
        assert.equal((await save(id, body)).statusCode, 200);
      assert.equal((await save(id, body)).statusCode, 429);
      // A full autosave budget does not consume the action/connection write budget.
      assert.equal(
        (
          await request('accounts', 'POST', {
            name: 'Another account',
            host: 'mail.example.test',
            port: 993,
            transport: 'tls',
            username: 'another@example.test',
            password: 'synthetic-password',
            history: 'all',
          })
        ).statusCode,
        202,
      );
    },
  );

  await t.test(
    'disconnect preserves draft content, clears the account and invalidates stale editors',
    async () => {
      const id = randomUUID();
      await save(id, initial());
      const removed = await request(`accounts/${ownAccount}`, 'DELETE', {
        password: owner.password,
      });
      assert.equal(removed.statusCode, 200, removed.body);
      const draft = (await request(`drafts/${id}`)).json().draft;
      assert.equal(draft.accountId, null);
      assert.equal(draft.revision, 2);
      assert.equal(draft.saveId, null);
      assert.equal(draft.content.subject, content.subject);
      assert.equal((await save(id, initial({ revision: 1 }))).statusCode, 409);
      const saved = await save(id, initial({ accountId: null, revision: 2 }));
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(saved.json().draft.revision, 3);
    },
  );
});
