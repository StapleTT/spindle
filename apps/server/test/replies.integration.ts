import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { Pool } from 'pg';
import { migrateDatabase } from '../src/db/migrate.js';
import { readContentConfig } from '../src/mail/content-config.js';
import { buildContentApp } from '../src/mail/content-server.js';
import { fetchMessageContent } from '../src/mail/content-worker.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { signContentGrant } from '../src/mail/grants.js';
import { connectImap } from '../src/mail/imap.js';
import { processOutgoing } from '../src/mail/outgoing-worker.js';
import { syncAccount } from '../src/mail/sync.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword } from './imap-fixture.js';
import {
  attachmentMail,
  newsletterHtml,
  readerMail,
  tinyPng,
} from './reader-fixture.js';
import { replyMail } from './reply-fixture.js';
import { smtpFixture, smtpPassword } from './smtp-fixture.js';

test('owned replies, safe forward drafts and durable SMTP threading', {
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
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 55).toString('base64'),
    }),
  });
  const contentConfig = readContentConfig(testConfig, {});
  assert.ok(contentConfig);
  let imageCalls = 0;
  let imageHook: (() => Promise<void>) | null = null;
  const contentApp = buildContentApp(pool, contentConfig, async () => {
    imageCalls++;
    await imageHook?.();
    return { type: 'image/png', data: tinyPng };
  });
  contentApp.log.level = 'silent';
  t.after(() => contentApp.close());
  const app = testApp(pool, testConfig, undefined, keys, contentConfig);
  t.after(() => app.close());
  const owner = await createTestUser(
      app,
      pool,
      testConfig,
      'login@example.test',
      '203.0.113.216',
    ),
    other = await createTestUser(
      app,
      pool,
      testConfig,
      'reply-admin@example.test',
      '203.0.113.216',
    );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const imap = await imapFixture(t, true, true, [], true),
    smtp = await smtpFixture(t, imap.server);
  const inputs = [
    replyMail(),
    replyMail({
      subject: 'Own sent message',
      from: 'Writer <writer@example.test>',
      to: 'friend@example.test, alias@example.test',
      cc: 'copy@example.test',
      replyTo: null,
    }),
    replyMail({ subject: 'Invalid Reply-To', replyTo: 'not-an-address' }),
    replyMail({ subject: 'Missing message identity', messageId: null }),
    replyMail({ subject: 'HTML only message', htmlOnly: true }),
    replyMail({ subject: 'Large quoted body', plain: '😀'.repeat(20000) }),
    replyMail({
      subject: 'Too many recipients',
      to: Array.from(
        { length: 61 },
        (_, index) => `friend${index}@example.test`,
      ).join(', '),
    }),
    attachmentMail(),
    readerMail(
      'Styled original',
      newsletterHtml(1),
      'Complete original plain alternative.',
    ),
    readerMail(
      'Oversized formatted original',
      `<table><tr><td>${'x'.repeat(600000)}</td></tr></table>`,
      'Large newsletter.',
    ),
  ];
  for (const raw of inputs)
    imap.server.control.addMessage('INBOX', {
      raw,
      flags: [],
      internaldate: new Date('2026-10-28T12:00:00Z'),
    });
  function request(
    path: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) {
    return app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { origin, cookie },
      ...(payload ? { payload } : {}),
    });
  }
  const accountBody = {
    name: 'Reply account',
    host: 'localhost',
    port: imap.port,
    transport: 'tls',
    username: 'testuser',
    password: imapPassword,
    history: 'all',
  };
  const account = (await request('accounts', 'POST', accountBody)).json()
    .account.id;
  await request('accounts', 'POST', {
    ...accountBody,
    name: 'Known receiving alias',
    host: 'mail.example.test',
    username: 'alias@example.test',
  });
  const foreign = (
    await request('accounts', 'POST', accountBody, other.cookie)
  ).json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  await syncAccount(pool, keys, other.id, foreign);
  await request(`accounts/${account}/smtp`, 'PUT', {
    host: 'localhost',
    port: smtp.port,
    transport: 'tls',
    username: 'writer@example.test',
    password: smtpPassword,
  });
  await processOutgoing(pool, keys, owner.id, account);
  const idOf = async (subject: string, user = owner.id) =>
    (
      await pool.query(
        'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
        [user, subject],
      )
    ).rows[0].id as string;
  const source = await idOf('Project question');
  const cache = async (id: string) => {
    const requested = await request(`messages/${id}/content`, 'POST', {});
    assert.equal(requested.statusCode, 202, requested.body);
    const version = (
      await pool.query(
        'SELECT version FROM mail_content WHERE user_id=$1 AND message_id=$2',
        [owner.id, id],
      )
    ).rows[0].version;
    await fetchMessageContent(pool, keys, {
      userId: owner.id,
      accountId: account,
      messageId: id,
      version,
    });
    assert.equal(
      (await request(`messages/${id}`)).json().content.state,
      'ready',
    );
    return version;
  };
  const compose = (
    id: string,
    kind: string,
    operation = randomUUID(),
    cookie = owner.cookie,
  ) =>
    request(`messages/${id}/compose`, 'POST', { id: operation, kind }, cookie);
  const load = async (id: string) =>
    (await request(`drafts/${id}`)).json().draft;
  const prepare = async (subject: string, kind: string) => {
    const id = await idOf(subject);
    if (
      !(
        await pool.query(
          "SELECT 1 FROM mail_content WHERE user_id=$1 AND message_id=$2 AND state='ready'",
          [owner.id, id],
        )
      ).rowCount
    )
      await cache(id);
    const result = await compose(id, kind);
    assert.equal(result.statusCode, 201, result.body);
    return load(result.json().draft.id);
  };
  t.beforeEach(async () => {
    await pool.query('DELETE FROM mail_outbox');
    await pool.query('DELETE FROM mail_drafts');
    await pool.query('DELETE FROM mail_request_limits');
    smtp.received.length = 0;
  });

  await t.test(
    'composition is owned, verified, CSRF-protected and requires cached body headers',
    async () => {
      assert.equal(
        (await compose(source, 'reply', randomUUID(), '')).statusCode,
        401,
      );
      assert.equal(
        (await compose(source, 'reply', randomUUID(), other.cookie)).statusCode,
        404,
      );
      const foreignMessage = await idOf('Project question', other.id);
      assert.equal((await compose(foreignMessage, 'reply')).statusCode, 404);
      assert.equal(
        (
          await request(
            `messages/${source}/compose`,
            'POST',
            { id: randomUUID(), kind: 'reply' },
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      assert.equal((await compose(source, 'unexpected')).statusCode, 400);
      assert.equal((await compose(source, 'reply')).statusCode, 409);
      await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
        other.id,
      ]);
      assert.equal(
        (await compose(source, 'reply', randomUUID(), other.cookie)).statusCode,
        403,
      );
      await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
        other.id,
      ]);
      await cache(source);
      const operation = randomUUID(),
        first = await compose(source, 'reply', operation);
      assert.equal(first.statusCode, 201, first.body);
      assert.equal(
        (await compose(source, 'reply', operation)).json().draft.id,
        operation,
      );
      assert.equal(
        (await compose(source, 'forward', operation)).statusCode,
        409,
      );
      assert.equal(
        (await request(`drafts/${operation}`, 'GET', undefined, other.cookie))
          .statusCode,
        404,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM mail_drafts WHERE user_id=$1',
            [owner.id],
          )
        ).rows[0].count,
        1,
      );
    },
  );

  await t.test(
    'reply and reply-all use Reply-To, the receiving account and visible deduplicated recipients',
    async () => {
      const reply = await prepare('Project question', 'reply');
      assert.equal(reply.accountId, account);
      assert.match(reply.content.to, /support@example.test/);
      assert.equal(reply.content.cc, '');
      assert.equal(reply.content.bcc, '');
      assert.equal(reply.content.subject, 'Re: Project question');
      const all = await prepare('Project question', 'replyAll');
      assert.equal(all.accountId, account);
      assert.match(all.content.to, /support@example.test/);
      assert.match(all.content.to, /other@example.test/);
      assert.equal(all.content.cc, 'copy@example.test');
      assert.doesNotMatch(
        all.content.to + all.content.cc,
        /writer@example|alias@example|login@example|author@example/,
      );
      assert.doesNotMatch(all.content.html, /never-copy/);
      assert.equal(all.replyContext.inReplyTo, '<parent@example.test>');
      assert.deepEqual(all.replyContext.references, [
        '<root@example.test>',
        '<previous@example.test>',
        '<parent@example.test>',
      ]);
      const sent = await prepare('Own sent message', 'replyAll');
      assert.equal(sent.content.to, 'friend@example.test');
      assert.equal(sent.content.cc, 'copy@example.test');
    },
  );

  await t.test(
    'forwards keep formatted originals separate from editable content, without recipients, Bcc or thread headers',
    async () => {
      const forward = await prepare('HTML only message', 'forward');
      assert.equal(forward.content.to, '');
      assert.equal(forward.content.cc, '');
      assert.equal(forward.content.bcc, '');
      assert.equal(forward.content.subject, 'Fwd: HTML only message');
      assert.equal(forward.replyContext.inReplyTo, null);
      assert.deepEqual(forward.replyContext.references, []);
      assert.equal(forward.content.text, '');
      assert.match(forward.forwarded.text, /Business newsletter/);
      assert.doesNotMatch(
        forward.content.html,
        /<script|<img|<style|never-copy/,
      );
      const attachment = await prepare('Attachment mail', 'forward');
      assert.equal(attachment.attachmentIds.length, 2);
      assert.match(attachment.forwarded.text, /See attached/);
      const large = await prepare('Large quoted body', 'forward');
      assert.ok(
        large.replyContext.warnings.some((value: string) =>
          value.includes('shortened'),
        ),
      );
      assert.ok(Buffer.byteLength(JSON.stringify(large.content)) < 120000);
      const oversized = await idOf('Oversized formatted original');
      await cache(oversized);
      const refused = await compose(oversized, 'forward');
      assert.equal(refused.statusCode, 409, refused.body);
      assert.match(refused.json().message, /not been shortened/);
    },
  );

  await t.test(
    'formatted originals survive autosave, copies and source deletion, with isolated owned previews and received SMTP HTML',
    async () => {
      const forward = await prepare('Styled original', 'forward');
      const source = await idOf('Styled original');
      const savedSnapshot = (
        await pool.query(
          'SELECT forward_content FROM mail_drafts WHERE id=$1',
          [forward.id],
        )
      ).rows[0].forward_content;
      assert.match(savedSnapshot.html, /<table/);
      assert.match(savedSnapshot.html, /@media/);
      assert.equal(savedSnapshot.images.length, 1);
      assert.equal(imageCalls, 0);
      assert.equal(
        (
          await request(
            `drafts/${forward.id}/forward-preview`,
            'POST',
            {},
            other.cookie,
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            `drafts/${forward.id}/forward-preview`,
            'POST',
            {},
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      const previewResponse = await request(
        `drafts/${forward.id}/forward-preview`,
        'POST',
        {},
      );
      assert.equal(previewResponse.statusCode, 200, previewResponse.body);
      const path = (url: string) => {
        const parsed = new URL(url);
        return parsed.pathname + parsed.search;
      };
      const previewPath = path(previewResponse.json().htmlUrl);
      const preview = await contentApp.inject(previewPath);
      assert.equal(preview.statusCode, 200);
      assert.match(
        preview.headers['content-security-policy'] as string,
        /script-src 'none'/,
      );
      assert.match(preview.body, /<table[^>]+width="600"/);
      assert.match(preview.body, /@media/);
      assert.doesNotMatch(preview.body, /<img|<script|readerPwned/);
      assert.equal(imageCalls, 0);
      const enabled = await contentApp.inject(
        path(
          (
            await request(`drafts/${forward.id}/forward-preview`, 'POST', {
              images: true,
            })
          ).json().htmlUrl,
        ),
      );
      const imageUrls = [
        ...enabled.body.matchAll(/<img[^>]+src="([^"]+)"/g),
      ].map((match) => (match[1] ?? '').replaceAll('&amp;', '&'));
      assert.equal(imageUrls.length, 2);
      for (const url of imageUrls) {
        const image = await contentApp.inject(path(url));
        assert.equal(image.statusCode, 200, image.body);
        assert.deepEqual(image.rawPayload, tinyPng);
      }
      assert.equal(imageCalls, 1);
      const previousExpiry = (
        await pool.query('SELECT expires_at FROM auth_sessions WHERE id=$1', [
          owner.session,
        ])
      ).rows[0].expires_at;
      imageHook = async () => {
        await pool.query(
          "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [owner.session],
        );
      };
      try {
        const remote = imageUrls.find((url) => url.includes('index=0'));
        assert.ok(remote);
        assert.equal((await contentApp.inject(path(remote))).statusCode, 404);
      } finally {
        imageHook = null;
        await pool.query('UPDATE auth_sessions SET expires_at=$2 WHERE id=$1', [
          owner.session,
          previousExpiry,
        ]);
      }
      const foreignSession = (
        await pool.query(
          'SELECT id FROM auth_sessions WHERE user_id=$1 LIMIT 1',
          [other.id],
        )
      ).rows[0].id;
      const foreignToken = signContentGrant(
        {
          owner: other.id,
          session: foreignSession,
          message: forward.id,
          version: forward.id,
          images: false,
          kind: 'forward-body',
        },
        contentConfig.secret,
      );
      assert.equal(
        (await contentApp.inject(`/forward?token=${foreignToken}`)).statusCode,
        404,
      );
      assert.equal(
        (await contentApp.inject(previewPath.replace('/forward?', '/body?')))
          .statusCode,
        403,
      );
      const content = {
        ...forward.content,
        to: 'friend@example.test',
        html: '<p>My forwarded note.</p>',
        text: 'My forwarded note.',
      };
      const changed = await request(`drafts/${forward.id}`, 'PUT', {
        revision: forward.revision,
        saveId: randomUUID(),
        accountId: account,
        content,
        forward_content: { html: '<script>injected</script>' },
      });
      assert.equal(changed.statusCode, 200, changed.body);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT forward_content FROM mail_drafts WHERE id=$1',
            [forward.id],
          )
        ).rows[0].forward_content,
        savedSnapshot,
      );
      const copied = randomUUID();
      const copy = await request(`drafts/${copied}`, 'PUT', {
        revision: 0,
        saveId: randomUUID(),
        accountId: account,
        content,
        copyOf: forward.id,
      });
      assert.equal(copy.statusCode, 200, copy.body);
      assert.ok(copy.json().draft.forwarded);
      const foreignCopy = await request(
        `drafts/${randomUUID()}`,
        'PUT',
        {
          revision: 0,
          saveId: randomUUID(),
          accountId: foreign,
          content,
          copyOf: forward.id,
        },
        other.cookie,
      );
      assert.equal(foreignCopy.statusCode, 200, foreignCopy.body);
      assert.equal(foreignCopy.json().draft.forwarded, null);
      await pool.query('DELETE FROM mail_messages WHERE user_id=$1 AND id=$2', [
        owner.id,
        source,
      ]);
      assert.equal((await contentApp.inject(previewPath)).statusCode, 200);
      const sessionExpiry = (
        await pool.query('SELECT expires_at FROM auth_sessions WHERE id=$1', [
          owner.session,
        ])
      ).rows[0].expires_at;
      await pool.query(
        "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [owner.session],
      );
      assert.equal((await contentApp.inject(previewPath)).statusCode, 404);
      await pool.query('UPDATE auth_sessions SET expires_at=$2 WHERE id=$1', [
        owner.session,
        sessionExpiry,
      ]);
      const reloaded = await load(copied);
      assert.match(
        reloaded.forwarded.text,
        /Complete original plain alternative/,
      );
      const copyPreviewPath = path(
        (await request(`drafts/${copied}/forward-preview`, 'POST', {})).json()
          .htmlUrl,
      );
      const send = await request(`drafts/${copied}/send`, 'POST', {
        id: randomUUID(),
        revision: reloaded.revision,
      });
      assert.equal(send.statusCode, 202, send.body);
      await pool.query(
        "UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE user_id=$1 AND state='queued'",
        [owner.id],
      );
      await processOutgoing(pool, keys, owner.id, account);
      const delivered = await simpleParser(
        smtp.received.at(-1)?.raw ?? Buffer.alloc(0),
      );
      assert.match(String(delivered.html), /@media/);
      assert.match(String(delivered.html), /<table/);
      assert.match(String(delivered.html), /My forwarded note/);
      assert.match(
        String(delivered.html),
        /https:\/\/images.example.test\/pixel.png/,
      );
      assert.doesNotMatch(
        String(delivered.html),
        /<script|spindle-image:|\/forward-image\?token=/,
      );
      assert.equal(delivered.attachments.length, 1);
      assert.deepEqual(delivered.attachments[0]?.content, tinyPng);
      assert.equal(delivered.inReplyTo, undefined);
      assert.equal(
        (await request(`drafts/${copied}/forward-preview`, 'POST', {}))
          .statusCode,
        404,
      );
      assert.equal((await contentApp.inject(copyPreviewPath)).statusCode, 404);
    },
  );

  await t.test(
    'invalid recipients and missing message identity require review instead of forged threading',
    async () => {
      const invalid = await prepare('Invalid Reply-To', 'reply');
      assert.equal(invalid.content.to, '');
      assert.ok(invalid.replyContext.warnings.length);
      const missing = await prepare('Missing message identity', 'reply');
      assert.equal(missing.replyContext.inReplyTo, null);
      assert.deepEqual(missing.replyContext.references, []);
      assert.ok(
        missing.replyContext.warnings.some((value: string) =>
          value.includes('Message-ID'),
        ),
      );
      const id = await idOf('Too many recipients');
      await cache(id);
      const refused = await compose(id, 'replyAll');
      assert.equal(refused.statusCode, 409);
      assert.match(refused.json().message, /too many recipients/);
    },
  );

  await t.test(
    'legacy header refresh preserves cached bodies and images through provider failure and retry',
    async () => {
      const snapshot = async () =>
        (
          await pool.query(
            'SELECT version,plain_text,html,resources,attachments,expires_at FROM mail_content WHERE user_id=$1 AND message_id=$2',
            [owner.id, source],
          )
        ).rows[0];
      const before = await snapshot();
      await pool.query(
        `INSERT INTO mail_content_images(user_id,account_id,message_id,position,content_type,data)
        VALUES($1,$2,$3,0,'image/png',$4)`,
        [owner.id, account, source, tinyPng],
      );
      await pool.query(
        'UPDATE mail_content SET reply_metadata=NULL WHERE user_id=$1 AND message_id=$2',
        [owner.id, source],
      );
      const initial = (await request(`messages/${source}`)).json().content;
      assert.equal(initial.state, 'ready');
      assert.equal(initial.replyHeaders, 'missing');
      const operation = randomUUID();
      assert.equal((await compose(source, 'reply', operation)).statusCode, 202);
      const scheduled = (
        await pool.query(
          'SELECT next_attempt_at FROM mail_content WHERE message_id=$1',
          [source],
        )
      ).rows[0];
      assert.equal((await compose(source, 'reply', operation)).statusCode, 202);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT next_attempt_at FROM mail_content WHERE message_id=$1',
            [source],
          )
        ).rows[0],
        scheduled,
      );
      assert.equal(
        (await request(`messages/${source}`)).json().content.replyHeaders,
        'pending',
      );
      const job = {
        userId: owner.id,
        accountId: account,
        messageId: source,
        version: before.version,
      };
      await fetchMessageContent(pool, keys, job, async () => {
        throw new Error('Provider offline');
      });
      const offline = (await request(`messages/${source}`)).json().content;
      assert.equal(offline.state, 'ready');
      assert.equal(offline.replyHeaders, 'failed');
      assert.equal(offline.plainText, before.plain_text);
      assert.deepEqual(await snapshot(), before);
      assert.equal((await compose(source, 'reply', operation)).statusCode, 202);
      await fetchMessageContent(pool, keys, job, async (...args) => {
        const client = await connectImap(...args);
        client.download = async () => {
          throw new Error('Header upgrade must never download body');
        };
        return client;
      });
      const refreshed = (await request(`messages/${source}`)).json().content;
      assert.equal(refreshed.state, 'ready');
      assert.equal(refreshed.replyHeaders, 'ready');
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT data FROM mail_content_images WHERE message_id=$1',
            [source],
          )
        ).rows[0].data,
        tinyPng,
      );
      const prepared = await compose(source, 'reply', operation);
      assert.equal(prepared.statusCode, 201, prepared.body);
      assert.equal(
        (await load(prepared.json().draft.id)).replyContext.inReplyTo,
        '<parent@example.test>',
      );
      assert.equal((await compose(source, 'reply')).statusCode, 201);
      assert.equal(
        imap.server.control.getMessage('INBOX', 1).flags.includes('\\Seen'),
        false,
      );
    },
  );

  await t.test(
    'autosave, copied conflicts and API restart preserve immutable reply context',
    async () => {
      const original = await prepare('Project question', 'reply'),
        copy = randomUUID();
      const content = { ...original.content, to: 'reviewed@example.test' };
      const saved = await request(`drafts/${original.id}`, 'PUT', {
        revision: 1,
        saveId: randomUUID(),
        accountId: account,
        content,
      });
      assert.equal(saved.statusCode, 200, saved.body);
      assert.deepEqual(saved.json().draft.replyContext, original.replyContext);
      const forged = await request(`drafts/${original.id}`, 'PUT', {
        revision: 2,
        saveId: randomUUID(),
        accountId: account,
        content,
        replyContext: { inReplyTo: '<forged@example.test>' },
      });
      assert.equal(forged.statusCode, 200, forged.body);
      assert.deepEqual(forged.json().draft.replyContext, original.replyContext);
      const cloned = await request(`drafts/${copy}`, 'PUT', {
        revision: 0,
        saveId: randomUUID(),
        accountId: account,
        content,
        copyOf: original.id,
      });
      assert.equal(cloned.statusCode, 200, cloned.body);
      assert.deepEqual(cloned.json().draft.replyContext, original.replyContext);
      const foreignCopy = await request(
        `drafts/${randomUUID()}`,
        'PUT',
        {
          revision: 0,
          saveId: randomUUID(),
          accountId: null,
          content,
          copyOf: original.id,
        },
        other.cookie,
      );
      assert.equal(foreignCopy.statusCode, 200, foreignCopy.body);
      assert.equal(foreignCopy.json().draft.replyContext.kind, 'copy');
      assert.equal(foreignCopy.json().draft.replyContext.inReplyTo, null);
      const second = testApp(
        new Pool({ connectionString }),
        testConfig,
        undefined,
        keys,
      );
      try {
        const restored = await second.inject({
          url: `/api/mail/drafts/${original.id}`,
          headers: { cookie: owner.cookie },
        });
        assert.deepEqual(
          restored.json().draft.replyContext,
          original.replyContext,
        );
      } finally {
        await second.close();
      }
    },
  );

  await t.test(
    'actual recipient-side SMTP MIME threads replies while forwards start a new conversation',
    async () => {
      for (const kind of ['reply', 'replyAll', 'forward']) {
        const draft = await prepare('Project question', kind);
        let revision = 1;
        if (kind === 'forward') {
          const saved = await request(`drafts/${draft.id}`, 'PUT', {
            revision: 1,
            saveId: randomUUID(),
            accountId: account,
            content: { ...draft.content, to: 'friend@example.test' },
          });
          assert.equal(saved.statusCode, 200, saved.body);
          revision = saved.json().draft.revision;
        }
        const operation = randomUUID(),
          queued = await request(`drafts/${draft.id}/send`, 'POST', {
            id: operation,
            revision,
          });
        assert.equal(queued.statusCode, 202, queued.body);
        await pool.query(
          'UPDATE mail_outbox SET next_attempt_at=clock_timestamp() WHERE id=$1',
          [operation],
        );
        await processOutgoing(pool, keys, owner.id, account);
        const received = smtp.received.at(-1);
        assert.ok(received);
        const parsed = await simpleParser(received.raw);
        assert.notEqual(parsed.messageId, '<parent@example.test>');
        assert.equal(parsed.bcc, undefined);
        assert.doesNotMatch(received.raw.toString(), /^Bcc:/im);
        if (kind === 'forward') {
          assert.equal(parsed.inReplyTo, undefined);
          assert.equal(parsed.references, undefined);
        } else {
          assert.equal(parsed.inReplyTo, '<parent@example.test>');
          assert.deepEqual(parsed.references, [
            '<root@example.test>',
            '<previous@example.test>',
            '<parent@example.test>',
          ]);
        }
        assert.equal(
          (
            await pool.query('SELECT state FROM mail_outbox WHERE id=$1', [
              operation,
            ])
          ).rows[0].state,
          'accepted',
        );
        assert.equal((await compose(source, kind, draft.id)).statusCode, 409);
      }
      assert.equal(smtp.received.length, 3);
    },
  );

  await t.test(
    'source deletion preserves prepared threading and lost-create replay; deleted copies recover explicitly unthreaded',
    async () => {
      const operation = randomUUID(),
        created = await compose(source, 'reply', operation);
      assert.equal(created.statusCode, 201, created.body);
      const original = await load(operation);
      await pool.query('DELETE FROM mail_messages WHERE user_id=$1 AND id=$2', [
        owner.id,
        source,
      ]);
      assert.equal((await compose(source, 'reply', operation)).statusCode, 201);
      assert.deepEqual(
        (await load(operation)).replyContext,
        original.replyContext,
      );
      await request(`drafts/${operation}`, 'DELETE', { revision: 1 });
      const copy = await request(`drafts/${randomUUID()}`, 'PUT', {
        revision: 0,
        saveId: randomUUID(),
        accountId: account,
        content: original.content,
        copyOf: operation,
      });
      assert.equal(copy.statusCode, 200, copy.body);
      assert.equal(copy.json().draft.replyContext.kind, 'copy');
      assert.equal(copy.json().draft.replyContext.inReplyTo, null);
      assert.ok(copy.json().draft.replyContext.warnings.length);
    },
  );
});
