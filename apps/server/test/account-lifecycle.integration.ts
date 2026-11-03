import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { Pool } from 'pg';
import { deleteUserData } from '../src/auth/account-lifecycle.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { transaction } from '../src/mail/store.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

// Seeds one row in every owned mail table so deletion and export cover them.
async function seedMail(pool: Pool, userId: string) {
  const account = randomUUID();
  const mailbox = randomUUID();
  const message = randomUUID();
  const draft = randomUUID();
  const file = randomUUID();
  const outbox = randomUUID();
  const q = (sql: string, values: unknown[] = []) =>
    pool.query(sql, [userId, ...values]);
  await q(
    `INSERT INTO mail_accounts(id,user_id,name,host,port,transport,username,credential)
     VALUES($2,$1,'Synthetic','imap.example.test',993,'tls','lifecycle@example.test','v1:SECRET-CIPHERTEXT')`,
    [account],
  );
  await q(
    `INSERT INTO mail_smtp(user_id,account_id,host,port,transport,username,credential)
     VALUES($1,$2,'smtp.example.test',465,'tls','lifecycle@example.test','v1:SMTP-SECRET-CIPHERTEXT')`,
    [account],
  );
  await q(
    `INSERT INTO mail_signatures(account_id,user_id,html,text) VALUES($2,$1,'<p>Sig</p>','Sig')`,
    [account],
  );
  await q(
    `INSERT INTO mailboxes(id,user_id,account_id,path,name,role) VALUES($2,$1,$3,'INBOX','Inbox','inbox')`,
    [mailbox, account],
  );
  await q(
    `INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at)
     VALUES($2,$1,$3,'k1','Exported subject','{"address":"from@example.test"}','[{"address":"to@example.test"}]',now())`,
    [message, account],
  );
  await q(
    `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags)
     VALUES($1,$2,$3,$4,'1',1,ARRAY['\\Seen'])`,
    [account, mailbox, message],
  );
  await q(
    `INSERT INTO mail_content(message_id,user_id,account_id,state,plain_text) VALUES($2,$1,$3,'ready','CACHED-BODY-NOT-EXPORTED')`,
    [message, account],
  );
  await q(
    `INSERT INTO mail_drafts(id,user_id,account_id,content) VALUES($2,$1,$3,'{"subject":"Draft subject"}')`,
    [draft, account],
  );
  await q(
    `INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state) VALUES($2,$1,'notes.txt',5,5,'ready')`,
    [file],
  );
  await q(
    `INSERT INTO mail_upload_chunks(user_id,file_id,position,data) VALUES($1,$2,0,'hello'::bytea)`,
    [file],
  );
  await q(
    `INSERT INTO mail_draft_attachments(user_id,draft_id,file_id,position) VALUES($1,$2,$3,0)`,
    [draft, file],
  );
  await q(
    `INSERT INTO mail_outbox(id,user_id,account_id,source_draft_id,draft_revision,smtp_version,sender,recipients,subject,message_id,raw,state)
     VALUES($2,$1,$3,$4,1,gen_random_uuid(),'lifecycle@example.test','["to@example.test"]','Queued','<'||gen_random_uuid()||'@example.test>','MIME'::bytea,'cancelled')`,
    [outbox, account, draft],
  );
  await q(
    `INSERT INTO mail_saved_searches(id,user_id,name,query) VALUES(gen_random_uuid(),$1,'Saved','from:a')`,
  );
  await q('INSERT INTO mail_preferences(user_id) VALUES($1)');
  return { account, message, draft };
}

async function ownedRowCounts(pool: Pool, userId: string) {
  const tables = (
    await pool.query(
      `SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='user_id'
       AND table_name<>'security_events'`,
    )
  ).rows.map((row) => row.table_name as string);
  const counts: Record<string, number> = {};
  for (const table of tables)
    counts[table] = (
      await pool.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE user_id=$1`,
        [userId],
      )
    ).rows[0].n;
  counts.users = (
    await pool.query('SELECT count(*)::int AS n FROM users WHERE id=$1', [
      userId,
    ])
  ).rows[0].n;
  return counts;
}

test('security activity, data export, scheduled self-deletion and admin deletion', {
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
  const sent: { to: string; subject: string }[] = [];
  const mailer = nodemailer.createTransport({ jsonTransport: true });
  t.mock.method(mailer, 'sendMail', async (mail: SendMailOptions) => {
    sent.push({ to: String(mail.to), subject: String(mail.subject) });
    return { messageId: 'synthetic-lifecycle' };
  });
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 72).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, mailer, keys);
  t.after(async () => {
    // Seeded synthetic mail must not leak into later files if a subtest fails.
    await pool.query(
      "DELETE FROM users WHERE email LIKE 'lifecycle-%' AND role<>'admin'",
    );
    await app.close();
  });
  const origin = testConfig.appUrl;
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'lifecycle-owner@example.test',
    '203.0.113.150',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'lifecycle-other@example.test',
    '203.0.113.151',
  );
  const admin = await createTestUser(
    app,
    pool,
    testConfig,
    'lifecycle-admin@example.test',
    '203.0.113.152',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [admin.id]);
  const account = (path: string, cookie: string, payload?: object) =>
    app.inject({
      method: payload ? 'POST' : 'GET',
      url: `/api/auth/account${path}`,
      headers: { cookie, origin },
      ...(payload ? { payload } : {}),
    });
  let signIns = 0;
  const signIn = (email: string, password: string) =>
    app.inject({
      remoteAddress: `203.0.113.${160 + signIns++}`,
      method: 'POST',
      url: '/api/auth/sign-in/email',
      headers: { origin, 'user-agent': 'Lifecycle Browser' },
      payload: { email, password },
    });

  await t.test('records owned security activity without secrets', async () => {
    assert.equal(
      (await signIn(owner.email, 'wrong password value')).statusCode,
      401,
    );
    assert.equal(
      (await signIn('nobody@example.test', 'wrong password value')).statusCode,
      401,
    );
    const activity = await account('/activity', owner.cookie);
    assert.equal(activity.statusCode, 200, activity.body);
    const types = activity
      .json()
      .events.map((event: { type: string }) => event.type);
    assert.deepEqual(types.slice(0, 2), [
      'sign_in.failed',
      'sign_in.succeeded',
    ]);
    assert.ok(types.includes('account.created'));
    const failed = activity.json().events[0];
    assert.equal(failed.ipAddress, '203.0.113.160');
    assert.equal(failed.userAgent, 'Lifecycle Browser');
    assert.ok(!activity.body.includes(owner.password));
    // Unknown addresses leave no rows; other users' events stay private.
    assert.equal(
      (
        await pool.query(
          "SELECT count(*)::int n FROM security_events WHERE type='sign_in.failed'",
        )
      ).rows[0].n,
      1,
    );
    const foreign = await account('/activity', other.cookie);
    assert.ok(
      foreign
        .json()
        .events.every(
          (event: { type: string }) => event.type !== 'sign_in.failed',
        ),
    );
    assert.equal(
      (await account('/activity?unknown=1', owner.cookie)).statusCode,
      400,
    );
  });

  await t.test(
    'exports owned Spindle data behind password confirmation',
    async () => {
      const seeded = await seedMail(pool, owner.id);
      await seedMail(pool, other.id);
      const exportRequest = (
        payload: object,
        cookie = owner.cookie,
        requestOrigin = origin,
      ) =>
        app.inject({
          method: 'POST',
          url: '/api/account/export',
          headers: { cookie, origin: requestOrigin },
          payload,
        });
      assert.equal(
        (
          await exportRequest(
            { currentPassword: owner.password },
            owner.cookie,
            'https://evil.example',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await exportRequest({ currentPassword: owner.password }, ''))
          .statusCode,
        401,
      );
      assert.equal(
        (await exportRequest({ currentPassword: 'incorrect password' }))
          .statusCode,
        400,
      );
      assert.equal(
        (await exportRequest({ currentPassword: owner.password, extra: 1 }))
          .statusCode,
        400,
      );
      const response = await exportRequest({ currentPassword: owner.password });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers['content-type'], 'application/gzip');
      assert.match(
        String(response.headers['content-disposition']),
        /^attachment; filename="spindle-export-\d{4}-\d{2}-\d{2}\.json\.gz"$/,
      );
      const text = gunzipSync(response.rawPayload).toString();
      const data = JSON.parse(text);
      assert.equal(data.format, 'spindle-export');
      assert.equal(data.profile.email, owner.email);
      assert.equal(data.accounts.length, 1);
      assert.equal(data.accounts[0].id, seeded.account);
      assert.equal(data.accounts[0].smtp.username, 'lifecycle@example.test');
      assert.equal(data.accounts[0].signature.text, 'Sig');
      assert.equal(data.messages.length, 1);
      assert.equal(data.messages[0].subject, 'Exported subject');
      assert.deepEqual(data.messages[0].folders[0].flags, ['\\Seen']);
      assert.equal(data.drafts[0].attachments[0].filename, 'notes.txt');
      assert.equal(
        Buffer.from(data.drafts[0].attachments[0].base64, 'base64').toString(),
        'hello',
      );
      assert.equal(
        Buffer.from(data.outbox[0].mimeBase64, 'base64').toString(),
        'MIME',
      );
      assert.equal(data.savedSearches.length, 1);
      assert.deepEqual(data.preferences, {
        imageProxy: true,
        blockRemoteImages: true,
        undoSend: true,
      });
      assert.ok(
        data.securityActivity.some(
          (event: { type: string }) => event.type === 'export.created',
        ),
      );
      for (const secret of [
        'SECRET-CIPHERTEXT',
        'CACHED-BODY-NOT-EXPORTED',
        owner.password,
        'lifecycle-other',
      ])
        assert.ok(!text.includes(secret), secret);
      const token = (
        await pool.query(
          'SELECT token FROM auth_sessions WHERE user_id=$1 LIMIT 1',
          [owner.id],
        )
      ).rows[0].token;
      assert.ok(!text.includes(token));
    },
  );

  await t.test(
    'schedules deletion, blocks sign-in and cancels with credentials',
    async () => {
      const before = await account('/deletion', owner.cookie, {
        currentPassword: 'incorrect password',
      });
      assert.equal(before.statusCode, 400);
      const scheduled = await account('/deletion', owner.cookie, {
        currentPassword: owner.password,
      });
      assert.equal(scheduled.statusCode, 200, scheduled.body);
      const due = new Date(scheduled.json().deletionDueAt).getTime();
      assert.ok(Math.abs(due - Date.now() - 7 * 86400000) < 60000);
      assert.ok(
        sent.some(
          (mail) =>
            mail.to === owner.email &&
            /scheduled for deletion/.test(mail.subject),
        ),
      );
      const row = (
        await pool.query(
          'SELECT suspended,deletion_due_at FROM users WHERE id=$1',
          [owner.id],
        )
      ).rows[0];
      assert.equal(row.suspended, true);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1',
            [owner.id],
          )
        ).rows[0].n,
        0,
      );
      assert.equal((await account('', owner.cookie)).statusCode, 401);
      const blocked = await signIn(owner.email, owner.password);
      assert.equal(blocked.statusCode, 403);
      assert.equal(blocked.json().code, 'ACCOUNT_DELETION_PENDING');
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1',
            [owner.id],
          )
        ).rows[0].n,
        0,
      );
      const cancel = (email: string, password: string) =>
        app.inject({
          method: 'POST',
          url: '/api/auth/account/deletion/cancel',
          headers: { origin },
          payload: { email, password },
        });
      assert.equal(
        (await cancel(owner.email, 'incorrect password')).statusCode,
        401,
      );
      assert.equal(
        (await cancel('nobody@example.test', owner.password)).statusCode,
        401,
      );
      assert.equal((await cancel(other.email, other.password)).statusCode, 400);
      assert.equal((await cancel(owner.email, owner.password)).statusCode, 200);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT suspended,deletion_due_at FROM users WHERE id=$1',
            [owner.id],
          )
        ).rows[0],
        { suspended: false, deletion_due_at: null },
      );
      const restored = await signIn(owner.email, owner.password);
      assert.equal(restored.statusCode, 200, restored.body);
    },
  );

  await t.test(
    'the last active administrator cannot schedule deletion',
    async () => {
      // The shared integration database keeps administrators from earlier files.
      await pool.query(
        "UPDATE users SET role='user' WHERE role='admin' AND NOT suspended AND id<>$1",
        [admin.id],
      );
      const refused = await account('/deletion', admin.cookie, {
        currentPassword: admin.password,
      });
      assert.equal(refused.statusCode, 400);
      assert.match(refused.json().message, /another administrator/);
      assert.equal(
        (
          await pool.query('SELECT suspended FROM users WHERE id=$1', [
            admin.id,
          ])
        ).rows[0].suspended,
        false,
      );
    },
  );

  await t.test('expired grace periods delete every owned row', async () => {
    const login = await signIn(owner.email, owner.password);
    const cookie = (login.headers['set-cookie'] as string[])
      .map((value) => value.split(';')[0])
      .join('; ');
    assert.equal(
      (await account('/deletion', cookie, { currentPassword: owner.password }))
        .statusCode,
      200,
    );
    // Not yet due: the dispatcher path leaves the user alone.
    assert.equal(
      await transaction(pool, (client) =>
        deleteUserData(client, owner.id, true),
      ),
      false,
    );
    await pool.query(
      "UPDATE users SET deletion_due_at=now()-interval '1 second' WHERE id=$1",
      [owner.id],
    );
    assert.equal(
      await transaction(pool, (client) =>
        deleteUserData(client, owner.id, true),
      ),
      true,
    );
    const counts = await ownedRowCounts(pool, owner.id);
    assert.ok(
      Object.values(counts).every((count) => count === 0),
      JSON.stringify(counts),
    );
    assert.deepEqual(
      (
        await pool.query(
          'SELECT type,ip_address FROM security_events WHERE user_id=$1',
          [owner.id],
        )
      ).rows,
      [{ type: 'account.deleted', ip_address: null }],
    );
    assert.equal(
      (
        await pool.query('SELECT count(*)::int n FROM invites WHERE email=$1', [
          owner.email,
        ])
      ).rows[0].n,
      0,
    );
    // The other user's data is untouched.
    assert.equal(
      (
        await pool.query(
          'SELECT count(*)::int n FROM mail_messages WHERE user_id=$1',
          [other.id],
        )
      ).rows[0].n,
      1,
    );
  });

  await t.test(
    'administrators delete suspended users with scrubbed audit',
    async () => {
      const admin2 = await createTestUser(
        app,
        pool,
        testConfig,
        'lifecycle-admin2@example.test',
        '203.0.113.153',
      );
      const adminRequest = (path: string, body?: object) =>
        app.inject({
          method: body ? 'POST' : 'GET',
          url: `/api/admin/${path}`,
          headers: { cookie: admin.cookie, origin },
          ...(body ? { payload: body } : {}),
        });
      assert.equal(
        (await adminRequest('unlock', { currentPassword: admin.password }))
          .statusCode,
        200,
      );
      const revision = async (id: string) =>
        (await pool.query('SELECT admin_revision FROM users WHERE id=$1', [id]))
          .rows[0].admin_revision;
      const change = async (id: string, action: string) =>
        adminRequest(`users/${id}`, {
          operationId: randomUUID(),
          action,
          expectedRevision: await revision(id),
        });
      assert.equal((await change(admin.id, 'delete')).statusCode, 400);
      const active = await change(other.id, 'delete');
      assert.equal(active.statusCode, 409);
      assert.match(active.json().message, /Suspend this user/);
      assert.equal((await change(other.id, 'suspend')).statusCode, 200);
      const deleted = await change(other.id, 'delete');
      assert.equal(deleted.statusCode, 200, deleted.body);
      const counts = await ownedRowCounts(pool, other.id);
      assert.ok(
        Object.values(counts).every((count) => count === 0),
        JSON.stringify(counts),
      );
      const audit = (
        await pool.query(
          'SELECT action,target_id,details FROM admin_audit WHERE target_id=$1 ORDER BY created_at',
          [other.id],
        )
      ).rows;
      assert.deepEqual(
        audit.map((row) => row.action),
        ['user.suspend', 'user.delete'],
      );
      assert.ok(
        audit.every(
          (row) => !JSON.stringify(row.details).includes(other.email),
        ),
      );
      // Pending self-deletion cannot be resumed by an administrator; it can be deleted now.
      const login = await signIn(admin2.email, admin2.password);
      const cookie = (login.headers['set-cookie'] as string[])
        .map((value) => value.split(';')[0])
        .join('; ');
      assert.equal(
        (
          await account('/deletion', cookie, {
            currentPassword: admin2.password,
          })
        ).statusCode,
        200,
      );
      const resume = await change(admin2.id, 'resume');
      assert.equal(resume.statusCode, 409);
      assert.match(resume.json().message, /scheduled account deletion/);
      const users = await adminRequest('users?search=lifecycle-admin2');
      assert.equal(users.statusCode, 200, users.body);
      assert.ok(users.json().users[0].deletionDueAt);
      const security = await adminRequest('security');
      assert.equal(security.statusCode, 200);
      assert.ok(
        security
          .json()
          .events.some(
            (event: { type: string; email: string }) =>
              event.type === 'deletion.scheduled' &&
              event.email === admin2.email,
          ),
      );
      assert.equal((await change(admin2.id, 'delete')).statusCode, 200);
    },
  );
});
