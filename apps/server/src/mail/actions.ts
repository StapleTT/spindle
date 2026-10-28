import type { Pool, PoolClient } from 'pg';
import { decryptCredential, type MailKeys } from './credentials.js';
import { connectImap } from './imap.js';
import { claimAccount, releaseLease, withLease } from './store.js';

export type ActionKind = 'read' | 'unread';

// SQL for a flags array with an action's \Seen change applied; other flags are untouched.
export function withSeen(flags: string, kind: string) {
  return `CASE ${kind} WHEN 'read' THEN array_append(array_remove(${flags},'\\Seen'),'\\Seen')
    WHEN 'unread' THEN array_remove(${flags},'\\Seen') ELSE ${flags} END`;
}

// Latest pending intent for a message; sync keeps it over provider flags until applied.
export const pendingKind = (user: string, message: string) =>
  `(SELECT a.kind FROM mail_actions a WHERE a.user_id=${user} AND a.message_id=${message}
    AND a.state='pending' ORDER BY a.seq DESC LIMIT 1)`;

type Settled = {
  message_id: string;
  kind: ActionKind;
  seq: string;
  state: string;
};

async function settle(
  db: PoolClient,
  owner: string,
  ids: string[],
  state: 'applied' | 'failed',
  code: string | null,
) {
  const rows = (
    await db.query<Settled>(
      `UPDATE mail_actions SET state=$3,error_code=$4,completed_at=clock_timestamp()
      WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' RETURNING message_id,kind,seq,state`,
      [owner, ids, state, code],
    )
  ).rows;
  // Applied intent is now provider truth; a failed change is reverted locally.
  // Either way, a newer action for the same message owns the local state.
  for (const row of rows)
    await db.query(
      `UPDATE mail_memberships SET flags=${withSeen('flags', '$3::text')} WHERE user_id=$1 AND message_id=$2
      AND NOT EXISTS(SELECT 1 FROM mail_actions n WHERE n.user_id=$1 AND n.message_id=$2 AND n.seq>$4)`,
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
}

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
      await pool.query<{
        id: string;
        kind: ActionKind;
        uid: string | null;
        uid_validity: string | null;
        path: string | null;
      }>(
        `SELECT a.id,a.kind,mm.uid,mm.uid_validity,b.path FROM mail_actions a
        LEFT JOIN mail_memberships mm ON mm.user_id=a.user_id AND mm.account_id=a.account_id AND mm.message_id=a.message_id
        LEFT JOIN mailboxes b ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=mm.mailbox_id
        WHERE a.user_id=$1 AND a.account_id=$2 AND a.state='pending' AND a.next_attempt_at<=clock_timestamp()
        ORDER BY a.seq LIMIT 50`,
        [owner, accountId],
      )
    ).rows;
    if (!actions.length) return;
    for (const action of actions) remaining.add(action.id);
    await withLease(pool, account, (db) =>
      db.query(
        `UPDATE mail_actions SET next_attempt_at=clock_timestamp()+interval '90 seconds'
        WHERE user_id=$1 AND id=ANY($2::uuid[])`,
        [owner, [...remaining]],
      ),
    );
    const finish = async (
      ids: string[],
      state: 'applied' | 'failed',
      code: string | null = null,
    ) => {
      await withLease(pool, account, (db) =>
        settle(db, owner, ids, state, code),
      );
      for (const id of ids) remaining.delete(id);
    };
    const orphaned = actions.filter((action) => !action.path);
    if (orphaned.length)
      await finish(
        orphaned.map((action) => action.id),
        'failed',
        'message_changed',
      );
    const paths = [...new Set(actions.flatMap((action) => action.path ?? []))];
    if (!paths.length) return;
    client = await connect(
      account,
      decryptCredential(account.credential, owner, accountId, keys),
    );
    const active = client;
    timer = setTimeout(() => active.close(), 45000);
    for (const path of paths) {
      const lock = await active.getMailboxLock(path);
      try {
        const validity = String(
          active.mailbox ? active.mailbox.uidValidity : '',
        );
        for (const action of actions.filter((item) => item.path === path)) {
          if (action.uid_validity !== validity) {
            await finish([action.id], 'failed', 'message_changed');
            continue;
          }
          // STORE +/-FLAGS is idempotent, so redelivery after a crash is safe.
          const stored =
            action.kind === 'read'
              ? await active.messageFlagsAdd(String(action.uid), ['\\Seen'], {
                  uid: true,
                })
              : await active.messageFlagsRemove(
                  String(action.uid),
                  ['\\Seen'],
                  { uid: true },
                );
          if (!stored) throw new Error('Provider rejected flag change');
          await finish([action.id], 'applied');
        }
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
          WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' RETURNING id,attempts`,
          [owner, [...remaining]],
        )
      ).rows.filter((row) => row.attempts >= 5);
      if (failed.length)
        await settle(
          db,
          owner,
          failed.map((row) => row.id),
          'failed',
          'provider_unavailable',
        );
    }).catch(() => {});
  } finally {
    if (timer) clearTimeout(timer);
    client?.close();
    await releaseLease(pool, account);
  }
}
