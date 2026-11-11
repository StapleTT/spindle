import type { Pool, PoolClient } from 'pg';
import { logger } from '../logger.js';
import { writeMemberships } from './actions.js';
import { reconcileConversationState } from './conversation-state.js';
import type { MailKeys } from './credentials.js';
import {
  type MicrosoftApi,
  type MicrosoftConfig,
  MicrosoftError,
  MicrosoftPause,
  openMicrosoft,
} from './microsoft.js';
import { headerBlock, parseReplyHeaders } from './parse.js';
import { claimAccount, type MailAccount, withLease } from './store.js';
import { text, upsertMessage, validDate } from './sync.js';
import { bodyPending } from './work-pending.js';

export const graphId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_+=/-]{1,2048}$/.test(value);

export type GraphMessage = {
  id: string;
  parentFolderId: string;
  receivedDateTime?: string;
  sentDateTime?: string;
  subject?: string;
  internetMessageId?: string;
  internetMessageHeaders?: unknown;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  ccRecipients?: { emailAddress?: { name?: string; address?: string } }[];
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
};
const fields =
  'id,parentFolderId,receivedDateTime,sentDateTime,subject,internetMessageId,internetMessageHeaders,from,toRecipients,ccRecipients,isRead,isDraft,flag';

export async function graphMessage(api: MicrosoftApi, remote: string) {
  const message = await api<GraphMessage>(
    `/messages/${encodeURIComponent(remote)}`,
    { $select: fields },
  );
  if (message.id !== remote || !graphId(message.parentFolderId))
    throw new MicrosoftError(502, 'invalid_response');
  return message;
}

export function graphFlags(message: GraphMessage) {
  return [
    ...(message.isRead === true ? ['\\Seen'] : []),
    ...(message.isDraft === true ? ['\\Draft'] : []),
    ...(message.flag?.flagStatus === 'flagged' ? ['\\Flagged'] : []),
  ];
}

// Shared with actions so provider replies and sync write identical memberships.
export async function saveGraphMessage(
  db: PoolClient,
  account: MailAccount,
  boxes: Map<string, string>,
  message: GraphMessage,
  notify = false,
) {
  const received = validDate(new Date(message.receivedDateTime ?? ''));
  if (!received) throw new MicrosoftError(502, 'invalid_response');
  if (account.history_since && received < account.history_since) {
    await db.query(
      'DELETE FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key=$3',
      [account.user_id, account.id, message.id],
    );
    return null;
  }
  const box = boxes.get(message.parentFolderId);
  if (!box) throw new MicrosoftPause(1); // Folder discovery catches concurrent new folders next pass.
  const { block } = headerBlock(message.internetMessageHeaders, [
    'From',
    'To',
    'Cc',
    'Subject',
    'Date',
    'Message-ID',
    'In-Reply-To',
    'References',
  ]);
  let headers: Awaited<ReturnType<typeof parseReplyHeaders>> | null = null;
  try {
    headers = await parseReplyHeaders(block);
  } catch {
    /* Malformed mail headers must not block the metadata page. */
  }
  const local = await upsertMessage(
    db,
    account,
    message.id,
    {
      messageId: headers?.messageId ?? message.internetMessageId,
      subject:
        typeof message.subject === 'string'
          ? message.subject
          : headers?.subject,
      from: message.from?.emailAddress
        ? [message.from.emailAddress]
        : headers?.from,
      to: Array.isArray(message.toRecipients)
        ? message.toRecipients
            .slice(0, 100)
            .map((item) => item.emailAddress ?? {})
        : headers?.to,
      cc: Array.isArray(message.ccRecipients)
        ? message.ccRecipients
            .slice(0, 100)
            .map((item) => item.emailAddress ?? {})
        : headers?.cc,
      sentAt: validDate(new Date(message.sentDateTime ?? '')),
      receivedAt: received,
      inReplyTo: headers?.inReplyTo ?? undefined,
      references: headers?.references ?? null,
      // Graph has no ordinary size property; raw content is bounded separately.
      size: 0,
    },
    notify && !message.isRead && !message.isDraft,
  );
  await writeMemberships(db, account, local, {
    flags: graphFlags(message),
    targets: [box],
  });
  return local;
}

const roles: Record<string, string> = {
  inbox: 'inbox',
  sentitems: '\\Sent',
  drafts: '\\Drafts',
  deleteditems: '\\Trash',
  junkemail: '\\Junk',
  archive: '\\Archive',
};
type Checkpoint = {
  next_link: string | null;
  delta_link: string | null;
  initial_complete: boolean;
};
type DeltaPage = {
  value?: unknown;
  '@odata.nextLink'?: unknown;
  '@odata.deltaLink'?: unknown;
};

function pageValues(page: DeltaPage) {
  if (!Array.isArray(page.value) || page.value.length > 500)
    throw new MicrosoftError(502, 'invalid_response');
  return page.value as {
    id?: unknown;
    displayName?: unknown;
    '@removed'?: unknown;
  }[];
}
function links(page: DeltaPage, config: MicrosoftConfig) {
  const next = page['@odata.nextLink'];
  const delta = page['@odata.deltaLink'];
  if (Boolean(next) === Boolean(delta))
    throw new MicrosoftError(502, 'invalid_link');
  for (const link of [next, delta]) {
    if (link === undefined) continue;
    if (typeof link !== 'string' || link.length > 16384)
      throw new MicrosoftError(502, 'invalid_link');
    const url = new URL(link);
    const base = new URL(config.graphUrl);
    if (
      url.origin !== base.origin ||
      !url.pathname.startsWith(`${base.pathname}/mailFolders`) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new MicrosoftError(502, 'invalid_link');
  }
  return {
    next: typeof next === 'string' ? next : null,
    delta: typeof delta === 'string' ? delta : null,
  };
}

// Folder hierarchy and per-folder message deltas use the same durable page checkpoint.
export async function syncGraphAccount(
  pool: Pool,
  keys: MailKeys,
  microsoft: MicrosoftConfig | null,
  owner: string,
  id: string,
) {
  const account = await claimAccount(pool, owner, id);
  if (!account) return false;
  const started = new Date();
  const deadline = started.getTime() + 40000;
  try {
    const api = await openMicrosoft(
      pool,
      microsoft,
      keys,
      account,
      started.getTime() + 75000,
    );
    if (!microsoft) throw new Error('Microsoft is not configured');
    const roleIds = new Map<string, string>();
    for (const [folder, role] of Object.entries(roles)) {
      try {
        const result = await api<{ id?: unknown }>(`/mailFolders/${folder}`, {
          $select: 'id',
        });
        if (!graphId(result.id))
          throw new MicrosoftError(502, 'invalid_response');
        roleIds.set(result.id, role);
      } catch (error) {
        if (!(error instanceof MicrosoftError && error.status === 404))
          throw error;
      }
    }
    await withLease(pool, account, async (db) => {
      await db.query(
        "INSERT INTO mail_graph_sync(user_id,account_id,scope) VALUES($1,$2,'') ON CONFLICT DO NOTHING",
        [owner, id],
      );
      // Roles come from well-known IDs, never localized display names.
      await db.query(
        'UPDATE mailboxes SET role=NULL WHERE user_id=$1 AND account_id=$2',
        [owner, id],
      );
      for (const [path, role] of roleIds)
        await db.query(
          'UPDATE mailboxes SET role=$4 WHERE user_id=$1 AND account_id=$2 AND path=$3',
          [owner, id, path, role],
        );
    });
    let foldersDone = false;
    let boxes = new Map<string, string>();
    const loadBoxes = async () =>
      new Map(
        (
          await pool.query<{ id: string; path: string }>(
            'SELECT id,path FROM mailboxes WHERE user_id=$1 AND account_id=$2',
            [owner, id],
          )
        ).rows.map((row) => [row.path, row.id]),
      );
    while (Date.now() < deadline) {
      if ((await pool.query(bodyPending, [owner, id])).rowCount) break;
      const scopeRow = foldersDone
        ? (
            await pool.query<{ scope: string }>(
              `SELECT s.scope FROM mail_graph_sync s JOIN mailboxes b ON b.user_id=s.user_id AND b.account_id=s.account_id AND b.path=s.scope
            WHERE s.user_id=$1 AND s.account_id=$2 AND (s.checked_at IS NULL OR s.checked_at<$3)
            ORDER BY s.checked_at NULLS FIRST,s.scope LIMIT 1`,
              [owner, id, started],
            )
          ).rows[0]
        : { scope: '' };
      if (!scopeRow) break;
      const scope = scopeRow.scope;
      const state = (
        await pool.query<Checkpoint>(
          'SELECT next_link,delta_link,initial_complete FROM mail_graph_sync WHERE user_id=$1 AND account_id=$2 AND scope=$3',
          [owner, id, scope],
        )
      ).rows[0];
      if (!state) throw new Error('Graph checkpoint missing');
      let page: DeltaPage;
      try {
        page = await api<DeltaPage>(
          state.next_link ??
            state.delta_link ??
            (scope
              ? `/mailFolders/${encodeURIComponent(scope)}/messages/delta`
              : '/mailFolders/delta'),
          state.next_link || state.delta_link
            ? {}
            : { $select: scope ? fields : 'id,displayName' },
          { headers: { prefer: 'odata.maxpagesize=50' } },
        );
      } catch (error) {
        if (
          error instanceof MicrosoftError &&
          (error.status === 410 ||
            [
              'SyncStateNotFound',
              'InvalidDeltaToken',
              'ErrorInvalidSyncStateData',
              'resyncRequired',
            ].includes(error.code))
        ) {
          await withLease(pool, account, async (db) => {
            await db.query(
              'UPDATE mail_graph_sync SET next_link=NULL,delta_link=NULL,initial_complete=false,checked_at=NULL WHERE user_id=$1 AND account_id=$2 AND scope=$3',
              [owner, id, scope],
            );
            await db.query(
              'DELETE FROM mail_graph_listed WHERE user_id=$1 AND account_id=$2 AND scope=$3',
              [owner, id, scope],
            );
            if (scope)
              await db.query(
                'UPDATE mailboxes SET initial_complete=false WHERE user_id=$1 AND account_id=$2 AND path=$3',
                [owner, id, scope],
              );
          });
          continue;
        }
        // A concurrently removed folder is reconciled by hierarchy delta next pass.
        if (scope && error instanceof MicrosoftError && error.status === 404)
          throw new MicrosoftPause(1);
        throw error;
      }
      const values = pageValues(page);
      const checkpoint = links(page, microsoft);
      for (const entry of values)
        if (!graphId(entry.id))
          throw new MicrosoftError(502, 'invalid_response');
      const messages: [string, GraphMessage | null][] = [];
      if (scope)
        for (const entry of values) {
          const remote = entry.id as string;
          try {
            messages.push([remote, await graphMessage(api, remote)]);
          } catch (error) {
            if (error instanceof MicrosoftError && error.status === 404)
              messages.push([remote, null]);
            else throw error;
          }
        }
      await withLease(pool, account, async (db) => {
        if (!scope) {
          for (const entry of values) {
            const path = entry.id as string;
            if (entry['@removed']) {
              await db.query(
                'DELETE FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND path=$3',
                [owner, id, path],
              );
              await db.query(
                'DELETE FROM mail_graph_sync WHERE user_id=$1 AND account_id=$2 AND scope=$3',
                [owner, id, path],
              );
            } else {
              if (typeof entry.displayName !== 'string')
                throw new MicrosoftError(502, 'invalid_response');
              await db.query(
                `INSERT INTO mailboxes(user_id,account_id,path,name,role) VALUES($1,$2,$3,$4,$5)
                ON CONFLICT(account_id,path) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role`,
                [
                  owner,
                  id,
                  path,
                  text(entry.displayName, 1000),
                  roleIds.get(path) ?? null,
                ],
              );
              await db.query(
                'INSERT INTO mail_graph_sync(user_id,account_id,scope) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
                [owner, id, path],
              );
            }
          }
        } else {
          const anchors: string[] = [];
          for (const [remote, message] of messages) {
            // A folder tombstone can be a move. Fetching by immutable ID above
            // preserves the global message and body cache when it still exists.
            if (!message)
              await db.query(
                'DELETE FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key=$3',
                [owner, id, remote],
              );
            else {
              const local = await saveGraphMessage(
                db,
                account,
                boxes,
                message,
                state.initial_complete &&
                  roleIds.get(message.parentFolderId) === 'inbox',
              );
              if (local) anchors.push(local);
            }
          }
          await reconcileConversationState(db, owner, id, anchors);
        }
        if (!state.initial_complete) {
          await db.query(
            `INSERT INTO mail_graph_listed(user_id,account_id,scope,remote_key)
            SELECT $1,$2,$3,unnest($4::text[]) ON CONFLICT DO NOTHING`,
            [
              owner,
              id,
              scope,
              values
                .filter((entry) => !entry['@removed'])
                .map((entry) => entry.id),
            ],
          );
          if (!checkpoint.next) {
            if (!scope)
              await db.query(
                `DELETE FROM mailboxes b WHERE b.user_id=$1 AND b.account_id=$2
              AND NOT EXISTS(SELECT 1 FROM mail_graph_listed l WHERE l.account_id=$2 AND l.scope='' AND l.remote_key=b.path)`,
                [owner, id],
              );
            else
              await db.query(
                `DELETE FROM mail_memberships mm USING mail_messages m,mailboxes b
              WHERE mm.user_id=$1 AND mm.account_id=$2 AND b.id=mm.mailbox_id AND b.path=$3 AND m.id=mm.message_id
              AND NOT EXISTS(SELECT 1 FROM mail_graph_listed l WHERE l.account_id=$2 AND l.scope=$3 AND l.remote_key=m.remote_key)`,
                [owner, id, scope],
              );
            await db.query(
              'DELETE FROM mail_graph_listed WHERE user_id=$1 AND account_id=$2 AND scope=$3',
              [owner, id, scope],
            );
          }
        }
        await db.query(
          `UPDATE mail_graph_sync SET next_link=$4,delta_link=COALESCE($5,delta_link),
          initial_complete=initial_complete OR $4::text IS NULL,checked_at=CASE WHEN $4::text IS NULL THEN $6 ELSE checked_at END
          WHERE user_id=$1 AND account_id=$2 AND scope=$3`,
          [owner, id, scope, checkpoint.next, checkpoint.delta, started],
        );
        if (scope && !checkpoint.next)
          await db.query(
            'UPDATE mailboxes SET initial_complete=true,last_synced_at=clock_timestamp() WHERE user_id=$1 AND account_id=$2 AND path=$3',
            [owner, id, scope],
          );
      });
      if (!scope && !checkpoint.next) {
        foldersDone = true;
        await withLease(pool, account, (db) =>
          db.query(
            `DELETE FROM mail_graph_sync s WHERE s.user_id=$1 AND s.account_id=$2 AND s.scope<>''
          AND NOT EXISTS(SELECT 1 FROM mailboxes b WHERE b.user_id=s.user_id AND b.account_id=s.account_id AND b.path=s.scope)`,
            [owner, id],
          ),
        );
        boxes = await loadBoxes();
      }
    }
    // Folder deletion/full resync can orphan rows; reconcile their current
    // immutable location in bounded, individually committed steps.
    if (foldersDone)
      while (Date.now() < deadline) {
        if ((await pool.query(bodyPending, [owner, id])).rowCount) break;
        const orphan = (
          await pool.query<{ remote_key: string }>(
            `SELECT m.remote_key FROM mail_messages m WHERE m.user_id=$1 AND m.account_id=$2
          AND NOT EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.message_id=m.id) LIMIT 1`,
            [owner, id],
          )
        ).rows[0];
        if (!orphan) break;
        let message: GraphMessage | null;
        try {
          message = await graphMessage(api, orphan.remote_key);
        } catch (error) {
          if (error instanceof MicrosoftError && error.status === 404)
            message = null;
          else throw error;
        }
        await withLease(pool, account, async (db) => {
          if (message) {
            const local = await saveGraphMessage(db, account, boxes, message);
            if (local) await reconcileConversationState(db, owner, id, [local]);
          } else
            await db.query(
              'DELETE FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key=$3',
              [owner, id, orphan.remote_key],
            );
        });
      }
    await withLease(pool, account, async (db) => {
      const pending = (
        await db.query(
          `SELECT 1 FROM mail_graph_sync WHERE user_id=$1 AND account_id=$2 AND (NOT initial_complete OR next_link IS NOT NULL)
        UNION ALL SELECT 1 FROM mail_messages m WHERE m.user_id=$1 AND m.account_id=$2 AND NOT EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.message_id=m.id) LIMIT 1`,
          [owner, id],
        )
      ).rowCount;
      await db.query(
        `UPDATE mail_accounts SET status=CASE WHEN $4 THEN 'syncing' ELSE 'ready' END,
        next_sync_at=clock_timestamp()+CASE WHEN $4 OR sync_request<>$3 THEN interval '1 second' ELSE interval '60 seconds' END,
        sync_completed=$3,error_code=NULL,failures=0,last_synced_at=clock_timestamp(),lease_token=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2`,
        [owner, id, account.sync_request, Boolean(pending)],
      );
    });
    return true;
  } catch (error) {
    const paused =
      error instanceof MicrosoftPause ||
      (error instanceof MicrosoftError && error.status === 429);
    const reconnect =
      error instanceof MicrosoftError &&
      (error.status === 401 ||
        error.code === 'invalid_grant' ||
        error.code === 'insufficient_scope' ||
        error.code === 'ErrorAccessDenied');
    if (!paused)
      logger.warn(
        {
          account: id,
          ...(error instanceof MicrosoftError
            ? { status: error.status, code: error.code }
            : {}),
        },
        'Microsoft sync failed',
      );
    await pool.query(
      `UPDATE mail_accounts SET status=$4,error_code=$5,failures=CASE WHEN $4='error' THEN LEAST(failures+1,10) ELSE failures END,
      next_sync_at=clock_timestamp()+make_interval(secs=>$6),lease_token=NULL,lease_until=NULL
      WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
      [
        owner,
        id,
        account.lease_token,
        paused ? 'syncing' : 'error',
        paused ? null : reconnect ? 'reconnect_required' : 'sync_failed',
        paused
          ? error instanceof MicrosoftPause
            ? error.delaySeconds
            : error instanceof MicrosoftError
              ? (error.retryAfter ?? 60)
              : 60
          : reconnect
            ? 30 * 86400
            : Math.min(3600, 30 * 2 ** Math.min(account.failures, 7)),
      ],
    );
    return false;
  }
}
