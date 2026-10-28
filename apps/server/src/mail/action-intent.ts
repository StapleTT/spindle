import type { PoolClient } from 'pg';
import {
  type ActionKind,
  moveDestination,
  moveKinds,
  refreshPendingFolder,
  withSeen,
} from './actions.js';
export const undoMs = `GREATEST(0,floor(extract(epoch FROM a.undo_until-clock_timestamp())*1000))::int AS "undoMs"`;

export async function queueAction(
  db: PoolClient,
  owner: string,
  messageId: string,
  action: string,
  kind: ActionKind,
  mailbox?: string,
) {
  await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
  // Locking the message serializes action order with its local changes.
  const message = (
    await db.query(
      `SELECT m.account_id,m.subject FROM mail_messages m WHERE m.user_id=$1 AND m.id=$2
        AND EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=$1 AND mm.message_id=m.id) FOR UPDATE`,
      [owner, messageId],
    )
  ).rows[0];
  if (!message) return null;
  const recorded = `SELECT a.id,a.kind,a.state,t.path AS target,a.message_id,a.target_mailbox_id,${undoMs}
          FROM mail_actions a LEFT JOIN mailboxes t ON t.user_id=a.user_id AND t.id=a.target_mailbox_id
          WHERE a.id=$1 AND a.user_id=$2`;
  // A retried request with the same operation ID returns the original intent.
  const existing = (await db.query(recorded, [action, owner])).rows[0];
  if (existing)
    return existing.message_id === messageId &&
      existing.kind === kind &&
      (!mailbox || existing.target_mailbox_id === mailbox)
      ? existing
      : 'conflict';
  let source: string | null = null;
  let target: string | null = null;
  if (moveKinds.includes(kind)) {
    const destination = await moveDestination(
      db,
      owner,
      message.account_id,
      messageId,
      kind as 'archive' | 'trash' | 'move' | 'restore',
      mailbox,
    );
    if ('error' in destination) return destination;
    source = destination.source;
    target = destination.target.id;
  }
  const inserted = await db.query(
    `INSERT INTO mail_actions(id,user_id,account_id,message_id,kind,source_mailbox_id,target_mailbox_id,subject,undo_until,next_attempt_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp()+interval '5 seconds',clock_timestamp()+interval '5 seconds')
          ON CONFLICT (id) DO NOTHING`,
    [
      action,
      owner,
      message.account_id,
      messageId,
      kind,
      source,
      target,
      message.subject,
    ],
  );
  if (!inserted.rowCount) return 'conflict';
  await db.query(
    `UPDATE mail_memberships SET flags=${withSeen('flags', '$3::text')} WHERE user_id=$1 AND message_id=$2`,
    [owner, messageId, kind],
  );
  await refreshPendingFolder(db, owner, messageId);
  return (await db.query(recorded, [action, owner])).rows[0];
}
