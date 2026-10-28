import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { scanFile } from '../src/mail/file-scanner.js';
import { scanUpload } from '../src/mail/file-worker.js';
import { connectImap } from '../src/mail/imap.js';
import { processOutgoing } from '../src/mail/outgoing-worker.js';
import { syncProviderDrafts } from '../src/mail/provider-drafts.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';
import { scannerFixture } from './scanner-fixture.js';
import { smtpFixture, smtpPassword } from './smtp-fixture.js';

test('owned provider Drafts synchronization and recovery', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 120000,
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
      v1: Buffer.alloc(32, 57).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'provider-owner@example.test',
    '203.0.113.217',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'provider-admin@example.test',
    '203.0.113.217',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const imap = await imapFixture(
    t,
    true,
    true,
    ['UIDPLUS', 'CONDSTORE'],
    true,
    true,
  );
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
    name: 'Draft sync fixture',
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
  const content = {
    to: 'recipient@example.test',
    cc: 'copy@example.test',
    bcc: 'hidden@example.test',
    subject: 'Synchronized café',
    format: 'rich',
    html: '<p>Hello <strong>draft</strong></p>',
    text: '',
  };
  async function save(id = randomUUID(), revision = 0, patch = {}) {
    const result = await request(`drafts/${id}`, 'PUT', {
      revision,
      saveId: randomUUID(),
      accountId: account,
      content: { ...content, ...patch },
    });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().draft;
  }
  const link = async (id: string) =>
    (
      await pool.query(
        'SELECT * FROM mail_draft_links WHERE user_id=$1 AND source_draft_id=$2',
        [owner.id, id],
      )
    ).rows[0];
  const copy = async (id: string) =>
    (
      await pool.query(
        'SELECT c.* FROM mail_draft_copies c JOIN mail_draft_links l ON l.user_id=c.user_id AND l.id=c.link_id WHERE l.source_draft_id=$1 AND c.id=l.active_copy_id',
        [id],
      )
    ).rows[0];
  async function sync(connect?: typeof connectImap) {
    await pool.query(
      'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
      [owner.id],
    );
    await syncProviderDrafts(pool, keys, owner.id, account, connect);
  }
  async function replace(id: string, subject: string) {
    const remote = await copy(id);
    const old = imap.server.control.getMessage(
      'Drafts',
      Number(remote.uid),
    ).raw;
    assert.ok(old);
    imap.server.control.expungeMessages('Drafts', [Number(remote.uid)]);
    return imap.server.control.addMessage('Drafts', {
      raw: old.toString().replace(/^Subject:.*$/m, `Subject: ${subject}\r`),
      flags: ['\\Draft'],
    });
  }
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_outbox');
    await pool.query('DELETE FROM mail_drafts');
    await pool.query('DELETE FROM mail_draft_links');
    await pool.query('DELETE FROM mail_draft_imports');
    await pool.query('DELETE FROM mail_request_limits');
    const messages = imap.server.control.listMessages('Drafts');
    if (messages.length)
      imap.server.control.expungeMessages(
        'Drafts',
        messages.map((m) => m.uid),
      );
  });
  await t.test(
    'mirrors partial recipients and Bcc, replaces only its prior copy, and cleans up discard',
    async () => {
      const draft = await save(undefined, 0, { to: 'Unfinished <' });
      await sync();
      assert.equal(
        (await link(draft.id)).state,
        'synced',
        JSON.stringify(await link(draft.id)),
      );
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
      const first = await copy(draft.id);
      const raw = imap.server.control.getMessage(
        'Drafts',
        Number(first.uid),
      ).raw;
      assert.ok(raw);
      assert.equal((await simpleParser(raw)).bcc && true, true);
      const unrelated = imap.server.control.addMessage('Drafts', {
        raw: rawMail('Unrelated deleted'),
        flags: ['\\Deleted'],
      });
      await save(draft.id, 1, { subject: 'New revision' });
      await sync();
      assert.equal((await link(draft.id)).synced_revision, 2);
      assert.equal(imap.server.control.listMessages('Drafts').length, 2);
      assert.ok(imap.server.control.getMessage('Drafts', unrelated.uid));
      const discarded = await request(`drafts/${draft.id}`, 'DELETE', {
        revision: 2,
      });
      assert.equal(discarded.statusCode, 200, discarded.body);
      await sync();
      assert.equal((await link(draft.id)).state, 'removed');
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
    },
  );
  await t.test(
    'discard cleanup treats a provider copy already removed elsewhere as complete',
    async () => {
      const draft = await save();
      await sync();
      const remote = await copy(draft.id);
      await request(`drafts/${draft.id}`, 'DELETE', { revision: 1 });
      imap.server.control.expungeMessages('Drafts', [Number(remote.uid)]);
      await sync();
      assert.equal((await link(draft.id)).state, 'removed');
      assert.equal((await request('draft-sync')).json().issues.length, 0);
    },
  );
  await t.test(
    'pulls external edits and rejects the stale editor revision',
    async () => {
      const draft = await save();
      await sync();
      await replace(draft.id, 'Native revision');
      await sync();
      const loaded = (await request(`drafts/${draft.id}`)).json().draft;
      assert.equal(loaded.content.subject, 'Native revision');
      assert.equal(loaded.revision, 2);
      assert.equal((await link(draft.id)).state, 'synced');
      const stale = await request(`drafts/${draft.id}`, 'PUT', {
        revision: 1,
        saveId: randomUUID(),
        accountId: account,
        content,
      });
      assert.equal(stale.statusCode, 409);
    },
  );
  await t.test(
    'preserves both edited versions, owns resolution and explicitly adopts provider',
    async () => {
      const draft = await save();
      await sync();
      await save(draft.id, 1, { subject: 'Local revision' });
      await replace(draft.id, 'Native conflict');
      await sync();
      const current = await link(draft.id);
      assert.equal(current.state, 'conflict');
      assert.equal(
        (await request(`drafts/${draft.id}`)).json().draft.content.subject,
        'Local revision',
      );
      assert.equal(
        (await request(`draft-sync/${current.id}/version`)).json().subject,
        'Native conflict',
      );
      assert.equal(
        (
          await request(
            `draft-sync/${current.id}/version`,
            'GET',
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (await request('draft-sync', 'GET', undefined, other.cookie)).json()
          .issues.length,
        0,
      );
      assert.equal(
        (
          await request(
            `draft-sync/${current.id}`,
            'POST',
            { action: 'useProvider', revision: 2 },
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            `draft-sync/${current.id}`,
            'POST',
            { action: 'useProvider', revision: 2 },
            owner.cookie,
            'https://evil.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await request(`draft-sync/${current.id}`, 'POST', {
            action: 'useProvider',
            revision: 1,
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await request(`draft-sync/${current.id}`, 'POST', {
            action: 'useProvider',
            revision: 2,
          })
        ).statusCode,
        200,
      );
      await sync();
      assert.equal(
        (await request(`drafts/${draft.id}`)).json().draft.content.subject,
        'Native conflict',
      );
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
    },
  );
  await t.test(
    'keep-local publishes a separate copy without deleting external edits',
    async () => {
      const draft = await save();
      await sync();
      await save(draft.id, 1, { subject: 'Keep this local' });
      await replace(draft.id, 'Keep this native');
      await sync();
      const current = await link(draft.id);
      assert.equal(
        (
          await request(`draft-sync/${current.id}`, 'POST', {
            action: 'keepLocal',
            revision: 2,
          })
        ).statusCode,
        200,
      );
      await sync();
      assert.equal((await link(draft.id)).state, 'synced');
      assert.equal(imap.server.control.listMessages('Drafts').length, 2);
    },
  );
  await t.test(
    'remote deletion becomes a persistent conflict and is not recreated',
    async () => {
      const draft = await save();
      await sync();
      const remote = await copy(draft.id);
      imap.server.control.expungeMessages('Drafts', [Number(remote.uid)]);
      await sync();
      await sync();
      assert.equal((await link(draft.id)).error_code, 'draft_removed');
      assert.equal(imap.server.control.listMessages('Drafts').length, 0);
      assert.equal((await request('draft-sync')).json().issues.length, 1);
    },
  );
  await t.test(
    'lost APPEND acknowledgment is recovered without another APPEND',
    async () => {
      const draft = await save();
      let appends = 0;
      await sync(async (...args) => {
        const client = await connectImap(...args);
        const append = client.append.bind(client);
        client.append = async (...values) => {
          appends++;
          await append(...values);
          throw new Error('Lost acknowledgment');
        };
        return client;
      });
      assert.equal((await link(draft.id)).state, 'unknown');
      const current = await link(draft.id);
      assert.equal(
        (await request(`draft-sync/${current.id}`, 'POST', { action: 'retry' }))
          .statusCode,
        200,
      );
      await sync();
      assert.equal((await link(draft.id)).state, 'synced');
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
      assert.equal(appends, 1);
    },
  );
  await t.test(
    'a crash before APPEND remains uncertain and retries only search',
    async () => {
      const draft = await save();
      await sync(async (...args) => {
        const client = await connectImap(...args);
        client.append = async () => {
          throw new Error('Interrupted before write');
        };
        return client;
      });
      const current = await link(draft.id);
      assert.equal(current.state, 'unknown');
      await request(`draft-sync/${current.id}`, 'POST', { action: 'retry' });
      await sync();
      assert.equal((await link(draft.id)).state, 'unknown');
      assert.equal(imap.server.control.listMessages('Drafts').length, 0);
    },
  );
  await t.test(
    'cleanup conflicts stay visible after the local draft is discarded',
    async () => {
      const draft = await save();
      await sync();
      await replace(draft.id, 'Edited elsewhere');
      assert.equal(
        (await request(`drafts/${draft.id}`, 'DELETE', { revision: 1 }))
          .statusCode,
        200,
      );
      await sync();
      const current = await link(draft.id);
      assert.equal(current.state, 'conflict');
      const issues = (await request('draft-sync')).json().issues;
      assert.equal(issues[0].draftId, null);
      assert.equal(
        (
          await request(`draft-sync/${current.id}`, 'POST', {
            action: 'leaveProvider',
          })
        ).statusCode,
        200,
      );
      assert.equal((await request('draft-sync')).json().issues.length, 0);
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
    },
  );
  await t.test(
    'autosave during APPEND queues the newer revision and discard during APPEND still cleans the copy',
    async () => {
      const draft = await save();
      await sync(async (...args) => {
        const client = await connectImap(...args);
        const append = client.append.bind(client);
        client.append = async (...values) => {
          const result = await append(...values);
          await save(draft.id, 1, { subject: 'Changed while uploading' });
          return result;
        };
        return client;
      });
      assert.equal((await link(draft.id)).state, 'pending');
      assert.equal((await link(draft.id)).synced_revision, 1);
      await sync();
      assert.equal((await link(draft.id)).synced_revision, 2);
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
      const discarded = await save();
      await sync(async (...args) => {
        const client = await connectImap(...args);
        const append = client.append.bind(client);
        client.append = async (...values) => {
          const result = await append(...values);
          assert.equal(
            (await request(`drafts/${discarded.id}`, 'DELETE', { revision: 1 }))
              .statusCode,
            200,
          );
          return result;
        };
        return client;
      });
      await sync();
      assert.equal((await link(discarded.id)).state, 'removed');
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
    },
  );
  await t.test(
    'UIDVALIDITY reset reconciles by identity without duplicating the draft',
    async () => {
      const draft = await save();
      await sync();
      imap.server.control.resetUidValidity('Drafts', {
        uidvalidity: 123,
        uids: 'renumber',
      });
      await sync();
      assert.equal((await link(draft.id)).state, 'synced');
      assert.equal((await copy(draft.id)).uid_validity, '123');
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
    },
  );
  await t.test(
    'servers without UIDPLUS keep the original instead of broadly expunging or accumulating replacements',
    async () => {
      const draft = await save();
      await sync();
      await save(draft.id, 1, { subject: 'Cannot replace safely' });
      await sync(async (...args) => {
        const client = await connectImap(...args);
        client.capabilities.delete('UIDPLUS');
        client.capabilities.set('IMAP4rev2', true);
        return client;
      });
      assert.equal(
        (await link(draft.id)).error_code,
        'safe_delete_unavailable',
      );
      assert.equal(imap.server.control.listMessages('Drafts').length, 1);
    },
  );
  await t.test(
    'missing designated Drafts folder leaves the saved local content available',
    async () => {
      const draft = await save();
      await sync(async (...args) => {
        const client = await connectImap(...args);
        client.list = async () => [];
        return client;
      });
      assert.equal(
        (await link(draft.id)).error_code,
        'drafts_folder_unavailable',
      );
      assert.equal(
        (await request(`drafts/${draft.id}`)).json().draft.content.subject,
        content.subject,
      );
      assert.equal(imap.server.control.listMessages('Drafts').length, 0);
    },
  );
  await t.test(
    'lease fencing refuses provider writes after account claim is lost',
    async () => {
      const draft = await save();
      await sync(async (...args) => {
        const client = await connectImap(...args);
        await pool.query(
          "UPDATE mail_accounts SET lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1",
          [account],
        );
        return client;
      });
      assert.equal(imap.server.control.listMessages('Drafts').length, 0);
      assert.equal((await link(draft.id)).synced_revision, 0);
      await pool.query(
        'UPDATE mail_accounts SET lease_until=NULL,lease_token=NULL WHERE id=$1',
        [account],
      );
    },
  );
  await t.test(
    'removing the selected account cleans its old provider copy while preserving the local draft',
    async () => {
      const draft = await save();
      await sync();
      const changed = await request(`drafts/${draft.id}`, 'PUT', {
        revision: 1,
        saveId: randomUUID(),
        accountId: null,
        content,
      });
      assert.equal(changed.statusCode, 200, changed.body);
      await sync();
      assert.equal((await link(draft.id)).state, 'removed');
      assert.equal(imap.server.control.listMessages('Drafts').length, 0);
      assert.equal(
        (await request(`drafts/${draft.id}`)).json().draft.accountId,
        null,
      );
    },
  );
  await t.test(
    'imports native Bcc and file bytes through quarantine, reuses unchanged files, and mirrors edits only after scanning',
    async () => {
      const compiled = new MailComposer({
        to: 'recipient@example.test',
        bcc: 'hidden@example.test',
        subject: 'Native attachment',
        text: 'Native body',
        attachments: [
          {
            filename: 'native.txt',
            content: Buffer.from('Native exact bytes'),
          },
        ],
      }).compile();
      compiled.keepBcc = true;
      const native = imap.server.control.addMessage('Drafts', {
        raw: await compiled.build(),
        flags: ['\\Draft'],
      });
      const validity = imap.server.control.getMailbox('Drafts').uidvalidity;
      await pool.query(
        'INSERT INTO mail_draft_imports(user_id,account_id,path,uid_validity,uid,subject) VALUES($1,$2,$3,$4,$5,$6)',
        [
          owner.id,
          account,
          'Drafts',
          String(validity),
          String(native.uid),
          'Native attachment',
        ],
      );
      await sync();
      const drafts = (await request('drafts')).json().drafts;
      assert.equal(drafts.length, 1);
      let draft = (await request(`drafts/${drafts[0].id}`)).json().draft;
      assert.match(draft.content.bcc, /hidden@example.test/);
      const file = draft.attachmentIds[0];
      assert.ok(file);
      assert.equal(
        (await pool.query('SELECT state FROM mail_uploads WHERE id=$1', [file]))
          .rows[0].state,
        'pending_scan',
      );
      await save(draft.id, 1, {
        subject: 'Edited imported file',
        format: 'plain',
        html: '',
        text: 'Edited body',
      });
      await sync();
      assert.equal((await link(draft.id)).state, 'waiting');
      const scanner = await scannerFixture(t);
      await scanUpload(pool, owner.id, file, (source) =>
        scanFile(source, scanner.env),
      );
      assert.equal(scanner.received[0]?.toString(), 'Native exact bytes');
      await sync();
      assert.equal((await link(draft.id)).state, 'synced');
      const remote = await copy(draft.id);
      const raw = imap.server.control.getMessage(
        'Drafts',
        Number(remote.uid),
      ).raw;
      assert.ok(raw);
      assert.equal(
        (await simpleParser(raw)).attachments[0]?.content.toString(),
        'Native exact bytes',
      );
      await replace(draft.id, 'Native file edit');
      await sync();
      draft = (await request(`drafts/${draft.id}`)).json().draft;
      assert.deepEqual(draft.attachmentIds, [file]);
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM mail_uploads WHERE id=$1',
            [file],
          )
        ).rows[0].n,
        1,
      );
    },
  );
  await t.test(
    'SMTP checks outside changes before delivery, retains unknown outcomes and cleans accepted drafts',
    async () => {
      const smtp = await smtpFixture(t, imap.server);
      const settings = await request(`accounts/${account}/smtp`, 'PUT', {
        host: 'localhost',
        port: smtp.port,
        transport: 'tls',
        username: 'writer@example.test',
        password: smtpPassword,
        saveSentCopy: false,
      });
      assert.equal(settings.statusCode, 202, settings.body);
      await processOutgoing(pool, keys, owner.id, account);
      const draft = await save();
      await sync();
      const queued = await request(`drafts/${draft.id}/send`, 'POST', {
        id: randomUUID(),
        revision: 1,
      });
      assert.equal(queued.statusCode, 202, queued.body);
      await replace(draft.id, 'Native edit before SMTP');
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(smtp.received.length, 0);
      assert.equal(
        (
          await pool.query('SELECT state FROM mail_outbox WHERE id=$1', [
            queued.json().outbox.id,
          ])
        ).rows[0].state,
        'failed',
      );
      assert.equal((await link(draft.id)).state, 'conflict');
      const next = await save();
      await sync();
      smtp.controls.dropAfterData = true;
      const unknown = await request(`drafts/${next.id}/send`, 'POST', {
        id: randomUUID(),
        revision: 1,
      });
      assert.equal(unknown.statusCode, 202, unknown.body);
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(
        (
          await pool.query('SELECT state FROM mail_outbox WHERE id=$1', [
            unknown.json().outbox.id,
          ])
        ).rows[0].state,
        'unknown',
      );
      await sync();
      assert.equal((await link(next.id)).state, 'synced');
      assert.equal((await request(`drafts/${next.id}`)).statusCode, 200);
      smtp.controls.dropAfterData = false;
      const sent = await save();
      await sync();
      const accepted = await request(`drafts/${sent.id}/send`, 'POST', {
        id: randomUUID(),
        revision: 1,
      });
      assert.equal(accepted.statusCode, 202, accepted.body);
      await pool.query(
        'UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1',
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
      assert.equal(
        (
          await pool.query('SELECT state FROM mail_outbox WHERE id=$1', [
            accepted.json().outbox.id,
          ])
        ).rows[0].state,
        'accepted',
      );
      assert.equal((await request(`drafts/${sent.id}`)).statusCode, 404);
      await sync();
      assert.equal((await link(sent.id)).state, 'removed');
      await pool.query('DELETE FROM mail_smtp WHERE user_id=$1', [owner.id]);
    },
  );
  await t.test(
    'durable dispatcher imports native drafts from synchronized local metadata and mirrors persisted saves',
    async () => {
      const draft = await save();
      imap.server.control.addMessage('Drafts', {
        raw: rawMail('Native worker draft', 'native-worker@example.test'),
        flags: ['\\Draft'],
        internaldate: new Date(),
      });
      await pool.query(
        "UPDATE mailboxes SET last_synced_at=clock_timestamp()-interval '2 minutes' WHERE account_id=$1",
        [account],
      );
      await syncAccount(pool, keys, owner.id, account);
      await pool.query(
        "UPDATE mail_accounts SET next_sync_at=clock_timestamp()+interval '1 day'",
      );
      await pool.query(
        'UPDATE mail_draft_links SET next_attempt_at=clock_timestamp()',
      );
      const boss = new PgBoss({ connectionString });
      const errors: unknown[] = [];
      boss.on('error', (error) => errors.push(error));
      let stop: (() => void) | undefined;
      try {
        await boss.start();
        stop = await startMailWorker(boss, pool, keys);
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const imported = (
            await pool.query(
              "SELECT id FROM mail_drafts WHERE user_id=$1 AND content->>'subject'='Native worker draft'",
              [owner.id],
            )
          ).rowCount;
          if (imported && (await link(draft.id)).state === 'synced') break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.equal((await link(draft.id)).state, 'synced');
        const imported = (
          await pool.query(
            "SELECT id FROM mail_drafts WHERE user_id=$1 AND content->>'subject'='Native worker draft'",
            [owner.id],
          )
        ).rows;
        assert.equal(imported.length, 1);
        assert.equal(imap.server.control.listMessages('Drafts').length, 2);
        assert.deepEqual(errors, []);
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
    },
  );
});
