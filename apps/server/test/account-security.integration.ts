import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('private account profile, credential changes, verified replacement emails and revocable sessions', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60000,
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
  const mailer = nodemailer.createTransport({ jsonTransport: true });
  const messages: { to: string; text: string; subject: string }[] = [];
  t.mock.method(mailer, 'sendMail', async (mail: SendMailOptions) => {
    messages.push({
      to: String(mail.to),
      text: String(mail.text),
      subject: String(mail.subject),
    });
    return { messageId: 'synthetic-account-security' };
  });
  const app = testApp(pool, testConfig, mailer);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'security-owner@example.test',
    '203.0.113.238',
  );
  const foreign = await createTestUser(
    app,
    pool,
    testConfig,
    'security-admin@example.test',
    '203.0.113.238',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [foreign.id]);
  type TestUser = typeof owner;
  const request = (
    path: string,
    body?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) =>
    app.inject({
      method: body ? 'POST' : 'GET',
      url: `/api/auth/account${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
  const login = async (
    user: TestUser,
    email = user.email,
    password = user.password,
  ) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: '203.0.113.239',
      headers: {
        origin: testConfig.appUrl,
        'user-agent': 'Synthetic other device',
      },
      payload: { email, password },
    });
    assert.equal(response.statusCode, 200, response.body);
    const token = response.json().token;
    const row = (
      await pool.query(
        'SELECT id FROM auth_sessions WHERE user_id=$1 AND token=$2',
        [user.id, token],
      )
    ).rows[0];
    assert.ok(row);
    const headers = response.headers['set-cookie'];
    const cookie = (Array.isArray(headers) ? headers : [String(headers)])
      .map((value) => value.split(';')[0])
      .join('; ');
    return { cookie, id: row.id as string };
  };
  const user = (name: string) =>
    createTestUser(
      app,
      pool,
      testConfig,
      `security-${name}@example.test`,
      '203.0.113.240',
    );
  const beginEmail = (account: TestUser, newEmail: string) =>
    request(
      '/email',
      { currentPassword: account.password, newEmail },
      account.cookie,
    );
  const token = (email: string) => {
    const message = messages.findLast(
      (mail) => mail.to === email && mail.subject.includes('new Spindle'),
    );
    assert.ok(message, 'Expected replacement verification email');
    const href = message.text.match(/https?:\/\/\S+/)?.[0];
    assert.ok(href);
    const link = new URL(href);
    assert.equal(link.pathname, '/login');
    assert.equal(link.searchParams.get('view'), 'email-change');
    const value = link.searchParams.get('token');
    assert.ok(value);
    return value;
  };
  const confirm = (value: string, cookie = '') =>
    request('/email/confirm', { token: value }, cookie);
  t.beforeEach(async () => {
    await pool.query('DELETE FROM auth_rate_limits');
    await pool.query(
      "DELETE FROM mail_request_limits WHERE action LIKE 'account-%'",
    );
  });

  await t.test(
    'profile updates are verified, owned, bounded and cannot forge email, identity or privilege',
    async () => {
      assert.equal((await request('')).statusCode, 200);
      assert.equal((await request('', undefined, '')).statusCode, 401);
      assert.equal(
        (
          await request(
            '/profile',
            { name: 'New name' },
            owner.cookie,
            'https://foreign.example.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await request('/profile', { name: '  New profile name  ' }))
          .statusCode,
        200,
      );
      assert.equal((await request('')).json().user.name, 'New profile name');
      for (const body of [
        { name: '' },
        { name: 'x'.repeat(101) },
        { name: 'line\nbreak' },
        { name: 'valid', role: 'admin' },
        { name: 'valid', email: foreign.email },
        { name: 'valid', id: foreign.id },
      ])
        assert.equal((await request('/profile', body)).statusCode, 400);
      const rows = (
        await pool.query(
          'SELECT id,name,email,role FROM users WHERE id=ANY($1::text[])',
          [[owner.id, foreign.id]],
        )
      ).rows;
      assert.equal(rows.find((row) => row.id === owner.id).role, 'user');
      assert.equal(
        rows.find((row) => row.id === foreign.id).name,
        'Reader Test',
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        owner.id,
      ]);
      assert.equal((await request('')).statusCode, 403);
      assert.equal(
        (await request('/profile', { name: 'Denied' })).statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        owner.id,
      ]);
      for (const path of [
        '/update-user',
        '/change-password',
        '/change-email',
        '/list-sessions',
        '/revoke-session',
      ])
        assert.equal(
          (
            await app.inject({
              method: 'POST',
              url: `/api/auth${path}`,
              headers: { cookie: owner.cookie, origin: testConfig.appUrl },
              payload: {},
            })
          ).statusCode,
          404,
        );
    },
  );

  await t.test(
    'sessions are private and paged without bearer tokens; revocation requires current password and preserves this device',
    async () => {
      const other = await login(owner);
      const listed = await request('/sessions');
      assert.equal(listed.statusCode, 200, listed.body);
      assert.ok(
        listed
          .json()
          .sessions.some(
            (session: { id: string; current: boolean }) =>
              session.id === owner.session && session.current,
          ),
      );
      assert.ok(
        listed
          .json()
          .sessions.some((session: { id: string }) => session.id === other.id),
      );
      assert.ok(
        listed
          .json()
          .sessions.every(
            (session: object) =>
              !('token' in session) && !('userId' in session),
          ),
      );
      assert.equal(
        (
          await request('/sessions/revoke', {
            currentPassword: 'wrong',
            sessionId: other.id,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('/sessions/revoke', {
            currentPassword: owner.password,
            sessionId: foreign.session,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            '/sessions/revoke',
            { currentPassword: foreign.password, sessionId: other.id },
            foreign.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request('/sessions/revoke', {
            currentPassword: owner.password,
            sessionId: owner.session,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('/sessions/revoke', {
            currentPassword: owner.password,
            sessionId: other.id,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await request('', undefined, other.cookie)).statusCode,
        401,
      );
      assert.equal((await request('')).statusCode, 200);
      await pool.query(
        "DELETE FROM mail_request_limits WHERE user_id=$1 AND action='account-settings-confirm'",
        [owner.id],
      );
      const second = await login(owner),
        third = await login(owner);
      assert.equal(
        (
          await request('/sessions/revoke-others', {
            currentPassword: owner.password,
          })
        ).statusCode,
        200,
      );
      assert.equal(
        (await request('', undefined, second.cookie)).statusCode,
        401,
      );
      assert.equal(
        (await request('', undefined, third.cookie)).statusCode,
        401,
      );
      assert.equal(
        (await request('', undefined, foreign.cookie)).statusCode,
        200,
      );
      assert.equal(
        (await request('/sessions?cursor=foreign-session')).statusCode,
        400,
      );
    },
  );

  await t.test(
    'replacement email is verified before switching, binds stable identity, revokes sessions/links, and never signs in',
    async () => {
      const account = await user('change');
      await login(account);
      const response = await beginEmail(account, 'SECURITY-NEW@example.test');
      assert.equal(response.statusCode, 200, response.body);
      const value = token('security-new@example.test');
      const stored = await request('', undefined, account.cookie);
      assert.equal(stored.json().user.email, account.email);
      assert.equal(
        stored.json().pendingEmail.email,
        'security-new@example.test',
      );
      const records = (
        await pool.query(
          'SELECT identifier,value FROM auth_verifications WHERE value=$1',
          [account.id],
        )
      ).rows;
      assert.ok(records.length > 0);
      assert.ok(
        records.every(
          (row) => !row.identifier.includes(value) && row.value === account.id,
        ),
      );
      assert.equal((await confirm(value, foreign.cookie)).statusCode, 400);
      assert.equal(
        (
          await request(
            '/email/confirm',
            { token: value },
            '',
            'https://foreign.example.test',
          )
        ).statusCode,
        403,
      );
      assert.equal((await confirm(value)).statusCode, 200);
      assert.equal((await confirm(value)).statusCode, 400);
      const row = (
        await pool.query(
          'SELECT id,email,email_verified,role FROM users WHERE id=$1',
          [account.id],
        )
      ).rows[0];
      assert.equal(row.email, 'security-new@example.test');
      assert.equal(row.email_verified, true);
      assert.equal(row.role, 'user');
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM auth_sessions WHERE user_id=$1',
              [account.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM auth_email_changes WHERE user_id=$1',
              [account.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        (await request('', undefined, account.cookie)).statusCode,
        401,
      );
      const signed = await login(account, row.email);
      assert.equal(
        (await request('', undefined, signed.cookie)).json().user.id,
        account.id,
      );
    },
  );

  await t.test(
    'expired, cancelled, replaced and password-invalidated links cannot change an email',
    async () => {
      const account = await user('invalid-links');
      assert.equal(
        (await beginEmail(account, 'security-expired@example.test')).statusCode,
        200,
      );
      const expired = token('security-expired@example.test');
      await pool.query(
        "UPDATE auth_verifications SET expires_at=now()-interval '1 second' WHERE value=$1",
        [account.id],
      );
      assert.equal((await confirm(expired)).statusCode, 400);
      assert.equal(
        (await beginEmail(account, 'security-replaced@example.test'))
          .statusCode,
        200,
      );
      const old = token('security-replaced@example.test');
      assert.equal(
        (await beginEmail(account, 'security-current@example.test')).statusCode,
        200,
      );
      const current = token('security-current@example.test');
      assert.equal((await confirm(old)).statusCode, 400);
      assert.equal(
        (
          await request(
            '/email/cancel',
            { currentPassword: account.password },
            account.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal((await confirm(current)).statusCode, 400);
      assert.equal(
        (await beginEmail(account, 'security-before-password@example.test'))
          .statusCode,
        200,
      );
      const stale = token('security-before-password@example.test');
      await pool.query(
        "DELETE FROM mail_request_limits WHERE user_id=$1 AND action='account-settings-confirm'",
        [account.id],
      );
      const changed = await request(
        '/password',
        {
          currentPassword: account.password,
          newPassword: 'a strong changed password 42!',
        },
        account.cookie,
      );
      assert.equal(changed.statusCode, 200, changed.body);
      assert.equal((await confirm(stale)).statusCode, 400);
      assert.equal(
        (await request('', undefined, account.cookie)).statusCode,
        401,
      );
      await login(account, account.email, 'a strong changed password 42!');
    },
  );

  await t.test(
    'simultaneous confirmation has one winner, existing targets are non-enumerating and later collisions preserve the original',
    async () => {
      const account = await user('race');
      const taken = await beginEmail(account, foreign.email);
      const available = await beginEmail(
        account,
        'security-race-new@example.test',
      );
      assert.deepEqual(taken.json(), available.json());
      assert.equal(
        messages.filter(
          (mail) =>
            mail.to === foreign.email && mail.subject.includes('new Spindle'),
        ).length,
        0,
      );
      const value = token('security-race-new@example.test');
      const outcomes = await Promise.all([confirm(value), confirm(value)]);
      assert.deepEqual(
        outcomes.map((result) => result.statusCode).sort(),
        [200, 400],
      );
      const collision = await user('collision');
      assert.equal(
        (await beginEmail(collision, 'security-occupied@example.test'))
          .statusCode,
        200,
      );
      const collisionToken = token('security-occupied@example.test');
      await user('occupied');
      assert.equal((await confirm(collisionToken)).statusCode, 400);
      assert.equal(
        (await request('', undefined, collision.cookie)).json().user.email,
        collision.email,
      );
    },
  );

  await t.test(
    'session pagination is stable, bounded and rejects foreign cursors',
    async () => {
      const account = await user('pagination');
      await pool.query(
        `INSERT INTO auth_sessions(id,user_id,token,expires_at,created_at,updated_at)
      SELECT 'security-page-'||n,$1,'synthetic-page-token-'||n,now()+interval '1 day',now(),now()
      FROM generate_series(1,31) n`,
        [account.id],
      );
      const first = await request('/sessions', undefined, account.cookie);
      assert.equal(first.statusCode, 200, first.body);
      assert.equal(first.json().sessions.length, 25);
      assert.equal(first.json().sessions[0].id, account.session);
      const second = await request(
        `/sessions?cursor=${first.json().nextCursor}`,
        undefined,
        account.cookie,
      );
      assert.equal(second.statusCode, 200, second.body);
      assert.equal(second.json().sessions.length, 7);
      assert.equal(second.json().nextCursor, null);
      const sessions = [...first.json().sessions, ...second.json().sessions];
      assert.equal(
        new Set(sessions.map((row: { id: string }) => row.id)).size,
        32,
      );
      assert.ok(
        sessions.every(
          (row: object) => !('token' in row) && !('userId' in row),
        ),
      );
      assert.equal(
        (
          await request(
            `/sessions?cursor=${foreign.session}`,
            undefined,
            account.cookie,
          )
        ).statusCode,
        400,
      );
    },
  );

  await t.test(
    'sign out others covers more sessions than the adapter default page',
    async () => {
      const account = await user('many-devices');
      await pool.query(
        `INSERT INTO auth_sessions(id,user_id,token,expires_at,created_at,updated_at)
      SELECT 'security-many-'||n,$1,'synthetic-many-token-'||n,now()+interval '1 day',now(),now()
      FROM generate_series(1,110) n`,
        [account.id],
      );
      const result = await request(
        '/sessions/revoke-others',
        { currentPassword: account.password },
        account.cookie,
      );
      assert.equal(result.statusCode, 200, result.body);
      const rows = (
        await pool.query('SELECT id FROM auth_sessions WHERE user_id=$1', [
          account.id,
        ])
      ).rows;
      assert.deepEqual(
        rows.map((row) => row.id),
        [account.session],
      );
    },
  );

  await t.test(
    'delivery failure preserves the current login and retry replaces the pending link',
    async (subtest) => {
      const account = await user('relay-failure');
      const mock = subtest.mock.method(mailer, 'sendMail', async () => {
        throw new Error('Synthetic private relay failure');
      });
      const result = await beginEmail(
        account,
        'security-relay-target@example.test',
      );
      assert.equal(result.statusCode, 503);
      assert.ok(!result.body.includes('private relay'));
      assert.equal(
        (await request('', undefined, account.cookie)).json().user.email,
        account.email,
      );
      const pending = (
        await pool.query(
          'SELECT verification_id FROM auth_email_changes WHERE user_id=$1',
          [account.id],
        )
      ).rows[0];
      assert.ok(pending);
      mock.mock.restore();
      assert.equal(
        (await beginEmail(account, 'security-relay-target@example.test'))
          .statusCode,
        200,
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM auth_verifications WHERE id=$1', [
            pending.verification_id,
          ])
        ).rowCount,
        0,
      );
      assert.equal(
        (await confirm(token('security-relay-target@example.test'))).statusCode,
        200,
      );
    },
  );

  await t.test(
    'deleted identities cannot transfer pending verification to a reused login address',
    async () => {
      const account = await user('deleted');
      assert.equal(
        (await beginEmail(account, 'security-deleted-target@example.test'))
          .statusCode,
        200,
      );
      const stale = token('security-deleted-target@example.test');
      await pool.query('DELETE FROM users WHERE id=$1', [account.id]);
      const replacement = await user('deleted');
      assert.notEqual(replacement.id, account.id);
      assert.equal((await confirm(stale)).statusCode, 400);
      assert.equal(
        (await request('', undefined, replacement.cookie)).json().user.email,
        replacement.email,
      );
    },
  );

  await t.test(
    'concurrent password changes accept only the confirmed current credential and revoke every session',
    async () => {
      const account = await user('password-race');
      const changes = await Promise.all(
        ['changed password one 42!', 'changed password two 42!'].map(
          (newPassword) =>
            request(
              '/password',
              { currentPassword: account.password, newPassword },
              account.cookie,
            ),
        ),
      );
      assert.equal(
        changes.filter((result) => result.statusCode === 200).length,
        1,
      );
      assert.ok(
        changes.every((result) => [200, 400, 401].includes(result.statusCode)),
        changes.map((result) => result.body).join(' '),
      );
      assert.equal(
        (await request('', undefined, account.cookie)).statusCode,
        401,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM auth_sessions WHERE user_id=$1',
              [account.id],
            )
          ).rows[0].count,
        ),
        0,
      );
      await login(
        account,
        account.email,
        changes[0]?.statusCode === 200
          ? 'changed password one 42!'
          : 'changed password two 42!',
      );
    },
  );

  await t.test(
    'wrong password, unsupported fields and repeated password guesses fail closed',
    async () => {
      assert.equal(
        (
          await request('/password', {
            currentPassword: 'wrong',
            newPassword: 'a strong changed password 42!',
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('/password', {
            currentPassword: owner.password,
            newPassword: 'short',
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('/email', {
            currentPassword: owner.password,
            newEmail: 'not-an-email',
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('/email', {
            currentPassword: 'wrong',
            newEmail: 'security-denied@example.test',
          })
        ).statusCode,
        400,
      );
      await pool.query(
        "DELETE FROM mail_request_limits WHERE user_id=$1 AND action='account-settings-confirm'",
        [owner.id],
      );
      for (let n = 0; n < 5; n++)
        assert.equal(
          (
            await request('/sessions/revoke-others', {
              currentPassword: 'wrong',
            })
          ).statusCode,
          400,
        );
      assert.equal(
        (
          await request('/sessions/revoke-others', {
            currentPassword: owner.password,
          })
        ).statusCode,
        429,
      );
      assert.equal((await request('')).json().user.email, owner.email);
      assert.equal(
        (await confirm(randomUUID().replaceAll('-', '').repeat(2))).statusCode,
        400,
      );
    },
  );
});
