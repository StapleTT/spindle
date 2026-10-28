import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import {
  AttachmentError,
  DRAFT_FILE_BYTES,
  FILE_BYTES,
  fixedChunks,
  OUTGOING_STORAGE_BYTES,
  outgoingStorage,
} from './file-storage.js';
import { type AttachmentInfo, safeFilename } from './media.js';
import { transaction } from './store.js';

export const uploadFields =
  'id,filename,size_bytes AS size,state,error_code AS code';
const uuid = { type: 'string', format: 'uuid' };
const params = {
  type: 'object',
  required: ['id'],
  properties: { id: uuid },
  additionalProperties: false,
};

export async function addForwardFiles(
  db: PoolClient,
  owner: string,
  draft: string,
  source: { accountId: string; messageId: string; version: string },
  files: AttachmentInfo[],
) {
  let total = 0,
    count = 0;
  const skipped: string[] = [];
  let storage = await outgoingStorage(db, owner);
  let storedCount = (
    await db.query(
      'SELECT count(*)::int AS count FROM mail_uploads WHERE user_id=$1',
      [owner],
    )
  ).rows[0].count as number;
  for (const [position, file] of files.entries()) {
    if (
      file.size > FILE_BYTES ||
      total + file.size > DRAFT_FILE_BYTES ||
      count >= 10 ||
      storedCount >= 1000 ||
      storage + FILE_BYTES > OUTGOING_STORAGE_BYTES
    ) {
      skipped.push(file.filename);
      continue;
    }
    const id = randomUUID();
    await db.query(
      `INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state,source)
      VALUES($1,$2,$3,$4,$5,'pending_fetch',$6)`,
      [
        id,
        owner,
        safeFilename(file.filename, 'attachment'),
        file.size,
        FILE_BYTES,
        JSON.stringify({ ...source, position }),
      ],
    );
    await db.query(
      'INSERT INTO mail_draft_attachments(user_id,draft_id,file_id,position) VALUES($1,$2,$3,$4)',
      [owner, draft, id, count++],
    );
    total += file.size;
    storage += FILE_BYTES;
    storedCount++;
  }
  return skipped.length
    ? `Some original files exceed attachment/storage limits and were not included (${skipped.length}).`
    : null;
}

export function registerUploadRoutes(app: FastifyInstance, pool: Pool) {
  // Authentication/origin checks run before consuming this stream.
  app.addContentTypeParser(
    'application/octet-stream',
    (_request, payload, done) => done(null, payload),
  );
  app.get<{ Querystring: { ids: string } }>(
    '/api/mail/uploads',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['ids'],
          additionalProperties: false,
          properties: {
            ids: {
              type: 'string',
              maxLength: 369,
              pattern: '^[a-fA-F0-9,-]+$',
            },
          },
        },
      },
    },
    async (request, reply) => {
      const ids = request.query.ids.split(',');
      if (
        ids.length > 10 ||
        ids.some(
          (id) => !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id),
        )
      )
        return reply.code(400).send({ message: 'Invalid attachment IDs.' });
      return {
        files: (
          await pool.query(
            `SELECT ${uploadFields} FROM mail_uploads WHERE user_id=$1 AND id=ANY($2::uuid[])`,
            [request.mailUser, ids],
          )
        ).rows,
      };
    },
  );
  app.post<{ Body: { id: string; filename: string; size: number } }>(
    '/api/mail/uploads',
    {
      schema: {
        body: {
          type: 'object',
          required: ['id', 'filename', 'size'],
          additionalProperties: false,
          properties: {
            id: uuid,
            filename: { type: 'string', minLength: 1, maxLength: 1000 },
            size: { type: 'integer', minimum: 0, maximum: FILE_BYTES },
          },
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        body = request.body,
        filename = safeFilename(body.filename, 'attachment');
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        const existing = (
          await db.query(
            `SELECT ${uploadFields} FROM mail_uploads WHERE user_id=$1 AND id=$2`,
            [owner, body.id],
          )
        ).rows[0];
        if (existing)
          return existing.filename === filename && existing.size === body.size
            ? { file: existing }
            : { error: 'This attachment ID was already used.' };
        if (
          (
            await db.query(
              "SELECT count(*)::int AS count FROM mail_uploads WHERE user_id=$1 AND state='uploading'",
              [owner],
            )
          ).rows[0].count >= 2
        )
          return {
            error:
              'Two uploads are already in progress. Finish or cancel one first.',
          };
        if (
          (
            await db.query(
              'SELECT count(*)::int AS count FROM mail_uploads WHERE user_id=$1',
              [owner],
            )
          ).rows[0].count >= 1000
        )
          return {
            error:
              'Attachment count limit reached. Unused files are cleaned after 24 hours.',
          };
        if (
          (await outgoingStorage(db, owner)) + body.size >
          OUTGOING_STORAGE_BYTES
        )
          return {
            error:
              'Outgoing storage is full (256 MiB). Discard unused drafts; unattached files are cleaned after 24 hours and settled send history after seven days.',
          };
        const file = (
          await db.query(
            `INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state,lease_until) VALUES($1,$2,$3,$4,$4,'uploading',clock_timestamp()+interval '10 minutes') ON CONFLICT DO NOTHING RETURNING ${uploadFields}`,
            [body.id, owner, filename, body.size],
          )
        ).rows[0];
        return file
          ? { file }
          : { error: 'This attachment ID was already used.' };
      });
      return 'error' in result
        ? reply.code(409).send({ message: result.error })
        : reply.code(201).send(result);
    },
  );
  let active = 0;
  app.put<{ Params: { id: string }; Body: Readable }>(
    '/api/mail/uploads/:id',
    { schema: { params }, bodyLimit: FILE_BYTES },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        id = request.params.id,
        token = randomUUID();
      if (active >= 4)
        return reply
          .code(429)
          .send({ message: 'Uploads are busy. Try again shortly.' });
      active++;
      try {
        const file = (
          await pool.query(
            `UPDATE mail_uploads SET token=$3,lease_until=clock_timestamp()+interval '2 minutes'
      WHERE user_id=$1 AND id=$2 AND state='uploading' AND token IS NULL RETURNING size_bytes`,
            [owner, id, token],
          )
        ).rows[0];
        if (!file) {
          const existing = (
            await pool.query(
              `SELECT ${uploadFields} FROM mail_uploads WHERE user_id=$1 AND id=$2`,
              [owner, id],
            )
          ).rows[0];
          if (
            existing &&
            ['pending_scan', 'scanning', 'ready'].includes(existing.state)
          )
            return { file: existing };
          return reply.code(existing ? 409 : 404).send({
            message: existing
              ? 'This upload cannot be resumed. Select the file again.'
              : 'Attachment not found.',
          });
        }
        const source = request.body ?? request.raw;
        const timer = setTimeout(
          () => source.destroy(new Error('Upload timed out')),
          120000,
        );
        let bytes = 0,
          position = 0;
        try {
          if (!source || typeof source[Symbol.asyncIterator] !== 'function')
            throw new AttachmentError('Use a binary file upload.');
          for await (const data of fixedChunks(source)) {
            bytes += data.length;
            if (bytes > file.size_bytes || bytes > FILE_BYTES)
              throw new AttachmentError(
                'File exceeds its declared size or the 10 MiB limit.',
              );
            const inserted = await pool.query(
              `WITH current AS (SELECT f.id FROM mail_uploads f JOIN users u ON u.id=f.user_id
              WHERE f.user_id=$1 AND f.id=$2 AND f.token=$3 AND f.state='uploading' AND f.lease_until>clock_timestamp() AND u.email_verified FOR UPDATE OF f)
            INSERT INTO mail_upload_chunks(user_id,file_id,position,data) SELECT $1,$2,$4,$5 FROM current RETURNING position`,
              [owner, id, token, position++, data],
            );
            if (!inserted.rowCount)
              throw new AttachmentError('Upload was cancelled.');
          }
          if (bytes !== file.size_bytes)
            throw new AttachmentError(
              'Upload was interrupted. Select the file again.',
            );
          const completed = await pool.query(
            `UPDATE mail_uploads f SET state='pending_scan',token=NULL,lease_until=NULL WHERE f.user_id=$1 AND f.id=$2 AND f.token=$3 AND f.state='uploading' AND EXISTS(SELECT 1 FROM users WHERE id=$1 AND email_verified) RETURNING ${uploadFields}`,
            [owner, id, token],
          );
          if (!completed.rowCount)
            throw new AttachmentError('Upload was cancelled.');
          return reply.code(202).send({ file: completed.rows[0] });
        } catch (error) {
          await transaction(pool, async (db) => {
            const failed = await db.query(
              "UPDATE mail_uploads SET state='failed',error_code='upload_failed',reserved_bytes=0 WHERE user_id=$1 AND id=$2 AND token=$3 RETURNING id",
              [owner, id, token],
            );
            if (failed.rowCount)
              await db.query(
                'DELETE FROM mail_upload_chunks WHERE user_id=$1 AND file_id=$2',
                [owner, id],
              );
          });
          return reply.code(400).send({
            message:
              error instanceof AttachmentError
                ? error.message
                : 'Upload interrupted. Select the file again.',
          });
        } finally {
          clearTimeout(timer);
        }
      } finally {
        active--;
      }
    },
  );
  app.post<{ Params: { id: string } }>(
    '/api/mail/uploads/:id/retry',
    { schema: { params } },
    async (request, reply) => {
      const changed = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          request.mailUser,
        ]);
        const file = (
          await db.query(
            "SELECT * FROM mail_uploads WHERE user_id=$1 AND id=$2 AND state='failed' AND error_code<>'upload_failed' FOR UPDATE",
            [request.mailUser, request.params.id],
          )
        ).rows[0];
        if (!file) return false;
        const refetch = file.error_code === 'source_unavailable';
        if (
          refetch &&
          (await outgoingStorage(db, request.mailUser ?? '')) + FILE_BYTES >
            OUTGOING_STORAGE_BYTES
        )
          return false;
        await db.query(
          'UPDATE mail_uploads SET state=$3,reserved_bytes=$4,error_code=NULL,token=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2',
          [
            request.mailUser,
            request.params.id,
            refetch ? 'pending_fetch' : 'pending_scan',
            refetch ? FILE_BYTES : file.reserved_bytes,
          ],
        );
        return true;
      });
      return changed
        ? { state: 'pending' }
        : reply.code(409).send({
            message: 'Select the file again or remove this attachment.',
          });
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/api/mail/uploads/:id',
    { schema: { params } },
    async (request, reply) => {
      await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
          request.mailUser,
        ]);
        const changed = await db.query(
          "UPDATE mail_uploads SET state='failed',error_code='upload_failed',reserved_bytes=0,token=NULL WHERE user_id=$1 AND id=$2 AND state NOT IN ('ready','quarantined') RETURNING id",
          [request.mailUser, request.params.id],
        );
        if (changed.rowCount)
          await db.query(
            'DELETE FROM mail_upload_chunks WHERE user_id=$1 AND file_id=$2',
            [request.mailUser, request.params.id],
          );
      });
      return reply.code(204).send();
    },
  );
}
