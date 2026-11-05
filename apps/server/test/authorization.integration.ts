import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { InjectOptions } from 'fastify';
import { Pool } from 'pg';
import { authProxyPaths } from '../src/auth/routes.js';
import { migrateDatabase } from '../src/db/migrate.js';
import { readContentConfig } from '../src/mail/content-config.js';
import { buildContentApp } from '../src/mail/content-server.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { type ContentGrant, signContentGrant } from '../src/mail/grants.js';
import { SANITIZER_VERSION } from '../src/mail/sanitize.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { tinyPng } from './reader-fixture.js';

// C10: every API route is classified here. Unclassified or stale routes fail
// the coverage check, so new routes must declare and prove their guard.
type Guard = 'public' | 'session' | 'admin' | 'adminGate';
type Entry = {
  guard: Guard;
  url?: string; // concrete URL; owner resource IDs substituted
  body?: unknown;
  raw?: boolean; // octet-stream upload body
  query?: Record<string, string>; // valid query used for malformed variants
  foreign?: 'deny' | 'allow'; // run as non-owners against owner resources
  stream?: boolean; // never invoke as an accepted caller
};

const sentinel = 'C10-OWNER-SENTINEL';
const origin = testConfig.appUrl;

test('route-wide authorization matrix', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 180000,
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
      v1: Buffer.alloc(32, 91).toString('base64'),
    }),
  });
  const content = readContentConfig(testConfig, {});
  assert.ok(content);
  const app = testApp(pool, testConfig, undefined, keys, content);
  const contentApp = buildContentApp(pool, content, async () => {
    throw new Error('No remote images in authorization tests');
  });
  contentApp.log.level = 'silent';
  const routes = new Set<string>();
  // Plugin-scoped (mail/admin) routes are collected here; root routes are
  // registered inside buildApp and checked by the printed route count below.
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat())
      if (method !== 'HEAD') routes.add(`${method} ${route.url}`);
  });
  await app.ready();
  await contentApp.ready();
  t.after(async () => {
    // Keep the last active administrator; the database refuses to delete it.
    await pool.query(
      "DELETE FROM users WHERE email LIKE 'c10-%' AND email<>'c10-admin@example.test'",
    );
    await pool.query(
      "DELETE FROM users u WHERE email='c10-admin@example.test' AND EXISTS(SELECT 1 FROM users o WHERE o.role='admin' AND NOT o.suspended AND o.id<>u.id)",
    );
    await contentApp.close();
    await app.close();
  });

  const user = (name: string, address: number) =>
    createTestUser(
      app,
      pool,
      testConfig,
      `c10-${name}@example.test`,
      `203.0.113.${address}`,
    );
  const owner = await user('owner', 60);
  const other = await user('other', 61);
  const admin = await user('admin', 62);
  const lockedAdmin = await user('locked-admin', 63);
  const expired = await user('expired', 64);
  const suspended = await user('suspended', 65);
  const unverified = await user('unverified', 66);
  const pendingDeletion = await user('pending-deletion', 67);
  // Malformed auth-proxy calls may sign this user out; never the owner.
  const scratch = await user('scratch', 68);
  await pool.query(
    "UPDATE users SET role='admin' WHERE id IN ($1,$2,$3,$4,$5)",
    [admin.id, lockedAdmin.id, suspended.id, unverified.id, expired.id],
  );
  await pool.query(
    'UPDATE auth_sessions SET admin_unlocked_at=now() WHERE id IN ($1,$2,$3,$4)',
    [admin.session, suspended.session, unverified.session, expired.session],
  );
  await pool.query(
    "UPDATE auth_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",
    [expired.session],
  );
  await pool.query('UPDATE users SET suspended=true WHERE id=$1', [
    suspended.id,
  ]);
  await pool.query('UPDATE users SET email_verified=false WHERE id=$1', [
    unverified.id,
  ]);
  await pool.query(
    "UPDATE users SET suspended=true,deletion_due_at=now()+interval '7 days' WHERE id=$1",
    [pendingDeletion.id],
  );

  // Synthetic owner mail covering every resource addressed by an :id route.
  const ids = {
    account: randomUUID(),
    mailbox: randomUUID(),
    message: randomUUID(),
    version: randomUUID(),
    draft: randomUUID(),
    upload: randomUUID(),
    outbox: randomUUID(),
    search: randomUUID(),
    action: randomUUID(),
    link: randomUUID(),
  };
  const q = (sql: string, values: unknown[] = []) =>
    pool.query(sql, [owner.id, ...values]);
  await q(
    `INSERT INTO mail_accounts(id,user_id,name,host,port,transport,username,credential)
     VALUES($2,$1,$3,'imap.example.test',993,'tls',$3,'v1:SECRET')`,
    [ids.account, `${sentinel}-account`],
  );
  await q(
    `INSERT INTO mail_smtp(user_id,account_id,host,port,transport,username,credential)
     VALUES($1,$2,'smtp.example.test',465,'tls',$3,'v1:SECRET')`,
    [ids.account, `${sentinel}-smtp`],
  );
  await q(
    'INSERT INTO mail_signatures(account_id,user_id,html,text) VALUES($2,$1,$3,$3)',
    [ids.account, `${sentinel}-signature`],
  );
  await q(
    `INSERT INTO mailboxes(id,user_id,account_id,path,name,role) VALUES($2,$1,$3,'INBOX',$4,'inbox')`,
    [ids.mailbox, ids.account, `${sentinel}-mailbox`],
  );
  await q(
    `INSERT INTO mail_messages(id,user_id,account_id,remote_key,subject,sender,recipients,received_at)
     VALUES($2,$1,$3,'c10',$4,'{"address":"c10-sender@example.test"}','[{"address":"c10-to@example.test"}]',now())`,
    [ids.message, ids.account, `${sentinel}-subject`],
  );
  await q(
    `INSERT INTO mail_memberships(user_id,account_id,mailbox_id,message_id,uid_validity,uid,flags)
     VALUES($1,$2,$3,$4,'1',1,ARRAY[]::text[])`,
    [ids.account, ids.mailbox, ids.message],
  );
  await q(
    `INSERT INTO mail_content(message_id,user_id,account_id,version,state,html,plain_text,resources,attachments,sanitizer_version,expires_at)
     VALUES($2,$1,$3,$4,'ready',$5,$5,'[{"kind":"inline"}]','[{"filename":"c10.txt","size":5,"type":"text/plain"}]',$6,now()+interval '1 day')`,
    [
      ids.message,
      ids.account,
      ids.version,
      `<p>${sentinel}-body</p>`,
      SANITIZER_VERSION,
    ],
  );
  await q(
    `INSERT INTO mail_content_attachments(user_id,account_id,message_id,position,state,data)
     VALUES($1,$2,$3,0,'ready','hello'::bytea)`,
    [ids.account, ids.message],
  );
  await q(
    `INSERT INTO mail_content_images(user_id,account_id,message_id,position,content_type,data)
     VALUES($1,$2,$3,0,'image/png',$4)`,
    [ids.account, ids.message, tinyPng],
  );
  await q(
    `INSERT INTO mail_drafts(id,user_id,account_id,content,revision,forward_content)
     VALUES($2,$1,$3,$4,1,$5)`,
    [
      ids.draft,
      ids.account,
      JSON.stringify({ subject: `${sentinel}-draft` }),
      JSON.stringify({
        html: `<p>${sentinel}-forward</p>`,
        text: `${sentinel}-forward`,
        resources: [{ kind: 'inline' }],
        images: [
          { position: 0, type: 'image/png', data: tinyPng.toString('base64') },
        ],
      }),
    ],
  );
  await q(
    `INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state) VALUES($2,$1,$3,5,5,'ready')`,
    [ids.upload, `${sentinel}-upload.txt`],
  );
  await q(
    `INSERT INTO mail_outbox(id,user_id,account_id,source_draft_id,draft_revision,smtp_version,sender,recipients,subject,message_id,raw,state,scheduled_at)
     VALUES($2,$1,$3,$4,1,gen_random_uuid(),'c10@example.test','["c10-to@example.test"]',$5,'<c10@example.test>','MIME'::bytea,'queued',now()+interval '1 day')`,
    [ids.outbox, ids.account, ids.draft, `${sentinel}-outbox`],
  );
  await q(
    'INSERT INTO mail_saved_searches(id,user_id,name,query) VALUES($2,$1,$3,$4)',
    [ids.search, `${sentinel}-search`, 'from:c10'],
  );
  await q(
    `INSERT INTO mail_actions(id,user_id,account_id,message_id,kind,state,subject)
     VALUES($2,$1,$3,$4,'read','failed',$5)`,
    [ids.action, ids.account, ids.message, `${sentinel}-action`],
  );
  // Draft creation already maintains the provider link row.
  ids.link = (
    await q(
      `UPDATE mail_draft_links SET subject=$3,state='conflict'
       WHERE user_id=$1 AND source_draft_id=$2 RETURNING id`,
      [ids.draft, `${sentinel}-link`],
    )
  ).rows[0].id;
  const markers = [sentinel, ...Object.values(ids)];

  const fresh = randomUUID;
  const draftContent = {
    to: '',
    cc: '',
    bcc: '',
    subject: 'Synthetic',
    format: 'plain',
    html: '',
    text: 'Synthetic',
  };
  const matrix: Record<string, Entry> = {
    'GET /api/health': { guard: 'public' },
    'GET /api/ready': { guard: 'public' },
    'GET /api/auth-config': { guard: 'public' },
    'GET /api/me': { guard: 'session' },
    'POST /api/account/export': {
      guard: 'session',
      body: { currentPassword: 'wrong password' },
    },
    'GET /api/admin/access': { guard: 'adminGate' },
    'POST /api/admin/unlock': {
      guard: 'adminGate',
      body: { currentPassword: 'wrong password' },
    },
    'GET /api/admin/overview': { guard: 'admin' },
    'GET /api/admin/users': { guard: 'admin', query: { search: 'c10' } },
    'GET /api/admin/invites': { guard: 'admin', query: { search: 'c10' } },
    'GET /api/admin/audit': { guard: 'admin', query: { cursor: fresh() } },
    'GET /api/admin/security': { guard: 'admin', query: { cursor: 'c10' } },
    'POST /api/admin/users/:id': {
      guard: 'admin',
      url: `/api/admin/users/${other.id}`,
      body: { operationId: fresh(), action: 'suspend', expectedRevision: 999 },
    },
    'POST /api/admin/invites': {
      guard: 'admin',
      body: {
        operationId: fresh(),
        email: 'c10-invite@example.test',
        expectedId: 'c10-stale-invite',
      },
    },
    'POST /api/admin/invites/revoke': {
      guard: 'admin',
      body: { operationId: fresh(), inviteId: 'c10-missing-invite' },
    },
    'GET /api/mail/events': { guard: 'session', stream: true },
    'GET /api/mail/notifications': {
      guard: 'session',
      query: { since: new Date().toISOString() },
      foreign: 'allow',
    },
    'GET /api/mail/preferences': { guard: 'session', foreign: 'allow' },
    'PATCH /api/mail/preferences': {
      guard: 'session',
      body: { undoSend: true },
    },
    'GET /api/mail/accounts': { guard: 'session', foreign: 'allow' },
    'PATCH /api/mail/accounts/order': {
      guard: 'session',
      body: { accountIds: [ids.account], expectedAccountIds: [ids.account] },
      foreign: 'deny',
    },
    'PATCH /api/mail/accounts/:id/name': {
      guard: 'session',
      body: { name: 'Renamed synthetic' },
      foreign: 'deny',
    },
    'PATCH /api/mail/accounts/:id/color': {
      guard: 'session',
      body: { color: '#123456' },
      foreign: 'deny',
    },
    'POST /api/mail/accounts': {
      guard: 'session',
      body: {
        name: 'Synthetic',
        host: 'imap.example.test',
        port: 993,
        transport: 'tls',
        username: 'c10@example.test',
        password: 'synthetic',
        history: '90d',
      },
    },
    // Without Google configuration the start route answers 503; ownership of
    // reconnect targets and state binding are covered in gmail.integration.ts.
    'POST /api/mail/oauth/google': {
      guard: 'session',
      body: { history: 'all' },
    },
    'GET /api/mail/oauth/google/callback': {
      guard: 'session',
      query: { state: 'c10-state', code: 'c10-code' },
    },
    'POST /api/mail/accounts/:id/sync': { guard: 'session', foreign: 'deny' },
    'DELETE /api/mail/accounts/:id': {
      guard: 'session',
      // Foreign callers send their own correct password below.
      body: { password: owner.password },
      foreign: 'deny',
    },
    'GET /api/mail/mailboxes': { guard: 'session', foreign: 'allow' },
    'GET /api/mail/messages': {
      guard: 'session',
      query: { account: ids.account, mailbox: ids.mailbox, q: 'c10' },
      foreign: 'allow',
    },
    'GET /api/mail/searches': { guard: 'session', foreign: 'allow' },
    'PUT /api/mail/searches/:id': {
      guard: 'session',
      body: {
        name: 'Synthetic',
        query: 'from:c10',
        accountId: ids.account,
        mailboxId: null,
      },
      foreign: 'deny',
    },
    'DELETE /api/mail/searches/:id': { guard: 'session', foreign: 'deny' },
    'POST /api/mail/batch-actions': {
      guard: 'session',
      body: { kind: 'read', items: [{ id: fresh(), messageId: ids.message }] },
      foreign: 'allow', // per-item "Message not found" results
    },
    'GET /api/mail/contacts': {
      guard: 'session',
      query: { q: 'c10', account: ids.account },
      foreign: 'allow',
    },
    'GET /api/mail/contacts/export': {
      guard: 'session',
      query: { after: 'a' },
      foreign: 'allow',
    },
    'GET /api/mail/messages/:id': {
      guard: 'session',
      query: { account: ids.account },
      foreign: 'deny',
    },
    'POST /api/mail/messages/:id/actions': {
      guard: 'session',
      body: { id: fresh(), kind: 'read' },
      foreign: 'deny',
    },
    'GET /api/mail/actions': { guard: 'session', foreign: 'allow' },
    'POST /api/mail/actions/:id/retry': { guard: 'session', foreign: 'deny' },
    'POST /api/mail/actions/:id/dismiss': { guard: 'session', foreign: 'deny' },
    'POST /api/mail/actions/:id/undo': { guard: 'session', foreign: 'deny' },
    'POST /api/mail/messages/:id/content': {
      guard: 'session',
      body: { retry: false },
      foreign: 'deny',
    },
    'POST /api/mail/messages/:id/attachments/:index': {
      guard: 'session',
      url: `/api/mail/messages/${ids.message}/attachments/0`,
      body: { retry: false },
      foreign: 'deny',
    },
    'POST /api/mail/messages/:id/images': {
      guard: 'session',
      body: { show: true },
      foreign: 'deny',
    },
    'GET /api/mail/messages/:id/conversation': {
      guard: 'session',
      query: { account: ids.account },
      foreign: 'deny',
    },
    'PATCH /api/mail/messages/:id/conversation/state': {
      guard: 'session',
      body: { version: '0', pinned: true },
      foreign: 'deny',
    },
    'GET /api/mail/accounts/:id/signature': {
      guard: 'session',
      foreign: 'deny',
    },
    'PUT /api/mail/accounts/:id/signature': {
      guard: 'session',
      body: {
        html: '<p>Synthetic</p>',
        newMessages: true,
        repliesForwards: true,
        revision: 0,
      },
      foreign: 'deny',
    },
    'POST /api/mail/messages/:id/compose': {
      guard: 'session',
      body: { id: fresh(), kind: 'reply' },
      foreign: 'deny',
    },
    'GET /api/mail/drafts': { guard: 'session', foreign: 'allow' },
    'POST /api/mail/drafts/:id/forward-preview': {
      guard: 'session',
      body: { images: false },
      foreign: 'deny',
    },
    'GET /api/mail/drafts/:id': { guard: 'session', foreign: 'deny' },
    'PUT /api/mail/drafts/:id': {
      guard: 'session',
      body: {
        accountId: ids.account,
        content: draftContent,
        revision: 0,
        saveId: fresh(),
        attachmentIds: [ids.upload],
      },
      foreign: 'deny',
    },
    'DELETE /api/mail/drafts/:id': {
      guard: 'session',
      body: { revision: 1 },
      foreign: 'deny',
    },
    'GET /api/mail/uploads': {
      guard: 'session',
      query: { ids: ids.upload },
      foreign: 'allow',
    },
    'POST /api/mail/uploads': {
      guard: 'session',
      body: { id: ids.upload, filename: 'c10.txt', size: 5 },
      foreign: 'deny',
    },
    'PUT /api/mail/uploads/:id': {
      guard: 'session',
      raw: true,
      foreign: 'deny',
    },
    'POST /api/mail/uploads/:id/retry': { guard: 'session', foreign: 'deny' },
    'DELETE /api/mail/uploads/:id': { guard: 'session', foreign: 'allow' },
    'GET /api/mail/draft-sync/:id/version': {
      guard: 'session',
      url: `/api/mail/draft-sync/${ids.link}/version`,
      foreign: 'deny',
    },
    'GET /api/mail/draft-sync': { guard: 'session', foreign: 'allow' },
    'POST /api/mail/draft-sync/:id': {
      guard: 'session',
      url: `/api/mail/draft-sync/${ids.link}`,
      body: { action: 'keepLocal', revision: 1 },
      foreign: 'deny',
    },
    'GET /api/mail/accounts/:id/smtp': { guard: 'session', foreign: 'deny' },
    'PUT /api/mail/accounts/:id/smtp': {
      guard: 'session',
      body: {
        host: 'smtp.example.test',
        port: 465,
        transport: 'tls',
        username: 'c10@example.test',
        password: 'synthetic',
      },
      foreign: 'deny',
    },
    'POST /api/mail/accounts/:id/smtp/test': {
      guard: 'session',
      foreign: 'deny',
    },
    'POST /api/mail/drafts/:id/send': {
      guard: 'session',
      body: { id: fresh(), revision: 1 },
      foreign: 'deny',
    },
    'PATCH /api/mail/outbox/:id/reschedule': {
      guard: 'session',
      body: {
        revision: 1,
        scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(),
      },
      foreign: 'deny',
    },
    'GET /api/mail/outbox': { guard: 'session', foreign: 'allow' },
    'POST /api/mail/outbox/:id/cancel': { guard: 'session', foreign: 'deny' },
    'POST /api/mail/outbox/:id/retry': { guard: 'session', foreign: 'deny' },
  };
  // Better Auth endpoints behind the /api/auth/* proxy.
  const publicAuth = new Set([
    'POST /sign-up/email',
    'POST /sign-in/email',
    'POST /sign-out',
    'POST /send-verification-email',
    'POST /request-password-reset',
    'POST /reset-password',
    'POST /account/email/confirm',
    'POST /account/deletion/cancel',
    'GET /get-session',
    'GET /verify-email',
  ]);
  const authBodies: Record<string, unknown> = {
    '/sign-up/email': {
      email: 'c10-signup@example.test',
      name: 'Synthetic',
      password: 'synthetic password 123!',
    },
    '/sign-in/email': {
      email: 'c10-nobody@example.test',
      password: 'wrong password',
    },
    '/send-verification-email': { email: 'c10-nobody@example.test' },
    '/request-password-reset': { email: 'c10-nobody@example.test' },
    '/reset-password': {
      token: 'c10-invalid',
      newPassword: 'another synthetic password 123!',
    },
    '/account/email/confirm': { token: 'c10-invalid' },
    '/account/deletion/cancel': {
      email: 'c10-nobody@example.test',
      password: 'wrong password',
    },
    '/account/profile': { name: 'Synthetic' },
    '/account/password': {
      currentPassword: 'wrong password',
      newPassword: 'another synthetic password 123!',
    },
    '/account/email': {
      currentPassword: 'wrong password',
      newEmail: 'c10-new@example.test',
    },
    '/account/email/cancel': { currentPassword: 'wrong password' },
    '/account/sessions/revoke': {
      sessionId: 'c10-missing-session',
      currentPassword: 'wrong password',
    },
    '/account/sessions/revoke-others': { currentPassword: 'wrong password' },
    '/account/deletion': { currentPassword: 'wrong password' },
  };
  for (const method of ['GET', 'POST'] as const)
    for (const path of authProxyPaths[method]) {
      const key = `${method} ${path}`;
      matrix[`${method} /api/auth${path}`] = {
        guard: publicAuth.has(key) ? 'public' : 'session',
        body: method === 'POST' ? (authBodies[path] ?? {}) : undefined,
      };
    }

  const fill = (pattern: string, entry: Entry) =>
    entry.url ??
    pattern
      .replace(
        /^\/api\/mail\/accounts\/:id/,
        `/api/mail/accounts/${ids.account}`,
      )
      .replace(
        /^\/api\/mail\/messages\/:id/,
        `/api/mail/messages/${ids.message}`,
      )
      .replace(/^\/api\/mail\/actions\/:id/, `/api/mail/actions/${ids.action}`)
      .replace(
        /^\/api\/mail\/searches\/:id/,
        `/api/mail/searches/${ids.search}`,
      )
      .replace(/^\/api\/mail\/drafts\/:id/, `/api/mail/drafts/${ids.draft}`)
      .replace(/^\/api\/mail\/uploads\/:id/, `/api/mail/uploads/${ids.upload}`)
      .replace(/^\/api\/mail\/outbox\/:id/, `/api/mail/outbox/${ids.outbox}`);
  const withQuery = (url: string, query?: Record<string, string>) =>
    query ? `${url}?${new URLSearchParams(query)}` : url;
  const entries = Object.entries(matrix).map(([key, entry]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    const url = fill(pattern, entry);
    assert.doesNotMatch(url, /\/:/, `${key} needs a concrete URL`);
    return { key, method, pattern, url, entry };
  });

  let address = 0;
  const call = async (
    method: string,
    url: string,
    cookie: string | null,
    options: {
      body?: unknown;
      raw?: boolean | undefined;
      origin?: string | null | undefined;
    } = {},
  ) => {
    // Rate counters are cleared so a 429 can never stand in for a guard.
    await pool.query('DELETE FROM mail_request_limits');
    await pool.query('DELETE FROM auth_rate_limits');
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    const sentOrigin = options.origin === undefined ? origin : options.origin;
    if (sentOrigin) headers.origin = sentOrigin;
    const request: InjectOptions = {
      method: method as NonNullable<InjectOptions['method']>,
      url,
      headers,
      remoteAddress: `198.51.100.${(address++ % 200) + 1}`,
    };
    if (options.raw) {
      headers['content-type'] = 'application/octet-stream';
      request.payload = Buffer.from('hello');
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      request.payload = JSON.stringify(options.body);
    }
    const response = await app.inject(request);
    assert.ok(
      response.statusCode < 500,
      `${method} ${url} returned ${response.statusCode}: ${response.body}`,
    );
    return response;
  };
  const send = (
    item: (typeof entries)[number],
    cookie: string | null,
    origin?: string | null,
  ) =>
    call(item.method, withQuery(item.url, item.entry.query), cookie, {
      body: item.entry.body,
      raw: item.entry.raw,
      origin,
    });

  await t.test('every registered route has exactly one matrix entry', () => {
    const classified = new Set(Object.keys(matrix));
    for (const route of routes)
      assert.ok(classified.has(route), `${route} is not in the C10 matrix`);
    for (const key of classified) {
      const [method, pattern] = key.split(' ') as [string, string];
      const url = pattern.startsWith('/api/auth/') ? '/api/auth/*' : pattern;
      assert.ok(
        app.hasRoute({ method: method as 'GET', url }),
        `${key} is in the C10 matrix but not registered`,
      );
    }
    // onRoute misses routes registered directly on the root; compare totals.
    const printed = (server: typeof app | typeof contentApp) =>
      server
        .printRoutes({ commonPrefix: false })
        .split('\n')
        .flatMap(
          (line) => line.match(/\(([A-Z, ]+)\)\s*$/)?.[1]?.split(', ') ?? [],
        )
        .filter((method) => method !== 'HEAD').length;
    const rootRoutes = [
      'GET /api/health',
      'GET /api/ready',
      'GET /api/auth-config',
      'GET /api/me',
      'POST /api/account/export',
      'GET /api/auth/*',
      'POST /api/auth/*',
    ];
    assert.equal(
      printed(app),
      routes.size + rootRoutes.length,
      'A root route was added; classify it in the C10 matrix and rootRoutes',
    );
    const contentRoutes = [
      '/attachment',
      '/body',
      '/forward',
      '/forward-image',
      '/image',
    ];
    assert.equal(printed(contentApp), contentRoutes.length);
    for (const url of contentRoutes)
      assert.ok(contentApp.hasRoute({ method: 'GET', url }), url);
  });

  await t.test('public routes answer without a session', async () => {
    for (const item of entries.filter((e) => e.entry.guard === 'public')) {
      if (item.method !== 'GET') continue;
      const response = await send(item, null);
      assert.notEqual(response.statusCode, 401, item.key);
      assert.notEqual(response.statusCode, 403, item.key);
    }
  });

  const denied = (
    callers: { name: string; cookie: string | null; status: number }[],
    guards: Guard[],
  ) =>
    (async () => {
      for (const item of entries.filter((e) => guards.includes(e.entry.guard)))
        for (const caller of callers) {
          const response = await send(item, caller.cookie);
          assert.equal(
            response.statusCode,
            caller.status,
            `${caller.name} ${item.key}: ${response.body}`,
          );
          for (const marker of markers)
            assert.ok(!response.body.includes(marker), `${item.key} leaked`);
        }
    })();

  await t.test(
    'missing, garbage and expired sessions are refused',
    async () => {
      await denied(
        [
          { name: 'anonymous', cookie: null, status: 401 },
          {
            name: 'garbage cookie',
            cookie: 'better-auth.session_token=c10.forged',
            status: 401,
          },
          { name: 'expired', cookie: expired.cookie, status: 401 },
        ],
        ['session', 'admin', 'adminGate'],
      );
    },
  );

  await t.test(
    'suspended, pending-deletion and unverified users are refused',
    async () => {
      await denied(
        [
          // Suspension deletes sessions and refuses new ones in Postgres.
          { name: 'suspended', cookie: suspended.cookie, status: 401 },
          {
            name: 'pending deletion',
            cookie: pendingDeletion.cookie,
            status: 401,
          },
          { name: 'unverified', cookie: unverified.cookie, status: 403 },
        ],
        ['session', 'admin', 'adminGate'],
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM auth_sessions WHERE user_id IN ($1,$2)',
            [suspended.id, pendingDeletion.id],
          )
        ).rows[0].n,
        0,
      );
    },
  );

  await t.test('non-admins and locked admin sessions are refused', async () => {
    await denied(
      [{ name: 'regular user', cookie: other.cookie, status: 403 }],
      ['admin', 'adminGate'],
    );
    for (const item of entries.filter((e) => e.entry.guard === 'admin')) {
      const response = await send(item, lockedAdmin.cookie);
      assert.equal(response.statusCode, 403, `${item.key}: ${response.body}`);
      assert.equal(response.json().code, 'ADMIN_LOCKED', item.key);
    }
    const access = await call('GET', '/api/admin/access', lockedAdmin.cookie);
    assert.deepEqual(access.json(), { unlocked: false });
    const unlock = await call('POST', '/api/admin/unlock', lockedAdmin.cookie, {
      body: { currentPassword: 'wrong password' },
    });
    assert.equal(unlock.statusCode, 400);
  });

  await t.test('cross-site and origin-less writes are refused', async () => {
    for (const item of entries.filter((e) => e.method !== 'GET'))
      for (const sentOrigin of ['https://attacker.example', null]) {
        const response = await send(item, owner.cookie, sentOrigin);
        assert.equal(
          response.statusCode,
          403,
          `${item.key} origin ${sentOrigin}: ${response.body}`,
        );
      }
  });

  const ownedState = async () => {
    const tables = (
      await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.columns WHERE table_schema='public'
         AND column_name='user_id' AND table_name NOT IN ('mail_request_limits') ORDER BY table_name`,
      )
    ).rows.map((row) => row.table_name);
    const state: Record<string, string> = {};
    for (const table of tables)
      state[table] = (
        await pool.query(
          `SELECT md5(coalesce(string_agg(t::text,'|' ORDER BY t::text),'')) AS hash FROM "${table}" t WHERE user_id=$1`,
          [owner.id],
        )
      ).rows[0].hash;
    state.users = (
      await pool.query('SELECT md5(u::text) AS hash FROM users u WHERE id=$1', [
        owner.id,
      ])
    ).rows[0].hash;
    return state;
  };

  await t.test(
    'other users and administrators cannot read or change owner mail',
    async () => {
      const before = await ownedState();
      for (const caller of [other, admin])
        for (const item of entries.filter((e) => e.entry.foreign)) {
          const body =
            item.key === 'DELETE /api/mail/accounts/:id'
              ? { password: caller.password }
              : item.entry.body;
          const response = await call(
            item.method,
            withQuery(item.url, item.entry.query),
            caller.cookie,
            { body, raw: item.entry.raw },
          );
          if (item.entry.foreign === 'deny')
            assert.ok(
              [400, 403, 404, 409].includes(response.statusCode),
              `${caller.email} ${item.key} returned ${response.statusCode}: ${response.body}`,
            );
          // Identifiers the caller supplied may be echoed back as "not found".
          const supplied = JSON.stringify([item.url, item.entry.query, body]);
          for (const marker of markers.filter((m) => !supplied.includes(m)))
            assert.ok(
              !response.body.includes(marker),
              `${caller.email} ${item.key} exposed owner data: ${response.body}`,
            );
        }
      // Foreign uploads cannot be attached and foreign draft IDs not taken over.
      for (const draft of [fresh(), ids.draft]) {
        const response = await call(
          'PUT',
          `/api/mail/drafts/${draft}`,
          other.cookie,
          {
            body: {
              accountId: null,
              content: draftContent,
              revision: 0,
              saveId: fresh(),
              ...(draft === ids.draft ? {} : { attachmentIds: [ids.upload] }),
            },
          },
        );
        assert.ok(
          [400, 403, 404, 409].includes(response.statusCode),
          `draft ${draft}: ${response.statusCode} ${response.body}`,
        );
      }
      // A copy of a foreign draft starts empty instead of inheriting content.
      const copy = await call(
        'PUT',
        `/api/mail/drafts/${fresh()}`,
        other.cookie,
        {
          body: {
            accountId: null,
            content: draftContent,
            revision: 0,
            saveId: fresh(),
            copyOf: ids.draft,
          },
        },
      );
      for (const marker of markers)
        assert.ok(!copy.body.includes(marker), copy.body);
      assert.deepEqual(copy.json().draft?.attachmentIds ?? [], []);
      assert.deepEqual(await ownedState(), before);
    },
  );

  await t.test('malformed input is rejected without crashing', async () => {
    const replacements = (value: unknown) =>
      [{}, [], ['x'], 7, true, 'x', { $ne: '' }].filter(
        (candidate) =>
          Array.isArray(candidate) !== Array.isArray(value) ||
          typeof candidate !== typeof value,
      );
    const callerFor = (guard: Guard, pattern: string) =>
      guard === 'admin' || guard === 'adminGate'
        ? admin
        : pattern.startsWith('/api/auth/')
          ? scratch
          : owner;
    for (const item of entries) {
      if (item.entry.stream) continue;
      const cookie = callerFor(item.entry.guard, item.pattern).cookie;
      const body = item.entry.body;
      if (body !== undefined) {
        // Better Auth treats a null proxy body as {}; shape-only variants
        // there need only avoid crashing, field variants must still be 400.
        const strict = !item.pattern.startsWith('/api/auth/');
        const variants: [unknown, boolean][] = [
          [[], strict],
          ['x', strict],
          [7, strict],
          [null, strict],
          [[body], strict],
        ];
        if (body && typeof body === 'object' && !Array.isArray(body))
          for (const [field, value] of Object.entries(body)) {
            for (const replacement of replacements(value))
              variants.push([{ ...body, [field]: replacement }, true]);
            // NUL is valid JSON but invalid Postgres text: never a 500.
            if (typeof value === 'string')
              variants.push([{ ...body, [field]: `${value}\u0000x` }, false]);
            if (value && typeof value === 'object' && !Array.isArray(value))
              for (const [nested, inner] of Object.entries(value))
                for (const replacement of replacements(inner))
                  variants.push([
                    { ...body, [field]: { ...value, [nested]: replacement } },
                    true,
                  ]);
          }
        for (const [variant, strictVariant] of variants) {
          const response = await call(item.method, item.url, cookie, {
            body: variant,
          });
          if (strictVariant)
            assert.equal(
              response.statusCode,
              400,
              `${item.key} accepted ${JSON.stringify(variant)}: ${response.body}`,
            );
        }
      }
      if (item.entry.query)
        for (const [field, value] of Object.entries(item.entry.query)) {
          // Repeated keys arrive as arrays where a string is expected.
          const repeated: URLSearchParams = new URLSearchParams(
            item.entry.query,
          );
          repeated.append(field, value);
          const response = await call(
            item.method,
            `${item.url}?${repeated}`,
            cookie,
            { body },
          );
          assert.equal(response.statusCode, 400, `${item.key} ${repeated}`);
          await call(
            item.method,
            `${item.url}?${new URLSearchParams({ ...item.entry.query, [field]: `${value}\u0000` })}`,
            cookie,
          );
        }
      // Only reads: unknown query keys are ignored by schema-less writes.
      if (item.method === 'GET')
        for (const junk of ['c10[]=1&c10[x]=2', 'constructor=1&__proto__[x]=1'])
          await call(item.method, `${item.url}?${junk}`, cookie);
      if (item.pattern.includes(':id'))
        for (const bad of ['not-a-uuid', '%00', 'x'.repeat(300)]) {
          const response = await call(
            item.method,
            item.url.replace(
              /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|c10-[a-z-]+@[a-z.]+|[A-Za-z0-9]{32}/,
              bad,
            ),
            cookie,
            { body, raw: item.entry.raw },
          );
          assert.ok(
            [400, 404, 414].includes(response.statusCode),
            `${item.key} ${bad}: ${response.statusCode} ${response.body}`,
          );
        }
    }
    const blocked = await call('GET', '/api/auth/list-sessions', owner.cookie);
    assert.equal(blocked.statusCode, 404);
    for (const path of [
      '/update-user',
      '/delete-user',
      '/change-password',
      '/revoke-sessions',
    ])
      assert.equal(
        (await call('POST', `/api/auth${path}`, owner.cookie, { body: {} }))
          .statusCode,
        404,
        path,
      );
    assert.equal((await call('GET', '/api/health', null)).statusCode, 200);
  });

  await t.test('content grants require the live owner session', async () => {
    const grant = (overrides: Partial<Omit<ContentGrant, 'expires'>> = {}) =>
      signContentGrant(
        {
          owner: owner.id,
          session: owner.session,
          message: ids.message,
          version: ids.version,
          kind: 'body',
          images: true,
          ...overrides,
        },
        content.secret,
      );
    const forward = { message: ids.draft, version: ids.draft };
    const valid: Record<string, string> = {
      '/body': grant(),
      '/attachment': grant({ kind: 'attachment', attachment: 0 }),
      '/image': `${grant({ kind: 'image' })}&index=0`,
      '/forward': grant({ kind: 'forward-body', ...forward }),
      '/forward-image': `${grant({ kind: 'forward-image', ...forward })}&index=0`,
    };
    const get = (path: string, token?: string) =>
      contentApp.inject({
        method: 'GET',
        url: token === undefined ? path : `${path}?token=${token}`,
      });
    for (const path of Object.keys(valid))
      assert.equal((await get(path, valid[path])).statusCode, 200, path);
    for (const path of Object.keys(valid)) {
      assert.equal((await get(path)).statusCode, 400, path);
      assert.equal((await get(path, 'c10.forged')).statusCode, 403, path);
      const tampered = valid[path]?.replace(/^[^.]+/, (payload) =>
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
            owner: other.id,
          }),
        ).toString('base64url'),
      );
      assert.equal((await get(path, tampered)).statusCode, 403, path);
      const wrongKind =
        path === '/body' ? valid['/attachment'] : valid['/body'];
      assert.equal((await get(path, wrongKind)).statusCode, 403, path);
      // A signed grant naming another user's session or message is useless.
      const kind = valid[path] ?? '';
      const borrowed = kind.replace(/^[^.]+\.[^&]+/, (token) => {
        const payload = JSON.parse(
          Buffer.from(token.split('.')[0] ?? '', 'base64url').toString(),
        ) as ContentGrant;
        return grant({ ...payload, session: other.session });
      });
      assert.equal((await get(path, borrowed)).statusCode, 404, path);
    }
    const revoke = async (sql: string) => {
      await pool.query(sql, [owner.id]);
      for (const path of Object.keys(valid))
        assert.equal(
          (await get(path, valid[path])).statusCode,
          404,
          `${path} after ${sql}`,
        );
    };
    await revoke(
      "UPDATE auth_sessions SET expires_at=now()-interval '1 minute' WHERE user_id=$1",
    );
    await pool.query(
      "UPDATE auth_sessions SET expires_at=now()+interval '1 day' WHERE user_id=$1",
      [owner.id],
    );
    assert.equal((await get('/body', valid['/body'])).statusCode, 200);
    await revoke('UPDATE users SET email_verified=false WHERE id=$1');
    await pool.query('UPDATE users SET email_verified=true WHERE id=$1', [
      owner.id,
    ]);
    assert.equal((await get('/body', valid['/body'])).statusCode, 200);
    await revoke('UPDATE users SET suspended=true WHERE id=$1');
  });
});
