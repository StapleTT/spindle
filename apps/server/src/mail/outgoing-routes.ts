import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { encryptCredential, type MailKeys } from './credentials.js';
import {
  AttachmentError,
  DRAFT_FILE_BYTES,
  fileStream,
  fixedChunks,
  MIME_BYTES,
  OUTGOING_STORAGE_BYTES,
  outgoingStorage,
} from './file-storage.js';
import { composeOutgoing, outgoingMessage } from './outgoing-message.js';
import {
  defaultSenderName,
  emailAddress,
  senderDisplayName,
  smtpErrors,
} from './smtp.js';
import { transaction } from './store.js';

const uuid = { type: 'string', format: 'uuid' };
const params = {
  type: 'object',
  required: ['id'],
  properties: { id: uuid },
  additionalProperties: false,
};
const smtpFields =
  'host,port,transport,username,display_name AS "displayName",save_sent_copy AS "saveSentCopy",state,checked_at AS "checkedAt",error_code AS code';
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
        'SELECT u.name FROM mail_accounts a JOIN users u ON u.id=a.user_id WHERE a.user_id=$1 AND a.id=$2',
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
      const defaultDisplayName = defaultSenderName(owned.rows[0].name);
      if (!settings) return { smtp: null, defaultDisplayName };
      const { code, ...smtp } = settings;
      return {
        smtp: { ...smtp, error: code ? smtpErrors[code] : null },
        defaultDisplayName,
      };
    },
  );

  app.put<{
    Params: { id: string };
    Body: {
      host: string;
      port: number;
      transport: 'tls' | 'starttls';
      username: string;
      displayName?: string;
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
            displayName: {
              type: 'string',
              maxLength: 200,
              pattern: '^[^\u0000-\u001f\u007f-\u009f]*$',
            },
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
        const profile = (
          await db.query('SELECT name FROM users WHERE id=$1 FOR UPDATE', [
            owner,
          ])
        ).rows[0];
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
        const displayName =
          body.displayName === undefined
            ? (old?.display_name ?? defaultSenderName(profile.name))
            : senderDisplayName(body.displayName);
        await db.query(
          `INSERT INTO mail_smtp(user_id,account_id,host,port,transport,username,credential,save_sent_copy,display_name) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT(account_id) DO UPDATE SET version=gen_random_uuid(),host=EXCLUDED.host,port=EXCLUDED.port,transport=EXCLUDED.transport,
        username=EXCLUDED.username,credential=EXCLUDED.credential,save_sent_copy=EXCLUDED.save_sent_copy,display_name=EXCLUDED.display_name,state='pending',checked_at=NULL,error_code=NULL`,
          [
            owner,
            id,
            body.host.toLowerCase(),
            body.port,
            body.transport,
            body.username,
            credential,
            body.saveSentCopy ?? false,
            displayName,
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
              "SELECT 1 FROM mail_draft_links WHERE user_id=$1 AND account_id=$2 AND source_draft_id=$3 AND state IN ('conflict','unknown') LIMIT 1",
              [owner, at.account_id, draft.id],
            )
          ).rowCount
        )
          return {
            error:
              'Resolve the provider draft conflict before sending. Your local text is safe.',
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
        const files = (
          await db.query(
            `SELECT f.id,f.filename,f.size_bytes,f.state FROM mail_draft_attachments d JOIN mail_uploads f ON f.user_id=d.user_id AND f.id=d.file_id WHERE d.user_id=$1 AND d.draft_id=$2 ORDER BY d.position`,
            [owner, draft.id],
          )
        ).rows;
        if (files.some((file) => file.state !== 'ready'))
          return {
            error:
              'Attachments are still uploading, being checked, or blocked. Wait for Ready, retry a failed check, or remove the file before sending.',
          };
        if (
          files.length > 10 ||
          files.reduce((sum, file) => sum + file.size_bytes, 0) >
            DRAFT_FILE_BYTES
        )
          return { error: 'Attachments exceed the 20 MiB draft limit.' };
        let stream: ReturnType<typeof composeOutgoing>['compiled'] | undefined;
        let message: {
          messageId: string;
          recipients: string[];
          raw: Buffer | null;
        };
        try {
          if (files.length) {
            const composed = composeOutgoing(
              operation,
              smtp.username,
              draft.content,
              draft.reply_context,
              draft.forward_content,
              files.map((file) => ({
                filename: file.filename,
                contentType: 'application/octet-stream',
                content: fileStream(db, owner, file.id),
              })),
              smtp.display_name,
            );
            stream = composed.compiled;
            message = {
              messageId: composed.messageId,
              recipients: composed.recipients,
              raw: null,
            };
          } else
            message = await outgoingMessage(
              operation,
              smtp.username,
              draft.content,
              draft.reply_context,
              draft.forward_content,
              smtp.display_name,
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
            `INSERT INTO mail_outbox(id,user_id,account_id,draft_id,source_draft_id,draft_revision,smtp_version,sender,recipients,subject,message_id,raw,save_sent_copy,mime_size)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING RETURNING id,state`,
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
              stream ? 1 : null,
            ],
          )
        ).rows[0];
        if (inserted && stream) {
          let bytes = 0,
            position = 0;
          for await (const data of fixedChunks(stream.createReadStream())) {
            bytes += data.length;
            if (bytes > MIME_BYTES)
              throw new AttachmentError(
                'The encoded message exceeds the 30 MiB send limit. Remove an attachment or shorten the message.',
              );
            await db.query(
              'INSERT INTO mail_outbox_chunks(user_id,outbox_id,position,data) VALUES($1,$2,$3,$4)',
              [owner, inserted.id, position++, data],
            );
          }
          await db.query(
            "UPDATE mail_outbox SET mime_size=$3,next_attempt_at=clock_timestamp()+interval '5 seconds' WHERE user_id=$1 AND id=$2",
            [owner, inserted.id, bytes],
          );
        }
        if (
          inserted &&
          (await outgoingStorage(db, owner)) > OUTGOING_STORAGE_BYTES
        )
          throw new AttachmentError(
            'Outgoing storage is full (256 MiB). The draft and attachments are preserved.',
          );
        return inserted
          ? { outbox: inserted }
          : {
              error: 'This message is already queued or its send ID was used.',
            };
      }).catch((error) => {
        if (error instanceof AttachmentError) return { error: error.message };
        throw error;
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
