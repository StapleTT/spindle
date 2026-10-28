import type { FastifyInstance } from 'fastify';
import { Parser } from 'htmlparser2';
import type { Pool } from 'pg';
import sanitizeHtml from 'sanitize-html';
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
};
const fields = `id,account_id AS "accountId",content,revision,last_save_id AS "saveId",updated_at AS "updatedAt"`;
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

export function registerDraftRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/api/mail/drafts', async (request) => ({
    drafts: (
      await pool.query(
        `SELECT id,account_id AS "accountId",content->>'subject' AS subject,revision,updated_at AS "updatedAt"
       FROM mail_drafts WHERE user_id=$1 ORDER BY updated_at DESC,id LIMIT 100`,
        [request.mailUser],
      )
    ).rows,
  }));

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
        if (existing?.replay && existing.revision === revision + 1)
          return { draft: existing };
        if (
          (existing?.revision ?? 0) !== revision ||
          existing?.saveId === saveId
        )
          return { error: 'conflict' };
        if (!accountAvailable) return { error: 'account' };
        if (!existing) {
          const count = (
            await db.query(
              'SELECT count(*)::int AS count FROM mail_drafts WHERE user_id=$1',
              [owner],
            )
          ).rows[0].count;
          if (count >= 100) return { error: 'limit' };
          const inserted = (
            await db.query(
              `INSERT INTO mail_drafts(id,user_id,account_id,content,last_save_id) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(id) DO NOTHING RETURNING ${fields}`,
              [request.params.id, owner, accountId, content, saveId],
            )
          ).rows[0];
          return inserted ? { draft: inserted } : { error: 'conflict' };
        }
        return {
          draft: (
            await db.query(
              `UPDATE mail_drafts SET account_id=$3,content=$4,last_save_id=$5 WHERE user_id=$1 AND id=$2 RETURNING ${fields}`,
              [owner, request.params.id, accountId, content, saveId],
            )
          ).rows[0],
        };
      });
      if (result.error)
        return reply.code(409).send({
          message:
            result.error === 'account'
              ? 'That mail account is unavailable. Choose another account or keep this draft without one.'
              : result.error === 'limit'
                ? 'You can keep up to 100 local drafts. Discard a draft before saving another.'
                : 'This draft changed or was removed elsewhere. Your edits have not overwritten the saved version.',
          code: result.error,
        });
      const { replay: _replay, ...draft } = result.draft;
      return { draft };
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
      const removed = await pool.query(
        'DELETE FROM mail_drafts WHERE user_id=$1 AND id=$2 AND revision=$3 RETURNING id',
        [request.mailUser, request.params.id, request.body.revision],
      );
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
