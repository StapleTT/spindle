import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { encryptCredential, type MailKeys } from './credentials.js';
import { outgoingMessage } from './outgoing-message.js';
import { emailAddress, smtpErrors } from './smtp.js';
import { transaction } from './store.js';

const uuid = { type: 'string', format: 'uuid' };
const params = {
  type: 'object',
  required: ['id'],
  properties: { id: uuid },
  additionalProperties: false,
};
const smtpFields =
  'host,port,transport,username,save_sent_copy AS "saveSentCopy",state,checked_at AS "checkedAt",error_code AS code';
const outboxFields = `id,state,subject,sender,recipients,accepted,rejected,error_code AS code,sent_copy AS "sentCopy",
  draft_id AS "draftId",source_draft_id AS "sourceDraftId",created_at AS "createdAt",seq::text AS cursor,
  GREATEST(0,floor(extract(epoch FROM next_attempt_at-clock_timestamp())*1000))::int AS "undoMs"`;

export function registerOutgoingRoutes(
  app: FastifyInstance,
  pool: Pool,
  keys: MailKeys,
) {
  app.get<{ Params: { id: string } }>(
    '/api/mail/accounts/:id/smtp',
    { schema: { params } },
    async (request, reply) => {
      const owned = await pool.query(
        'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2',
        [request.mailUser, request.params.id],
      );
      if (!owned.rowCount)
        return reply.code(404).send({ message: 'Mail account not found.' });
      const settings = (
        await pool.query(
          `SELECT ${smtpFields} FROM mail_smtp WHERE user_id=$1 AND account_id=$2`,
          [request.mailUser, request.params.id],
        )
      ).rows[0];
      if (!settings) return { smtp: null };
      const { code, ...smtp } = settings;
      return { smtp: { ...smtp, error: code ? smtpErrors[code] : null } };
    },
  );

  app.put<{
    Params: { id: string };
    Body: {
      host: string;
      port: number;
      transport: 'tls' | 'starttls';
      username: string;
      password?: string;
      saveSentCopy?: boolean;
    };
  }>(
    '/api/mail/accounts/:id/smtp',
    {
      bodyLimit: 8192,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['host', 'port', 'transport', 'username'],
          additionalProperties: false,
          properties: {
            host: {
              type: 'string',
              minLength: 1,
              maxLength: 253,
              pattern: '^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$',
            },
            port: { type: 'integer', minimum: 1, maximum: 65535 },
            transport: { type: 'string', enum: ['tls', 'starttls'] },
            username: { type: 'string', maxLength: 254 },
            saveSentCopy: { type: 'boolean' },
            password: {
              type: 'string',
              minLength: 1,
              maxLength: 1024,
              pattern: '^[^\u0000]+$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        id = request.params.id,
        body = request.body;
      if (!keys.keys.has(keys.active))
        return reply
          .code(503)
          .send({ message: 'Mail encryption is unavailable.' });
      if (!emailAddress(body.username))
        return reply.code(400).send({
          message:
            'The SMTP login must be a complete email address. It is also the From address for this account.',
        });
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        if (
          !(
            await db.query(
              'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
              [owner, id],
            )
          ).rowCount
        )
          return 'missing';
        const old = (
          await db.query(
            'SELECT * FROM mail_smtp WHERE user_id=$1 AND account_id=$2',
            [owner, id],
          )
        ).rows[0];
        if (
          !body.password &&
          (!old ||
            old.host !== body.host.toLowerCase() ||
            old.username !== body.username ||
            old.port !== body.port ||
            old.transport !== body.transport)
        )
          return 'password';
        const credential = body.password
          ? encryptCredential(body.password, owner, `${id}:smtp`, keys)
          : old.credential;
        await db.query(
          `INSERT INTO mail_smtp(user_id,account_id,host,port,transport,username,credential,save_sent_copy) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(account_id) DO UPDATE SET version=gen_random_uuid(),host=EXCLUDED.host,port=EXCLUDED.port,transport=EXCLUDED.transport,
        username=EXCLUDED.username,credential=EXCLUDED.credential,save_sent_copy=EXCLUDED.save_sent_copy,state='pending',checked_at=NULL,error_code=NULL`,
          [
            owner,
            id,
            body.host.toLowerCase(),
            body.port,
            body.transport,
            body.username,
            credential,
            body.saveSentCopy ?? false,
          ],
        );
        return 'saved';
      });
      if (result === 'missing')
        return reply.code(404).send({ message: 'Mail account not found.' });
      if (result === 'password')
        return reply.code(400).send({
          message:
            'Enter the SMTP password when adding or changing connection settings.',
        });
      return reply.code(202).send({ state: 'pending' });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/mail/accounts/:id/smtp/test',
    { schema: { params } },
    async (request, reply) => {
      const updated = await pool.query(
        "UPDATE mail_smtp SET state='pending',error_code=NULL WHERE user_id=$1 AND account_id=$2 RETURNING account_id",
        [request.mailUser, request.params.id],
      );
      if (!updated.rowCount)
        return reply.code(404).send({ message: 'SMTP settings not found.' });
      return reply.code(202).send({ state: 'pending' });
    },
  );

  app.post<{ Params: { id: string }; Body: { id: string; revision: number } }>(
    '/api/mail/drafts/:id/send',
    {
      schema: {
        params,
        body: {
          type: 'object',
          required: ['id', 'revision'],
          additionalProperties: false,
          properties: {
            id: uuid,
            revision: { type: 'integer', minimum: 1, maximum: 2147483647 },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        operation = request.body.id;
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        const previous = (
          await db.query(
            'SELECT id,state,source_draft_id,draft_revision FROM mail_outbox WHERE user_id=$1 AND id=$2',
            [owner, operation],
          )
        ).rows[0];
        if (previous)
          return previous.source_draft_id === request.params.id &&
            previous.draft_revision === request.body.revision
            ? { outbox: { id: previous.id, state: previous.state } }
            : { error: 'This send ID was already used.' };
        const at = (
          await db.query(
            'SELECT account_id FROM mail_drafts WHERE user_id=$1 AND id=$2',
            [owner, request.params.id],
          )
        ).rows[0];
        if (!at) return null;
        const account = (
          await db.query(
            'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
            [owner, at.account_id],
          )
        ).rows[0];
        if (!account) return { error: 'Choose a connected sending account.' };
        const smtp = (
          await db.query(
            'SELECT * FROM mail_smtp WHERE user_id=$1 AND account_id=$2',
            [owner, at.account_id],
          )
        ).rows[0];
        if (smtp?.state !== 'ready')
          return {
            error:
              'Set up and check outgoing SMTP for this account before sending.',
          };
        const draft = (
          await db.query(
            'SELECT * FROM mail_drafts WHERE user_id=$1 AND id=$2 FOR UPDATE',
            [owner, request.params.id],
          )
        ).rows[0];
        if (!draft || draft.revision !== request.body.revision)
          return {
            error: 'The draft changed. Reload and review it before sending.',
          };
        if (
          (
            await db.query(
              "SELECT id FROM mail_outbox WHERE user_id=$1 AND draft_id=$2 AND state NOT IN ('failed','cancelled')",
              [owner, draft.id],
            )
          ).rowCount
        )
          return {
            error:
              'This draft is already in Outbox. Review its status before sending again.',
          };
        const limits = (
          await db.query(
            `SELECT count(*)::int AS messages,COALESCE(sum(jsonb_array_length(recipients)),0)::int AS recipients
        FROM mail_outbox WHERE user_id=$1 AND created_at>clock_timestamp()-interval '1 day'`,
            [owner],
          )
        ).rows[0];
        let message: Awaited<ReturnType<typeof outgoingMessage>>;
        try {
          message = await outgoingMessage(
            operation,
            smtp.username,
            draft.content,
          );
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : 'Invalid message.',
          };
        }
        if (
          limits.messages >= 100 ||
          limits.recipients + message.recipients.length > 500
        )
          return {
            error:
              'Daily send limit reached (100 messages or 500 recipients). Try again later.',
          };
        const inserted = (
          await db.query(
            `INSERT INTO mail_outbox(id,user_id,account_id,draft_id,source_draft_id,draft_revision,smtp_version,sender,recipients,subject,message_id,raw,save_sent_copy)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING RETURNING id,state`,
            [
              operation,
              owner,
              at.account_id,
              draft.id,
              draft.revision,
              smtp.version,
              smtp.username,
              JSON.stringify(message.recipients),
              draft.content.subject,
              message.messageId,
              message.raw,
              smtp.save_sent_copy,
            ],
          )
        ).rows[0];
        return inserted
          ? { outbox: inserted }
          : {
              error: 'This message is already queued or its send ID was used.',
            };
      });
      if (!result) return reply.code(404).send({ message: 'Draft not found.' });
      if (result.error) return reply.code(409).send({ message: result.error });
      return reply.code(202).send(result);
    },
  );

  app.get<{ Querystring: { before?: string } }>(
    '/api/mail/outbox',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { before: { type: 'string', pattern: '^[0-9]{1,19}$' } },
          additionalProperties: false,
        },
      },
    },
    async (request) => {
      const rows = (
        await pool.query(
          `SELECT ${outboxFields} FROM mail_outbox WHERE user_id=$1 AND ($2::numeric IS NULL OR seq<$2::numeric) ORDER BY seq DESC LIMIT 51`,
          [request.mailUser, request.query.before ?? null],
        )
      ).rows;
      const page = rows.slice(0, 50);
      return {
        messages: page.map(({ code, ...row }) => ({
          ...row,
          error: code ? smtpErrors[code] : null,
        })),
        nextCursor: rows.length > 50 ? page.at(-1).cursor : null,
      };
    },
  );
  for (const operation of ['cancel', 'retry'] as const)
    app.post<{ Params: { id: string } }>(
      `/api/mail/outbox/:id/${operation}`,
      { schema: { params } },
      async (request, reply) => {
        const owner = request.mailUser ?? '';
        const result = await transaction(pool, async (db) => {
          await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
            owner,
          ]);
          const row = (
            await db.query(
              'SELECT * FROM mail_outbox WHERE user_id=$1 AND id=$2',
              [owner, request.params.id],
            )
          ).rows[0];
          if (!row) return null;
          // Account -> draft -> outbox is shared with enqueue, autosave and worker settlement.
          const account = (
            await db.query(
              'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
              [owner, row.account_id],
            )
          ).rows[0];
          const draft = (
            await db.query(
              'SELECT revision FROM mail_drafts WHERE user_id=$1 AND id=$2 FOR UPDATE',
              [owner, row.draft_id],
            )
          ).rows[0];
          if (operation === 'cancel') {
            const cancelled = await db.query(
              "UPDATE mail_outbox SET state='cancelled',completed_at=clock_timestamp(),error_code=NULL WHERE user_id=$1 AND id=$2 AND state='queued' RETURNING id",
              [owner, row.id],
            );
            return cancelled.rowCount || row.state === 'cancelled'
              ? 'cancelled'
              : 'refused';
          }
          const smtp = (
            await db.query(
              'SELECT state,version FROM mail_smtp WHERE user_id=$1 AND account_id=$2',
              [owner, row.account_id],
            )
          ).rows[0];
          if (row.state === 'queued') return 'queued';
          if (
            row.state !== 'failed' ||
            !account ||
            !draft ||
            draft.revision !== row.draft_revision ||
            smtp?.state !== 'ready' ||
            smtp.version !== row.smtp_version
          )
            return 'refused';
          if (
            (
              await db.query(
                "SELECT id FROM mail_outbox WHERE user_id=$1 AND source_draft_id=$2 AND draft_revision=$3 AND id<>$4 AND state NOT IN ('failed','cancelled') LIMIT 1",
                [owner, row.source_draft_id, row.draft_revision, row.id],
              )
            ).rowCount
          )
            return 'refused';
          await db.query(
            "UPDATE mail_outbox SET state='queued',attempts=0,error_code=NULL,completed_at=NULL,next_attempt_at=clock_timestamp()+interval '5 seconds' WHERE user_id=$1 AND id=$2 AND state='failed'",
            [owner, row.id],
          );
          return 'queued';
        });
        if (!result)
          return reply.code(404).send({ message: 'Outbox message not found.' });
        if (result === 'refused')
          return reply.code(409).send({
            message:
              operation === 'cancel'
                ? 'This message has already started sending. It cannot be recalled.'
                : 'This outcome cannot be safely retried, or the draft/settings changed. Review Outbox and your draft.',
          });
        return { state: result };
      },
    );
}
