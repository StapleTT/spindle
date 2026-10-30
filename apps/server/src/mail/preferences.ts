import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { transaction } from './store.js';

export const defaultMailPreferences = {
  imageProxy: true,
  blockRemoteImages: true,
  undoSend: true,
};
export type MailPreferences = typeof defaultMailPreferences;
const fields =
  'image_proxy AS "imageProxy",block_remote_images AS "blockRemoteImages",undo_send AS "undoSend"';

export async function readMailPreferences(
  db: Pick<Pool, 'query'>,
  owner: string,
): Promise<MailPreferences> {
  return (
    (
      await db.query(
        `SELECT ${fields} FROM mail_preferences WHERE user_id=$1`,
        [owner],
      )
    ).rows[0] ?? { ...defaultMailPreferences }
  );
}

export function registerPreferenceRoutes(app: FastifyInstance, pool: Pool) {
  app.get('/api/mail/preferences', async (request) => ({
    preferences: await readMailPreferences(pool, request.mailUser ?? ''),
  }));
  app.patch<{ Body: Partial<MailPreferences> }>(
    '/api/mail/preferences',
    {
      bodyLimit: 1024,
      preValidation: async (request, reply) => {
        const body = request.body;
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          !Object.keys(body).length ||
          Object.entries(body).some(
            ([key, value]) =>
              !Object.hasOwn(defaultMailPreferences, key) ||
              typeof value !== 'boolean',
          )
        )
          return reply.code(400).send({
            message:
              'Supply only boolean imageProxy, blockRemoteImages or undoSend preferences.',
          });
      },
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            imageProxy: { type: 'boolean' },
            blockRemoteImages: { type: 'boolean' },
            undoSend: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const owner = request.mailUser ?? '';
      const preferences = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        await db.query(
          'INSERT INTO mail_preferences(user_id) VALUES($1) ON CONFLICT DO NOTHING',
          [owner],
        );
        return (
          await db.query(
            `UPDATE mail_preferences SET image_proxy=COALESCE($2,image_proxy),block_remote_images=COALESCE($3,block_remote_images),undo_send=COALESCE($4,undo_send) WHERE user_id=$1 RETURNING ${fields}`,
            [
              owner,
              request.body.imageProxy ?? null,
              request.body.blockRemoteImages ?? null,
              request.body.undoSend ?? null,
            ],
          )
        ).rows[0];
      });
      return { preferences };
    },
  );
}
