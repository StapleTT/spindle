import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Auth } from '../auth/auth.js';
import type { AuthConfig } from '../auth/config.js';
import { authHeaders } from '../auth/routes.js';
import { registerContactRoutes } from './contacts.js';
import type { ContentConfig } from './content-config.js';
import { registerConversationStateRoutes } from './conversation-state.js';
import { registerConversationRoutes } from './conversations.js';
import { encryptCredential, type MailKeys } from './credentials.js';
import { registerDraftRoutes } from './drafts.js';
import { registerMailEvents } from './events.js';
import { registerUploadRoutes } from './file-uploads.js';
import { registerNotificationRoutes } from './notifications.js';
import { registerOutgoingRoutes } from './outgoing-routes.js';
import { registerProviderDraftRoutes } from './provider-draft-routes.js';
import { registerReaderRoutes } from './reader-routes.js';
import {
  cachedBodyCondition,
  SearchError,
  searchCondition,
  searchKey,
  searchProperty,
  unreadCondition,
} from './search.js';
import { registerSignatureRoutes, signatureField } from './signatures.js';
import { consumeLimit, transaction } from './store.js';
import { registerTriageRoutes } from './triage-routes.js';
import { localStateFields, receivedMembershipCondition } from './view.js';

declare module 'fastify' {
  interface FastifyRequest {
    mailUser?: string;
    mailSession?: string;
  }
}

const uuid = { type: 'string', format: 'uuid' };
const accountParams = {
  type: 'object',
  required: ['id'],
  properties: { id: uuid },
  additionalProperties: false,
};
const accountFields = `id,name,color,host,port,transport,username,status,error_code AS "errorCode",
  last_synced_at AS "lastSyncedAt",history_since AS "historySince"`;

function parseCursor(value: string | undefined, key?: string) {
  if (!value) return null;
  try {
    const cursor: unknown = JSON.parse(
      Buffer.from(value, 'base64url').toString(),
    );
    if (
      !Array.isArray(cursor) ||
      ![key ? 3 : 2, key ? 4 : 3].includes(cursor.length) ||
      (key && cursor[2] !== key) ||
      (cursor.length === (key ? 4 : 3) &&
        typeof cursor[key ? 3 : 2] !== 'boolean') ||
      typeof cursor[0] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor[0]) ||
      !Number.isFinite(Date.parse(cursor[0])) ||
      new Date(cursor[0]).toISOString().slice(0, 19) !==
        cursor[0].slice(0, 19) ||
      typeof cursor[1] !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        cursor[1],
      )
    )
      return false;
    return [cursor[0], cursor[1], cursor[key ? 3 : 2] ?? false] as [
      string,
      string,
      boolean,
    ];
  } catch {
    return false;
  }
}

export async function registerMailRoutes(
  app: FastifyInstance,
  pool: Pool,
  auth: Auth,
  config: AuthConfig,
  keys: MailKeys,
  content: ContentConfig | null,
) {
  app.decorateRequest('mailUser', '');
  app.decorateRequest('mailSession', '');
  app.addHook('preHandler', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.method !== 'GET' && request.headers.origin !== config.appUrl)
      return reply
        .code(403)
        .send({ message: 'Request origin is not allowed.' });
    const current = await auth.api.getSession({
      headers: authHeaders(request),
    });
    if (!current)
      return reply.code(401).send({ message: 'Sign in to continue.' });
    if (!current.user.emailVerified)
      return reply
        .code(403)
        .send({ message: 'Verify your email to continue.' });
    request.mailUser = current.user.id;
    request.mailSession = current.session.id;
    if (
      !(await consumeLimit(
        pool,
        current.user.id,
        request.routeOptions.url?.startsWith('/api/mail/contacts')
          ? 'contacts'
          : request.method === 'GET'
            ? 'read'
            : request.routeOptions.url?.startsWith('/api/mail/uploads')
              ? 'upload'
              : request.routeOptions.url === '/api/mail/drafts/:id/send'
                ? 'send'
                : request.routeOptions.url?.startsWith('/api/mail/drafts')
                  ? 'draft'
                  : request.routeOptions.url?.startsWith('/api/mail/messages/')
                    ? 'reader'
                    : 'write',
        request.routeOptions.url?.startsWith('/api/mail/contacts')
          ? 120
          : request.method === 'GET'
            ? 240
            : request.routeOptions.url?.startsWith('/api/mail/uploads')
              ? 60
              : request.routeOptions.url === '/api/mail/drafts/:id/send'
                ? 10
                : request.routeOptions.url?.startsWith('/api/mail/drafts')
                  ? 120
                  : request.routeOptions.url?.startsWith('/api/mail/messages/')
                    ? 60
                    : 10,
      ))
    )
      return reply
        .code(429)
        .header('retry-after', '60')
        .send({ message: 'Too many requests. Try again in a minute.' });
  });

  registerMailEvents(app, pool, config);
  registerNotificationRoutes(app, pool);

  app.get('/api/mail/accounts', async (request) => ({
    configured: keys.keys.has(keys.active),
    accounts: (
      await pool.query(
        `SELECT ${accountFields},${signatureField},(SELECT state FROM mail_smtp s WHERE s.user_id=a.user_id AND s.account_id=a.id) AS "smtpState",
        (SELECT username FROM mail_smtp s WHERE s.user_id=a.user_id AND s.account_id=a.id) AS sender,
        (SELECT display_name FROM mail_smtp s WHERE s.user_id=a.user_id AND s.account_id=a.id) AS "senderName",
        (SELECT count(*)::int FROM mailboxes b WHERE b.user_id=$1 AND b.account_id=a.id AND NOT b.initial_complete) AS "foldersRemaining"
       FROM mail_accounts a WHERE user_id=$1 ORDER BY created_at,id`,
        [request.mailUser],
      )
    ).rows,
  }));

  app.patch<{ Params: { id: string }; Body: { color: string | null } }>(
    '/api/mail/accounts/:id/color',
    {
      bodyLimit: 256,
      schema: {
        params: accountParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['color'],
          properties: {
            color: {
              anyOf: [
                { type: 'null' },
                { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
              ],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await pool.query(
        'UPDATE mail_accounts SET color=$3 WHERE user_id=$1 AND id=$2 RETURNING id,color',
        [
          request.mailUser,
          request.params.id,
          request.body.color?.toLowerCase() ?? null,
        ],
      );
      if (!result.rowCount)
        return reply.code(404).send({ message: 'Mail account not found.' });
      return { account: result.rows[0] };
    },
  );

  app.post<{
    Body: {
      name: string;
      host: string;
      port: number;
      transport: 'tls' | 'starttls';
      username: string;
      password: string;
      history: '90d' | 'all';
    };
  }>(
    '/api/mail/accounts',
    {
      bodyLimit: 8192,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: [
            'name',
            'host',
            'port',
            'transport',
            'username',
            'password',
            'history',
          ],
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 100,
              pattern: '^[^\\u0000-\\u001f]+$',
            },
            host: {
              type: 'string',
              minLength: 1,
              maxLength: 253,
              pattern: '^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$',
            },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            transport: { type: 'string', enum: ['tls', 'starttls'] },
            username: {
              type: 'string',
              minLength: 1,
              maxLength: 320,
              pattern: '^[^\\u0000-\\u001f]+$',
            },
            password: {
              type: 'string',
              minLength: 1,
              maxLength: 1024,
              pattern: '^[^\\u0000]+$',
            },
            history: { type: 'string', enum: ['90d', 'all'] },
          },
        },
      },
    },
    async (request, reply) => {
      if (!keys.keys.has(keys.active))
        return reply.code(503).send({
          message: 'Mail encryption needs to be configured by the operator.',
        });
      const body = request.body;
      const owner = request.mailUser ?? '';
      const result = await transaction(pool, async (db) => {
        // Serialize account-limit checks and reconnects across API instances.
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        const host = body.host.toLowerCase();
        const existing = (
          await db.query(
            'SELECT id FROM mail_accounts WHERE user_id=$1 AND host=$2 AND port=$3 AND username=$4',
            [owner, host, body.port, body.username],
          )
        ).rows[0];
        if (!existing) {
          const count = (
            await db.query(
              'SELECT count(*)::int AS count FROM mail_accounts WHERE user_id=$1',
              [owner],
            )
          ).rows[0].count;
          if (count >= 5) return null;
        }
        const id = existing?.id ?? randomUUID();
        const credential = encryptCredential(body.password, owner, id, keys);
        if (existing) {
          await db.query(
            `UPDATE mail_accounts SET name=$3,transport=$4,credential=$5,status='pending',
          error_code=NULL,failures=0,next_sync_at=clock_timestamp(),sync_request=gen_random_uuid(),lease_token=NULL,lease_until=NULL,
          next_idle_at=clock_timestamp(),idle_failures=0
          WHERE user_id=$1 AND id=$2`,
            [owner, id, body.name, body.transport, credential],
          );
        } else {
          await db.query(
            `INSERT INTO mail_accounts(id,user_id,name,host,port,transport,username,credential,history_since)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [
              id,
              owner,
              body.name,
              host,
              body.port,
              body.transport,
              body.username,
              credential,
              body.history === '90d'
                ? new Date(Date.now() - 90 * 86400000)
                : null,
            ],
          );
        }
        return (
          await db.query(
            `SELECT ${accountFields} FROM mail_accounts WHERE user_id=$1 AND id=$2`,
            [owner, id],
          )
        ).rows[0];
      });
      if (!result)
        return reply
          .code(409)
          .send({ message: 'You can connect up to five mail accounts.' });
      return reply.code(202).send({ account: result });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/mail/accounts/:id/sync',
    { schema: { params: accountParams } },
    async (request, reply) => {
      const result = await pool.query(
        `UPDATE mail_accounts SET next_sync_at=clock_timestamp(),sync_request=gen_random_uuid()
      WHERE user_id=$1 AND id=$2 RETURNING id`,
        [request.mailUser, request.params.id],
      );
      if (!result.rowCount)
        return reply.code(404).send({ message: 'Mail account not found.' });
      return reply.code(202).send({
        message: 'Sync requested. The worker will check this account shortly.',
      });
    },
  );

  app.delete<{ Params: { id: string }; Body: { password: string } }>(
    '/api/mail/accounts/:id',
    {
      schema: {
        params: accountParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['password'],
          properties: {
            password: { type: 'string', minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser;
      const credential = (
        await pool.query(
          `SELECT password FROM auth_accounts WHERE user_id=$1 AND provider_id='credential'`,
          [owner],
        )
      ).rows[0];
      const context = await auth.$context;
      if (
        !credential?.password ||
        !(await context.password.verify({
          hash: credential.password,
          password: request.body.password,
        }))
      )
        return reply
          .code(403)
          .send({ message: 'Confirm your Spindle password to disconnect.' });
      const result = await pool.query(
        'DELETE FROM mail_accounts WHERE user_id=$1 AND id=$2 RETURNING id',
        [owner, request.params.id],
      );
      if (!result.rowCount)
        return reply.code(404).send({ message: 'Mail account not found.' });
      return {
        message:
          'Disconnected. The local mirror was removed; mail at your provider is unchanged.',
      };
    },
  );

  app.get('/api/mail/mailboxes', async (request) => ({
    mailboxes: (
      await pool.query(
        `SELECT b.id,b.account_id AS "accountId",b.name,b.path,b.role,b.initial_complete AS "initialComplete",
      count(mm.message_id) FILTER(WHERE (b.role='\\Drafts' OR (${receivedMembershipCondition})) AND (b.role IS DISTINCT FROM 'inbox' OR coalesce(m.local_snoozed_until<=clock_timestamp(),true)))::int AS total,
      count(mm.message_id) FILTER(WHERE (b.role='\\Drafts' OR (${receivedMembershipCondition})) AND NOT('\\Seen'=ANY(mm.flags)) AND (b.role IS DISTINCT FROM 'inbox' OR coalesce(m.local_snoozed_until<=clock_timestamp(),true)))::int AS unread
      FROM mailboxes b LEFT JOIN mail_memberships mm ON mm.user_id=b.user_id AND mm.account_id=b.account_id
        AND COALESCE(mm.pending_mailbox_id,mm.mailbox_id)=b.id
      LEFT JOIN mail_messages m ON m.user_id=mm.user_id AND m.id=mm.message_id
      WHERE b.user_id=$1 GROUP BY b.id ORDER BY b.account_id,CASE WHEN b.role='inbox' THEN 0 ELSE 1 END,b.path`,
        [request.mailUser],
      )
    ).rows,
  }));

  app.get<{
    Querystring: {
      account?: string;
      mailbox?: string;
      cursor?: string;
      q?: string;
      limit?: string;
    };
  }>(
    '/api/mail/messages',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            account: uuid,
            mailbox: uuid,
            q: searchProperty,
            cursor: { type: 'string', maxLength: 256 },
            limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|100)$' },
          },
        },
      },
    },
    async (request, reply) => {
      const { account, mailbox, cursor, q = '' } = request.query;
      const limit = Number(request.query.limit ?? '50');
      const owner = request.mailUser;
      const key = searchKey(owner ?? '', account, mailbox, q);
      const after = parseCursor(cursor, key);
      if (after === false)
        return reply.code(400).send({ message: 'Invalid inbox cursor.' });
      if (
        account &&
        !(
          await pool.query(
            'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2',
            [owner, account],
          )
        ).rowCount
      )
        return reply.code(404).send({ message: 'Mail account not found.' });
      if (
        mailbox &&
        !(
          await pool.query(
            `SELECT id FROM mailboxes WHERE user_id=$1 AND id=$2 AND ($3::uuid IS NULL OR account_id=$3)`,
            [owner, mailbox, account ?? null],
          )
        ).rowCount
      )
        return reply.code(404).send({ message: 'Folder not found.' });
      const values: unknown[] = [
        owner,
        account ?? null,
        mailbox ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        limit + 1,
        after?.[2] ?? false,
      ];
      let search: ReturnType<typeof searchCondition>;
      try {
        search = searchCondition(q, values);
      } catch (error) {
        if (error instanceof SearchError)
          return reply.code(400).send({ message: error.message });
        throw error;
      }
      const result = await pool.query(
        `SELECT m.id,m.account_id AS "accountId",a.name AS "accountName",m.subject,m.sender,m.recipients,
       m.received_at AS "receivedAt",m.sent_at AS "sentAt",
       to_char(m.received_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorTime",
       ${unreadCondition} AS unread,${localStateFields}
       FROM mail_messages m JOIN mail_accounts a ON a.user_id=m.user_id AND a.id=m.account_id
       WHERE ${search.condition}
       AND ($4::timestamptz IS NULL OR (m.local_pinned,m.received_at,m.id)<($7::boolean,$4::timestamptz,$5::uuid))
       ORDER BY m.local_pinned DESC,m.received_at DESC,m.id DESC LIMIT $6`,
        values,
      );
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const last = rows.at(-1);
      const coverage = q.trim()
        ? (
            await pool.query(
              `SELECT count(*)::int AS messages,count(*) FILTER(WHERE EXISTS(SELECT 1 FROM mail_content c WHERE ${cachedBodyCondition}))::int AS "cachedBodies" FROM mail_messages m WHERE ${search.base}`,
              [owner, account ?? null, mailbox ?? null],
            )
          ).rows[0]
        : null;
      return {
        coverage,
        messages: rows.map(
          ({ cursorTime: _cursorTime, ...message }) => message,
        ),
        nextCursor:
          hasMore && last
            ? Buffer.from(
                JSON.stringify(
                  key
                    ? [last.cursorTime, last.id, key, last.pinned]
                    : [last.cursorTime, last.id, last.pinned],
                ),
              ).toString('base64url')
            : null,
      };
    },
  );
  registerTriageRoutes(app, pool);
  registerContactRoutes(app, pool);
  registerReaderRoutes(app, pool, content);
  registerConversationRoutes(app, pool);
  registerConversationStateRoutes(app, pool);
  registerSignatureRoutes(app, pool);
  registerDraftRoutes(app, pool, content);
  registerUploadRoutes(app, pool);
  registerProviderDraftRoutes(app, pool);
  registerOutgoingRoutes(app, pool, keys);
}
