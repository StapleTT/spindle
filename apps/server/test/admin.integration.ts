import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { watchInbox } from '../src/mail/idle.js';
import { claimAccount, withLease } from '../src/mail/store.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('private administration, guarded access changes, invitation lifecycle and audit', {
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
  const messages: { to: string; text: string }[] = [];
  const mailer = nodemailer.createTransport({ jsonTransport: true });
  t.mock.method(mailer, 'sendMail', async (mail: SendMailOptions) => {
    messages.push({ to: String(mail.to), text: String(mail.text) });
    return { messageId: 'synthetic-admin' };
  });
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 71).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, mailer, keys);
  t.after(() => app.close());
  const admin = await createTestUser(
    app,
    pool,
    testConfig,
    'admin-panel-owner@example.test',
    '203.0.113.190',
  );
  const member = await createTestUser(
    app,
    pool,
    testConfig,
    'admin-panel-member@example.test',
    '203.0.113.191',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
  const request = (
    path: string,
    body?: object,
    cookie = admin.cookie,
    origin = testConfig.appUrl,
  ) =>
    app.inject({
      method: body ? 'POST' : 'GET',
      url: `/api/admin/${path}`,
      headers: { cookie, origin },
      ...(body ? { payload: body } : {}),
    });
  const change = (
    account: typeof member,
    action: string,
    revision = 0,
    extra: object = {},
  ) =>
    request(`users/${account.id}`, {
      operationId: randomUUID(),
      action,
      expectedRevision: revision,
      ...extra,
    });
  const login = async (email: string, password = member.password) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      remoteAddress: '203.0.113.192',
      headers: { origin: testConfig.appUrl },
      payload: { email, password },
    });
  const signup = (email: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      remoteAddress: '203.0.113.193',
      headers: { origin: testConfig.appUrl },
      payload: { email, name: 'Invited user', password: member.password },
    });
  t.beforeEach(async () => {
    await pool.query('DELETE FROM auth_rate_limits');
    await pool.query(
      "DELETE FROM mail_request_limits WHERE action LIKE 'admin-%'",
    );
    await request('unlock', { currentPassword: admin.password });
  });

  await t.test(
    'admin data and writes require a password unlock scoped to one active session',
    async () => {
      const gate = await createTestUser(
        app,
        pool,
        testConfig,
        'admin-gate-owner@example.test',
        '203.0.113.196',
      );
      await pool.query("UPDATE users SET role='admin' WHERE id=$1", [gate.id]);
      assert.deepEqual(
        (await request('access', undefined, gate.cookie)).json(),
        { unlocked: false },
      );
      for (const path of ['overview', 'users', 'invites', 'audit']) {
        const response = await request(path, undefined, gate.cookie);
        assert.equal(response.statusCode, 403, response.body);
        assert.equal(response.json().code, 'ADMIN_LOCKED');
        assert.ok(!response.body.includes(admin.email));
      }
      const action = {
        operationId: randomUUID(),
        action: 'sessions',
        expectedRevision: 0,
      };
      assert.equal(
        (await request(`users/${member.id}`, action, gate.cookie)).statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            'unlock',
            { currentPassword: gate.password },
            gate.cookie,
            'https://foreign.example.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await request('unlock', { currentPassword: 'wrong' }, gate.cookie))
          .statusCode,
        400,
      );
      assert.equal(
        (
          await request(
            'unlock',
            { currentPassword: gate.password, unlocked: true },
            gate.cookie,
          )
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request(
            'unlock',
            { currentPassword: gate.password },
            member.cookie,
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(
            'unlock',
            { currentPassword: gate.password },
            gate.cookie,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (await request('users', undefined, gate.cookie)).statusCode,
        200,
      );
      const sent = await request(
        'invites',
        {
          operationId: randomUUID(),
          email: 'admin-gate-invite@example.test',
          expectedId: null,
        },
        gate.cookie,
      );
      assert.equal(sent.statusCode, 200, sent.body);
      const replica = testApp(
        new Pool({ connectionString }),
        testConfig,
        mailer,
        keys,
      );
      try {
        const access = await replica.inject({
          method: 'GET',
          url: '/api/admin/access',
          headers: { cookie: gate.cookie },
        });
        assert.deepEqual(access.json(), { unlocked: true });
      } finally {
        await replica.close();
      }
      const signed = await login(gate.email, gate.password);
      assert.equal(signed.statusCode, 200, signed.body);
      const raw = signed.headers['set-cookie'];
      const cookie = (Array.isArray(raw) ? raw : [String(raw)])
        .map((value) => value.split(';')[0])
        .join('; ');
      assert.deepEqual((await request('access', undefined, cookie)).json(), {
        unlocked: false,
      });
      assert.equal((await request('users', undefined, cookie)).statusCode, 403);
      await pool.query("UPDATE users SET role='user' WHERE id=$1", [gate.id]);
      await pool.query("UPDATE users SET role='admin' WHERE id=$1", [gate.id]);
      assert.deepEqual(
        (await request('access', undefined, gate.cookie)).json(),
        { unlocked: false },
      );
      assert.equal(
        (
          await request(
            'unlock',
            { currentPassword: gate.password },
            gate.cookie,
          )
        ).statusCode,
        200,
      );
      const changed = await app.inject({
        method: 'POST',
        url: '/api/auth/account/password',
        headers: { cookie: gate.cookie, origin: testConfig.appUrl },
        payload: {
          currentPassword: gate.password,
          newPassword: 'new gated admin password 42!',
        },
      });
      assert.equal(changed.statusCode, 200, changed.body);
      assert.equal(
        (await request('access', undefined, gate.cookie)).statusCode,
        401,
      );
    },
  );

  await t.test(
    'only verified active admins may read or mutate, strict origin/body boundaries and private mail survive',
    async () => {
      assert.equal((await request('users', undefined, '')).statusCode, 401);
      assert.equal(
        (await request('users', undefined, member.cookie)).statusCode,
        403,
      );
      assert.equal((await request('users?userId=forged')).statusCode, 400);
      assert.equal((await request('users?search=%25')).json().users.length, 0);
      assert.equal(
        (await request('users'))
          .json()
          .users.some((u: { id: string }) => u.id === member.id),
        true,
      );
      const denied = await request(
        `users/${member.id}`,
        {
          operationId: randomUUID(),
          action: 'suspend',
          expectedRevision: 0,
        },
        admin.cookie,
        'https://foreign.example.test',
      );
      assert.equal(denied.statusCode, 403);
      assert.equal(
        (await request('unlock', { currentPassword: 'wrong' })).statusCode,
        400,
      );
      assert.equal(
        (
          await request(`users/${member.id}`, {
            operationId: randomUUID(),
            action: 'role',
            role: 'owner',
            expectedRevision: 0,
          })
        ).statusCode,
        400,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        admin.id,
      ]);
      assert.equal((await request('overview')).statusCode, 403);
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        admin.id,
      ]);
      assert.equal(
        (await request('unlock', { currentPassword: admin.password }))
          .statusCode,
        200,
      );
      const account = (
        await app.inject({
          method: 'POST',
          url: '/api/mail/accounts',
          headers: { cookie: member.cookie, origin: testConfig.appUrl },
          payload: {
            name: 'Private member account',
            host: 'mail.example.test',
            port: 993,
            transport: 'tls',
            username: member.email,
            password: 'synthetic-provider-password',
            history: 'all',
          },
        })
      ).json().account;
      assert.ok(account?.id);
      const deniedMail = await app.inject({
        method: 'GET',
        url: `/api/mail/accounts/${account.id}`,
        headers: { cookie: admin.cookie },
      });
      assert.notEqual(deniedMail.statusCode, 200);
      assert.ok(
        !(await request('users')).body.includes('synthetic-provider-password'),
      );
    },
  );
  await t.test(
    'invitations send once on replay, record delivery and acceptance, revoke signup and guard replaced invitations',
    async () => {
      const email = 'admin-panel-invited@example.test';
      const body = {
        email,

        operationId: randomUUID(),
        expectedId: null,
      };
      const sent = await request('invites', body);
      assert.equal(sent.statusCode, 200, sent.body);
      assert.equal(sent.json().delivery, 'sent');
      assert.equal((await request('invites', body)).json().replayed, true);
      assert.equal(messages.filter((m) => m.to === email).length, 1);
      const revoked = await request('invites/revoke', {
        operationId: randomUUID(),
        inviteId: sent.json().inviteId,
      });
      assert.equal(revoked.statusCode, 200, revoked.body);
      assert.equal((await signup(email)).statusCode, 200);
      assert.equal(
        (await pool.query('SELECT 1 FROM users WHERE email=$1', [email]))
          .rowCount,
        0,
      );
      const replaced = await request('invites', {
        ...body,
        operationId: randomUUID(),
        expectedId: sent.json().inviteId,
      });
      assert.equal(replaced.statusCode, 200, replaced.body);
      assert.notEqual(replaced.json().inviteId, sent.json().inviteId);
      assert.equal(
        (
          await request('invites/revoke', {
            operationId: randomUUID(),
            inviteId: sent.json().inviteId,
          })
        ).statusCode,
        409,
      );
      assert.equal((await signup(email)).statusCode, 200);
      const invitation = (await request(`invites?search=${email}`)).json()
        .invites[0];
      assert.equal(invitation.status, 'accepted');
      const user = (
        await pool.query('SELECT role,suspended FROM users WHERE email=$1', [
          email,
        ])
      ).rows[0];
      assert.deepEqual(user, { role: 'user', suspended: false });
    },
  );
  await t.test(
    'delivery failures preserve invitations and surface a safe retry state',
    async (subtest) => {
      const mock = subtest.mock.method(mailer, 'sendMail', async () => {
        throw new Error('private relay credential synthetic');
      });
      const response = await request('invites', {
        email: 'admin-panel-failed@example.test',
        expectedId: null,

        operationId: randomUUID(),
      });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.json().delivery, 'failed');
      assert.ok(!response.body.includes('credential'));
      const invite = (await request('invites?search=admin-panel-failed')).json()
        .invites[0];
      assert.equal(invite.delivery, 'failed');
      assert.equal(invite.status, 'pending');
      mock.mock.restore();
      assert.equal(
        (
          await request('invites', {
            email: invite.email,
            expectedId: invite.id,

            operationId: randomUUID(),
          })
        ).json().delivery,
        'sent',
      );
    },
  );
  await t.test(
    'suspension revokes sessions, denies sign-in and new/stale leases, preserves content and resumes work without restoring sessions',
    async () => {
      const account = (
        await pool.query('SELECT id FROM mail_accounts WHERE user_id=$1', [
          member.id,
        ])
      ).rows[0];
      assert.ok(account);
      const lease = await claimAccount(pool, member.id, account.id);
      assert.ok(lease);
      const response = await change(member, 'suspend');
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/api/mail/accounts',
            headers: { cookie: member.cookie },
          })
        ).statusCode,
        401,
      );
      assert.equal((await login(member.email)).statusCode, 403);
      assert.equal(await claimAccount(pool, member.id, account.id), undefined);
      await assert.rejects(
        withLease(pool, lease, async () => {
          throw new Error('unreachable');
        }),
        /owner is unavailable/,
      );
      let connections = 0;
      assert.equal(
        await watchInbox(
          pool,
          keys,
          member.id,
          account.id,
          undefined,
          async () => {
            connections++;
            throw new Error('must not connect');
          },
        ),
        false,
      );
      assert.equal(connections, 0);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_accounts WHERE id=$1', [
            account.id,
          ])
        ).rowCount,
        1,
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO auth_sessions(id,token,user_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",
          [randomUUID(), randomUUID(), member.id],
        ),
        /Account unavailable/,
      );
      assert.equal((await change(member, 'resume', 0)).statusCode, 409);
      assert.equal((await change(member, 'resume', 1)).statusCode, 200);
      assert.equal(
        (
          await pool.query('SELECT 1 FROM auth_sessions WHERE user_id=$1', [
            member.id,
          ])
        ).rowCount,
        0,
      );
      assert.equal((await login(member.email)).statusCode, 200);
      assert.ok(await claimAccount(pool, member.id, account.id));
    },
  );
  await t.test(
    'access changes replay once, revoke devices, deny self changes and serialize competing administrators',
    async () => {
      const promoted = await change(member, 'role', 2, { role: 'admin' });
      assert.equal(promoted.statusCode, 200, promoted.body);
      const signed = await login(member.email);
      assert.equal(signed.statusCode, 200, signed.body);
      const raw = signed.headers['set-cookie'];
      const memberCookie = (Array.isArray(raw) ? raw : [String(raw)])
        .map((value) => value.split(';')[0])
        .join('; ');
      assert.equal(
        (
          await request(
            'unlock',
            { currentPassword: member.password },
            memberCookie,
          )
        ).statusCode,
        200,
      );
      assert.equal((await change(admin, 'suspend', 0)).statusCode, 400);
      const a = {
        operationId: randomUUID(),
        action: 'role',
        role: 'user',
        expectedRevision: 3,
      };
      const b = {
        operationId: randomUUID(),
        action: 'role',
        role: 'user',
        expectedRevision: 0,
      };
      const result = await Promise.all([
        request(`users/${member.id}`, a),
        request(`users/${admin.id}`, b, memberCookie),
      ]);
      assert.equal(
        result.filter((r) => r.statusCode === 200).length,
        1,
        result.map((r) => r.body).join(' '),
      );
      assert.ok(result.every((r) => [200, 401, 403].includes(r.statusCode)));
      const enabled = (
        await pool.query(
          "SELECT id FROM users WHERE role='admin' AND NOT suspended",
        )
      ).rows;
      assert.ok(enabled.length >= 1);
      const winner = result[0]?.statusCode === 200 ? admin : member;
      const winnerCookie = winner.id === admin.id ? admin.cookie : memberCookie;
      const target = winner.id === admin.id ? member : admin;
      const revision = (
        await pool.query('SELECT admin_revision FROM users WHERE id=$1', [
          target.id,
        ])
      ).rows[0].admin_revision;
      await pool.query(
        "DELETE FROM mail_request_limits WHERE action LIKE 'admin-%'",
      );
      const op = {
        operationId: randomUUID(),
        action: 'sessions',
        expectedRevision: revision,
      };
      assert.equal(
        (await request(`users/${target.id}`, op, winnerCookie)).statusCode,
        200,
      );
      assert.equal(
        (await request(`users/${target.id}`, op, winnerCookie)).json().replayed,
        true,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM admin_audit WHERE id=$1',
            [op.operationId],
          )
        ).rows[0].n,
        1,
      );
      const audit = await request('audit', undefined, winnerCookie);
      assert.equal(audit.statusCode, 200, audit.body);
      assert.ok(!audit.body.includes(winner.password));
      assert.ok(!audit.body.includes('request_hash'));
      assert.equal(
        (
          await request(
            `users/${target.id}`,
            { ...op, action: 'suspend' },
            winnerCookie,
          )
        ).statusCode,
        409,
      );
    },
  );
  await t.test(
    'database protects the last active administrator and listings are bounded',
    async () => {
      await pool.query(
        "UPDATE users SET role='admin',suspended=false WHERE id=$1",
        [admin.id],
      );
      await pool.query(
        "UPDATE users SET role='user' WHERE role='admin' AND id<>$1",
        [admin.id],
      );
      await assert.rejects(
        pool.query("UPDATE users SET role='user' WHERE id=$1", [admin.id]),
        /last active administrator/,
      );
      await assert.rejects(
        pool.query('DELETE FROM users WHERE id=$1', [admin.id]),
        /last active administrator/,
      );
      for (let n = 0; n < 27; n++)
        await pool.query(
          "INSERT INTO invites(email,expires_at) VALUES($1,now()+interval '1 day')",
          [`admin-page-${n}@example.test`],
        );
      // Use a new valid admin session after earlier race revocation.
      const signed = await login(admin.email);
      assert.equal(signed.statusCode, 200, signed.body);
      const raw = signed.headers['set-cookie'];
      const cookie = (Array.isArray(raw) ? raw : [String(raw)])
        .map((value) => value.split(';')[0])
        .join('; ');
      assert.equal(
        (await request('unlock', { currentPassword: admin.password }, cookie))
          .statusCode,
        200,
      );
      const page = await request(
        'invites?search=admin-page-',
        undefined,
        cookie,
      );
      assert.equal(page.json().invites.length, 25);
      const next = await request(
        `invites?search=admin-page-&cursor=${page.json().nextCursor}`,
        undefined,
        cookie,
      );
      assert.equal(next.json().invites.length, 2);
    },
  );
});
