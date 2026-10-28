import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import {
  type ActionKind,
  currentFolder,
  moveDestination,
  moveKinds,
  moveRoles,
  refreshPendingFolder,
  restoreDestination,
  withSeen,
} from './actions.js';
import { trimContentCache } from './content-cache.js';
import type { ContentConfig } from './content-config.js';
import { attachmentUrl, bodyUrl } from './content-server.js';
import type { AttachmentInfo } from './media.js';
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
      m.received_at AS "receivedAt",m.sent_at AS "sentAt",m.message_id AS "messageId",m.in_reply_to AS "inReplyTo",
      NOT EXISTS(SELECT 1 FROM mail_memberships seen WHERE seen.user_id=$1 AND seen.message_id=m.id
        AND '\\Seen'=ANY(seen.flags)) AS unread,
      (SELECT json_build_object('id',x.id,'kind',x.kind,'state',x.state) FROM mail_actions x
        WHERE x.user_id=$1 AND x.message_id=m.id ORDER BY x.seq DESC LIMIT 1) AS "lastAction",
      (SELECT json_build_object('archive',bool_or(t.role='${moveRoles.archive}'),'trash',bool_or(t.role='${moveRoles.trash}'))
        FROM mailboxes t WHERE t.user_id=$1 AND t.account_id=m.account_id AND t.role IN ('${moveRoles.archive}','${moveRoles.trash}')
        AND NOT EXISTS(SELECT 1 FROM mail_memberships here WHERE here.user_id=$1 AND here.message_id=m.id
          AND COALESCE(here.pending_mailbox_id,here.mailbox_id)=t.id)) AS "canMove"
      FROM mail_messages m JOIN mail_accounts a ON a.user_id=m.user_id AND a.id=m.account_id
      WHERE ${mailViewCondition} AND m.id=$4`,
          values,
        )
      ).rows[0];
      if (!message)
        return reply
          .code(404)
          .send({ message: 'Message not found in this view.' });
      const folder = await currentFolder(pool, owner, id);
      const restore =
        folder &&
        (await restoreDestination(pool, owner, message.accountId, id, folder));
      message.folderId = folder?.id ?? null;
      message.restoreTo = restore && restore.id !== folder?.id ? restore : null;
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
      const fetched = new Map<number, string>();
      if (state === 'ready')
        for (const row of (
          await pool.query(
            'SELECT position,state FROM mail_content_attachments WHERE user_id=$1 AND message_id=$2',
            [owner, id],
          )
        ).rows)
          fetched.set(row.position, row.state);
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
                attachments: (cached.attachments as AttachmentInfo[]).map(
                  ({ filename, contentType, size }, index) => ({
                    index,
                    filename,
                    contentType,
                    size,
                    state: fetched.get(index) ?? 'missing',
                  }),
                ),
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

  app.post<{
    Params: { id: string };
    Body: { id: string; kind: ActionKind; mailbox?: string };
  }>(
    '/api/mail/messages/:id/actions',
    {
      schema: {
        params,
        body: {
          type: 'object',
          required: ['id', 'kind'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            kind: {
              type: 'string',
              enum: ['read', 'unread', 'archive', 'trash', 'move', 'restore'],
            },
            mailbox: { type: 'string', format: 'uuid' },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '';
      const { id: action, kind, mailbox } = request.body;
      if ((kind === 'move') !== Boolean(mailbox))
        return reply
          .code(400)
          .send({ message: 'Choose a folder only when moving a message.' });
      const result = await transaction(pool, async (db) => {
        // Locking the message serializes action order with its local changes.
        const message = (
          await db.query(
            `SELECT m.account_id FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2
        AND EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=$1 AND mm.message_id=m.id) FOR UPDATE`,
            [owner, request.params.id],
          )
        ).rows[0];
        if (!message) return null;
        const recorded = `SELECT a.id,a.kind,a.state,t.path AS target,a.message_id,a.target_mailbox_id
          FROM mail_actions a LEFT JOIN mailboxes t ON t.user_id=a.user_id AND t.id=a.target_mailbox_id
          WHERE a.id=$1 AND a.user_id=$2`;
        // A retried request with the same operation ID returns the original intent.
        const existing = (await db.query(recorded, [action, owner])).rows[0];
        if (existing)
          return existing.message_id === request.params.id &&
            existing.kind === kind &&
            (!mailbox || existing.target_mailbox_id === mailbox)
            ? existing
            : 'conflict';
        let source: string | null = null;
        let target: string | null = null;
        if (moveKinds.includes(kind)) {
          const destination = await moveDestination(
            db,
            owner,
            message.account_id,
            request.params.id,
            kind as 'archive' | 'trash' | 'move' | 'restore',
            mailbox,
          );
          if ('error' in destination) return destination;
          source = destination.source;
          target = destination.target.id;
        }
        const inserted = await db.query(
          `INSERT INTO mail_actions(id,user_id,account_id,message_id,kind,source_mailbox_id,target_mailbox_id)
          VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
          [
            action,
            owner,
            message.account_id,
            request.params.id,
            kind,
            source,
            target,
          ],
        );
        if (!inserted.rowCount) return 'conflict';
        await db.query(
          `UPDATE mail_memberships SET flags=${withSeen('flags', '$3::text')} WHERE user_id=$1 AND message_id=$2`,
          [owner, request.params.id, kind],
        );
        await refreshPendingFolder(db, owner, request.params.id);
        return (await db.query(recorded, [action, owner])).rows[0];
      });
      if (!result)
        return reply.code(404).send({ message: 'Message not found.' });
      if (result === 'conflict')
        return reply
          .code(409)
          .send({ message: 'This action ID was already used.' });
      if ('error' in result)
        return reply.code(409).send({ message: result.error });
      const { id, state, target } = result;
      return reply
        .code(202)
        .send({ action: { id, kind: result.kind, state }, target });
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

  app.post<{
    Params: { id: string; index: string };
    Body: { retry?: boolean };
  }>(
    '/api/mail/messages/:id/attachments/:index',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id', 'index'],
          properties: {
            id: { type: 'string', format: 'uuid' },
            index: { type: 'string', pattern: '^(?:0|[1-9][0-9]?)$' },
          },
          additionalProperties: false,
        },
        body: {
          type: 'object',
          properties: { retry: { type: 'boolean' } },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      if (!config)
        return reply.code(503).send({
          message: 'Attachment downloads need the isolated content server.',
        });
      const owner = request.mailUser ?? '';
      const id = request.params.id;
      const index = Number(request.params.index);
      const result = await transaction(pool, async (db) => {
        const content = (
          await db.query(
            `SELECT c.version,c.account_id FROM mail_content c WHERE c.user_id=$1 AND c.message_id=$2 AND c.state='ready'
        AND c.sanitizer_version=${SANITIZER_VERSION} AND c.expires_at>clock_timestamp() AND jsonb_array_length(c.attachments)>$3
        AND EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=$1 AND mm.message_id=c.message_id) FOR UPDATE`,
            [owner, id, index],
          )
        ).rows[0];
        if (!content) return null;
        const existing = (
          await db.query(
            'SELECT state FROM mail_content_attachments WHERE user_id=$1 AND message_id=$2 AND position=$3',
            [owner, id, index],
          )
        ).rows[0];
        if (existing && (existing.state !== 'failed' || !request.body.retry))
          return { state: existing.state as string, version: content.version };
        await db.query(
          'DELETE FROM mail_content_attachments WHERE user_id=$1 AND message_id=$2 AND position=$3',
          [owner, id, index],
        );
        await db.query(
          'INSERT INTO mail_content_attachments(user_id,account_id,message_id,position) VALUES($1,$2,$3,$4)',
          [owner, content.account_id, id, index],
        );
        return { state: 'pending', version: content.version };
      });
      if (!result)
        return reply.code(404).send({ message: 'Attachment not found.' });
      if (result.state === 'ready')
        return {
          state: 'ready',
          url: attachmentUrl(
            config,
            owner,
            request.mailSession ?? '',
            id,
            result.version,
            index,
          ),
        };
      if (result.state === 'failed')
        return {
          state: 'failed',
          message:
            'This attachment could not be fetched. It may have moved, exceeded the 10 MiB attachment or cache limit, or the provider may be unavailable.',
        };
      return reply.code(202).send({ state: result.state });
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
