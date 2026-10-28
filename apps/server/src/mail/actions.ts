import type { Pool, PoolClient } from 'pg';
import { decryptCredential, type MailKeys } from './credentials.js';
import { connectImap } from './imap.js';
import { claimAccount, releaseLease, withLease } from './store.js';

export type ActionKind =
  | 'read'
  | 'unread'
  | 'archive'
  | 'trash'
  | 'move'
  | 'restore';
export const moveKinds = ['archive', 'trash', 'move', 'restore'];

// Provider-designated (SPECIAL-USE) destinations; folders are never guessed by name.
export const moveRoles = { archive: '\\Archive', trash: '\\Trash' } as const;

// SQL for a flags array with an action's \Seen change applied; other flags are untouched.
export function withSeen(flags: string, kind: string) {
  return `CASE ${kind} WHEN 'read' THEN array_append(array_remove(${flags},'\\Seen'),'\\Seen')
    WHEN 'unread' THEN array_remove(${flags},'\\Seen') ELSE ${flags} END`;
}

// Latest pending read intent for a message; sync keeps it over provider flags until applied.
export const pendingKind = (user: string, message: string) =>
  `(SELECT a.kind FROM mail_actions a WHERE a.user_id=${user} AND a.message_id=${message}
    AND a.state='pending' AND a.kind IN ('read','unread') ORDER BY a.seq DESC LIMIT 1)`;

// The latest pending move decides which folder shows the message before the provider confirms.
export async function refreshPendingFolder(
  db: PoolClient,
  owner: string,
  message: string,
) {
  await db.query(
    `UPDATE mail_memberships SET pending_mailbox_id=(SELECT a.target_mailbox_id FROM mail_actions a
      WHERE a.user_id=$1 AND a.message_id=$2 AND a.state='pending' AND a.target_mailbox_id IS NOT NULL
      ORDER BY a.seq DESC LIMIT 1) WHERE user_id=$1 AND message_id=$2`,
    [owner, message],
  );
}

// User-facing outcomes for stored error codes; provider diagnostics are never stored.
export const actionErrors: Record<string, string> = {
  provider_unavailable:
    'The provider did not confirm this change after several attempts. It may already have happened; sync will check your mail.',
  move_unsupported:
    'This mail server supports neither MOVE nor UIDPLUS, so Spindle will not move messages on it.',
  message_missing:
    'The original message is no longer in its folder. It may have been moved or deleted in another mail client, or by an earlier attempt. Sync will check your mail.',
  message_changed:
    'Its folder was reset at the provider, so Spindle could not identify it safely.',
  folder_missing: 'The destination folder no longer exists.',
  source_missing:
    'The original folder no longer exists. Sync will check your mail.',
  flags_changed:
    'Another mail client changed the read state before confirmation. Sync will check your mail.',
  move_unconfirmed:
    'The provider did not confirm the move. It may already have happened; sync will check your mail. Review its current folder before moving it again.',
};

type Db = Pick<PoolClient, 'query'>;
type Folder = { id: string; path: string };

// The effective folder: a pending move already counts as the message's location.
export async function currentFolder(db: Db, owner: string, message: string) {
  return (
    await db.query<{ id: string; role: string | null }>(
      `SELECT b.id,b.role FROM mail_memberships mm JOIN mailboxes b
      ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=COALESCE(mm.pending_mailbox_id,mm.mailbox_id)
      WHERE mm.user_id=$1 AND mm.message_id=$2 LIMIT 1`,
      [owner, message],
    )
  ).rows[0];
}

// Restore returns to the folder recorded by the move that brought the message here.
// Mail already archived or trashed before Spindle knew its origin goes to the inbox.
export async function restoreDestination(
  db: Db,
  owner: string,
  account: string,
  message: string,
  current: { id: string; role: string | null },
) {
  const origin = (
    await db.query<Folder>(
      `SELECT b.id,b.path FROM mail_actions a JOIN mailboxes b
      ON b.user_id=a.user_id AND b.account_id=a.account_id AND b.id=a.source_mailbox_id
      WHERE a.user_id=$1 AND a.message_id=$2 AND a.target_mailbox_id=$3 AND a.state IN ('pending','applied')
      ORDER BY a.seq DESC LIMIT 1`,
      [owner, message, current.id],
    )
  ).rows[0];
  if (origin) return origin;
  if (current.role !== moveRoles.trash && current.role !== moveRoles.archive)
    return undefined;
  return (
    await db.query<Folder>(
      `SELECT id,path FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND role='inbox' LIMIT 1`,
      [owner, account],
    )
  ).rows[0];
}

const unavailable = {
  archive: 'This account has no provider-designated Archive folder.',
  trash: 'This account has no provider-designated Trash folder.',
  move: 'Choose a folder from the same mail account.',
  restore: 'There is no known folder to restore this message to.',
};

export async function moveDestination(
  db: Db,
  owner: string,
  account: string,
  message: string,
  kind: 'archive' | 'trash' | 'move' | 'restore',
  chosen?: string,
): Promise<{ source: string; target: Folder } | { error: string }> {
  const current = await currentFolder(db, owner, message);
  if (!current) return { error: unavailable[kind] };
  const target =
    kind === 'restore'
      ? await restoreDestination(db, owner, account, message, current)
      : (
          await db.query<Folder>(
            kind === 'move'
              ? 'SELECT id,path FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND id=$3'
              : 'SELECT id,path FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND role=$3 ORDER BY path LIMIT 1',
            [owner, account, kind === 'move' ? chosen : moveRoles[kind]],
          )
        ).rows[0];
  if (!target) return { error: unavailable[kind] };
  if (target.id === current.id)
    return { error: `This message is already in ${target.path}.` };
  return { source: current.id, target };
}

type Settled = {
  message_id: string | null;
  kind: ActionKind;
  seq: string;
  state: string;
};

export async function settle(
  db: PoolClient,
  owner: string,
  ids: string[],
  state: 'applied' | 'failed' | 'cancelled' | 'conflict',
  code: string | null,
) {
  const rows = (
    await db.query<Settled>(
      `UPDATE mail_actions SET state=$3,error_code=$4,completed_at=clock_timestamp()
      WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' RETURNING message_id,kind,seq,state`,
      [owner, ids, state, code],
    )
  ).rows;
  for (const row of rows) {
    // A deleted message has no local state left to reconcile.
    if (!row.message_id) continue;
    // Applied read state is now provider truth; a failed or undone change is reverted locally.
    // Either way, a newer read action for the same message owns the local state.
    if (row.kind === 'read' || row.kind === 'unread')
      await db.query(
        `UPDATE mail_memberships SET flags=${withSeen('flags', '$3::text')} WHERE user_id=$1 AND message_id=$2
        AND NOT EXISTS(SELECT 1 FROM mail_actions n WHERE n.user_id=$1 AND n.message_id=$2 AND n.seq>$4
          AND n.kind IN ('read','unread'))`,
        [
          owner,
          row.message_id,
          row.state === 'applied'
            ? row.kind
            : row.kind === 'read'
              ? 'unread'
              : 'read',
          row.seq,
        ],
      );
    await refreshPendingFolder(db, owner, row.message_id);
  }
}

type PendingAction = {
  id: string;
  kind: ActionKind;
  message_id: string | null;
  target_mailbox_id: string | null;
  target_path: string | null;
  due: boolean;
  error_code: string | null;
};

export async function applyMailActions(
  pool: Pool,
  keys: MailKeys,
  owner: string,
  accountId: string,
  connect = connectImap,
) {
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remaining = new Set<string>();
  try {
    const actions = (
      await pool.query<PendingAction>(
        `SELECT a.id,a.kind,a.message_id,a.target_mailbox_id,a.error_code,t.path AS target_path,
        a.next_attempt_at<=clock_timestamp() AS due FROM mail_actions a
        LEFT JOIN mailboxes t ON t.user_id=a.user_id AND t.account_id=a.account_id AND t.id=a.target_mailbox_id
        WHERE a.user_id=$1 AND a.account_id=$2 AND a.state='pending'
        ORDER BY a.seq LIMIT 50`,
        [owner, accountId],
      )
    ).rows;
    // A newer intent must wait for an older intent's backoff/undo deadline;
    // otherwise a redelivery could overwrite the user's later choice.
    const waiting = actions.findIndex((action) => !action.due);
    if (waiting !== -1) actions.splice(waiting);
    if (!actions.length) return;
    // Claiming is the dispatch point: an undo that committed first leaves the row unclaimed.
    const claimed = await withLease(pool, account, (db) =>
      db.query<{ id: string }>(
        `UPDATE mail_actions SET next_attempt_at=clock_timestamp()+interval '90 seconds'
        WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' AND next_attempt_at<=clock_timestamp()
        RETURNING id`,
        [owner, actions.map((action) => action.id)],
      ),
    );
    for (const row of claimed.rows) remaining.add(row.id);
    const finish = async (
      id: string,
      state: 'applied' | 'failed' | 'conflict',
      code: string | null = null,
      record?: (db: PoolClient) => Promise<unknown>,
    ) => {
      await withLease(pool, account, async (db) => {
        await record?.(db);
        await settle(db, owner, [id], state, code);
        if (state !== 'applied') {
          await db.query(
            'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1 AND account_id=$2',
            [owner, accountId],
          );
          await db.query(
            'UPDATE mail_accounts SET next_sync_at=clock_timestamp() WHERE user_id=$1 AND id=$2',
            [owner, accountId],
          );
        }
      });
      remaining.delete(id);
    };
    for (const action of actions) {
      if (!remaining.has(action.id)) continue;
      // Read the current location per action: an earlier move in this batch changes the UID.
      const at = (
        await pool.query<{
          mailbox_id: string;
          uid: string;
          uid_validity: string;
          path: string;
        }>(
          `SELECT mm.mailbox_id,mm.uid,mm.uid_validity,b.path FROM mail_memberships mm
          JOIN mailboxes b ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=mm.mailbox_id
          WHERE mm.user_id=$1 AND mm.account_id=$2 AND mm.message_id=$3 LIMIT 1`,
          [owner, accountId, action.message_id],
        )
      ).rows[0];
      // Another client moved or deleted the message, or removed the destination, first.
      if (!at) {
        await finish(action.id, 'conflict', 'message_missing');
        continue;
      }
      if (moveKinds.includes(action.kind) && !action.target_path) {
        await finish(action.id, 'conflict', 'folder_missing');
        continue;
      }
      // A crash after sending a move may leave an unacknowledged COPY/DELETE.
      // Repeating it could create a second copy, so reconcile instead.
      if (action.error_code === 'move_unconfirmed') {
        await finish(action.id, 'conflict', 'move_unconfirmed');
        continue;
      }
      if (!client) {
        client = await connect(
          account,
          decryptCredential(account.credential, owner, accountId, keys),
        );
        const opened = client;
        timer = setTimeout(() => opened.close(), 45000);
      }
      const active = client;
      // Local metadata can lag other clients. Check provider folders and the exact
      // UID before STORE/MOVE: IMAP may acknowledge a nonexistent UID as a no-op.
      const folders = (await active.list()).filter(
        (box) => !box.flags.has('\\Noselect'),
      );
      if (!folders.some((box) => box.path === at.path)) {
        await finish(action.id, 'conflict', 'source_missing');
        continue;
      }
      if (
        action.target_path &&
        !folders.some((box) => box.path === action.target_path)
      ) {
        await finish(action.id, 'conflict', 'folder_missing');
        continue;
      }
      // Without MOVE or UIDPLUS the fallback EXPUNGE would also remove other clients' \Deleted mail.
      if (
        action.target_path &&
        !active.capabilities.has('MOVE') &&
        !active.capabilities.has('UIDPLUS')
      ) {
        await finish(action.id, 'failed', 'move_unsupported');
        continue;
      }
      const lock = await active.getMailboxLock(at.path);
      try {
        if (
          String(active.mailbox ? active.mailbox.uidValidity : '') !==
          at.uid_validity
        ) {
          await finish(action.id, 'conflict', 'message_changed');
          continue;
        }
        const present = await active.fetchOne(
          at.uid,
          { uid: true },
          { uid: true },
        );
        if (!present) {
          await finish(action.id, 'conflict', 'message_missing');
          continue;
        }
        if (at.mailbox_id === action.target_mailbox_id) {
          await finish(action.id, 'applied');
          continue;
        }
        if (action.target_path && action.target_mailbox_id) {
          const target = action.target_mailbox_id;
          await withLease(pool, account, (db) =>
            db.query(
              `UPDATE mail_actions SET error_code='move_unconfirmed' WHERE user_id=$1 AND id=$2 AND state='pending'`,
              [owner, action.id],
            ),
          );
          const moved = await active.messageMove(at.uid, action.target_path, {
            uid: true,
          });
          if (!moved) throw new Error('Provider rejected move');
          const uid = moved.uidMap?.get(Number(at.uid));
          if (moved.uidMap && !uid) {
            await finish(action.id, 'conflict', 'message_missing');
            continue;
          }
          const validity = moved.uidValidity ? String(moved.uidValidity) : '';
          await finish(action.id, 'applied', null, async (db) => {
            if (uid && validity) {
              // COPYUID keeps the same local message, cache and history at its new address.
              await db.query(
                `UPDATE mail_memberships SET mailbox_id=$4,uid_validity=$5,uid=$6
                WHERE user_id=$1 AND account_id=$2 AND message_id=$3`,
                [owner, accountId, action.message_id, target, validity, uid],
              );
              await db.query(
                'UPDATE mail_messages SET remote_key=$4 WHERE user_id=$1 AND account_id=$2 AND id=$3',
                [
                  owner,
                  accountId,
                  action.message_id,
                  `${target}:${validity}:${uid}`,
                ],
              );
              return;
            }
            // Without COPYUID the destination UID is unknown: rescan that folder instead.
            await db.query(
              'DELETE FROM mail_memberships WHERE user_id=$1 AND account_id=$2 AND message_id=$3',
              [owner, accountId, action.message_id],
            );
            await db.query(
              'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1 AND account_id=$2 AND id=$3',
              [owner, accountId, target],
            );
            await db.query(
              'UPDATE mail_accounts SET next_sync_at=clock_timestamp() WHERE user_id=$1 AND id=$2',
              [owner, accountId],
            );
          });
          continue;
        }
        // STORE +/-FLAGS is idempotent, so redelivery after a crash is safe.
        const stored =
          action.kind === 'read'
            ? await active.messageFlagsAdd(at.uid, ['\\Seen'], { uid: true })
            : await active.messageFlagsRemove(at.uid, ['\\Seen'], {
                uid: true,
              });
        if (!stored) throw new Error('Provider rejected flag change');
        const confirmed = await active.fetchOne(
          at.uid,
          { flags: true },
          { uid: true },
        );
        if (!confirmed) {
          await finish(action.id, 'conflict', 'message_missing');
          continue;
        }
        if (
          Boolean(confirmed.flags?.has('\\Seen')) !==
          (action.kind === 'read')
        ) {
          await finish(action.id, 'conflict', 'flags_changed');
          continue;
        }
        await finish(action.id, 'applied');
      } finally {
        lock.release();
      }
    }
  } catch {
    // Transient failures retry with backoff; the fifth failure reverts the local change.
    await withLease(pool, account, async (db) => {
      const failed = (
        await db.query<{ id: string; attempts: number }>(
          `UPDATE mail_actions SET attempts=attempts+1,
          next_attempt_at=clock_timestamp()+make_interval(secs=>15*power(2,attempts))
          WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' AND error_code IS DISTINCT FROM 'move_unconfirmed' RETURNING id,attempts`,
          [owner, [...remaining]],
        )
      ).rows.filter((row) => row.attempts >= 5);
      const uncertain = (
        await db.query<{ id: string }>(
          `SELECT id FROM mail_actions WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' AND error_code='move_unconfirmed'`,
          [owner, [...remaining]],
        )
      ).rows;
      if (uncertain.length)
        await settle(
          db,
          owner,
          uncertain.map((row) => row.id),
          'conflict',
          'move_unconfirmed',
        );
      if (failed.length)
        await settle(
          db,
          owner,
          failed.map((row) => row.id),
          'failed',
          'provider_unavailable',
        );
      if (failed.length || uncertain.length) {
        await db.query(
          'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1 AND account_id=$2',
          [owner, accountId],
        );
        await db.query(
          'UPDATE mail_accounts SET next_sync_at=clock_timestamp() WHERE user_id=$1 AND id=$2',
          [owner, accountId],
        );
      }
    }).catch(() => {});
  } finally {
    if (timer) clearTimeout(timer);
    client?.close();
    await releaseLease(pool, account);
  }
}
