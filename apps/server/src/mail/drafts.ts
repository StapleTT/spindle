import type { FastifyInstance } from 'fastify';
import { Parser } from 'htmlparser2';
import type { Pool } from 'pg';
import sanitizeHtml from 'sanitize-html';
import type { ContentConfig } from './content-config.js';
import { forwardBodyUrl } from './content-server.js';
import { AttachmentError, setDraftAttachments } from './file-storage.js';
import { addForwardFiles } from './file-uploads.js';
import { forwardContent } from './forward.js';
import {
  type ReplyContext,
  type ReplyKind,
  type ReplyMetadata,
  responseDraft,
} from './reply.js';
import { SANITIZER_VERSION } from './sanitize.js';
import { transaction } from './store.js';

type Content = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  format: 'rich' | 'plain';
  html: string;
  text: string;
};
type Save = {
  accountId: string | null;
  content: Content;
  revision: number;
  saveId: string;
  copyOf?: string;
  attachmentIds?: string[];
};
const fields = `id,account_id AS "accountId",content,revision,last_save_id AS "saveId",updated_at AS "updatedAt",reply_context AS "replyContext",
  CASE WHEN forward_content IS NULL THEN NULL ELSE jsonb_build_object('text',forward_content->>'text','imageCount',jsonb_array_length(forward_content->'resources')) END AS forwarded,
  COALESCE((SELECT jsonb_agg(da.file_id ORDER BY da.position) FROM mail_draft_attachments da WHERE da.user_id=mail_drafts.user_id AND da.draft_id=mail_drafts.id),'[]') AS "attachmentIds"`;
const uuid = { type: 'string', format: 'uuid' };
const params = {
  type: 'object',
  required: ['id'],
  properties: { id: uuid },
  additionalProperties: false,
};

// Draft HTML has a much smaller vocabulary than received mail. No styles,
// images, embedded content, external resources or arbitrary attributes survive.
export function cleanDraft(content: Content): Content {
  if (content.format === 'plain') return { ...content, html: '' };
  const html = sanitizeHtml(content.html, {
    allowedTags: [
      'p',
      'br',
      'strong',
      'em',
      's',
      'ul',
      'ol',
      'li',
      'blockquote',
      'a',
    ],
    allowedAttributes: { a: ['href'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    nonTextTags: [
      'script',
      'style',
      'textarea',
      'option',
      'iframe',
      'object',
      'svg',
      'math',
    ],
    nestingLimit: 20,
    transformTags: { b: 'strong', i: 'em', strike: 's', div: 'p' },
  });
  let text = '';
  const parser = new Parser({
    ontext: (value) => {
      text += value;
    },
    onopentag: (tag) => {
      if (tag === 'br') text += '\n';
    },
    onclosetag: (tag) => {
      if (['p', 'li', 'blockquote'].includes(tag)) text += '\n';
    },
  });
  parser.end(html);
  return { ...content, html, text: text.replace(/\n$/, '') };
}

export function registerDraftRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: ContentConfig | null = null,
) {
  app.post<{ Params: { id: string }; Body: { id: string; kind: ReplyKind } }>(
    '/api/mail/messages/:id/compose',
    {
      schema: {
        params,
        body: {
          type: 'object',
          required: ['id', 'kind'],
          additionalProperties: false,
          properties: {
            id: uuid,
            kind: { type: 'string', enum: ['reply', 'replyAll', 'forward'] },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        kind = request.body.kind;
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        const existing = (
          await db.query(
            'SELECT id,reply_context FROM mail_drafts WHERE user_id=$1 AND id=$2',
            [owner, request.body.id],
          )
        ).rows[0];
        if (existing)
          return existing.reply_context?.kind === kind &&
            existing.reply_context?.sourceMessageId === request.params.id
            ? { id: existing.id }
            : { error: 'This draft ID was already used.' };
        if (
          (
            await db.query(
              'SELECT id FROM mail_outbox WHERE user_id=$1 AND source_draft_id=$2 LIMIT 1',
              [owner, request.body.id],
            )
          ).rowCount
        )
          return {
            error:
              'This response draft was already submitted. Review Outbox before starting another response.',
          };
        const source = (
          await db.query(
            `SELECT m.* FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2
        AND EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=$1 AND mm.message_id=m.id)`,
            [owner, request.params.id],
          )
        ).rows[0];
        if (!source) return null;
        if (
          !(
            await db.query(
              'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR KEY SHARE',
              [owner, source.account_id],
            )
          ).rowCount
        )
          return null;
        const body = (
          await db.query(
            `SELECT plain_text,html,reply_metadata,attachments,resources,version FROM mail_content WHERE user_id=$1 AND message_id=$2
        AND state='ready' AND expires_at>clock_timestamp() AND sanitizer_version=$3 FOR UPDATE`,
            [owner, source.id, SANITIZER_VERSION],
          )
        ).rows[0];
        if (!body)
          return {
            error:
              'Open the original message and wait for its body to load before composing a response.',
          };
        if (!body.reply_metadata) {
          await db.query(
            `UPDATE mail_content SET reply_headers_pending=true,next_attempt_at=clock_timestamp(),error_code=NULL
            WHERE user_id=$1 AND message_id=$2 AND NOT reply_headers_pending`,
            [owner, source.id],
          );
          return { preparing: true };
        }
        if (
          (
            await db.query(
              'SELECT count(*)::int AS count FROM mail_drafts WHERE user_id=$1',
              [owner],
            )
          ).rows[0].count >= 100
        )
          return {
            error:
              'You can keep up to 100 local drafts. Discard a draft before creating another.',
          };
        const identities = (
          await db.query(
            `SELECT email AS address FROM users WHERE id=$1 UNION SELECT username FROM mail_accounts WHERE user_id=$1
        UNION SELECT username FROM mail_smtp WHERE user_id=$1`,
            [owner],
          )
        ).rows.map((row) => row.address as string);
        let generated: ReturnType<typeof responseDraft>;
        let forwarded: ReturnType<typeof forwardContent> | null = null;
        try {
          generated = responseDraft(
            kind,
            {
              id: source.id,
              accountId: source.account_id,
              date: source.sent_at ?? source.received_at,
              plain: body.plain_text,
              html: body.html ?? '',
              metadata: body.reply_metadata as ReplyMetadata,
              attachments: body.attachments.length,
            },
            identities,
          );
          if (generated.forwarded) {
            const images = (
              await db.query(
                'SELECT position,content_type,data FROM mail_content_images WHERE user_id=$1 AND message_id=$2',
                [owner, source.id],
              )
            ).rows;
            forwarded = forwardContent(
              generated.forwarded,
              body.resources,
              images,
            );
            if (
              body.resources.some(
                (resource: { kind: string }, index: number) =>
                  resource.kind === 'inline' &&
                  !forwarded?.images.some((image) => image.position === index),
              )
            )
              generated.replyContext.warnings.push(
                'Some embedded images are unavailable and will be omitted.',
              );
          }
        } catch (error) {
          return {
            error:
              error instanceof Error
                ? error.message
                : 'Unable to prepare recipients.',
          };
        }
        const content = JSON.stringify(cleanDraft(generated.content));
        if (kind === 'forward')
          generated.replyContext.warnings =
            generated.replyContext.warnings.filter(
              (warning) => warning !== 'Original attachments are not included.',
            );
        if (Buffer.byteLength(content) > 120000)
          return {
            error:
              'This quote is too large for a draft. Compose a new message with a shorter excerpt.',
          };
        const inserted = (
          await db.query(
            `INSERT INTO mail_drafts(id,user_id,account_id,content,last_save_id,reply_context,forward_content)
        VALUES($1,$2,$3,$4,$1,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id`,
            [
              request.body.id,
              owner,
              source.account_id,
              content,
              JSON.stringify(generated.replyContext),
              forwarded ? JSON.stringify(forwarded) : null,
            ],
          )
        ).rows[0];
        if (inserted && kind === 'forward') {
          const warning = await addForwardFiles(
            db,
            owner,
            inserted.id,
            {
              accountId: source.account_id,
              messageId: source.id,
              version: body.version,
            },
            body.attachments,
          );
          if (warning) {
            generated.replyContext.warnings.push(warning);
            await db.query(
              'UPDATE mail_drafts SET reply_context=$3 WHERE user_id=$1 AND id=$2',
              [owner, inserted.id, JSON.stringify(generated.replyContext)],
            );
          }
        }
        return inserted
          ? { id: inserted.id }
          : { error: 'This draft ID was already used.' };
      });
      if (!result)
        return reply.code(404).send({ message: 'Message not found.' });
      if ('error' in result)
        return reply.code(409).send({ message: result.error });
      if ('preparing' in result)
        return reply.code(202).send({ state: 'preparing' });
      return reply.code(201).send({ draft: { id: result.id } });
    },
  );

  app.get('/api/mail/drafts', async (request) => ({
    drafts: (
      await pool.query(
        `SELECT id,account_id AS "accountId",content->>'subject' AS subject,revision,updated_at AS "updatedAt"
       FROM mail_drafts WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT 100`,
        [request.mailUser],
      )
    ).rows,
  }));

  app.post<{ Params: { id: string }; Body: { images?: boolean } }>(
    '/api/mail/drafts/:id/forward-preview',
    {
      schema: {
        params,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: { images: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const owned = await pool.query(
        'SELECT 1 FROM mail_drafts WHERE user_id=$1 AND id=$2 AND forward_content IS NOT NULL',
        [request.mailUser, request.params.id],
      );
      if (!owned.rowCount)
        return reply
          .code(404)
          .send({ message: 'Forwarded original not found.' });
      if (!config)
        return reply.code(503).send({
          message:
            'Formatted preview needs the isolated content server. The original formatting will still be sent.',
        });
      return {
        htmlUrl: forwardBodyUrl(
          config,
          request.mailUser ?? '',
          request.mailSession ?? '',
          request.params.id,
          request.body.images ?? false,
        ),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/mail/drafts/:id',
    { schema: { params } },
    async (request, reply) => {
      const draft = (
        await pool.query(
          `SELECT ${fields} FROM mail_drafts WHERE user_id=$1 AND id=$2`,
          [request.mailUser, request.params.id],
        )
      ).rows[0];
      if (!draft) return reply.code(404).send({ message: 'Draft not found.' });
      draft.outbox =
        (
          await pool.query(
            "SELECT id,state FROM mail_outbox WHERE user_id=$1 AND draft_id=$2 AND state NOT IN ('failed','cancelled') ORDER BY seq DESC LIMIT 1",
            [request.mailUser, request.params.id],
          )
        ).rows[0] ?? null;
      return { draft };
    },
  );

  app.put<{ Params: { id: string }; Body: Save }>(
    '/api/mail/drafts/:id',
    {
      bodyLimit: 128 * 1024,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['accountId', 'content', 'revision', 'saveId'],
          additionalProperties: false,
          properties: {
            accountId: { anyOf: [uuid, { type: 'null' }] },
            saveId: uuid,
            copyOf: uuid,
            attachmentIds: {
              type: 'array',
              maxItems: 10,
              uniqueItems: true,
              items: uuid,
            },
            revision: { type: 'integer', minimum: 0, maximum: 2147483646 },
            content: {
              type: 'object',
              required: [
                'to',
                'cc',
                'bcc',
                'subject',
                'format',
                'html',
                'text',
              ],
              additionalProperties: false,
              properties: {
                to: {
                  type: 'string',
                  maxLength: 4000,
                  pattern: '^[^\r\n\u0000]*$',
                },
                cc: {
                  type: 'string',
                  maxLength: 4000,
                  pattern: '^[^\r\n\u0000]*$',
                },
                bcc: {
                  type: 'string',
                  maxLength: 4000,
                  pattern: '^[^\r\n\u0000]*$',
                },
                subject: {
                  type: 'string',
                  maxLength: 1000,
                  pattern: '^[^\r\n\u0000]*$',
                },
                format: { type: 'string', enum: ['rich', 'plain'] },
                html: {
                  type: 'string',
                  maxLength: 100000,
                  pattern: '^[^\u0000]*$',
                },
                text: {
                  type: 'string',
                  maxLength: 100000,
                  pattern: '^[^\u0000]*$',
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '';
      const { accountId, revision, saveId } = request.body;
      const content = JSON.stringify(cleanDraft(request.body.content));
      if (Buffer.byteLength(content) > 120000)
        return reply.code(413).send({
          message:
            'This draft is too large. Shorten the body or recipient lists.',
        });
      const result = await transaction(pool, async (db) => {
        // Serialize per-user creation quotas.
        await db.query(
          'SELECT id FROM users WHERE id=$1 AND email_verified FOR UPDATE',
          [owner],
        );
        // Account deletion locks the account before its draft cascade.
        const accountAvailable =
          !accountId ||
          (
            await db.query(
              'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR KEY SHARE',
              [owner, accountId],
            )
          ).rowCount;
        const existing = (
          await db.query(
            `SELECT ${fields},last_save_id=$3 AND account_id IS NOT DISTINCT FROM $4::uuid AND content=$5::jsonb AS replay
         FROM mail_drafts WHERE user_id=$1 AND id=$2 FOR UPDATE`,
            [owner, request.params.id, saveId, accountId, content],
          )
        ).rows[0];
        const attachmentIds =
          request.body.attachmentIds ??
          existing?.attachmentIds ??
          (request.body.copyOf
            ? (
                await db.query(
                  'SELECT file_id FROM mail_draft_attachments WHERE user_id=$1 AND draft_id=$2 ORDER BY position',
                  [owner, request.body.copyOf],
                )
              ).rows.map((row) => row.file_id)
            : []);
        const attachmentsMatch =
          JSON.stringify(attachmentIds) ===
          JSON.stringify(existing?.attachmentIds ?? []);
        if (
          (
            await db.query(
              "SELECT id FROM mail_outbox WHERE user_id=$1 AND draft_id=$2 AND state NOT IN ('failed','cancelled') LIMIT 1",
              [owner, request.params.id],
            )
          ).rowCount
        )
          return { error: 'outbox' };
        if (
          existing?.replay &&
          attachmentsMatch &&
          existing.revision === revision + 1
        )
          return { draft: existing };
        if (
          (existing?.revision ?? 0) !== revision ||
          existing?.saveId === saveId
        )
          return { error: 'conflict' };
        if (!accountAvailable) return { error: 'account' };
        if (!existing) {
          let context: ReplyContext | null = null;
          let forwarded = null;
          if (request.body.copyOf) {
            const original = (
              await db.query(
                'SELECT reply_context,forward_content FROM mail_drafts WHERE user_id=$1 AND id=$2',
                [owner, request.body.copyOf],
              )
            ).rows[0];
            forwarded = original?.forward_content ?? null;
            context = original
              ? original.reply_context
              : {
                  kind: 'copy',
                  sourceMessageId: '',
                  originalSubject: '',
                  inReplyTo: null,
                  references: [],
                  warnings: [
                    'The original draft is unavailable. This copy starts a new conversation and cannot include a stored formatted original; review recipients and content before sending.',
                  ],
                };
          }
          const count = (
            await db.query(
              'SELECT count(*)::int AS count FROM mail_drafts WHERE user_id=$1',
              [owner],
            )
          ).rows[0].count;
          if (count >= 100) return { error: 'limit' };
          const inserted = (
            await db.query(
              `INSERT INTO mail_drafts(id,user_id,account_id,content,last_save_id,reply_context,forward_content) VALUES($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT(id) DO NOTHING RETURNING ${fields}`,
              [
                request.params.id,
                owner,
                accountId,
                content,
                saveId,
                context ? JSON.stringify(context) : null,
                forwarded ? JSON.stringify(forwarded) : null,
              ],
            )
          ).rows[0];
          if (!inserted) return { error: 'conflict' };
          await setDraftAttachments(
            db,
            owner,
            request.params.id,
            attachmentIds,
          );
          return { draft: { ...inserted, attachmentIds } };
        }
        await setDraftAttachments(db, owner, request.params.id, attachmentIds);
        return {
          draft: (
            await db.query(
              `UPDATE mail_drafts SET account_id=$3,content=$4,last_save_id=$5 WHERE user_id=$1 AND id=$2 RETURNING ${fields}`,
              [owner, request.params.id, accountId, content, saveId],
            )
          ).rows[0],
        };
      }).catch((error) => {
        if (error instanceof AttachmentError)
          return { error: 'attachment', message: error.message };
        throw error;
      });
      if (result.error || !('draft' in result))
        return reply.code(409).send({
          message:
            result.error === 'attachment'
              ? 'message' in result
                ? result.message
                : 'Attachment unavailable.'
              : result.error === 'outbox'
                ? 'This draft is frozen in Outbox. Review its send status before editing; keep a separate copy of any unsaved changes.'
                : result.error === 'account'
                  ? 'That mail account is unavailable. Choose another account or keep this draft without one.'
                  : result.error === 'limit'
                    ? 'You can keep up to 100 local drafts. Discard a draft before saving another.'
                    : 'This draft changed or was removed elsewhere. Your edits have not overwritten the saved version.',
          code: result.error,
        });
      const { replay: _replay, ...draft } = result.draft;
      return { draft: { ...draft, outbox: null } };
    },
  );

  app.delete<{ Params: { id: string }; Body: { revision: number } }>(
    '/api/mail/drafts/:id',
    {
      schema: {
        params,
        body: {
          type: 'object',
          required: ['revision'],
          properties: {
            revision: { type: 'integer', minimum: 1, maximum: 2147483647 },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const removed = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          request.mailUser,
        ]);
        if (
          (
            await db.query(
              "SELECT id FROM mail_outbox WHERE user_id=$1 AND draft_id=$2 AND state NOT IN ('failed','cancelled') LIMIT 1",
              [request.mailUser, request.params.id],
            )
          ).rowCount
        )
          return null;
        return db.query(
          'DELETE FROM mail_drafts WHERE user_id=$1 AND id=$2 AND revision=$3 RETURNING id',
          [request.mailUser, request.params.id, request.body.revision],
        );
      });
      if (!removed)
        return reply.code(409).send({
          message:
            'This draft is frozen in Outbox. Review its send status before discarding.',
        });
      if (removed.rowCount) return { discarded: true };
      const exists = (
        await pool.query(
          'SELECT id FROM mail_drafts WHERE user_id=$1 AND id=$2',
          [request.mailUser, request.params.id],
        )
      ).rowCount;
      return reply.code(exists ? 409 : 404).send({
        message: exists
          ? 'This draft changed elsewhere. Reload it before discarding.'
          : 'Draft not found.',
      });
    },
  );
}
