import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmailVerificationToken } from 'better-auth/api';
import type { LightMyRequestResponse } from 'fastify';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { testApp, testConfig } from './auth-fixture.js';

const password = 'a strong test-only password 42!';
const nextPassword = 'a different test-only password 84!';

test('PostgreSQL authentication flows', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 120000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5000,
    query_timeout: 15000,
  });
  await migrateDatabase(pool);
  await migrateDatabase(pool);
  const messages: { to: string; subject: string; text: string }[] = [];
  const mailer = nodemailer.createTransport({ jsonTransport: true });
  t.mock.method(mailer, 'sendMail', async (options: SendMailOptions) => {
    messages.push({
      to: String(options.to),
      subject: String(options.subject),
      text: String(options.text),
    });
    return { messageId: 'test-message' };
  });
  const app = testApp(pool, testConfig, mailer);
  t.after(() => app.close());
  let ip = 0;
  function request(
    path: string,
    payload?: object,
    cookie?: string,
    extra: Record<string, string> = {},
    remoteAddress?: string,
  ) {
    return app.inject({
      method: payload ? 'POST' : 'GET',
      url: path,
      remoteAddress: remoteAddress ?? `198.51.100.${++ip}`,
      headers: {
        origin: testConfig.appUrl,
        ...(cookie ? { cookie } : {}),
        ...extra,
      },
      ...(payload ? { payload } : {}),
    });
  }
  function cookies(response: LightMyRequestResponse) {
    const values = response.headers['set-cookie'];
    return (Array.isArray(values) ? values : values ? [values] : [])
      .map((value) => value.split(';')[0])
      .join('; ');
  }
  function emailLink(email: string, subject: string) {
    const message = messages.findLast(
      (item) => item.to === email && item.subject.includes(subject),
    );
    assert.ok(message, `Expected ${subject} email`);
    const link = message.text.match(/https?:\/\/\S+/)?.[0];
    assert.ok(link);
    return new URL(link);
  }
  async function invite(email: string, role = 'user', expired = false) {
    await pool.query(
      'INSERT INTO invites(email, role, expires_at) VALUES ($1, $2, $3)',
      [email, role, new Date(Date.now() + (expired ? -3600000 : 86400000))],
    );
  }
  async function signup(email: string, extra: Record<string, unknown> = {}) {
    return request('/api/auth/sign-up/email', {
      email,
      name: 'Test user',
      password,
      callbackURL: `${testConfig.appUrl}/?verified=1`,
      ...extra,
    });
  }
  async function verify(email: string) {
    const link = emailLink(email, 'Verify');
    return request(`${link.pathname}${link.search}`);
  }
  async function login(email: string, value = password) {
    return request('/api/auth/sign-in/email', { email, password: value });
  }
  let firstCookie = '';
  let firstId = '';
  let otherCookie = '';

  await t.test('registration is invite-only and validates inputs', async () => {
    assert.equal(
      (await request('/api/auth-config')).json().registrationMode,
      'invite',
    );
    assert.equal((await signup('not-invited@example.test')).statusCode, 200);
    assert.equal(
      Number(
        (
          await pool.query('SELECT count(*) FROM users WHERE email=$1', [
            'not-invited@example.test',
          ])
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(messages.length, 0);
    await invite('expired@example.test', 'user', true);
    assert.equal((await signup('expired@example.test')).statusCode, 200);
    assert.equal(
      Number(
        (
          await pool.query('SELECT count(*) FROM users WHERE email=$1', [
            'expired@example.test',
          ])
        ).rows[0].count,
      ),
      0,
    );
    assert.equal((await signup('invalid-email')).statusCode, 400);
    assert.equal(
      (await signup('not-invited@example.test', { password: 'short' }))
        .statusCode,
      400,
    );
    for (const value of [[], {}, true, 42]) {
      assert.equal(
        (
          await request('/api/auth/sign-up/email', {
            email: value,
            name: 'Test',
            password,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('/api/auth/sign-in/email', {
            email: 'one@example.test',
            password: value,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal((await request('/api/health')).statusCode, 200);
  });

  await t.test(
    'invite, signup and verification do not grant a session or accept forged privileges',
    async () => {
      await invite('one@example.test');
      const response = await signup('ONE@example.test', {
        role: 'admin',
        emailVerified: true,
      });
      assert.equal(response.statusCode, 200, response.body);
      const row = (
        await pool.query('SELECT * FROM users WHERE email=$1', [
          'one@example.test',
        ])
      ).rows[0];
      assert.ok(row);
      firstId = row.id;
      assert.equal(row.role, 'user');
      assert.equal(row.email_verified, false);
      assert.equal((await request('/api/me')).statusCode, 401);
      assert.equal((await login('one@example.test')).statusCode, 403);
      const stored = (
        await pool.query(
          'SELECT password FROM auth_accounts WHERE user_id=$1',
          [firstId],
        )
      ).rows[0].password;
      assert.notEqual(stored, password);
      assert.ok(stored.length > 50);
      assert.equal((await verify('one@example.test')).statusCode, 302);
      assert.equal((await request('/api/me')).statusCode, 401);
      assert.equal((await verify('one@example.test')).statusCode, 302);
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM auth_sessions')).rows[0]
            .count,
        ),
        0,
      );
      assert.equal(
        (
          await pool.query('SELECT email_verified FROM users WHERE id=$1', [
            firstId,
          ])
        ).rows[0].email_verified,
        true,
      );
    },
  );

  await t.test(
    'verification rejects tampered, expired and external-redirect links',
    async () => {
      const tampered = emailLink('one@example.test', 'Verify');
      tampered.searchParams.set(
        'token',
        `${tampered.searchParams.get('token')}broken`,
      );
      tampered.searchParams.delete('callbackURL');
      assert.equal(
        (await request(`${tampered.pathname}${tampered.search}`)).statusCode,
        401,
      );
      await invite('unverified@example.test');
      assert.equal((await signup('unverified@example.test')).statusCode, 200);
      const expired = await createEmailVerificationToken(
        testConfig.secret,
        'unverified@example.test',
        undefined,
        -1,
      );
      assert.equal(
        (await request(`/api/auth/verify-email?token=${expired}`)).statusCode,
        401,
      );
      const outside = emailLink('unverified@example.test', 'Verify');
      outside.searchParams.set('callbackURL', 'https://attacker.example');
      assert.equal(
        (await request(`${outside.pathname}${outside.search}`)).statusCode,
        403,
      );
      assert.equal(
        (
          await pool.query('SELECT email_verified FROM users WHERE email=$1', [
            'unverified@example.test',
          ])
        ).rows[0].email_verified,
        false,
      );
    },
  );

  await t.test(
    'login creates protected cookies, rotates sessions and rejects bad credentials',
    async () => {
      const result = await login('one@example.test');
      assert.equal(result.statusCode, 200, result.body);
      firstCookie = cookies(result);
      const header = String(result.headers['set-cookie']);
      assert.match(header, /HttpOnly/i);
      assert.match(header, /SameSite=Lax/i);
      assert.match(header, /Path=\//i);
      assert.ok(!header.includes('Domain='));
      assert.ok(!header.includes('Secure'));
      const me = await request('/api/me', undefined, firstCookie);
      assert.deepEqual(me.json().user, {
        id: firstId,
        email: 'one@example.test',
        role: 'user',
      });
      assert.equal(me.headers['cache-control'], 'no-store');
      const wrong = await login(
        'one@example.test',
        'a wrong but sufficiently long password',
      );
      const unknown = await login('unknown@example.test');
      assert.equal(wrong.statusCode, 401);
      assert.deepEqual(wrong.json(), unknown.json());
      const second = await login('one@example.test');
      const secondCookie = cookies(second);
      assert.notEqual(secondCookie, firstCookie);
      assert.equal(
        (await request('/api/auth/sign-out', {}, secondCookie)).statusCode,
        200,
      );
      assert.equal(
        (await request('/api/me', undefined, secondCookie)).statusCode,
        401,
      );
      assert.equal(
        (await request('/api/me', undefined, firstCookie)).statusCode,
        200,
      );
      const duplicate = await signup('one@example.test');
      assert.equal(duplicate.statusCode, 200);
      assert.equal(
        Number(
          (
            await pool.query('SELECT count(*) FROM users WHERE email=$1', [
              'one@example.test',
            ])
          ).rows[0].count,
        ),
        1,
      );
    },
  );

  await t.test(
    'session data persists across API instances and is isolated per user',
    async () => {
      await invite('two@example.test', 'admin');
      assert.equal((await signup('two@example.test')).statusCode, 200);
      await verify('two@example.test');
      otherCookie = cookies(await login('two@example.test'));
      const secondUser = (
        await request('/api/me', undefined, otherCookie)
      ).json().user;
      assert.equal(secondUser.role, 'admin');
      assert.notEqual(secondUser.id, firstId);
      const scoped = await request(
        `/api/me?userId=${secondUser.id}`,
        undefined,
        firstCookie,
      );
      assert.equal(scoped.json().user.id, firstId);
      assert.ok(!scoped.body.includes(secondUser.email));
      const another = testApp(
        new Pool({ connectionString }),
        testConfig,
        mailer,
      );
      try {
        const persisted = await another.inject({
          url: '/api/me',
          headers: { cookie: firstCookie },
        });
        assert.equal(persisted.statusCode, 200);
        assert.equal(persisted.json().user.id, firstId);
      } finally {
        await another.close();
      }
      const unknownCookie = firstCookie.replace(/=([^;]+)/, '=forged');
      assert.equal(
        (await request('/api/me', undefined, unknownCookie)).statusCode,
        401,
      );
    },
  );

  await t.test(
    'CSRF, callback validation and unsupported endpoints fail closed',
    async () => {
      const wrongOrigin = await request('/api/auth/sign-out', {}, firstCookie, {
        origin: 'https://attacker.example',
      });
      assert.equal(wrongOrigin.statusCode, 403);
      assert.equal(
        (await request('/api/me', undefined, firstCookie)).statusCode,
        200,
      );
      assert.equal(
        (
          await request(
            '/api/auth/sign-in/email',
            { email: 'one@example.test', password },
            undefined,
            { origin: '' },
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request('/api/auth/request-password-reset', {
            email: 'one@example.test',
            redirectTo: 'https://attacker.example',
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (await request('/api/auth/update-user', { role: 'admin' }, firstCookie))
          .statusCode,
        404,
      );
      const oversize = await request('/api/auth/sign-in/email', {
        email: 'one@example.test',
        password: 'x'.repeat(9000),
      });
      assert.equal(oversize.statusCode, 413);
    },
  );

  await t.test(
    'recovery is non-enumerating, tokens are hashed, and reset revokes every session/link',
    async () => {
      const known = await request('/api/auth/request-password-reset', {
        email: 'one@example.test',
        redirectTo: `${testConfig.appUrl}/?view=reset`,
      });
      const before = messages.length;
      const unknown = await request('/api/auth/request-password-reset', {
        email: 'absent@example.test',
        redirectTo: `${testConfig.appUrl}/?view=reset`,
      });
      assert.equal(known.statusCode, 200, known.body);
      assert.deepEqual(known.json(), unknown.json());
      assert.equal(messages.length, before);
      const first = emailLink('one@example.test', 'Reset');
      const firstToken = first.pathname.split('/').at(-1);
      assert.ok(firstToken);
      const stored = await pool.query(
        'SELECT identifier FROM auth_verifications WHERE value=$1',
        [firstId],
      );
      assert.ok(stored.rows.length);
      assert.ok(
        stored.rows.every((row) => !row.identifier.includes(firstToken)),
      );
      assert.equal(
        (await request(`${first.pathname}${first.search}`)).statusCode,
        302,
      );
      await request('/api/auth/request-password-reset', {
        email: 'one@example.test',
        redirectTo: `${testConfig.appUrl}/?view=reset`,
      });
      const secondToken = emailLink('one@example.test', 'Reset')
        .pathname.split('/')
        .at(-1);
      assert.notEqual(secondToken, firstToken);
      const reset = await request('/api/auth/reset-password', {
        token: secondToken,
        newPassword: nextPassword,
      });
      assert.equal(reset.statusCode, 200, reset.body);
      assert.equal(
        (await request('/api/me', undefined, firstCookie)).statusCode,
        401,
      );
      assert.equal(
        (
          await request('/api/auth/reset-password', {
            token: secondToken,
            newPassword: password,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('/api/auth/reset-password', {
            token: firstToken,
            newPassword: password,
          })
        ).statusCode,
        400,
      );
      assert.equal((await login('one@example.test')).statusCode, 401);
      assert.equal(
        (await login('one@example.test', nextPassword)).statusCode,
        200,
      );
      assert.equal(
        (await request('/api/me', undefined, otherCookie)).statusCode,
        200,
      );
      await request('/api/auth/request-password-reset', {
        email: 'one@example.test',
        redirectTo: testConfig.appUrl,
      });
      const expiredToken = emailLink('one@example.test', 'Reset')
        .pathname.split('/')
        .at(-1);
      await pool.query(
        "UPDATE auth_verifications SET expires_at=now()-interval '1 hour' WHERE value=$1",
        [firstId],
      );
      assert.equal(
        (
          await request('/api/auth/reset-password', {
            token: expiredToken,
            newPassword: password,
          })
        ).statusCode,
        400,
      );
    },
  );

  await t.test(
    'email resend is generic and rate limiting cannot be bypassed with forged IP headers',
    async () => {
      const a = await request('/api/auth/send-verification-email', {
        email: 'absent@example.test',
      });
      const b = await request('/api/auth/send-verification-email', {
        email: 'unverified@example.test',
      });
      assert.deepEqual(a.json(), b.json());
      const address = '203.0.113.41';
      for (let i = 0; i < 3; i++) {
        assert.equal(
          (
            await request(
              '/api/auth/send-verification-email',
              { email: 'absent@example.test' },
              undefined,
              { 'x-spindle-client-ip': `192.0.2.${i}` },
              address,
            )
          ).statusCode,
          200,
        );
      }
      const throttled = await request(
        '/api/auth/send-verification-email',
        { email: 'absent@example.test' },
        undefined,
        { 'x-spindle-client-ip': '192.0.2.99' },
        address,
      );
      assert.equal(throttled.statusCode, 429);
      assert.ok(throttled.headers['x-retry-after']);
    },
  );

  await t.test(
    'concurrent signup uses the existing transaction and cannot duplicate an account',
    async () => {
      const emails = Array.from(
        { length: 6 },
        (_, index) => `concurrent-${index}@example.test`,
      );
      for (const email of emails) await invite(email);
      const results = await Promise.all(emails.map((email) => signup(email)));
      assert.ok(results.every((result) => result.statusCode === 200));
      assert.equal(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM users WHERE email LIKE 'concurrent-%@example.test'",
            )
          ).rows[0].count,
        ),
        6,
      );
      await invite('same@example.test');
      const duplicate = await Promise.all([
        signup('same@example.test'),
        signup('same@example.test'),
      ]);
      assert.ok(duplicate.some((result) => result.statusCode === 200));
      assert.equal(
        Number(
          (
            await pool.query('SELECT count(*) FROM users WHERE email=$1', [
              'same@example.test',
            ])
          ).rows[0].count,
        ),
        1,
      );
    },
  );

  await t.test(
    'concurrent reset requests can consume a recovery link only once',
    async () => {
      await request('/api/auth/request-password-reset', {
        email: 'one@example.test',
        redirectTo: testConfig.appUrl,
      });
      const token = emailLink('one@example.test', 'Reset')
        .pathname.split('/')
        .at(-1);
      const results = await Promise.all([
        request('/api/auth/reset-password', {
          token,
          newPassword: nextPassword,
        }),
        request('/api/auth/reset-password', {
          token,
          newPassword: nextPassword,
        }),
      ]);
      assert.deepEqual(
        results.map((result) => result.statusCode).sort(),
        [200, 400],
      );
    },
  );

  await t.test(
    'only configured ingress proxies may supply the client address',
    async () => {
      const config = { ...testConfig, trustProxy: ['127.0.0.1/32'] };
      const proxied = testApp(new Pool({ connectionString }), config, mailer);
      try {
        for (const [remoteAddress, expected] of [
          ['127.0.0.1', '198.51.100.240'],
          ['203.0.113.50', '203.0.113.50'],
        ] as const) {
          const response = await proxied.inject({
            method: 'POST',
            url: '/api/auth/sign-in/email',
            remoteAddress,
            headers: {
              origin: config.appUrl,
              'x-forwarded-for': '198.51.100.240',
              'x-spindle-client-ip': '192.0.2.99',
            },
            payload: { email: 'one@example.test', password: nextPassword },
          });
          assert.equal(response.statusCode, 200);
          const stored = await pool.query(
            'SELECT ip_address FROM auth_sessions WHERE token=$1',
            [response.json().token],
          );
          assert.equal(stored.rows[0].ip_address, expected);
        }
      } finally {
        await proxied.close();
      }
    },
  );

  await t.test(
    'HTTPS uses host-only secure cookies and public mode preserves existing users',
    async () => {
      const config = {
        ...testConfig,
        appUrl: 'https://mail.example.test',
        secureCookies: true,
        registrationMode: 'public',
      };
      const hosted = testApp(new Pool({ connectionString }), config, mailer);
      try {
        const headers = { origin: config.appUrl };
        const signed = await hosted.inject({
          method: 'POST',
          url: '/api/auth/sign-in/email',
          headers,
          payload: { email: 'one@example.test', password: nextPassword },
        });
        assert.equal(signed.statusCode, 200, signed.body);
        const header = String(signed.headers['set-cookie']);
        assert.match(header, /__Host-spindle\.session=/);
        assert.match(header, /; Secure/i);
        assert.match(header, /HttpOnly/i);
        assert.ok(!header.includes('Domain='));
        const registered = await hosted.inject({
          method: 'POST',
          url: '/api/auth/sign-up/email',
          remoteAddress: '192.0.2.22',
          headers,
          payload: {
            email: 'public@example.test',
            password,
            name: 'Public',
            role: 'admin',
          },
        });
        assert.equal(registered.statusCode, 200, registered.body);
        assert.equal(
          (
            await pool.query('SELECT role FROM users WHERE email=$1', [
              'public@example.test',
            ])
          ).rows[0].role,
          'user',
        );
        assert.equal(
          (
            await pool.query('SELECT id FROM users WHERE email=$1', [
              'one@example.test',
            ])
          ).rows[0].id,
          firstId,
        );
      } finally {
        await hosted.close();
      }
    },
  );

  await t.test(
    'expired and newly unverified sessions cannot access protected user data',
    async () => {
      await pool.query('UPDATE users SET email_verified=false WHERE email=$1', [
        'two@example.test',
      ]);
      assert.equal(
        (await request('/api/me', undefined, otherCookie)).statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE email=$1', [
        'two@example.test',
      ]);
      await pool.query(
        "UPDATE auth_sessions SET expires_at=now()-interval '1 hour' WHERE user_id=(SELECT id FROM users WHERE email=$1)",
        ['two@example.test'],
      );
      assert.equal(
        (await request('/api/me', undefined, otherCookie)).statusCode,
        401,
      );
    },
  );

  await t.test(
    'recovery delivery failures do not reveal account existence or SMTP details',
    async () => {
      const broken = nodemailer.createTransport({ jsonTransport: true });
      t.mock.method(broken, 'sendMail', async () => {
        throw new Error('smtp-host:private-password');
      });
      const failing = testApp(
        new Pool({ connectionString }),
        testConfig,
        broken,
      );
      try {
        const known = await failing.inject({
          method: 'POST',
          url: '/api/auth/request-password-reset',
          remoteAddress: '192.0.2.101',
          headers: { origin: testConfig.appUrl },
          payload: { email: 'one@example.test' },
        });
        const unknown = await failing.inject({
          method: 'POST',
          url: '/api/auth/request-password-reset',
          remoteAddress: '192.0.2.102',
          headers: { origin: testConfig.appUrl },
          payload: { email: 'absent@example.test' },
        });
        assert.equal(known.statusCode, 200);
        assert.deepEqual(known.json(), unknown.json());
        assert.ok(!known.body.includes('private-password'));
      } finally {
        await failing.close();
      }
    },
  );
});
