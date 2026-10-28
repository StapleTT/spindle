import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { test } from 'node:test';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { SANITIZER_VERSION } from '../src/mail/sanitize.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';

test('private local search, saved scopes, stable navigation and bounded batch actions', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 45000,
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
      'search-owner@example.test',
      '203.0.113.219',
    ),
    other = await createTestUser(
      app,
      pool,
      testConfig,
      'search-admin@example.test',
      '203.0.113.219',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
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
  async function account(cookie: string, name: string) {
    const response = await request(
      'accounts',
      'POST',
      {
        name,
        host: 'mail.example.test',
        port: 993,
        transport: 'tls',
        username: name,
        password: 'synthetic-only-password',
        history: 'all',
      },
      cookie,
    );
    assert.equal(response.statusCode, 202, response.body);
    return response.json().account.id as string;
  }
  const ownAccount = await account(owner.cookie, 'owner'),
    second = await account(owner.cookie, 'second'),
    foreign = await account(other.cookie, 'other');
  async function box(
    user: string,
    account: string,
    path: string,
    role: string | null,
  ) {
    return (
      await pool.query(
        'INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,$3,$3,$4) RETURNING id',
        [user, account, path, role],
      )
    ).rows[0].id as string;
  }
  const inbox = await box(owner.id, ownAccount, 'INBOX', 'inbox'),
    archive = await box(owner.id, ownAccount, 'Archive', '\\Archive'),
    trash = await box(owner.id, ownAccount, 'Trash', '\\Trash');
  await box(owner.id, second, 'Archive', '\\Archive');
  await box(owner.id, second, 'Trash', '\\Trash');
  const secondInbox = await box(owner.id, second, 'INBOX', 'inbox'),
    foreignInbox = await box(other.id, foreign, 'INBOX', 'inbox');
  let uid = 0;
  async function mail(
    subject: string,
    folder = inbox,
    user = owner.id,
    account = ownAccount,
    flags: string[] = [],
    date = '2026-10-28T12:00:00Z',
  ) {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO mail_messages(id,user_id,account_id,remote_key,message_id,subject,sender,recipients,received_at) VALUES($1::uuid,$2,$3,$1::text,$4,$5,$6,$7,$8)',
      [
        id,
        user,
        account,
        `<${id}@example.test>`,
        subject,
        JSON.stringify([
          { name: 'Alice Example', address: 'alice@example.test' },
        ]),
        {
          to: [{ name: 'Bob Example', address: 'bob@example.test' }],
          cc: [{ name: 'Carbon', address: 'carbon@example.test' }],
        },
        date,
      ],
    );
    await pool.query(
      'INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [user, account, folder, id, '1', ++uid, flags],
    );
    return id;
  }
  const first = await mail('Project launch alpha'),
    tie = await mail('Project launch beta'),
    archived = await mail('Project archived', archive),
    trashed = await mail('Project trashed', trash),
    bodyOnly = await mail('Neutral subject'),
    uncached = await mail('Uncached subject'),
    foreignId = await mail(
      'Private project secret',
      foreignInbox,
      other.id,
      foreign,
    ),
    secondId = await mail('Second project', secondInbox, owner.id, second, [
      '\\Seen',
    ]);
  async function cache(id: string, text: string, attachments: unknown[] = []) {
    await pool.query(
      "INSERT INTO mail_content(user_id,account_id,message_id,state,plain_text,sanitizer_version,attachments) VALUES($1,$2,$3,'ready',$4,$5,$6)",
      [
        owner.id,
        ownAccount,
        id,
        text,
        SANITIZER_VERSION,
        JSON.stringify(attachments),
      ],
    );
  }
  await cache(bodyOnly, 'Body-only lunar phrase with Café text', [
    { filename: 'known.txt' },
  ]);
  await cache(first, 'Project launch details');
  const search = (query: string, extra = '') =>
    request(`messages?q=${encodeURIComponent(query)}${extra}`);
  const ids = (response: { json: () => { messages: { id: string }[] } }) =>
    response.json().messages.map((item) => item.id);
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_request_limits');
  });
  await t.test(
    'word/phrase/field/date/read/attachment filters use only owned local data with honest coverage',
    async () => {
      const lookup = t.mock.method(dns, 'lookup', async () => {
        throw new Error('Search attempted provider DNS');
      });
      const all = await search('project');
      assert.equal(all.statusCode, 200, all.body);
      assert.equal(all.json().coverage.messages, 6);
      assert.equal(all.json().coverage.cachedBodies, 2);
      assert.deepEqual(
        new Set(ids(all)),
        new Set([first, tie, archived, secondId]),
      );
      assert.ok(!ids(all).includes(trashed));
      assert.ok(!ids(all).includes(foreignId));
      assert.deepEqual(ids(await search('body:"lunar phrase"')), [bodyOnly]);
      assert.deepEqual(ids(await search('lunar')), [bodyOnly]);
      assert.equal(ids(await search('"launch alpha"')).length, 1);
      assert.equal(
        ids(await search('from:alice to:bob subject:project')).length,
        4,
      );
      assert.equal(ids(await search('to:carbon')).length, 0);
      assert.equal(ids(await search('subject:address')).length, 0);
      assert.equal(ids(await search('project is:read')).length, 1);
      assert.equal(ids(await search('project is:unread')).length, 3);
      assert.deepEqual(ids(await search('has:attachment')), [bodyOnly]);
      assert.equal(ids(await search('after:2026-10-29')).length, 0);
      assert.equal(ids(await search('before:2026-10-29')).length, 6);
      assert.deepEqual(ids(await search('in:trash project')), [trashed]);
      assert.equal(ids(await search('in:anywhere project')).length, 5);
      assert.equal(ids(await search('-subject:project body:lunar')).length, 1);
      assert.equal(
        ids(await search('project', `&account=${second}`)).length,
        1,
      );
      assert.deepEqual(ids(await search('project', `&mailbox=${archive}`)), [
        archived,
      ]);
      assert.equal(lookup.mock.callCount(), 0);
      t.mock.restoreAll();
    },
  );
  await t.test(
    'expired or stale body caches are excluded and cache removal changes search coverage without losing headers',
    async () => {
      await pool.query(
        "UPDATE mail_content SET expires_at=clock_timestamp()-interval '1 second' WHERE message_id=$1",
        [bodyOnly],
      );
      assert.equal(ids(await search('lunar')).length, 0);
      assert.equal((await search('Neutral')).json().coverage.cachedBodies, 1);
      assert.deepEqual(ids(await search('Neutral')), [bodyOnly]);
      await pool.query(
        "UPDATE mail_content SET expires_at=clock_timestamp()+interval '1 day',sanitizer_version=0 WHERE message_id=$1",
        [bodyOnly],
      );
      assert.equal(ids(await search('lunar')).length, 0);
      await pool.query(
        'UPDATE mail_content SET sanitizer_version=$2 WHERE message_id=$1',
        [bodyOnly, SANITIZER_VERSION],
      );
      assert.equal(ids(await search('lunar')).length, 1);
      await pool.query(
        'UPDATE mail_content SET plain_text=$2 WHERE message_id=$1',
        [bodyOnly, `lunar ${'padding '.repeat(13000)}outsideprefix`],
      );
      assert.deepEqual(ids(await search('body:lunar')), [bodyOnly]);
      assert.equal(ids(await search('body:outsideprefix')).length, 0);
    },
  );
  await t.test(
    'search navigation uses the same filters and tied-date cursors are bound to owner/query/scope',
    async () => {
      const response = await search('subject:launch', '&limit=1');
      assert.equal(response.statusCode, 200, response.body);
      const page = response.json();
      assert.ok(page.nextCursor);
      const next = await search(
        'subject:launch',
        `&limit=1&cursor=${page.nextCursor}`,
      );
      assert.equal(next.statusCode, 200, next.body);
      assert.notEqual(ids(next)[0], ids(response)[0]);
      assert.equal(next.json().nextCursor, null);
      assert.equal(
        (await search('different', `&cursor=${page.nextCursor}`)).statusCode,
        400,
      );
      assert.equal(
        (
          await search(
            'subject:launch',
            `&account=${second}&cursor=${page.nextCursor}`,
          )
        ).statusCode,
        400,
      );
      const detail = await request(
        `messages/${ids(response)[0]}?q=subject:launch`,
      );
      assert.equal(detail.statusCode, 200, detail.body);
      assert.equal(detail.json().next, ids(next)[0]);
      assert.equal(detail.json().previous, null);
      assert.equal(
        (await request(`messages/${uncached}?q=subject:launch`)).statusCode,
        404,
      );
    },
  );
  await t.test(
    'anonymous, unverified, foreign-admin and malformed search scopes cannot disclose mail',
    async () => {
      assert.equal(
        (await request('messages?q=private', 'GET', undefined, '')).statusCode,
        401,
      );
      assert.equal(
        (
          await request(
            `messages?q=project&account=${ownAccount}`,
            'GET',
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            `messages?q=project&mailbox=${inbox}`,
            'GET',
            undefined,
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.ok(
        !ids(
          await request('messages?q=project', 'GET', undefined, other.cookie),
        ).includes(first),
      );
      for (const query of [
        'from:',
        'unknown:value',
        '"unclosed',
        'before:2026-02-30',
        'in:trash in:sent',
      ])
        assert.equal((await search(query)).statusCode, 400, query);
      assert.equal((await search("'; DROP TABLE users; --")).statusCode, 200);
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        other.id,
      ]);
      assert.equal(
        (await request('messages?q=project', 'GET', undefined, other.cookie))
          .statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        other.id,
      ]);
    },
  );
  await t.test(
    'saved searches are owned, replay-safe and cannot refer to foreign accounts or mismatched folders',
    async () => {
      const id = randomUUID(),
        body = {
          name: 'Project launches',
          query: 'subject:launch',
          accountId: ownAccount,
          mailboxId: inbox,
        };
      assert.equal(
        (
          await request(
            `searches/${id}`,
            'PUT',
            body,
            owner.cookie,
            'https://evil.test',
          )
        ).statusCode,
        403,
      );
      assert.equal(
        (await request(`searches/${id}`, 'PUT', body, other.cookie)).statusCode,
        404,
      );
      assert.equal(
        (await request(`searches/${id}`, 'PUT', body)).statusCode,
        200,
      );
      assert.equal(
        (await request(`searches/${id}`, 'PUT', body)).statusCode,
        200,
      );
      assert.equal((await request('searches')).json().searches.length, 1);
      assert.equal(
        (await request('searches', 'GET', undefined, other.cookie)).json()
          .searches.length,
        0,
      );
      assert.equal(
        (
          await request(`searches/${randomUUID()}`, 'PUT', {
            ...body,
            name: 'Bad',
            accountId: second,
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await request(`searches/${id}`, 'DELETE', undefined, other.cookie))
          .statusCode,
        404,
      );
      assert.equal((await request(`searches/${id}`, 'DELETE')).statusCode, 200);
    },
  );
  await t.test(
    'saved view quotas serialize concurrent saves and removed scopes cannot broaden a saved query',
    async () => {
      const folder = await box(owner.id, ownAccount, 'Saved-only', null);
      const scoped = randomUUID();
      assert.equal(
        (
          await request(`searches/${scoped}`, 'PUT', {
            name: 'Scoped',
            query: 'project',
            accountId: ownAccount,
            mailboxId: folder,
          })
        ).statusCode,
        200,
      );
      await pool.query('DELETE FROM mailboxes WHERE user_id=$1 AND id=$2', [
        owner.id,
        folder,
      ]);
      assert.equal((await request('searches')).json().searches.length, 0);
      await pool.query(
        "INSERT INTO mail_saved_searches(id,user_id,name,query) SELECT gen_random_uuid(),$1,'Saved '||n,'project' FROM generate_series(1,49) n",
        [owner.id],
      );
      const responses = await Promise.all(
        ['Fifty', 'Fifty one'].map((name) =>
          request(`searches/${randomUUID()}`, 'PUT', {
            name,
            query: 'project',
            accountId: null,
            mailboxId: null,
          }),
        ),
      );
      assert.deepEqual(
        responses.map((response) => response.statusCode).sort(),
        [200, 409],
      );
      assert.equal((await request('searches')).json().searches.length, 50);
      await pool.query('DELETE FROM mail_saved_searches WHERE user_id=$1', [
        owner.id,
      ]);
    },
  );
  await t.test(
    'batch actions persist individual outcomes, replay without duplicate intent, retain undo, and reject foreign messages',
    async () => {
      const payload = {
        kind: 'archive',
        items: [
          { id: randomUUID(), messageId: first },
          { id: randomUUID(), messageId: secondId },
          { id: randomUUID(), messageId: foreignId },
        ],
      };
      assert.equal(
        (
          await request(
            'batch-actions',
            'POST',
            payload,
            owner.cookie,
            'https://evil.test',
          )
        ).statusCode,
        403,
      );
      const response = await request('batch-actions', 'POST', payload);
      assert.equal(response.statusCode, 202, response.body);
      const results = response.json().results;
      assert.equal(
        results.filter((item: { action?: object }) => item.action).length,
        2,
      );
      assert.equal(
        results.filter((item: { error?: string }) => item.error).length,
        1,
      );
      assert.equal(
        (await request('batch-actions', 'POST', payload)).statusCode,
        202,
      );
      assert.ok(
        (await request('batch-actions', 'POST', { ...payload, kind: 'read' }))
          .json()
          .results.every((item: { error?: string }) => !!item.error),
      );
      assert.equal(
        (
          await pool.query('SELECT 1 FROM mail_actions WHERE user_id=$1', [
            owner.id,
          ])
        ).rowCount,
        2,
      );
      assert.equal(
        ids(await search('subject:launch in:inbox')).includes(first),
        false,
      );
      const status = (await request('actions')).json().actions;
      assert.equal(status.length, 2);
      assert.ok(status.every((item: { undoMs: number }) => item.undoMs > 0));
      const undone = await request(
        `actions/${payload.items[0]?.id}/undo`,
        'POST',
        {},
      );
      assert.equal(undone.statusCode, 200, undone.body);
      assert.equal(
        (
          await request('batch-actions', 'POST', {
            kind: 'read',
            items: Array.from({ length: 51 }, () => ({
              id: randomUUID(),
              messageId: tie,
            })),
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await request('batch-actions', 'POST', {
            kind: 'read',
            items: [
              { id: randomUUID(), messageId: tie },
              { id: randomUUID(), messageId: tie },
            ],
          })
        ).statusCode,
        400,
      );
    },
  );
  await t.test(
    'a batch consumes the per-message action budget and reports partial refusal without losing accepted intents',
    async () => {
      await pool.query(
        "INSERT INTO mail_request_limits(user_id,action,window_start,count) VALUES($1,'reader',clock_timestamp(),59)",
        [owner.id],
      );
      const response = await request('batch-actions', 'POST', {
        kind: 'read',
        items: [tie, uncached].map((messageId) => ({
          id: randomUUID(),
          messageId,
        })),
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(
        response
          .json()
          .results.filter((item: { action?: object }) => item.action).length,
        1,
      );
      assert.equal(
        response.json().results.filter((item: { error?: string }) => item.error)
          .length,
        1,
      );
    },
  );
});
