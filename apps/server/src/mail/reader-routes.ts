import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { trimContentCache } from './content-cache.js';
import type { ContentConfig } from './content-config.js';
import { bodyUrl } from './content-server.js';
import { SANITIZER_VERSION } from './sanitize.js';
import { transaction } from './store.js';
import { mailViewCondition } from './view.js';

const params = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
  additionalProperties: false,
};
const view = {
  type: 'object',
  properties: {
    account: { type: 'string', format: 'uuid' },
    mailbox: { type: 'string', format: 'uuid' },
  },
  additionalProperties: false,
};

export function registerReaderRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ContentConfig | null,
) {
  app.get<{
    Params: { id: string };
    Querystring: { account?: string; mailbox?: string };
  }>(
    '/api/mail/messages/:id',
    {
      schema: { params, querystring: view },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '';
      const id = request.params.id;
      const values = [
        owner,
        request.query.account ?? null,
        request.query.mailbox ?? null,
        id,
      ];
      const message = (
        await pool.query(
          `SELECT m.id,m.account_id AS "accountId",a.name AS "accountName",m.subject,m.sender,m.recipients,
      m.received_at AS "receivedAt",m.sent_at AS "sentAt",m.message_id AS "messageId",m.in_reply_to AS "inReplyTo"
      FROM mail_messages m JOIN mail_accounts a ON a.user_id=m.user_id AND a.id=m.account_id
      WHERE ${mailViewCondition} AND m.id=$4`,
          values,
        )
      ).rows[0];
      if (!message)
        return reply
          .code(404)
          .send({ message: 'Message not found in this view.' });
      const neighbors = await Promise.all(
        [
          ['>', 'ASC'],
          ['<', 'DESC'],
        ].map(async ([operator, order]) => {
          return (
            (
              await pool.query(
                `SELECT m.id FROM mail_messages m WHERE ${mailViewCondition}
        AND (m.received_at,m.id) ${operator} (SELECT received_at,id FROM mail_messages WHERE user_id=$1 AND id=$4)
        ORDER BY m.received_at ${order},m.id ${order} LIMIT 1`,
                values,
              )
            ).rows[0]?.id ?? null
          );
        }),
      );
      const cached = (
        await pool.query(
          `UPDATE mail_content SET accessed_at=clock_timestamp() WHERE user_id=$1 AND message_id=$2
      RETURNING *,expires_at>clock_timestamp() AND (state<>'ready' OR sanitizer_version=${SANITIZER_VERSION}) AS fresh`,
          [owner, id],
        )
      ).rows[0];
      const state = !cached?.fresh ? 'missing' : cached.state;
      return {
        message,
        previous: neighbors[0],
        next: neighbors[1],
        content: {
          state,
          configured: Boolean(config),
          ...(state === 'ready'
            ? {
                plainText: cached.plain_text,
                hasHtml: Boolean(cached.html),
                imageCount: cached.resources.length,
                htmlUrl:
                  config && cached.html
                    ? bodyUrl(
                        config,
                        owner,
                        request.mailSession ?? '',
                        id,
                        cached.version,
                      )
                    : null,
                expiresAt: cached.expires_at,
              }
            : {}),
          ...(state === 'failed'
            ? {
                message:
                  'This message could not be fetched. It may have moved, exceeded a size limit, or the provider may be unavailable.',
              }
            : {}),
        },
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { retry?: boolean } }>(
    '/api/mail/messages/:id/content',
    {
      schema: {
        params,
        body: {
          type: 'object',
          properties: { retry: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '';
      const id = request.params.id;
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        const message = (
          await db.query(
            `SELECT m.account_id FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2
        AND EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=$1 AND mm.message_id=m.id)`,
            [owner, id],
          )
        ).rows[0];
        if (!message) return null;
        const cached = (
          await db.query(
            `SELECT *,expires_at>clock_timestamp() AND (state<>'ready' OR sanitizer_version=${SANITIZER_VERSION}) AS fresh FROM mail_content WHERE user_id=$1 AND message_id=$2 FOR UPDATE`,
            [owner, id],
          )
        ).rows[0];
        if (cached?.fresh && (cached.state !== 'failed' || !request.body.retry))
          return cached.state as string;
        await db.query(
          'DELETE FROM mail_content WHERE user_id=$1 AND message_id=$2',
          [owner, id],
        );
        await db.query(
          'INSERT INTO mail_content(user_id,account_id,message_id) VALUES($1,$2,$3)',
          [owner, message.account_id, id],
        );
        await trimContentCache(db, owner, id);
        return 'pending';
      });
      if (!result)
        return reply.code(404).send({ message: 'Message not found.' });
      return reply
        .code(result === 'pending' ? 202 : 200)
        .send({ state: result });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/mail/messages/:id/images',
    { schema: { params } },
    async (request, reply) => {
      if (!config)
        return reply.code(503).send({
          message: 'The isolated content server needs to be configured.',
        });
      const owner = request.mailUser ?? '';
      const id = request.params.id;
      const content = (
        await pool.query(
          `SELECT version FROM mail_content c WHERE user_id=$1 AND message_id=$2 AND state='ready'
      AND sanitizer_version=${SANITIZER_VERSION} AND expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=$1 AND mm.message_id=c.message_id)`,
          [owner, id],
        )
      ).rows[0];
      if (!content)
        return reply.code(404).send({ message: 'Cached message not found.' });
      return {
        htmlUrl: bodyUrl(
          config,
          owner,
          request.mailSession ?? '',
          id,
          content.version,
          true,
        ),
      };
    },
  );
}
