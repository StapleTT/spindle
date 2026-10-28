import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { fetchMessageContent } from '../src/mail/content-worker.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { scanFile } from '../src/mail/file-scanner.js';
import { CHUNK_BYTES, FILE_BYTES } from '../src/mail/file-storage.js';
import {
  cleanupUploads,
  fetchForwardFile,
  scanUpload,
} from '../src/mail/file-worker.js';
import { processOutgoing } from '../src/mail/outgoing-worker.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword } from './imap-fixture.js';
import { attachmentBytes, attachmentMail } from './reader-fixture.js';
import { eicar, scannerFixture } from './scanner-fixture.js';
import { smtpFixture, smtpPassword } from './smtp-fixture.js';

test('owned outgoing attachments, quarantine, recovery and streamed immutable delivery', {
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
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 61).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'files-owner@example.test',
      '203.0.113.218',
    ),
    other = await createTestUser(
      app,
      pool,
      testConfig,
      'files-admin@example.test',
      '203.0.113.218',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const imap = await imapFixture(t, true, true, [], true),
    smtp = await smtpFixture(t, imap.server),
    scanner = await scannerFixture(t);
  const request = (
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
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
  const account = (
    await request('accounts', 'POST', {
      name: 'Files account',
      host: 'localhost',
      port: imap.port,
      transport: 'tls',
      username: 'testuser',
      password: imapPassword,
      history: 'all',
    })
  ).json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  await request(`accounts/${account}/smtp`, 'PUT', {
    host: 'localhost',
    port: smtp.port,
    transport: 'tls',
    username: 'writer@example.test',
    password: smtpPassword,
    saveSentCopy: true,
  });
  await processOutgoing(pool, keys, owner.id, account);
  const content = {
    to: 'friend@example.test',
    cc: '',
    bcc: 'blind@example.test',
    subject: 'Attached files',
    format: 'rich',
    html: '<p>My attachment note.</p>',
    text: 'My attachment note.',
  };
  const load = async (id: string) =>
    (await request(`drafts/${id}`)).json().draft;
  const reserve = async (
    bytes: Buffer,
    filename = 'report.txt',
    id = randomUUID(),
    cookie = owner.cookie,
  ) => request('uploads', 'POST', { id, filename, size: bytes.length }, cookie);
  const binary = (
    id: string,
    bytes: Buffer,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) =>
    app.inject({
      url: `/api/mail/uploads/${id}`,
      method: 'PUT',
      headers: { cookie, origin, 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
  const scan = (id: string) =>
    scanUpload(pool, owner.id, id, (source) => scanFile(source, scanner.env));
  const upload = async (bytes: Buffer, filename = 'report.txt') => {
    const result = await reserve(bytes, filename);
    assert.equal(result.statusCode, 201, result.body);
    const id = result.json().file.id;
    const sent = await binary(id, bytes);
    assert.equal(sent.statusCode, 202, sent.body);
    return id as string;
  };
  const draft = async (ids: string[] = []) => {
    const id = randomUUID();
    const saved = await request(`drafts/${id}`, 'PUT', {
      accountId: account,
      content,
      revision: 0,
      saveId: randomUUID(),
      attachmentIds: ids,
    });
    assert.equal(saved.statusCode, 200, saved.body);
    return saved.json().draft;
  };
  const queue = async (
    id: string,
    revision: number,
    operation = randomUUID(),
  ) => request(`drafts/${id}/send`, 'POST', { id: operation, revision });
  const apply = async () => {
    await pool.query(
      "UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1 AND state='queued'",
      [owner.id],
    );
    await processOutgoing(pool, keys, owner.id, account);
  };
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_outbox WHERE user_id=$1', [owner.id]);
    await pool.query('DELETE FROM mail_drafts WHERE user_id=$1', [owner.id]);
    await pool.query('DELETE FROM mail_uploads WHERE user_id=$1', [owner.id]);
    await pool.query('DELETE FROM mail_request_limits');
    smtp.received.length = 0;
    smtp.controls.dropAfterData = false;
    scanner.controls.unavailable = false;
  });

  await t.test(
    'uploads enforce verified ownership, origin, stable IDs and safe filenames',
    async () => {
      const bytes = Buffer.from('private bytes'),
        id = randomUUID();
      assert.equal((await reserve(bytes, 'name.txt', id, '')).statusCode, 401);
      assert.equal(
        (
          await request(
            'uploads',
            'POST',
            { id, filename: 'name.txt', size: 1 },
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      const first = await reserve(bytes, '../../résumé\u202epdf.txt', id);
      assert.equal(first.statusCode, 201, first.body);
      assert.doesNotMatch(first.json().file.filename, /[/\u202e]/);
      assert.equal(
        (await reserve(bytes, '../../résumé\u202epdf.txt', id)).statusCode,
        201,
      );
      assert.equal((await reserve(bytes, 'different.txt', id)).statusCode, 409);
      assert.equal((await binary(id, bytes, other.cookie)).statusCode, 404);
      assert.equal(
        (await binary(id, bytes, owner.cookie, 'https://attacker.test'))
          .statusCode,
        403,
      );
      assert.deepEqual(
        (
          await request(`uploads?ids=${id}`, 'GET', undefined, other.cookie)
        ).json().files,
        [],
      );
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        other.id,
      ]);
      assert.equal(
        (await request(`uploads?ids=${id}`, 'GET', undefined, other.cookie))
          .statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        other.id,
      ]);
      assert.equal((await binary(id, bytes)).statusCode, 202);
      await scan(id);
      assert.equal(
        (await binary(id, Buffer.from('new content'))).statusCode,
        200,
      );
      assert.deepEqual(scanner.received.at(-1), bytes);
    },
  );
  await t.test(
    'partial/oversized uploads clear bytes; concurrency, per-file and draft aggregate limits persist',
    async () => {
      const reserved = await reserve(Buffer.from('1234'));
      const id = reserved.json().file.id;
      assert.equal((await binary(id, Buffer.from('12'))).statusCode, 400);
      assert.equal(
        (
          await pool.query(
            'SELECT reserved_bytes FROM mail_uploads WHERE id=$1',
            [id],
          )
        ).rows[0].reserved_bytes,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM mail_upload_chunks WHERE file_id=$1',
            [id],
          )
        ).rows[0].count,
        0,
      );
      const small = (await reserve(Buffer.from('x'))).json().file.id;
      assert.equal((await binary(small, Buffer.from('xx'))).statusCode, 400);
      assert.equal(
        (
          await request('uploads', 'POST', {
            id: randomUUID(),
            filename: 'big.bin',
            size: FILE_BYTES + 1,
          })
        ).statusCode,
        400,
      );
      const a = (await reserve(Buffer.from('a'))).json().file.id;
      await reserve(Buffer.from('b'));
      assert.equal((await reserve(Buffer.from('c'))).statusCode, 409);
      await request(`uploads/${a}`, 'DELETE');
      assert.equal((await reserve(Buffer.from('c'))).statusCode, 201);
      const ids = Array.from({ length: 4 }, () => randomUUID());
      for (const file of ids)
        await pool.query(
          "INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state) VALUES($1,$2,'large.bin',6291456,6291456,'ready')",
          [file, owner.id],
        );
      const rejected = await request(`drafts/${randomUUID()}`, 'PUT', {
        accountId: account,
        content,
        revision: 0,
        saveId: randomUUID(),
        attachmentIds: ids,
      });
      assert.equal(rejected.statusCode, 409);
      assert.match(rejected.json().message, /20 MiB/);
    },
  );
  await t.test(
    'cancelling an active stream cannot leave late chunks behind; persistent storage quotas cannot be bypassed',
    async () => {
      const bytes = Buffer.alloc(CHUNK_BYTES * 2, 1),
        id = (await reserve(bytes)).json().file.id;
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const source = Readable.from(
        (async function* () {
          yield bytes.subarray(0, CHUNK_BYTES);
          await gate;
          yield bytes.subarray(CHUNK_BYTES);
        })(),
      );
      const running = app
        .inject({
          url: `/api/mail/uploads/${id}`,
          method: 'PUT',
          headers: {
            cookie: owner.cookie,
            origin: testConfig.appUrl,
            'content-type': 'application/octet-stream',
          },
          payload: source,
        })
        .then(
          (response) => ({ status: response.statusCode }),
          (error) => ({ error: (error as { code?: string }).code }),
        );
      try {
        const deadline = Date.now() + 5000;
        while (
          !(
            await pool.query(
              'SELECT 1 FROM mail_upload_chunks WHERE file_id=$1 LIMIT 1',
              [id],
            )
          ).rowCount
        ) {
          assert.ok(Date.now() < deadline);
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await request(`uploads/${id}`, 'DELETE');
      } finally {
        release();
      }
      const outcome = await running;
      if ('error' in outcome) assert.equal(outcome.error, 'ABORT_ERR');
      else assert.equal(outcome.status, 400);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM mail_upload_chunks WHERE file_id=$1',
            [id],
          )
        ).rows[0].count,
        0,
      );
      await pool.query(
        "INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state) SELECT gen_random_uuid(),$1,'quota.bin',10485760,10485760,'ready' FROM generate_series(1,26)",
        [owner.id],
      );
      assert.equal((await reserve(Buffer.from('new'))).statusCode, 409);
    },
  );
  await t.test(
    'security failures and malware never become sendable; clean scan retries preserve files',
    async () => {
      const id = await upload(Buffer.from('safe'));
      const saved = await draft([id]);
      assert.equal((await queue(saved.id, saved.revision)).statusCode, 409);
      scanner.controls.unavailable = true;
      await scan(id);
      assert.equal(
        (await request(`uploads?ids=${id}`)).json().files[0].state,
        'failed',
      );
      assert.equal((await queue(saved.id, saved.revision)).statusCode, 409);
      scanner.controls.unavailable = false;
      assert.equal(
        (await request(`uploads/${id}/retry`, 'POST', {})).statusCode,
        200,
      );
      await scan(id);
      assert.equal(
        (await request(`uploads?ids=${id}`)).json().files[0].state,
        'ready',
      );
      const infected = await upload(eicar, 'test.txt');
      await scan(infected);
      assert.equal(
        (await request(`uploads?ids=${infected}`)).json().files[0].state,
        'quarantined',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM mail_upload_chunks WHERE file_id=$1',
            [infected],
          )
        ).rows[0].count,
        0,
      );
      const blocked = await draft([infected]);
      assert.equal((await queue(blocked.id, blocked.revision)).statusCode, 409);
      assert.equal(
        (await request(`uploads/${infected}/retry`, 'POST', {})).statusCode,
        409,
      );
    },
  );
  await t.test(
    'draft revisions, lost acknowledgements, recovery copies and foreign references preserve attachment membership',
    async () => {
      const id = await upload(Buffer.from('safe'));
      await scan(id);
      const original = await draft([id]),
        copy = randomUUID();
      const copied = await request(`drafts/${copy}`, 'PUT', {
        accountId: account,
        content,
        revision: 0,
        saveId: randomUUID(),
        copyOf: original.id,
      });
      assert.equal(copied.statusCode, 200, copied.body);
      assert.deepEqual(copied.json().draft.attachmentIds, [id]);
      const saveId = randomUUID(),
        payload = {
          accountId: account,
          content,
          revision: original.revision,
          saveId,
          attachmentIds: [],
        };
      const removed = await request(`drafts/${original.id}`, 'PUT', payload);
      assert.equal(removed.statusCode, 200);
      assert.deepEqual(
        (await request(`drafts/${original.id}`, 'PUT', payload)).json().draft
          .attachmentIds,
        [],
      );
      assert.equal(
        (
          await request(`drafts/${original.id}`, 'PUT', {
            ...payload,
            saveId: randomUUID(),
            attachmentIds: [id],
          })
        ).statusCode,
        409,
      );
      assert.deepEqual((await load(copy)).attachmentIds, [id]);
      const stolen = await request(
        `drafts/${randomUUID()}`,
        'PUT',
        {
          accountId: null,
          content,
          revision: 0,
          saveId: randomUUID(),
          attachmentIds: [id],
        },
        other.cookie,
      );
      assert.equal(stolen.statusCode, 409);
    },
  );
  await t.test(
    'large MIME snapshots and SMTP are streamed, cancel/retry is immutable and Sent contains exact attachment bytes',
    async () => {
      const bytes = Buffer.alloc(1024 * 1024 + 31, 173),
        id = await upload(bytes, 'résumé.pdf');
      await scan(id);
      const saved = await draft([id]);
      const operation = randomUUID();
      const queued = await queue(saved.id, saved.revision, operation);
      assert.equal(queued.statusCode, 202, queued.body);
      assert.equal(
        (await queue(saved.id, saved.revision, operation)).json().outbox.id,
        operation,
      );
      const row = (
        await pool.query('SELECT raw,mime_size FROM mail_outbox WHERE id=$1', [
          operation,
        ])
      ).rows[0];
      assert.equal(row.raw, null);
      assert.ok(row.mime_size > bytes.length);
      const lengths = (
        await pool.query(
          'SELECT octet_length(data) AS size FROM mail_outbox_chunks WHERE outbox_id=$1',
          [operation],
        )
      ).rows;
      assert.ok(lengths.length > 4);
      assert.ok(lengths.every((row) => row.size <= CHUNK_BYTES));
      assert.equal(
        (
          await request(`drafts/${saved.id}`, 'PUT', {
            accountId: account,
            content,
            revision: saved.revision,
            saveId: randomUUID(),
            attachmentIds: [],
          })
        ).statusCode,
        409,
      );
      await apply();
      assert.equal(smtp.received.length, 1);
      const parsed = await simpleParser(
        smtp.received[0]?.raw ?? Buffer.alloc(0),
      );
      assert.equal(parsed.attachments[0]?.filename, 'résumé.pdf');
      assert.equal(parsed.from?.value[0]?.name, 'Reader Test');
      assert.deepEqual(parsed.attachments[0]?.content, bytes);
      assert.equal(parsed.bcc, undefined);
      assert.equal((await request(`drafts/${saved.id}`)).statusCode, 404);
      const sent = imap.server.control.listMessages('Sent', {
        raw: true,
      });
      const copy = sent.find((message) =>
        message.raw?.includes(Buffer.from(operation)),
      );
      assert.ok(copy);
      assert.ok(copy.raw);
      const sentMail = await simpleParser(copy.raw);
      assert.deepEqual(sentMail.attachments[0]?.content, bytes);
      const hash = createHash('sha256')
        .update(smtp.received[0]?.raw ?? Buffer.alloc(0))
        .digest('hex');
      assert.equal(createHash('sha256').update(copy.raw).digest('hex'), hash);
    },
  );
  await t.test(
    'advertised SMTP size limits fail before submission, preserve files and never become unknown',
    async () => {
      const id = await upload(Buffer.alloc(1024 * 1024, 19));
      await scan(id);
      const saved = await draft([id]);
      const queued = await queue(saved.id, saved.revision);
      assert.equal(queued.statusCode, 202, queued.body);
      smtp.server.options.size = 512 * 1024;
      try {
        await apply();
      } finally {
        smtp.server.options.size = 30 * 1024 * 1024;
      }
      const result = (
        await pool.query('SELECT state,attempts FROM mail_outbox WHERE id=$1', [
          queued.json().outbox.id,
        ])
      ).rows[0];
      assert.equal(result.state, 'failed');
      assert.equal(result.attempts, 1);
      assert.equal(smtp.received.length, 0);
      assert.deepEqual((await load(saved.id)).attachmentIds, [id]);
    },
  );
  await t.test(
    'cancel keeps editable files and unknown attachment sends never resend',
    async () => {
      const id = await upload(Buffer.from('do not duplicate'));
      await scan(id);
      const saved = await draft([id]);
      const first = await queue(saved.id, saved.revision);
      assert.equal(first.statusCode, 202);
      assert.equal(
        (await request(`outbox/${first.json().outbox.id}/cancel`, 'POST', {}))
          .statusCode,
        200,
      );
      assert.deepEqual((await load(saved.id)).attachmentIds, [id]);
      const next = await queue(saved.id, saved.revision);
      assert.equal(next.statusCode, 202, next.body);
      smtp.controls.dropAfterData = true;
      await apply();
      assert.equal(
        (
          await pool.query('SELECT state FROM mail_outbox WHERE id=$1', [
            next.json().outbox.id,
          ])
        ).rows[0].state,
        'unknown',
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 1);
      assert.deepEqual((await load(saved.id)).attachmentIds, [id]);
    },
  );
  await t.test(
    'forwarded original files use fenced IMAP fetches, scan independently and survive source deletion',
    async () => {
      imap.server.control.addMessage('INBOX', {
        raw: attachmentMail(),
        flags: [],
        internaldate: new Date(),
      });
      await request(`accounts/${account}/sync`, 'POST', {});
      await syncAccount(pool, keys, owner.id, account);
      const message = (
        await pool.query(
          "SELECT id FROM mail_messages WHERE user_id=$1 AND subject='Attachment mail'",
          [owner.id],
        )
      ).rows[0].id;
      await request(`messages/${message}/content`, 'POST', {});
      const version = (
        await pool.query(
          'SELECT version FROM mail_content WHERE message_id=$1',
          [message],
        )
      ).rows[0].version;
      await fetchMessageContent(pool, keys, {
        userId: owner.id,
        accountId: account,
        messageId: message,
        version,
      });
      const prepared = await request(`messages/${message}/compose`, 'POST', {
        id: randomUUID(),
        kind: 'forward',
      });
      assert.equal(prepared.statusCode, 201, prepared.body);
      const forward = await load(prepared.json().draft.id);
      assert.equal(forward.attachmentIds.length, 2);
      const file = forward.attachmentIds[0];
      await fetchForwardFile(pool, keys, owner.id, account, file, async () => {
        throw new Error('Offline');
      });
      assert.equal(
        (await request(`uploads?ids=${file}`)).json().files[0].state,
        'failed',
      );
      await request(`uploads/${file}/retry`, 'POST', {});
      for (const id of forward.attachmentIds) {
        await fetchForwardFile(pool, keys, owner.id, account, id);
        await scan(id);
      }
      await pool.query('DELETE FROM mail_messages WHERE user_id=$1 AND id=$2', [
        owner.id,
        message,
      ]);
      const saved = await request(`drafts/${forward.id}`, 'PUT', {
        accountId: account,
        content: { ...forward.content, to: 'friend@example.test' },
        revision: forward.revision,
        saveId: randomUUID(),
        attachmentIds: forward.attachmentIds,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.equal(
        (await queue(forward.id, saved.json().draft.revision)).statusCode,
        202,
      );
      await apply();
      const received = await simpleParser(
        smtp.received[0]?.raw ?? Buffer.alloc(0),
      );
      assert.ok(
        received.attachments.some((file) =>
          file.content.equals(attachmentBytes),
        ),
      );
      assert.ok(
        received.attachments.some((file) => file.filename === 'message.eml'),
        JSON.stringify(
          received.attachments.map((file) => ({
            filename: file.filename,
            type: file.contentType,
          })),
        ),
      );
    },
  );
  await t.test(
    'cleanup reclaims abandoned data but preserves linked files, and durable dispatch runs scans',
    async () => {
      const keep = await upload(Buffer.from('keep'));
      await scan(keep);
      await draft([keep]);
      const orphan = await upload(Buffer.from('orphan'));
      await scan(orphan);
      const unfinished = (await reserve(Buffer.from('unfinished'))).json().file
        .id;
      await pool.query(
        "UPDATE mail_uploads SET created_at=clock_timestamp()-interval '2 days',lease_until=clock_timestamp()-interval '1 minute' WHERE user_id=$1",
        [owner.id],
      );
      await cleanupUploads(pool);
      assert.equal(
        (await request(`uploads?ids=${keep}`)).json().files.length,
        1,
      );
      assert.equal(
        (await request(`uploads?ids=${orphan}`)).json().files.length,
        0,
      );
      assert.equal(
        (await request(`uploads?ids=${unfinished}`)).json().files.length,
        0,
      );
      const id = await upload(Buffer.from('durable scan'));
      const previous = {
        host: process.env.CLAMAV_HOST,
        port: process.env.CLAMAV_PORT,
      };
      process.env.CLAMAV_HOST = scanner.env.CLAMAV_HOST;
      process.env.CLAMAV_PORT = scanner.env.CLAMAV_PORT;
      const boss = new PgBoss({ connectionString });
      await boss.start();
      const stop = await startMailWorker(boss, pool, keys);
      try {
        const deadline = Date.now() + 15000;
        while (
          (await request(`uploads?ids=${id}`)).json().files[0].state !== 'ready'
        ) {
          assert.ok(Date.now() < deadline, 'durable scan did not complete');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        stop();
        await boss.stop({ graceful: true });
        if (previous.host === undefined) delete process.env.CLAMAV_HOST;
        else process.env.CLAMAV_HOST = previous.host;
        if (previous.port === undefined) delete process.env.CLAMAV_PORT;
        else process.env.CLAMAV_PORT = previous.port;
      }
    },
  );
});
