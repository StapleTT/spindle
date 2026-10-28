import { Readable } from 'node:stream';
import type { Pool, PoolClient } from 'pg';

export const FILE_BYTES = 10 * 1024 * 1024;
export const DRAFT_FILE_BYTES = 20 * 1024 * 1024;
export const MIME_BYTES = 30 * 1024 * 1024;
export const OUTGOING_STORAGE_BYTES = 256 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024;
export class AttachmentError extends Error {}
type Database = Pool | PoolClient;

export async function outgoingStorage(db: Database, owner: string) {
  return Number(
    (
      await db.query(
        `SELECT COALESCE((SELECT sum(reserved_bytes) FROM mail_uploads WHERE user_id=$1),0)
    +COALESCE((SELECT sum(COALESCE(mime_size,octet_length(raw))) FROM mail_outbox WHERE user_id=$1),0) AS bytes`,
        [owner],
      )
    ).rows[0].bytes,
  );
}

// A fixed chunk size bounds both database rows and MIME/scanner stream reads.
export async function* fixedChunks(
  source: AsyncIterable<Buffer | string | Uint8Array>,
) {
  let pending = Buffer.alloc(0);
  for await (const chunk of source) {
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (pending.length) {
      const take = Math.min(CHUNK_BYTES - pending.length, data.length);
      pending = Buffer.concat([pending, data.subarray(0, take)]);
      data = data.subarray(take);
      if (pending.length === CHUNK_BYTES) {
        yield pending;
        pending = Buffer.alloc(0);
      }
    }
    while (data.length >= CHUNK_BYTES) {
      yield data.subarray(0, CHUNK_BYTES);
      data = data.subarray(CHUNK_BYTES);
    }
    if (data.length) pending = Buffer.from(data);
  }
  if (pending.length) yield pending;
}

export function fileStream(db: Database, owner: string, file: string) {
  return Readable.from(
    (async function* () {
      let position = 0,
        bytes = 0;
      const fileRow = (
        await db.query(
          "SELECT size_bytes FROM mail_uploads WHERE user_id=$1 AND id=$2 AND state IN ('ready','scanning')",
          [owner, file],
        )
      ).rows[0];
      if (!fileRow) throw new AttachmentError('Attachment unavailable.');
      for (;;) {
        const rows = (
          await db.query(
            `SELECT c.position,c.data FROM mail_upload_chunks c JOIN users u ON u.id=c.user_id
        WHERE c.user_id=$1 AND c.file_id=$2 AND c.position>=$3 AND u.email_verified ORDER BY c.position LIMIT 4`,
            [owner, file, position],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows) {
          if (row.position !== position++)
            throw new AttachmentError('Attachment is incomplete.');
          bytes += row.data.length;
          if (bytes > FILE_BYTES)
            throw new AttachmentError('Attachment size limit.');
          yield row.data as Buffer;
        }
      }
      if (bytes !== fileRow.size_bytes)
        throw new AttachmentError('Attachment is incomplete.');
    })(),
  );
}

export function outboxStream(
  pool: Pool,
  owner: string,
  id: string,
  size: number,
  account: { id: string; lease_token: string },
) {
  return Readable.from(
    (async function* () {
      let position = 0,
        bytes = 0;
      for (;;) {
        const rows = (
          await pool.query(
            `SELECT c.position,c.data FROM mail_outbox_chunks c JOIN mail_outbox o ON o.user_id=c.user_id AND o.id=c.outbox_id
        JOIN users u ON u.id=c.user_id JOIN mail_accounts a ON a.user_id=o.user_id AND a.id=o.account_id
        WHERE c.user_id=$1 AND c.outbox_id=$2 AND c.position>=$3 AND u.email_verified AND a.id=$4 AND a.lease_token=$5 AND a.lease_until>clock_timestamp()
        ORDER BY c.position LIMIT 4`,
            [owner, id, position, account.id, account.lease_token],
          )
        ).rows;
        if (!rows.length) break;
        for (const row of rows) {
          if (row.position !== position++)
            throw new AttachmentError('Outbox content is incomplete.');
          bytes += row.data.length;
          if (bytes > MIME_BYTES)
            throw new AttachmentError('Outbox size limit.');
          yield row.data as Buffer;
        }
      }
      if (bytes !== size)
        throw new AttachmentError('Outbox content is unavailable.');
    })(),
  );
}

export async function setDraftAttachments(
  db: PoolClient,
  owner: string,
  draft: string,
  ids: string[],
) {
  const unique = [...new Set(ids)];
  const files = (
    await db.query(
      'SELECT id,size_bytes FROM mail_uploads WHERE user_id=$1 AND id=ANY($2::uuid[])',
      [owner, unique],
    )
  ).rows;
  if (unique.length > 10 || files.length !== unique.length)
    throw new AttachmentError(
      'An attachment is unavailable. Remove it or select the file again.',
    );
  if (
    files.reduce((total, row) => total + row.size_bytes, 0) > DRAFT_FILE_BYTES
  )
    throw new AttachmentError('Attachments exceed the 20 MiB draft limit.');
  await db.query(
    'DELETE FROM mail_draft_attachments WHERE user_id=$1 AND draft_id=$2',
    [owner, draft],
  );
  for (const [position, file] of unique.entries())
    await db.query(
      'INSERT INTO mail_draft_attachments(user_id,draft_id,file_id,position) VALUES($1,$2,$3,$4)',
      [owner, draft, file, position],
    );
}
