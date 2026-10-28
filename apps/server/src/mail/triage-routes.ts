import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { queueAction } from './action-intent.js';
import { parseSearch, SearchError } from './search.js';
import { consumeLimit, transaction } from './store.js';

const uuid = { type: 'string', format: 'uuid' };
const params = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: uuid },
};
export function registerTriageRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/api/mail/searches', async (request) => ({
    searches: (
      await pool.query(
        'SELECT id,name,query,account_id AS "accountId",mailbox_id AS "mailboxId" FROM mail_saved_searches WHERE user_id=$1 ORDER BY name,id LIMIT 50',
        [request.mailUser],
      )
    ).rows,
  }));
  app.put<{
    Params: { id: string };
    Body: {
      name: string;
      query: string;
      accountId: string | null;
      mailboxId: string | null;
    };
  }>(
    '/api/mail/searches/:id',
    {
      schema: {
        params,
        body: {
          type: 'object',
          required: ['name', 'query', 'accountId', 'mailboxId'],
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
              pattern: '^[^\\u0000-\\u001f]*$',
            },
            query: { type: 'string', minLength: 1, maxLength: 500 },
            accountId: { anyOf: [uuid, { type: 'null' }] },
            mailboxId: { anyOf: [uuid, { type: 'null' }] },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        body = request.body;
      try {
        parseSearch(body.query);
      } catch (error) {
        if (error instanceof SearchError)
          return reply.code(400).send({ message: error.message });
        throw error;
      }
      if (!body.query.trim() || !body.name.trim())
        return reply.code(400).send({ message: 'Enter a name and search.' });
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        if (
          body.accountId &&
          !(
            await db.query(
              'SELECT 1 FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR KEY SHARE',
              [owner, body.accountId],
            )
          ).rowCount
        )
          return 'missing';
        if (
          body.mailboxId &&
          !(
            await db.query(
              'SELECT 1 FROM mailboxes WHERE user_id=$1 AND id=$2 AND ($3::uuid IS NULL OR account_id=$3) FOR KEY SHARE',
              [owner, body.mailboxId, body.accountId],
            )
          ).rowCount
        )
          return 'missing';
        const existing = (
          await db.query(
            'SELECT * FROM mail_saved_searches WHERE user_id=$1 AND id=$2',
            [owner, request.params.id],
          )
        ).rows[0];
        if (existing)
          return existing.name === body.name.trim() &&
            existing.query === body.query.trim() &&
            existing.account_id === body.accountId &&
            existing.mailbox_id === body.mailboxId
            ? 'ok'
            : 'conflict';
        if (
          (
            await db.query(
              'SELECT count(*)::int AS n FROM mail_saved_searches WHERE user_id=$1',
              [owner],
            )
          ).rows[0].n >= 50
        )
          return 'quota';
        const inserted = await db.query(
          'INSERT INTO mail_saved_searches(id,user_id,name,query,account_id,mailbox_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
          [
            request.params.id,
            owner,
            body.name.trim(),
            body.query.trim(),
            body.accountId,
            body.mailboxId,
          ],
        );
        return inserted.rowCount ? 'ok' : 'conflict';
      });
      if (result === 'missing')
        return reply
          .code(404)
          .send({ message: 'The search account or folder is unavailable.' });
      if (result !== 'ok')
        return reply.code(409).send({
          message:
            result === 'quota'
              ? 'You can keep up to 50 saved searches.'
              : 'That search name or ID is already used.',
        });
      return { saved: true };
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/mail/searches/:id',
    { schema: { params } },
    async (request, reply) => {
      const removed = await pool.query(
        'DELETE FROM mail_saved_searches WHERE user_id=$1 AND id=$2',
        [request.mailUser, request.params.id],
      );
      return removed.rowCount
        ? { removed: true }
        : reply.code(404).send({ message: 'Saved search not found.' });
    },
  );
  app.post<{
    Body: {
      kind: 'read' | 'unread' | 'archive' | 'trash';
      items: { id: string; messageId: string }[];
    };
  }>(
    '/api/mail/batch-actions',
    {
      bodyLimit: 16 * 1024,
      schema: {
        body: {
          type: 'object',
          required: ['kind', 'items'],
          additionalProperties: false,
          properties: {
            kind: {
              type: 'string',
              enum: ['read', 'unread', 'archive', 'trash'],
            },
            items: {
              type: 'array',
              minItems: 1,
              maxItems: 50,
              uniqueItems: true,
              items: {
                type: 'object',
                required: ['id', 'messageId'],
                additionalProperties: false,
                properties: { id: uuid, messageId: uuid },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        { kind, items } = request.body;
      if (
        new Set(items.map((item) => item.messageId)).size !== items.length ||
        new Set(items.map((item) => item.id)).size !== items.length
      )
        return reply.code(400).send({
          message: 'Select each message once with a distinct action ID.',
        });
      const results = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        const results = [];
        for (const item of [...items].sort((a, b) =>
          a.messageId.localeCompare(b.messageId),
        )) {
          const known = (
            await db.query(
              'SELECT 1 FROM mail_actions WHERE user_id=$1 AND id=$2',
              [owner, item.id],
            )
          ).rowCount;
          if (!known && !(await consumeLimit(db, owner, 'reader', 60))) {
            results.push({
              messageId: item.messageId,
              error:
                'Action limit reached. Try this message again in a minute.',
            });
            continue;
          }
          const result = await queueAction(
            db,
            owner,
            item.messageId,
            item.id,
            kind,
          );
          if (!result || result === 'conflict' || 'error' in result)
            results.push({
              messageId: item.messageId,
              error: !result
                ? 'Message not found.'
                : result === 'conflict'
                  ? 'Action ID already used.'
                  : result.error,
            });
          else
            results.push({
              messageId: item.messageId,
              action: { id: result.id, kind: result.kind, state: result.state },
              target: result.target,
              undoMs: result.undoMs,
            });
        }
        return results;
      });
      return reply.code(202).send({ results });
    },
  );
}
