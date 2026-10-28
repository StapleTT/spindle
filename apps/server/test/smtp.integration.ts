import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { connectImap } from '../src/mail/imap.js';
import { processOutgoing } from '../src/mail/outgoing-worker.js';
import { connectSmtp } from '../src/mail/smtp.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword } from './imap-fixture.js';
import { smtpFixture, smtpPassword } from './smtp-fixture.js';

test('owned SMTP settings, immutable outbox and safe provider delivery', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90000,
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
      v1: Buffer.alloc(32, 52).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'smtp-owner@example.test',
    '203.0.113.214',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'smtp-admin@example.test',
    '203.0.113.214',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const imap = await imapFixture(t, true, true, [], true),
    smtp = await smtpFixture(t, imap.server);
  function request(
    path: string,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) {
    return app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { cookie, origin },
      ...(payload ? { payload } : {}),
    });
  }
  const connected = await request('accounts', 'POST', {
    name: 'Synthetic sending account',
    host: 'localhost',
    port: imap.port,
    transport: 'tls',
    username: 'testuser',
    password: imapPassword,
    history: 'all',
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  const settings = {
    host: 'localhost',
    port: smtp.port,
    transport: 'tls',
    username: 'writer@example.test',
    password: smtpPassword,
    saveSentCopy: true,
  };
  const setup = async () => {
    const result = await request(`accounts/${account}/smtp`, 'PUT', settings);
    assert.equal(result.statusCode, 202, result.body);
    await processOutgoing(pool, keys, owner.id, account);
    assert.equal(
      (await request(`accounts/${account}/smtp`)).json().smtp.state,
      'ready',
    );
  };
  const content = {
    to: 'Recipient <recipient@example.test>',
    cc: 'copy@example.test',
    bcc: 'hidden@example.test',
    subject: 'Synthetic SMTP — café',
    format: 'rich',
    html: '<p>Hello <strong>world</strong> 😀</p>',
    text: 'ignored',
  };
  const draft = async (patch: object = {}) => {
    const id = randomUUID();
    const result = await request(`drafts/${id}`, 'PUT', {
      revision: 0,
      saveId: randomUUID(),
      accountId: account,
      content: { ...content, ...patch },
    });
    assert.equal(result.statusCode, 200, result.body);
    return id;
  };
  const queue = (id: string, operation = randomUUID(), cookie = owner.cookie) =>
    request(
      `drafts/${id}/send`,
      'POST',
      { id: operation, revision: 1 },
      cookie,
    );
  const row = async (id: string) =>
    (await pool.query('SELECT * FROM mail_outbox WHERE id=$1', [id])).rows[0];
  const apply = async (
    connect?: typeof connectSmtp,
    imapConnect?: typeof connectImap,
  ) => {
    await pool.query(
      'UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
      [owner.id],
    );
    await processOutgoing(pool, keys, owner.id, account, connect, imapConnect);
  };
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_outbox');
    await pool.query('DELETE FROM mail_drafts');
    await pool.query('DELETE FROM mail_request_limits');
    smtp.received.length = 0;
    Object.assign(smtp.controls, {
      rejectData: false,
      rejectRecipient: false,
      dropAfterData: false,
      autoSaveSent: false,
      authFail: false,
    });
    const messages = imap.server.control.listMessages('Sent');
    if (messages.length)
      imap.server.control.expungeMessages(
        'Sent',
        messages.map((item) => item.uid),
      );
  });

  await t.test(
    'configuration is owned, encrypted, redacted and checked by the worker without sending',
    async () => {
      assert.equal(
        (
          await request(
            `accounts/${account}/smtp`,
            'GET',
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (await request(`accounts/${account}/smtp`, 'PUT', settings, ''))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await request(
            `accounts/${account}/smtp`,
            'PUT',
            settings,
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(`accounts/${account}/smtp`, 'PUT', {
            ...settings,
            username: 'Display <fake@example.test>',
          })
        ).statusCode,
        400,
      );
      const saved = await request(`accounts/${account}/smtp`, 'PUT', settings);
      assert.equal(saved.statusCode, 202, saved.body);
      const before = (await request(`accounts/${account}/smtp`)).json().smtp;
      assert.equal(before.state, 'pending');
      assert.equal(before.credential, undefined);
      const cipher = (
        await pool.query(
          'SELECT credential FROM mail_smtp WHERE account_id=$1',
          [account],
        )
      ).rows[0].credential;
      assert.ok(!cipher.includes(smtpPassword));
      await processOutgoing(pool, keys, other.id, account);
      assert.equal(smtp.received.length, 0);
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(
        (await request(`accounts/${account}/smtp`)).json().smtp.state,
        'ready',
      );
      assert.equal(smtp.received.length, 0);
      const { password: _password, ...keep } = settings;
      assert.equal(
        (await request(`accounts/${account}/smtp`, 'PUT', keep)).statusCode,
        202,
      );
      assert.equal(
        (
          await request(`accounts/${account}/smtp`, 'PUT', {
            ...keep,
            host: 'other.example.test',
          })
        ).statusCode,
        400,
      );
      await processOutgoing(pool, keys, owner.id, account);
    },
  );

  await t.test(
    'display names are owned, default to the profile, persist without credentials and reach recipient MIME',
    async () => {
      await setup();
      const name = 'Zoë "Support", Inbox';
      const previous = (
        await pool.query(
          'SELECT credential FROM mail_smtp WHERE account_id=$1',
          [account],
        )
      ).rows[0].credential;
      const { password: _password, ...keep } = settings;
      assert.equal(
        (await request(`accounts/${account}/smtp`)).json().defaultDisplayName,
        'Reader Test',
      );
      assert.equal(
        (await request(`accounts/${account}/smtp`)).json().smtp.displayName,
        'Reader Test',
      );
      assert.equal(
        (
          await request(
            `accounts/${account}/smtp`,
            'PUT',
            { ...keep, displayName: name },
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(`accounts/${account}/smtp`, 'PUT', {
            ...keep,
            displayName: name,
          })
        ).statusCode,
        202,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT credential FROM mail_smtp WHERE account_id=$1',
            [account],
          )
        ).rows[0].credential,
        previous,
      );
      for (const displayName of [
        'Injected\r\nBcc: attacker@example.test',
        'name\u0085',
        'x'.repeat(201),
      ])
        assert.equal(
          (
            await request(`accounts/${account}/smtp`, 'PUT', {
              ...keep,
              displayName,
            })
          ).statusCode,
          400,
        );
      // Older clients omit the field: their saves must preserve the stored name.
      assert.equal(
        (await request(`accounts/${account}/smtp`, 'PUT', keep)).statusCode,
        202,
      );
      assert.equal(
        (await request(`accounts/${account}/smtp`)).json().smtp.displayName,
        name,
      );
      assert.equal(
        (await request('accounts'))
          .json()
          .accounts.find((value: { id: string }) => value.id === account)
          .senderName,
        name,
      );
      await processOutgoing(pool, keys, owner.id, account);
      const id = await draft();
      const queued = await queue(id);
      assert.equal(queued.statusCode, 202, queued.body);
      await apply();
      const received = await simpleParser(
        smtp.received[0]?.raw ?? Buffer.alloc(0),
      );
      assert.equal(received.from?.value[0]?.name, name);
      assert.equal(received.from?.value[0]?.address, 'writer@example.test');
      assert.equal(
        (
          await request(`accounts/${account}/smtp`, 'PUT', {
            ...keep,
            displayName: '',
          })
        ).statusCode,
        202,
      );
      assert.equal(
        (await request(`accounts/${account}/smtp`)).json().smtp.displayName,
        '',
      );
      const frozen = await row(queued.json().outbox.id);
      assert.equal((await simpleParser(frozen.raw)).from?.value[0]?.name, name);
      await processOutgoing(pool, keys, owner.id, account);
      const bare = await draft();
      assert.equal((await queue(bare)).statusCode, 202);
      await apply();
      assert.equal(
        (await simpleParser(smtp.received.at(-1)?.raw ?? Buffer.alloc(0))).from
          ?.value[0]?.name,
        '',
      );
    },
  );

  await t.test(
    'TLS and required STARTTLS reject bad certificates and downgrade before authentication',
    async () => {
      const upgraded = await smtpFixture(t, imap.server, false, true),
        downgraded = await smtpFixture(t, imap.server, false, false);
      const client = await connectSmtp(
        { ...settings, port: upgraded.port, transport: 'starttls' },
        smtpPassword,
      );
      client.close();
      await assert.rejects(
        connectSmtp(
          { ...settings, port: downgraded.port, transport: 'starttls' },
          smtpPassword,
        ),
      );
      assert.equal(downgraded.authAttempts(), 0);
      imap.trustCertificate(false);
      await assert.rejects(
        connectSmtp({ ...settings, transport: 'tls' }, smtpPassword),
      );
      imap.trustCertificate(true);
      await assert.rejects(
        connectSmtp(
          { ...settings, host: '127.0.0.1', transport: 'tls' },
          smtpPassword,
        ),
      );
    },
  );

  await t.test(
    'enqueue checks ownership, completed recipients, revisions, readiness and frozen draft mutation',
    async () => {
      await setup();
      const id = await draft(),
        operation = randomUUID();
      assert.equal((await queue(id, operation, other.cookie)).statusCode, 404);
      const invalid = await draft({ to: 'unfinished', cc: '', bcc: '' });
      assert.equal((await queue(invalid)).statusCode, 409);
      const stale = await request(`drafts/${id}/send`, 'POST', {
        id: operation,
        revision: 2,
      });
      assert.equal(stale.statusCode, 409);
      const result = await queue(id, operation);
      assert.equal(result.statusCode, 202, result.body);
      assert.equal((await queue(id, operation)).statusCode, 202);
      assert.equal((await queue(id)).statusCode, 409);
      assert.equal(
        (
          await request(`drafts/${id}`, 'PUT', {
            revision: 1,
            saveId: randomUUID(),
            accountId: account,
            content,
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await request(`drafts/${id}`, 'DELETE', { revision: 1 })).statusCode,
        409,
      );
      assert.equal(
        (await request(`drafts/${id}`)).json().draft.outbox.id,
        operation,
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 0);
      assert.equal(
        (await request('outbox', 'GET', undefined, other.cookie)).json()
          .messages.length,
        0,
      );
      assert.equal(
        (await request(`outbox/${operation}/cancel`, 'POST', {}, other.cookie))
          .statusCode,
        404,
      );
      assert.equal(
        (await request(`outbox/${operation}/cancel`, 'POST', {})).statusCode,
        200,
      );
      assert.equal(
        (await request(`outbox/${operation}/cancel`, 'POST', {})).statusCode,
        200,
      );
      await apply();
      assert.equal(smtp.received.length, 0);
      assert.equal((await row(operation)).state, 'cancelled');
      assert.equal(
        (await request(`drafts/${id}`, 'DELETE', { revision: 1 })).statusCode,
        200,
      );
    },
  );

  await t.test(
    'concurrent submissions create one intent; SMTP accepts proper MIME without exposing Bcc',
    async () => {
      await setup();
      const id = await draft();
      const queued = await Promise.all([queue(id), queue(id)]);
      assert.deepEqual(
        queued.map((result) => result.statusCode).sort(),
        [202, 409],
      );
      const operation = queued
        .find((result) => result.statusCode === 202)
        ?.json().outbox.id;
      await apply();
      const saved = await row(operation);
      assert.equal(saved.state, 'accepted');
      assert.equal(smtp.received.length, 1);
      const received = smtp.received[0];
      assert.ok(received);
      assert.equal(received.recipients.length, 3);
      assert.ok(received.recipients.includes('hidden@example.test'));
      assert.doesNotMatch(received.raw.toString(), /^Bcc:/im);
      const parsed = await simpleParser(received.raw);
      assert.equal(parsed.subject, content.subject);
      assert.equal(parsed.messageId, saved.message_id);
      assert.match(parsed.text ?? '', /world.*😀/);
      assert.match(parsed.html || '', /<strong>world<\/strong>/);
      assert.equal((await request(`drafts/${id}`)).statusCode, 404);
      assert.equal(saved.sent_copy, 'saved');
      assert.equal(imap.server.control.listMessages('Sent').length, 1);
      await apply();
      assert.equal(smtp.received.length, 1);
      assert.equal(imap.server.control.listMessages('Sent').length, 1);
      assert.equal(
        (await request(`outbox/${operation}/cancel`, 'POST', {})).statusCode,
        409,
      );
      assert.equal(
        (await request(`outbox/${operation}/retry`, 'POST', {})).statusCode,
        409,
      );
    },
  );

  await t.test(
    'definite pre-send failures back off, preserve drafts and safely retry the same message',
    async () => {
      await setup();
      const id = await draft({
          format: 'plain',
          html: '',
          text: 'Plain message',
        }),
        operation = (await queue(id)).json().outbox.id;
      for (let attempt = 0; attempt < 3; attempt++)
        await apply(async () => {
          throw new Error('Synthetic connection failure');
        });
      assert.equal((await row(operation)).state, 'failed');
      assert.equal((await request(`drafts/${id}`)).statusCode, 200);
      assert.equal(smtp.received.length, 0);
      const messageId = (await row(operation)).message_id;
      assert.equal(
        (await request(`outbox/${operation}/retry`, 'POST', {})).statusCode,
        200,
      );
      await apply();
      assert.equal((await row(operation)).state, 'accepted');
      assert.equal((await row(operation)).message_id, messageId);
      assert.equal(smtp.received.length, 1);
      const parsed = await simpleParser(
        smtp.received[0]?.raw ?? Buffer.alloc(0),
      );
      assert.equal(parsed.html, false);
      assert.match(parsed.text ?? '', /Plain message/);
    },
  );

  await t.test(
    'explicit DATA rejection fails; partial recipient acceptance is reported without resending',
    async () => {
      await setup();
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      smtp.controls.rejectData = true;
      await apply();
      assert.equal((await row(operation)).state, 'failed');
      assert.equal(smtp.received.length, 0);
      assert.equal((await request(`drafts/${id}`)).statusCode, 200);
      smtp.controls.rejectData = false;
      smtp.controls.rejectRecipient = true;
      const partial = await draft({
          to: 'recipient@example.test, reject@example.test',
          cc: '',
          bcc: '',
        }),
        partialId = (await queue(partial)).json().outbox.id;
      await apply();
      const result = await row(partialId);
      assert.equal(result.state, 'partial');
      assert.deepEqual(result.accepted, ['recipient@example.test']);
      assert.deepEqual(result.rejected, ['reject@example.test']);
      assert.equal(
        (await request(`outbox/${partialId}/retry`, 'POST', {})).statusCode,
        409,
      );
      await apply();
      assert.equal(smtp.received.length, 1);
    },
  );

  await t.test(
    'a lost SMTP acceptance and killed-worker redelivery stay unknown and never duplicate mail',
    async () => {
      await setup();
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      smtp.controls.dropAfterData = true;
      smtp.controls.autoSaveSent = true;
      await apply();
      assert.equal((await row(operation)).state, 'unknown');
      assert.equal(smtp.received.length, 1);
      assert.equal((await request(`drafts/${id}`)).statusCode, 200);
      assert.equal(
        (await request(`outbox/${operation}/retry`, 'POST', {})).statusCode,
        409,
      );
      await apply();
      assert.equal((await row(operation)).state, 'unknown');
      assert.equal((await row(operation)).sent_copy, 'saved');
      assert.equal(smtp.received.length, 1);
      assert.equal(imap.server.control.listMessages('Sent').length, 1);
      const killed = await draft(),
        killedId = (await queue(killed)).json().outbox.id;
      await pool.query(
        "UPDATE mail_outbox SET state='sending',started_at=clock_timestamp() WHERE id=$1",
        [killedId],
      );
      await apply();
      assert.equal((await row(killedId)).state, 'unknown');
      assert.equal(smtp.received.length, 1);
    },
  );

  await t.test(
    'Sent reconciliation recognizes provider copies and lost APPEND acknowledgements',
    async () => {
      await setup();
      smtp.controls.autoSaveSent = true;
      const first = await draft(),
        firstId = (await queue(first)).json().outbox.id;
      await apply();
      assert.equal((await row(firstId)).sent_copy, 'saved');
      assert.equal(imap.server.control.listMessages('Sent').length, 1);
      smtp.controls.autoSaveSent = false;
      const second = await draft(),
        secondId = (await queue(second)).json().outbox.id;
      await apply(undefined, async (...args) => {
        const client = await connectImap(...args),
          append = client.append.bind(client);
        client.append = async (...args) => {
          await append(...args);
          throw new Error('Lost APPEND acknowledgement');
        };
        return client;
      });
      assert.equal((await row(secondId)).state, 'accepted');
      assert.equal((await row(secondId)).sent_copy, 'unknown');
      assert.equal(imap.server.control.listMessages('Sent').length, 2);
      await apply();
      assert.equal((await row(secondId)).sent_copy, 'saved');
      assert.equal(imap.server.control.listMessages('Sent').length, 2);
    },
  );

  await t.test(
    'provider-managed Sent never appends, including delayed provider copies',
    async () => {
      await setup();
      await request(`accounts/${account}/smtp`, 'PUT', {
        ...settings,
        saveSentCopy: false,
      });
      await processOutgoing(pool, keys, owner.id, account);
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      await apply();
      assert.equal((await row(operation)).state, 'accepted');
      assert.equal(imap.server.control.listMessages('Sent').length, 0);
      assert.equal((await row(operation)).sent_copy, 'unknown');
      const delivered = smtp.received[0];
      assert.ok(delivered);
      imap.server.control.addMessage('Sent', {
        raw: delivered.raw,
        flags: ['\\Seen'],
        internaldate: new Date(),
      });
      await apply();
      assert.equal((await row(operation)).sent_copy, 'saved');
      assert.equal(imap.server.control.listMessages('Sent').length, 1);
    },
  );

  await t.test(
    'failed SMTP checks free queued drafts and superseded intents cannot retry',
    async () => {
      await setup();
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      smtp.controls.authFail = true;
      await request(`accounts/${account}/smtp/test`, 'POST', {});
      await apply();
      assert.equal((await row(operation)).state, 'failed');
      assert.equal((await row(operation)).error_code, 'smtp_unavailable');
      assert.equal((await request(`drafts/${id}`)).json().draft.outbox, null);
      smtp.controls.authFail = false;
      await request(`accounts/${account}/smtp/test`, 'POST', {});
      await processOutgoing(pool, keys, owner.id, account);
      const newer = await queue(id);
      assert.equal(newer.statusCode, 202, newer.body);
      assert.equal(
        (await request(`outbox/${operation}/retry`, 'POST', {})).statusCode,
        409,
      );
      assert.equal(smtp.received.length, 0);
    },
  );

  await t.test(
    'recipient and daily submission limits are enforced transactionally',
    async () => {
      await setup();
      const excessive = await draft({
        to: Array.from(
          { length: 51 },
          (_, i) => `person${i}@example.test`,
        ).join(', '),
        cc: '',
        bcc: '',
      });
      assert.equal((await queue(excessive)).statusCode, 409);
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      await pool.query(
        `INSERT INTO mail_outbox(id,user_id,account_id,source_draft_id,draft_revision,smtp_version,sender,recipients,subject,message_id,raw,state)
      SELECT gen_random_uuid(),user_id,account_id,gen_random_uuid(),draft_revision,smtp_version,sender,recipients,subject,'<'||gen_random_uuid()||'@example.test>',raw,'cancelled'
      FROM mail_outbox CROSS JOIN generate_series(1,99) WHERE id=$1`,
        [operation],
      );
      const more = await draft();
      const limited = await queue(more);
      assert.equal(limited.statusCode, 409);
      assert.match(limited.json().message, /Daily send limit/);
      assert.equal(smtp.received.length, 0);
    },
  );

  await t.test(
    'user deletion cascades queued snapshots without blocking the owned data removal',
    async () => {
      await setup();
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      const otherDraft = randomUUID();
      const saved = await request(
        `drafts/${otherDraft}`,
        'PUT',
        { revision: 0, saveId: randomUUID(), accountId: null, content },
        other.cookie,
      );
      assert.equal(saved.statusCode, 200, saved.body);
      await pool.query(
        `INSERT INTO mail_outbox(id,user_id,draft_id,source_draft_id,draft_revision,smtp_version,sender,recipients,subject,message_id,raw)
      SELECT gen_random_uuid(),$2,$3,$3,1,smtp_version,sender,recipients,subject,'<'||gen_random_uuid()||'@example.test>',raw FROM mail_outbox WHERE id=$1`,
        [operation, other.id, otherDraft],
      );
      await pool.query('DELETE FROM users WHERE id=$1', [other.id]);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM mail_drafts WHERE user_id=$1',
            [other.id],
          )
        ).rows[0].count,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM mail_outbox WHERE user_id=$1',
            [other.id],
          )
        ).rows[0].count,
        0,
      );
    },
  );

  await t.test(
    'durable pg-boss dispatch checks SMTP and sends a persisted outbox intent',
    async () => {
      await setup();
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      await pool.query(
        "UPDATE mail_accounts SET next_sync_at=clock_timestamp()+interval '1 day'",
      );
      const boss = new PgBoss({ connectionString });
      const errors: unknown[] = [];
      boss.on('error', (error) => errors.push(error));
      let stop: (() => void) | undefined;
      try {
        await boss.start();
        stop = await startMailWorker(boss, pool, keys);
        const deadline = Date.now() + 20000;
        while (
          Date.now() < deadline &&
          (await row(operation)).state !== 'accepted'
        )
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal((await row(operation)).state, 'accepted');
        assert.equal(smtp.received.length, 1);
        assert.deepEqual(errors, []);
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
    },
  );

  await t.test(
    'changed settings invalidate queued sends; disconnect preserves failure history and text',
    async () => {
      await setup();
      const id = await draft(),
        operation = (await queue(id)).json().outbox.id;
      await setup();
      await apply();
      assert.equal((await row(operation)).state, 'failed');
      assert.equal((await row(operation)).error_code, 'settings_changed');
      assert.equal(
        (await request(`outbox/${operation}/retry`, 'POST', {})).statusCode,
        409,
      );
      const fresh = await draft(),
        queued = (await queue(fresh)).json().outbox.id;
      const removed = await request(`accounts/${account}`, 'DELETE', {
        password: owner.password,
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal((await row(queued)).state, 'failed');
      assert.equal((await row(queued)).account_id, null);
      assert.equal(
        (await request(`drafts/${fresh}`)).json().draft.accountId,
        null,
      );
      assert.equal(smtp.received.length, 0);
    },
  );
});
