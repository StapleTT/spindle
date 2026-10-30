import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { unreadCondition } from './search.js';
import { mailViewCondition } from './view.js';

const preview = (value: unknown, size: number) =>
  typeof value === 'string'
    ? Array.from(
        value.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ').trim(),
      )
        .slice(0, size)
        .join('')
    : '';
export function registerNotificationRoutes(app: FastifyInstance, pool: Pool) {
  app.get<{ Querystring: { since?: string } }>(
    '/api/mail/notifications',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            since: { type: 'string', format: 'date-time', maxLength: 40 },
          },
        },
      },
    },
    async (request) => {
      const owner = request.mailUser ?? '';
      const state = (
        await pool.query(
          `WITH arrivals AS (
      SELECT m.id,m.notification_at,m.sender,m.subject FROM mail_messages m WHERE ${mailViewCondition} AND ${unreadCondition}
      AND $4::timestamptz IS NOT NULL AND NOT m.local_muted
      AND m.notification_at>=greatest($4::timestamptz,clock_timestamp()-interval '5 minutes')
      AND m.received_at>=m.notification_at-interval '5 minutes'
      ORDER BY m.notification_at DESC,m.id DESC LIMIT 50
    ) SELECT clock_timestamp() AS "serverTime",(SELECT count(*)::int FROM mail_messages m WHERE ${mailViewCondition} AND ${unreadCondition}) AS "unreadCount",
      coalesce((SELECT json_agg(arrivals ORDER BY notification_at DESC,id DESC) FROM arrivals),'[]') AS arrivals`,
          [owner, null, null, request.query.since ?? null],
        )
      ).rows[0];
      return {
        userId: owner,
        serverTime: state.serverTime,
        unreadCount: state.unreadCount,
        arrivals: state.arrivals.map(
          (row: { id: string; subject: unknown; sender: unknown }) => {
            const first = Array.isArray(row.sender) ? row.sender[0] : undefined;
            return {
              id: row.id,
              subject: preview(row.subject, 120),
              sender: preview(first?.name || first?.address, 100),
            };
          },
        ),
      };
    },
  );
}
