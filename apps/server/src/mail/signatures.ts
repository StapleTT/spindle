import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { cleanDraft } from './drafts.js';
import { transaction } from './store.js';

type Content = Parameters<typeof cleanDraft>[0];
export type Signature = {
  html: string;
  text: string;
  newMessages: boolean;
  repliesForwards: boolean;
  revision: number;
};
export const signatureField = `(SELECT jsonb_build_object('html',s.html,'text',s.text,'newMessages',s.new_messages,'repliesForwards',s.replies_forwards,'revision',s.revision) FROM mail_signatures s WHERE s.user_id=a.user_id AND s.account_id=a.id) AS signature`;

export function signatureContent(
  content: Content,
  signature: Pick<Signature, 'html' | 'text'> | null,
  reply = false,
): Content {
  if (!signature || (!signature.html && !signature.text)) return content;
  if (content.format === 'plain')
    return {
      ...content,
      text: reply
        ? `\n${signature.text}\n\n${content.text}`
        : content.text
          ? `${content.text}\n\n${signature.text}`
          : signature.text,
    };
  // Response drafts begin with a blank note before their first quote. Forwards
  // keep their formatted original separately, so this remains above it too.
  const html = reply
    ? `<p></p>${signature.html}<p></p>${content.html}`
    : `${content.html}${signature.html}`;
  return cleanDraft({ ...content, html });
}
export async function accountSignature(
  db: Pick<Pool, 'query'>,
  owner: string,
  account: string,
) {
  return (
    await db.query(
      'SELECT html,text,new_messages AS "newMessages",replies_forwards AS "repliesForwards",revision FROM mail_signatures WHERE user_id=$1 AND account_id=$2',
      [owner, account],
    )
  ).rows[0] as Signature | undefined;
}

export function registerSignatureRoutes(app: FastifyInstance, pool: Pool) {
  const params = {
    type: 'object',
    required: ['id'],
    additionalProperties: false,
    properties: { id: { type: 'string', format: 'uuid' } },
  };
  app.get<{ Params: { id: string } }>(
    '/api/mail/accounts/:id/signature',
    { schema: { params } },
    async (request, reply) => {
      const owner = request.mailUser ?? '';
      if (
        !(
          await pool.query(
            'SELECT 1 FROM mail_accounts WHERE user_id=$1 AND id=$2',
            [owner, request.params.id],
          )
        ).rowCount
      )
        return reply.code(404).send({ message: 'Mail account not found.' });
      return {
        signature: (await accountSignature(pool, owner, request.params.id)) ?? {
          html: '',
          text: '',
          newMessages: true,
          repliesForwards: true,
          revision: 0,
        },
      };
    },
  );
  app.put<{
    Params: { id: string };
    Body: {
      html: string;
      newMessages: boolean;
      repliesForwards: boolean;
      revision: number;
    };
  }>(
    '/api/mail/accounts/:id/signature',
    {
      bodyLimit: 32 * 1024,
      schema: {
        params,
        body: {
          type: 'object',
          required: ['html', 'newMessages', 'repliesForwards', 'revision'],
          additionalProperties: false,
          properties: {
            html: {
              type: 'string',
              maxLength: 10000,
              pattern: '^[^\\u0000]*$',
            },
            newMessages: { type: 'boolean' },
            repliesForwards: { type: 'boolean' },
            revision: { type: 'integer', minimum: 0, maximum: 2147483646 },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        body = request.body;
      const safe = cleanDraft({
        to: '',
        cc: '',
        bcc: '',
        subject: '',
        format: 'rich',
        html: body.html,
        text: '',
      });
      if (!safe.text.trim()) {
        safe.html = '';
        safe.text = '';
      }
      if (
        Buffer.byteLength(safe.html) > 20000 ||
        Buffer.byteLength(safe.text) > 20000
      )
        return reply.code(413).send({
          message:
            'This signature is too large. Keep each version within 20,000 bytes.',
        });
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        if (
          !(
            await db.query(
              'SELECT id FROM mail_accounts WHERE user_id=$1 AND id=$2 FOR KEY SHARE',
              [owner, request.params.id],
            )
          ).rowCount
        )
          return { missing: true };
        const current = await accountSignature(db, owner, request.params.id);
        if ((current?.revision ?? 0) !== body.revision)
          return { conflict: true };
        await db.query(
          `INSERT INTO mail_signatures(account_id,user_id,html,text,new_messages,replies_forwards) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(account_id) DO UPDATE SET html=EXCLUDED.html,text=EXCLUDED.text,new_messages=EXCLUDED.new_messages,replies_forwards=EXCLUDED.replies_forwards,revision=mail_signatures.revision+1`,
          [
            request.params.id,
            owner,
            safe.html,
            safe.text,
            body.newMessages,
            body.repliesForwards,
          ],
        );
        return {
          signature: await accountSignature(db, owner, request.params.id),
        };
      });
      if ('missing' in result)
        return reply.code(404).send({ message: 'Mail account not found.' });
      if ('conflict' in result)
        return reply.code(409).send({
          message:
            'The signature changed in another tab. Your edits are still here; reload the saved signature to review it.',
        });
      return result;
    },
  );
}
