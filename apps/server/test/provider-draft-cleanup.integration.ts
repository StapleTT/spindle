import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import {
  cleanupProviderDrafts,
  draftHash,
} from '../src/mail/provider-drafts.js';
import { syncAccount } from '../src/mail/sync.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

// D044: drafts are Spindle-only. Earlier provider copies are removed once,
// only when provably unchanged; everything else stays at the provider.
test('local-only drafts and one-time provider Drafts cleanup', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 60000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString, max: 4 });
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
    'draft-cleanup@example.test',
    '203.0.113.231',
  );
  const request = (path: string, method = 'GET', payload?: object) =>
    app.inject({
      url: `/api/mail/${path}`,
      method: method as 'GET',
      headers: { cookie: owner.cookie, origin: testConfig.appUrl },
      ...(payload ? { payload } : {}),
    });

  async function connect(name: string, plugins: string[]) {
    const imap = await imapFixture(t, true, true, plugins, false, true);
    const result = await request('accounts', 'POST', {
      name,
      host: 'localhost',
      port: imap.port,
      transport: 'tls',
      username: 'testuser',
      password: imapPassword,
      history: 'all',
    });
    assert.equal(result.statusCode, 202, result.body);
    const account = result.json().account.id as string;
    await syncAccount(pool, keys, owner.id, account);
    return { imap, account };
  }
  // Seeds a pre-0040 link with one tracked copy per entry.
  async function seed(
    imap: Awaited<ReturnType<typeof imapFixture>>,
    account: string,
    copies: { state: string; edited?: boolean; byMarker?: boolean }[],
  ) {
    const link = randomUUID();
    await pool.query(
      `INSERT INTO mail_draft_links(id,user_id,account_id,source_draft_id,desired_revision,state,error_code)
       VALUES($1,$2,$3,$4,1,'conflict','draft_changed')`,
      [link, owner.id, account, randomUUID()],
    );
    const validity = String(
      imap.server.control.getMailbox('Drafts').uidvalidity,
    );
    const uids: number[] = [];
    for (const copy of copies) {
      const id = randomUUID();
      const raw = rawMail(
        'Old Spindle copy',
        `${id}@spindle-draft.invalid`,
      ).replace('\r\n\r\n', `\r\nX-Spindle-Operation: ${id}\r\n\r\n`);
      const added = imap.server.control.addMessage('Drafts', {
        raw: copy.edited ? raw.replace('Synthetic', 'Edited elsewhere') : raw,
        flags: ['\\Draft'],
      });
      uids.push(added.uid);
      await pool.query(
        `INSERT INTO mail_draft_copies(id,user_id,link_id,state,path,uid_validity,uid,message_id,marker,hash,size_bytes,revision)
         VALUES($1,$2,$3,$4,'Drafts',$5,$6,$7,$1,$8,$9,1)`,
        [
          id,
          owner.id,
          link,
          copy.state,
          validity,
          copy.byMarker ? null : String(added.uid),
          `<${id}@spindle-draft.invalid>`,
          draftHash(Buffer.from(raw)),
          raw.length,
        ],
      );
    }
    return { link, uids };
  }
  const present = (imap: Awaited<ReturnType<typeof imapFixture>>) =>
    new Set(imap.server.control.listMessages('Drafts').map((m) => m.uid));
  const copyStates = async (link: string) =>
    (
      await pool.query(
        'SELECT state FROM mail_draft_copies WHERE link_id=$1 ORDER BY created_at,id',
        [link],
      )
    ).rows.map((row) => row.state);

  const safe = await connect('Cleanup fixture', ['UIDPLUS', 'CONDSTORE']);
  const unsafe = await connect('No UIDPLUS fixture', []);
  const native = safe.imap.server.control.addMessage('Drafts', {
    raw: rawMail('Written in another client', 'native@example.test'),
    flags: ['\\Draft'],
  });
  const mixed = await seed(safe.imap, safe.account, [
    { state: 'active' },
    { state: 'obsolete', edited: true },
    { state: 'unknown', byMarker: true },
    { state: 'kept' },
  ]);
  const refused = await seed(unsafe.imap, unsafe.account, [
    { state: 'active' },
  ]);

  // Apply 0040's data step to the seeded pre-upgrade rows.
  const migration = await readFile(
    new URL('../drizzle/0040_local_only_drafts.sql', import.meta.url),
    'utf8',
  );
  await pool.query(migration.split('--> statement-breakpoint')[1] ?? '');
  assert.equal(
    (
      await pool.query('SELECT state FROM mail_draft_links WHERE id=$1', [
        mixed.link,
      ])
    ).rows[0].state,
    'pending',
  );

  await cleanupProviderDrafts(pool, keys, owner.id, safe.account);
  await cleanupProviderDrafts(pool, keys, owner.id, unsafe.account);

  const [unchanged, edited, unknown, kept] = mixed.uids;
  const remaining = present(safe.imap);
  assert.ok(!remaining.has(unchanged as number), 'unchanged copy removed');
  assert.ok(
    !remaining.has(unknown as number),
    'unconfirmed copy found by marker and removed',
  );
  assert.ok(remaining.has(edited as number), 'externally edited copy kept');
  assert.ok(remaining.has(kept as number), 'user-kept copy untouched');
  assert.ok(remaining.has(native.uid), 'native draft untouched');
  assert.deepEqual(await copyStates(mixed.link), [
    'removed',
    'kept',
    'removed',
    'kept',
  ]);
  assert.ok(
    present(unsafe.imap).has(refused.uids[0] as number),
    'no UIDPLUS: kept',
  );
  assert.deepEqual(await copyStates(refused.link), ['kept']);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM mail_draft_links WHERE user_id=$1 AND state<>'removed'",
        [owner.id],
      )
    ).rows[0].n,
    0,
  );

  // New drafts stay in Spindle: no provider work is queued and Drafts folders are hidden.
  const saved = await request(`drafts/${randomUUID()}`, 'PUT', {
    revision: 0,
    saveId: randomUUID(),
    accountId: safe.account,
    content: {
      to: 'recipient@example.test',
      cc: '',
      bcc: '',
      subject: 'Local only',
      format: 'plain',
      html: '',
      text: 'Stays here',
    },
  });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(
    (
      await pool.query(
        'SELECT 1 FROM mail_draft_links WHERE source_draft_id=$1',
        [saved.json().draft.id],
      )
    ).rowCount,
    0,
  );
  const boxes = (await request('mailboxes')).json().mailboxes as {
    role: string | null;
  }[];
  assert.ok(boxes.length > 0);
  assert.ok(boxes.every((box) => box.role !== '\\Drafts'));
  assert.equal((await request('draft-sync')).statusCode, 404);
});
