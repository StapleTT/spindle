import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { SearchError, searchCondition, searchProperty } from './search.js';
import { receivedMembershipCondition } from './view.js';

export class ConversationLimitError extends Error {}
export const conversationLimit = 1000;
const received = `EXISTS(SELECT 1 FROM mail_memberships mm JOIN mailboxes b
  ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=COALESCE(mm.pending_mailbox_id,mm.mailbox_id)
  WHERE mm.user_id=m.user_id AND mm.account_id=m.account_id AND mm.message_id=m.id AND ${receivedMembershipCondition})`;

// Header IDs link a conversation, never physical message identity or ownership.
// UNION terminates cycles; the materialized LIMIT bounds expansion before sorting.
export async function conversationIds(
  pool: Pool,
  owner: string,
  anchor: string,
) {
  const rows = (
    await pool.query<{ id: string }>(
      `
    WITH RECURSIVE related(id,account_id,tokens) AS (
      SELECT m.id,m.account_id,m.thread_tokens FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2 AND ${received}
      UNION
      SELECT m.id,m.account_id,m.thread_tokens FROM related r JOIN mail_messages m
        ON m.user_id=$1 AND m.account_id=r.account_id AND m.thread_tokens && r.tokens WHERE ${received}
    ), bounded AS MATERIALIZED (SELECT id FROM related LIMIT ${conversationLimit + 1})
    SELECT id FROM bounded`,
      [owner, anchor],
    )
  ).rows;
  if (rows.length > conversationLimit)
    throw new ConversationLimitError(
      'This conversation exceeds 1,000 synchronized message copies. Open its messages individually from the list.',
    );
  return rows.map((row) => row.id);
}

export const conversationQuery = { type: 'string', format: 'uuid' };
export function registerConversationRoutes(app: FastifyInstance, pool: Pool) {
  app.get<{
    Params: { id: string };
    Querystring: {
      account?: string;
      mailbox?: string;
      q?: string;
      cursor?: string;
    };
  }>(
    '/api/mail/messages/:id/conversation',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: conversationQuery },
        },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            account: conversationQuery,
            mailbox: conversationQuery,
            q: searchProperty,
            cursor: conversationQuery,
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        anchor = request.params.id;
      const { account, mailbox, q = '', cursor } = request.query;
      const values: unknown[] = [
        owner,
        account ?? null,
        mailbox ?? null,
        anchor,
      ];
      let condition: string;
      try {
        condition = searchCondition(q, values).condition;
      } catch (error) {
        if (error instanceof SearchError)
          return reply.code(400).send({ message: error.message });
        throw error;
      }
      // The source must belong to the requested list/search, before expanding context.
      if (
        !(
          await pool.query(
            `SELECT 1 FROM mail_messages m WHERE ${condition} AND m.id=$4`,
            values,
          )
        ).rowCount
      )
        return reply.code(404).send({
          message:
            'Conversation source not found in this view. Return to the message list.',
        });
      let ids: string[];
      try {
        ids = await conversationIds(pool, owner, anchor);
      } catch (error) {
        if (error instanceof ConversationLimitError)
          return reply.code(413).send({ message: error.message });
        throw error;
      }
      if (cursor && !ids.includes(cursor))
        return reply
          .code(400)
          .send({ message: 'Invalid conversation cursor.' });
      values.push(ids);
      const idsParam = `$${values.length}`;
      values.push(cursor ?? null);
      const cursorParam = `$${values.length}`;
      const rows = (
        await pool.query(
          `SELECT m.id,m.subject,m.sender,m.received_at AS "receivedAt",
        NOT EXISTS(SELECT 1 FROM mail_memberships seen WHERE seen.user_id=m.user_id AND seen.message_id=m.id AND '\\Seen'=ANY(seen.flags)) AS unread,
        (${condition}) AS "matchesView",
        m.reference_ids IS NULL AS "headersPending",
        (SELECT json_agg(folder ORDER BY folder.path) FROM (SELECT DISTINCT b.path,b.role FROM mail_memberships mm JOIN mailboxes b
          ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=COALESCE(mm.pending_mailbox_id,mm.mailbox_id)
          WHERE mm.user_id=m.user_id AND mm.message_id=m.id) folder) AS folders
        FROM mail_messages m WHERE m.user_id=$1 AND m.id=ANY(${idsParam}::uuid[]) AND $4::uuid=ANY(${idsParam}::uuid[])
        AND (${cursorParam}::uuid IS NULL OR (m.received_at,m.id)<(SELECT received_at,id FROM mail_messages WHERE user_id=$1 AND id=${cursorParam}))
        ORDER BY m.received_at DESC,m.id DESC LIMIT 51`,
          values,
        )
      ).rows;
      const messages = rows.slice(0, 50);
      return {
        anchorId: anchor,
        total: ids.length,
        messages,
        nextCursor: rows.length > 50 ? messages.at(-1)?.id : null,
      };
    },
  );
}
