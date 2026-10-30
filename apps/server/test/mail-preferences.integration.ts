import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readContentConfig } from '../src/mail/content-config.js';
import { buildContentApp } from '../src/mail/content-server.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { SANITIZER_VERSION, sanitizeMessage } from '../src/mail/sanitize.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { tinyPng } from './reader-fixture.js';

test('owned preferences control real image requests and durable send timing without weakening isolation', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 45000,
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
  const contentConfig = readContentConfig(testConfig, {});
  assert.ok(contentConfig);
  const app = testApp(
    pool,
    testConfig,
    undefined,
    readMailKeys({
      MAIL_ENCRYPTION_KEYS: JSON.stringify({
        v1: Buffer.alloc(32, 85).toString('base64'),
      }),
    }),
  );
  let proxyCalls = 0;
  const content = buildContentApp(pool, contentConfig, async () => {
    proxyCalls++;
    return { type: 'image/png', data: tinyPng };
  });
  content.log.level = 'silent';
  t.after(async () => {
    await content.close();
    await app.close();
  });
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'prefs-owner@example.test',
      '203.0.113.235',
    ),
    other = await createTestUser(
      app,
      pool,
      testConfig,
      'prefs-admin@example.test',
      '203.0.113.235',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const request = (
    path: string,
    method: 'GET' | 'PATCH' | 'POST' | 'PUT' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) =>
    app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { cookie, origin },
      ...(payload ? { payload } : {}),
    });
  const defaults = {
    imageProxy: true,
    blockRemoteImages: true,
    undoSend: true,
  };
  await t.test(
    'preferences are private, verified, origin checked and partial updates preserve other fields',
    async () => {
      assert.deepEqual(
        (await request('preferences')).json().preferences,
        defaults,
      );
      assert.equal(
        (await request('preferences', 'GET', undefined, '')).statusCode,
        401,
      );
      assert.equal(
        (
          await request(
            'preferences',
            'PATCH',
            { undoSend: false },
            owner.cookie,
            'https://foreign.example.test',
          )
        ).statusCode,
        403,
      );
      for (const payload of [
        { owner: owner.id, undoSend: false },
        { undoSend: 'false' },
        {},
      ])
        assert.equal(
          (await request('preferences', 'PATCH', payload)).statusCode,
          400,
        );
      assert.equal(
        (
          await request(
            'preferences',
            'PATCH',
            { undoSend: false },
            other.cookie,
          )
        ).statusCode,
        200,
      );
      assert.deepEqual(
        (await request('preferences')).json().preferences,
        defaults,
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        other.id,
      ]);
      assert.equal(
        (
          await request(
            'preferences',
            'PATCH',
            { undoSend: true },
            other.cookie,
          )
        ).statusCode,
        403,
      );
    },
  );
  const connected = await request('accounts', 'POST', {
    name: 'Preference account',
    host: 'mail.example.test',
    port: 993,
    transport: 'tls',
    username: owner.email,
    password: 'synthetic-password-only',
    history: 'all',
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id,
    id = randomUUID();
  const box = (
    await pool.query(
      "INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,'INBOX','INBOX','inbox') RETURNING id",
      [owner.id, account],
    )
  ).rows[0].id;
  await pool.query(
    `INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at) VALUES($1::uuid,$2,$3,$1::text,'Preferences mail','[]','{"to":[],"cc":[],"bcc":[]}',now())`,
    [id, owner.id, account],
  );
  await pool.query(
    "INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid) VALUES($1,$2,$3,$4,'1',1)",
    [owner.id, account, box, id],
  );
  const safe = sanitizeMessage(
    '<style>.image{background-image:url(https://images.example.test/background.png)}</style><p class="image">Synthetic newsletter</p><img src="https://images.example.test/pixel.png"><img src="cid:inline"><img src="https://127.0.0.1/private"><img src="http://images.example.test/insecure"><script>bad()</script>',
  );
  await pool.query(
    "INSERT INTO mail_content(user_id,account_id,message_id,state,html,plain_text,resources,sanitizer_version) VALUES($1,$2,$3,'ready',$4,'Synthetic newsletter',$5,$6)",
    [
      owner.id,
      account,
      id,
      safe.html,
      JSON.stringify(safe.resources),
      SANITIZER_VERSION,
    ],
  );
  const body = async (url: string) =>
    content.inject({ url: new URL(url).pathname + new URL(url).search });
  await t.test(
    'default blocks, automatic proxied loads, direct HTTPS/CSS and manual hiding honor the actual switches',
    async () => {
      const initial = (await request(`messages/${id}`)).json();
      assert.equal(initial.content.images, false);
      assert.doesNotMatch((await body(initial.content.htmlUrl)).body, /<img/);
      assert.equal(proxyCalls, 0);
      assert.equal(
        (await request('preferences', 'PATCH', { blockRemoteImages: false }))
          .statusCode,
        200,
      );
      const automatic = (await request(`messages/${id}`)).json();
      assert.equal(automatic.content.images, true);
      const proxied = await body(automatic.content.htmlUrl);
      assert.match(proxied.body, /\/image\?token=/);
      assert.ok(
        !proxied.body.includes('https://images.example.test/pixel.png'),
      );
      const source = proxied.body
        .match(/src="([^"]+)"/)?.[1]
        ?.replaceAll('&amp;', '&');
      assert.ok(source);
      assert.equal((await body(source)).statusCode, 200);
      assert.equal(proxyCalls, 1);
      assert.equal(
        (await request('preferences', 'PATCH', { imageProxy: false }))
          .statusCode,
        200,
      );
      let revokeDuringLookup = false;
      t.mock.method(dns, 'lookup', async () => {
        if (revokeDuringLookup)
          await pool.query('DELETE FROM auth_sessions WHERE id=$1', [
            owner.session,
          ]);
        return [{ address: '8.8.8.8', family: 4 }];
      });
      const direct = await body(
        (await request(`messages/${id}`)).json().content.htmlUrl,
      );
      assert.match(
        direct.body,
        /src="https:\/\/images.example.test\/pixel.png"/,
      );
      assert.match(
        direct.body,
        /background-image:[^;]*https:\/\/images.example.test\/background.png/,
      );
      assert.doesNotMatch(
        direct.body,
        /127\.0\.0\.1\/private|\/insecure|<script/,
      );
      assert.match(
        String(direct.headers['content-security-policy']),
        /img-src[^;]+https:\/\/images.example.test/,
      );
      assert.match(
        String(direct.headers['content-security-policy']),
        /script-src 'none'/,
      );
      assert.equal(direct.headers['referrer-policy'], 'no-referrer');
      assert.equal(proxyCalls, 1);
      const hidden = await request(`messages/${id}/images`, 'POST', {
        show: false,
      });
      assert.doesNotMatch((await body(hidden.json().htmlUrl)).body, /<img/);
      const blocked = await request('preferences', 'PATCH', {
        blockRemoteImages: true,
      });
      assert.equal(blocked.json().preferences.imageProxy, false);
      assert.equal(blocked.json().preferences.undoSend, true);
      assert.doesNotMatch(
        (await body((await request(`messages/${id}`)).json().content.htmlUrl))
          .body,
        /<img/,
      );
      const shown = await request(`messages/${id}/images`, 'POST', {
        show: true,
      });
      assert.match(
        (await body(shown.json().htmlUrl)).body,
        /https:\/\/images.example.test\/pixel.png/,
      );
      const draftId = randomUUID();
      const draft = await request(`drafts/${draftId}`, 'PUT', {
        revision: 0,
        saveId: randomUUID(),
        accountId: account,
        content: {
          to: '',
          cc: '',
          bcc: '',
          subject: 'Forward preferences',
          format: 'rich',
          html: '<p>Note</p>',
          text: '',
        },
      });
      assert.equal(draft.statusCode, 200, draft.body);
      await pool.query(
        'UPDATE mail_drafts SET forward_content=$2 WHERE id=$1',
        [
          draftId,
          JSON.stringify({
            html: safe.html,
            text: 'Synthetic original',
            resources: safe.resources,
            images: [],
          }),
        ],
      );
      const blockedPreview = await request(
        `drafts/${draftId}/forward-preview`,
        'POST',
        {},
      );
      assert.equal(blockedPreview.json().images, false);
      assert.doesNotMatch(
        (await body(blockedPreview.json().htmlUrl)).body,
        /<img/,
      );
      await request('preferences', 'PATCH', { blockRemoteImages: false });
      const automaticPreview = await request(
        `drafts/${draftId}/forward-preview`,
        'POST',
        {},
      );
      assert.equal(automaticPreview.json().images, true);
      assert.match(
        (await body(automaticPreview.json().htmlUrl)).body,
        /https:\/\/images.example.test\/pixel.png/,
      );
      const hiddenPreview = await request(
        `drafts/${draftId}/forward-preview`,
        'POST',
        { images: false },
      );
      assert.doesNotMatch(
        (await body(hiddenPreview.json().htmlUrl)).body,
        /<img/,
      );
      const token = new URL(shown.json().htmlUrl);
      revokeDuringLookup = true;
      assert.equal(
        (await content.inject({ url: token.pathname + token.search }))
          .statusCode,
        404,
      );
    },
  );
  // Restore an owned session after the revocation check; synthetic fixture creates no external mail.
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { origin: testConfig.appUrl },
    payload: { email: owner.email, password: owner.password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const cookies = login.headers['set-cookie'];
  owner.cookie = (Array.isArray(cookies) ? cookies : [String(cookies)])
    .map((item) => item.split(';')[0])
    .join('; ');
  await t.test(
    'undo off removes only future send grace; schedules, frozen messages and safe retry survive',
    async () => {
      await pool.query('DELETE FROM mail_request_limits WHERE user_id=$1', [
        owner.id,
      ]);
      await pool.query(
        "INSERT INTO mail_smtp(user_id,account_id,host,port,transport,username,credential,state) VALUES($1,$2,'smtp.example.test',465,'tls','writer@example.test','synthetic-not-used','ready')",
        [owner.id, account],
      );
      async function enqueue(scheduledAt?: string) {
        const draft = randomUUID(),
          operation = randomUUID();
        const saved = await request(`drafts/${draft}`, 'PUT', {
          revision: 0,
          saveId: randomUUID(),
          accountId: account,
          content: {
            to: 'recipient@example.test',
            cc: '',
            bcc: '',
            subject: 'Synthetic send preference',
            format: 'plain',
            text: 'Private test',
            html: '',
          },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        const sent = await request(`drafts/${draft}/send`, 'POST', {
          id: operation,
          revision: 1,
          ...(scheduledAt ? { scheduledAt } : {}),
        });
        assert.equal(sent.statusCode, 202, sent.body);
        return (
          await pool.query(
            'SELECT *,extract(epoch FROM next_attempt_at-clock_timestamp()) AS wait FROM mail_outbox WHERE id=$1',
            [operation],
          )
        ).rows[0];
      }
      const delayed = await enqueue();
      assert.ok(Number(delayed.wait) > 4);
      await request('preferences', 'PATCH', { undoSend: false });
      assert.equal(
        (
          await pool.query(
            'SELECT next_attempt_at FROM mail_outbox WHERE id=$1',
            [delayed.id],
          )
        ).rows[0].next_attempt_at.getTime(),
        delayed.next_attempt_at.getTime(),
      );
      const immediate = await enqueue();
      assert.ok(Number(immediate.wait) <= 0);
      const at = new Date(Date.now() + 60000).toISOString(),
        scheduled = await enqueue(at);
      assert.equal(scheduled.next_attempt_at.toISOString(), at);
      assert.equal(scheduled.scheduled_at.toISOString(), at);
      await pool.query(
        "UPDATE mail_outbox SET state='failed',error_code='send_failed' WHERE id=$1",
        [immediate.id],
      );
      const retried = await request(`outbox/${immediate.id}/retry`, 'POST', {});
      assert.equal(retried.statusCode, 200, retried.body);
      const after = (
        await pool.query(
          'SELECT *,extract(epoch FROM next_attempt_at-clock_timestamp()) AS wait FROM mail_outbox WHERE id=$1',
          [immediate.id],
        )
      ).rows[0];
      assert.ok(Number(after.wait) <= 0);
      assert.deepEqual(after.raw, immediate.raw);
      assert.equal(after.message_id, immediate.message_id);
    },
  );
});
