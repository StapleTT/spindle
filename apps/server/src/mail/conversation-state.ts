import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  ConversationLimitError,
  conversationIds,
  conversationQuery,
} from './conversations.js';
import { transaction } from './store.js';
import { localStateFields } from './view.js';

// Metadata writers already hold user/account locks. Retain each field's latest
// explicit choice when headers join components, including false/null choices.
export async function reconcileConversationState(
  db: PoolClient,
  owner: string,
  account: string,
  anchors: string[],
) {
  if (
    !anchors.length ||
    !(
      await db.query(
        `SELECT 1 FROM mail_messages WHERE user_id=$1 AND account_id=$2
    AND greatest(local_pin_version,local_mute_version,local_snooze_version)>0 LIMIT 1`,
        [owner, account],
      )
    ).rowCount
  )
    return;
  const seen = new Set<string>();
  for (const anchor of anchors) {
    if (seen.has(anchor)) continue;
    let ids: string[];
    try {
      // Include not-yet-pruned copies so provider moves/UID resets can inherit state.
      ids = await conversationIds(db, owner, anchor, true);
    } catch (error) {
      if (error instanceof ConversationLimitError) continue;
      throw error;
    }
    for (const id of ids) seen.add(id);
    await db.query(
      `WITH choices AS (
      SELECT (array_agg(local_pinned ORDER BY local_pin_version DESC,id))[1] AS pinned,
      (array_agg(local_muted ORDER BY local_mute_version DESC,id))[1] AS muted,
      (array_agg(local_snoozed_until ORDER BY local_snooze_version DESC,id))[1] AS until,
      max(local_pin_version) AS pv,max(local_mute_version) AS mv,max(local_snooze_version) AS sv
      FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND id=ANY($3::uuid[])
    ) UPDATE mail_messages m SET local_pinned=c.pinned,local_muted=c.muted,local_snoozed_until=c.until,
      local_pin_version=c.pv,local_mute_version=c.mv,local_snooze_version=c.sv FROM choices c
      WHERE m.user_id=$1 AND m.account_id=$2 AND m.id=ANY($3::uuid[])
      AND ROW(m.local_pinned,m.local_muted,m.local_snoozed_until,m.local_pin_version,m.local_mute_version,m.local_snooze_version)
        IS DISTINCT FROM ROW(c.pinned,c.muted,c.until,c.pv,c.mv,c.sv)`,
      [owner, account, ids],
    );
  }
}

// The persisted timestamp is the due-time intent. Dispatcher/startup scans recover
// missed ticks; the conditional UPDATE cannot clear a concurrently rescheduled snooze.
export async function wakeSnoozedConversations(pool: Pool) {
  const due =
    await pool.query(`SELECT DISTINCT m.user_id,m.account_id FROM mail_messages m
    JOIN users u ON u.id=m.user_id WHERE u.email_verified AND m.local_snoozed_until<=clock_timestamp() LIMIT 100`);
  for (const row of due.rows)
    await transaction(pool, async (db) => {
      if (
        !(
          await db.query(
            'SELECT id FROM users WHERE id=$1 AND email_verified FOR UPDATE',
            [row.user_id],
          )
        ).rowCount
      )
        return;
      if (
        !(
          await db.query(
            'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
            [row.user_id, row.account_id],
          )
        ).rowCount
      )
        return;
      const version = (
        await db.query(
          "SELECT nextval('mail_local_state_version')::text AS version",
        )
      ).rows[0].version;
      await db.query(
        `UPDATE mail_messages SET local_snoozed_until=NULL,local_snooze_version=$3
      WHERE user_id=$1 AND account_id=$2 AND local_snoozed_until<=clock_timestamp()`,
        [row.user_id, row.account_id, version],
      );
    });
}

export function registerConversationStateRoutes(
  app: FastifyInstance,
  pool: Pool,
) {
  app.patch<{
    Params: { id: string };
    Body: {
      version: string;
      pinned?: boolean;
      muted?: boolean;
      snoozedUntil?: string | null;
    };
  }>(
    '/api/mail/messages/:id/conversation/state',
    {
      bodyLimit: 1024,
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          additionalProperties: false,
          properties: { id: conversationQuery },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['version'],
          minProperties: 2,
          maxProperties: 2,
          properties: {
            version: { type: 'string', pattern: '^(0|[1-9][0-9]{0,18})$' },
            pinned: { type: 'boolean' },
            muted: { type: 'boolean' },
            snoozedUntil: {
              anyOf: [
                { type: 'string', format: 'date-time' },
                { type: 'null' },
              ],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        anchor = request.params.id,
        body = request.body;
      const until = body.snoozedUntil;
      if (
        until &&
        (Date.parse(until) <= Date.now() ||
          Date.parse(until) > Date.now() + 366 * 86400000)
      )
        return reply.code(400).send({
          message: 'Choose a future snooze time within the next year.',
        });
      try {
        const outcome = await transaction(pool, async (db) => {
          if (
            !(
              await db.query(
                'SELECT id FROM users WHERE id=$1 AND email_verified FOR UPDATE',
                [owner],
              )
            ).rowCount
          )
            return { status: 403, message: 'Verify your email to continue.' };
          const account = (
            await db.query(
              `SELECT a.id FROM mail_accounts a JOIN mail_messages m ON m.user_id=a.user_id AND m.account_id=a.id
          WHERE a.user_id=$1 AND m.id=$2 FOR UPDATE OF a`,
              [owner, anchor],
            )
          ).rows[0]?.id;
          if (!account)
            return { status: 404, message: 'Conversation not found.' };
          const ids = await conversationIds(db, owner, anchor);
          if (!ids.length)
            return { status: 404, message: 'Conversation not found.' };
          await reconcileConversationState(db, owner, account, [anchor]);
          const current = (
            await db.query(
              `SELECT ${localStateFields} FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2`,
              [owner, anchor],
            )
          ).rows[0];
          if (body.version !== current.version)
            return {
              status: 409,
              message:
                'Conversation settings changed in another tab. Reload the conversation before trying again.',
            };
          const field =
            body.pinned !== undefined
              ? 'pin'
              : body.muted !== undefined
                ? 'mute'
                : 'snooze';
          const column =
            field === 'pin'
              ? 'local_pinned'
              : field === 'mute'
                ? 'local_muted'
                : 'local_snoozed_until';
          const value =
            field === 'pin'
              ? body.pinned
              : field === 'mute'
                ? body.muted
                : until;
          await db.query(
            `WITH version AS MATERIALIZED(SELECT nextval('mail_local_state_version') AS v)
          UPDATE mail_messages SET ${column}=$3,local_${field}_version=version.v FROM version
          WHERE user_id=$1 AND id=ANY($2::uuid[])`,
            [owner, ids, value],
          );
          await reconcileConversationState(db, owner, account, [anchor]);
          const state = (
            await db.query(
              `SELECT ${localStateFields} FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2`,
              [owner, anchor],
            )
          ).rows[0];
          return { status: 200, state };
        });
        return reply
          .code(outcome.status)
          .send(
            outcome.message
              ? { message: outcome.message }
              : { state: outcome.state },
          );
      } catch (error) {
        if (error instanceof ConversationLimitError)
          return reply.code(413).send({ message: error.message });
        throw error;
      }
    },
  );
}
