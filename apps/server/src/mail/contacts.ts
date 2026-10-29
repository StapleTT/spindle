import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { emailAddress } from './smtp.js';
import { receivedMembershipCondition } from './view.js';

const eligible = `EXISTS(SELECT 1 FROM mail_memberships mm JOIN mailboxes b
  ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=coalesce(mm.pending_mailbox_id,mm.mailbox_id)
  WHERE mm.user_id=m.user_id AND mm.message_id=m.id AND ${receivedMembershipCondition}
  AND b.role IS DISTINCT FROM '\\Trash' AND b.role IS DISTINCT FROM '\\Junk' AND NOT('\\Deleted'=ANY(mm.flags)))`;
const people = `SELECT m.id,m.account_id,m.received_at,lower(p.value->>'address') AS address,
  CASE WHEN jsonb_typeof(p.value->'name')='string' THEN left(p.value->>'name',200) ELSE '' END AS name
  FROM candidates m CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m.sender)='array' THEN m.sender ELSE '[]'::jsonb END ||
    CASE WHEN jsonb_typeof(m.recipients->'to')='array' THEN m.recipients->'to' ELSE '[]'::jsonb END ||
    CASE WHEN jsonb_typeof(m.recipients->'cc')='array' THEN m.recipients->'cc' ELSE '[]'::jsonb END
  ) WITH ORDINALITY p(value,n)
  WHERE p.n<=300 AND jsonb_typeof(p.value->'address')='string'
    AND length(p.value->>'address')<=254 AND p.value->>'address' !~ '[[:space:]<>(),:;"\\\\]'
    AND p.value->>'address' ~ '^[!-~]+@[a-zA-Z0-9.-]+[.][a-zA-Z0-9-]+$'`;
const notSelf = `NOT EXISTS(SELECT 1 FROM mail_accounts a WHERE a.user_id=$1 AND lower(a.username)=p.address)
  AND NOT EXISTS(SELECT 1 FROM mail_smtp s WHERE s.user_id=$1 AND lower(s.username)=p.address)`;
type Contact = { name: string; address: string };
const clean = (rows: Contact[]) =>
  rows
    .filter((row) => emailAddress(row.address))
    .map((row) => ({
      address: row.address,
      name: row.name.replace(/\p{Cc}/gu, ' ').trim(),
    }));

export function registerContactRoutes(app: FastifyInstance, pool: Pool) {
  app.get<{ Querystring: { q: string; account?: string } }>(
    '/api/mail/contacts',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['q'],
          properties: {
            q: {
              type: 'string',
              minLength: 2,
              maxLength: 100,
              pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*$',
            },
            account: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        { q, account } = request.query;
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
      const terms = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
      if (!terms.length || terms.length > 8)
        return { contacts: [], limited: false };
      // Only letters/numbers enter tsquery syntax; user input remains a bound value.
      const query = terms.map((term) => `'${term}':*`).join(' & ');
      const result = (
        await pool.query(
          `WITH matching AS MATERIALIZED (
      SELECT m.id,m.account_id,m.received_at,m.sender,m.recipients FROM mail_messages m
      WHERE m.user_id=$1 AND m.contact_vector @@ to_tsquery('simple',$2) AND ${eligible}
      ORDER BY m.received_at DESC,m.id DESC LIMIT 2001
    ), candidates AS (SELECT * FROM matching ORDER BY received_at DESC,id DESC LIMIT 2000), people AS (${people}), ranked AS (
      SELECT address,(array_agg(name ORDER BY (account_id=$3::uuid) DESC NULLS LAST,(name<>'') DESC,received_at DESC,id))[1] AS name,
      min(CASE WHEN address=$4 THEN 0 WHEN starts_with(address,$4) THEN 1 WHEN starts_with(lower(name),$4) THEN 2 ELSE 3 END) AS quality,
      bool_or(account_id=$3::uuid) AS preferred,count(DISTINCT id) AS frequency,max(received_at) AS recent
      FROM people p WHERE ${notSelf} AND to_tsvector('simple',left(p.name||' '||p.address||' '||translate(p.name||' '||p.address,'@._+-','     '),1200)) @@ to_tsquery('simple',$2)
      GROUP BY address ORDER BY quality,preferred DESC NULLS LAST,frequency DESC,recent DESC,address LIMIT 64
    ) SELECT coalesce((SELECT json_agg(json_build_object('name',name,'address',address) ORDER BY quality,preferred DESC NULLS LAST,frequency DESC,recent DESC,address) FROM ranked),'[]') AS contacts,
      (SELECT count(*)>2000 FROM matching) AS limited`,
          [owner, query, account ?? null, q.trim().toLowerCase()],
        )
      ).rows[0];
      return {
        contacts: clean(result.contacts).slice(0, 8),
        limited: result.limited,
      };
    },
  );

  // No separate contact store: export and deletion follow the same current mail boundary.
  app.get<{ Querystring: { after?: string } }>(
    '/api/mail/contacts/export',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            after: {
              type: 'string',
              minLength: 1,
              maxLength: 254,
              pattern: '^[^\\u0000-\\u001f\\u007f-\\u009f]*$',
            },
          },
        },
      },
    },
    async (request) => {
      const rows = (
        await pool.query(
          `WITH candidates AS (
      SELECT m.id,m.account_id,m.received_at,m.sender,m.recipients FROM mail_messages m WHERE m.user_id=$1 AND ${eligible}
    ), people AS (${people})
    SELECT address,(array_agg(name ORDER BY (name<>'') DESC,received_at DESC,id))[1] AS name FROM people p
    WHERE ${notSelf} AND ($2::text IS NULL OR address>$2) GROUP BY address ORDER BY address LIMIT 101`,
          [request.mailUser, request.query.after ?? null],
        )
      ).rows;
      return {
        contacts: clean(rows.slice(0, 100)),
        nextCursor: rows.length > 100 ? rows[99].address : null,
      };
    },
  );
}
