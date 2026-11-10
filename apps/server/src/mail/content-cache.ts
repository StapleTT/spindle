import type { PoolClient } from 'pg';

export const CACHE_BYTES = 128 * 1024 * 1024;
export const CACHE_MESSAGES = 1000;
// A background prefetch that failed (D042). Readers treat the row as missing
// and request the body themselves; it only stops prefetch retrying at once.
export const PREFETCH_FAILED = 'prefetch_unavailable';

export async function trimContentCache(
  db: PoolClient,
  owner: string,
  keep: string,
  additional = 0,
) {
  // Callers lock the owner before modifying cache sizes, including image downloads.
  const rows = (
    await db.query<{ message_id: string; byte_size: number }>(
      'SELECT message_id,byte_size FROM mail_content WHERE user_id=$1 ORDER BY accessed_at,message_id',
      [owner],
    )
  ).rows;
  let total = rows.reduce((sum, row) => sum + row.byte_size, 0) + additional;
  let count = rows.length;
  for (const row of rows) {
    if (total <= CACHE_BYTES && count <= CACHE_MESSAGES) break;
    if (row.message_id === keep) continue;
    await db.query(
      'DELETE FROM mail_content WHERE user_id=$1 AND message_id=$2',
      [owner, row.message_id],
    );
    total -= row.byte_size;
    count--;
  }
  if (total > CACHE_BYTES) throw new Error('Mail content cache limit');
}
