import type { Pool, PoolClient } from 'pg';
import { logger } from '../logger.js';
import { writeMemberships } from './actions.js';
import { reconcileConversationState } from './conversation-state.js';
import { decryptCredential, type MailKeys } from './credentials.js';
import {
  type GoogleConfig,
  GoogleError,
  type GoogleRequest,
  googleJson,
  refreshAccessToken,
} from './google.js';
import { headerBlock, parseReplyHeaders } from './parse.js';
import { defaultSenderName } from './smtp.js';
import { claimAccount, type MailAccount, withLease } from './store.js';
import { text, upsertMessage, validDate } from './sync.js';
import { bodyPending } from './work-pending.js';

type GmailMessage = {
  id?: unknown;
  labelIds?: unknown;
  internalDate?: unknown;
  sizeEstimate?: unknown;
  payload?: { headers?: { name?: unknown; value?: unknown }[] };
};
type HistoryEntry = { message?: { id?: unknown }; labelIds?: unknown };
type HistoryRecord = Partial<
  Record<
    'messagesAdded' | 'messagesDeleted' | 'labelsAdded' | 'labelsRemoved',
    HistoryEntry[]
  >
>;

// System labels that are folders; other system labels (UNREAD, STARRED,
// IMPORTANT, CATEGORY_*, CHAT) are flags or Gmail-only views.
const SYSTEM_FOLDERS: Record<string, [string, string]> = {
  INBOX: ['Inbox', 'inbox'],
  SENT: ['Sent', '\\Sent'],
  DRAFT: ['Drafts', '\\Drafts'],
  SPAM: ['Spam', '\\Junk'],
  TRASH: ['Trash', '\\Trash'],
};
// Synthetic Archive folder: mail with none of INBOX, SPAM or TRASH, which is
// what Gmail calls archived. Brackets never occur in Gmail label IDs. The path
// predates D040, when this folder held all mail outside Spam and Trash.
export const ARCHIVE = '[All Mail]';
const HEADERS = [
  'From',
  'To',
  'Cc',
  'Subject',
  'Date',
  'Message-ID',
  'In-Reply-To',
  'References',
];
const PAGE = 100;
// Gmail allows 250 quota units per user per second and messages.get costs 5.
// Starting at most one request per 25 ms keeps a job near 200 units/s, and a
// small pool stays under Google's concurrent-request limit.
const CONCURRENCY = 5;
const SPACING_MS = 25;
const RETRIES = 4;

// Quota exhaustion or the job deadline: stop without an error state. Committed
// pages are kept and the next job resumes from the checkpoint.
export class GmailPause extends Error {
  constructor(readonly delaySeconds: number) {
    super('Gmail sync paused');
  }
}

const retryable = (error: GoogleError) =>
  error.status === 429 ||
  error.status >= 500 ||
  (error.status === 403 &&
    [
      'rateLimitExceeded',
      'userRateLimitExceeded',
      'RESOURCE_EXHAUSTED',
    ].includes(error.reason));
// Consent revoked or Gmail access unchecked after connecting.
export const needsReconnect = (error: unknown) =>
  error instanceof GoogleError &&
  (error.code === 'invalid_grant' ||
    error.status === 401 ||
    (error.status === 403 &&
      ['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(
        error.reason,
      )));
const remoteId = /^[0-9A-Za-z_-]{1,64}$/;
const historyId = /^[0-9]{1,20}$/;

function ids(values: unknown, limit: number) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > limit)
    throw new Error('Invalid Gmail response');
  return values.map((value) => {
    const id = (value as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !remoteId.test(id))
      throw new Error('Invalid Gmail response');
    return id;
  });
}

// Gmail labels as local memberships and flags. Every message maps to Inbox,
// Spam, Trash or Archive, so an empty target list means a folder is missing.
export function mirror(labels: string[], boxes: Map<string, string>) {
  const flags = [
    ...(labels.includes('UNREAD') ? [] : ['\\Seen']),
    ...(labels.includes('STARRED') ? ['\\Flagged'] : []),
    ...(labels.includes('DRAFT') ? ['\\Draft'] : []),
  ];
  // Trash and Spam hide mail from every other view, as in Gmail.
  const shown = labels.includes('TRASH')
    ? ['TRASH']
    : labels.includes('SPAM')
      ? ['SPAM']
      : labels.includes('INBOX')
        ? labels
        : [...labels, ARCHIVE];
  const targets = [
    ...new Set(
      shown
        .map((label) => boxes.get(label))
        .filter((box): box is string => Boolean(box)),
    ),
  ];
  return { flags, targets };
}

async function saveGmailMessage(
  db: PoolClient,
  account: MailAccount,
  boxes: Map<string, string>,
  message: GmailMessage,
  notify: boolean,
) {
  const id = message.id as string;
  const labels = Array.isArray(message.labelIds)
    ? message.labelIds
        .slice(0, 500)
        .filter((label) => typeof label === 'string')
    : [];
  const received = validDate(new Date(Number(message.internalDate)));
  if (
    !received ||
    (account.history_since && received < account.history_since)
  ) {
    await db.query(
      'DELETE FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key=$3',
      [account.user_id, account.id, id],
    );
    return null;
  }
  const { values, block } = headerBlock(message.payload?.headers, HEADERS);
  let meta: Awaited<ReturnType<typeof parseReplyHeaders>> | null = null;
  try {
    meta = await parseReplyHeaders(block);
  } catch {
    // Unparseable headers still leave a listed message.
  }
  const mirrored = mirror(labels, boxes);
  if (!mirrored.targets.length) return null;
  const local = await upsertMessage(
    db,
    account,
    id,
    {
      messageId: meta?.messageId ?? undefined,
      subject: meta?.subject ?? values.get('subject'),
      from: meta?.from,
      to: meta?.to,
      cc: meta?.cc,
      sentAt: validDate(new Date(values.get('date') ?? '')),
      receivedAt: received,
      inReplyTo: meta?.inReplyTo ?? undefined,
      size: Number.isSafeInteger(message.sizeEstimate)
        ? Math.max(0, message.sizeEstimate as number)
        : 0,
      references: meta?.references ?? null,
    },
    notify &&
      labels.includes('INBOX') &&
      labels.includes('UNREAD') &&
      !labels.includes('DRAFT'),
  );
  await writeMemberships(db, account, local, mirrored);
  return local;
}

// Label-only history changes are applied as deltas to the local label set, so
// bulk changes (mark all read, filters) need no refetch. Mirrored labels are
// recovered from folder paths and flags; unmirrored ones (IMPORTANT,
// CATEGORY_*) never affect local state.
export async function applyLabelDeltas(
  db: PoolClient,
  account: MailAccount,
  boxes: Map<string, string>,
  deltas: Map<string, [add: boolean, labels: string[]][]>,
) {
  if (!deltas.size) return [];
  const rows = (
    await db.query<{
      id: string;
      remote_key: string;
      paths: string[];
      flags: string[];
    }>(
      `SELECT m.id,m.remote_key,array_agg(b.path) AS paths,
       (SELECT x.flags FROM mail_memberships x WHERE x.message_id=m.id LIMIT 1) AS flags
       FROM mail_messages m JOIN mail_memberships mm ON mm.user_id=m.user_id AND mm.message_id=m.id
       JOIN mailboxes b ON b.user_id=mm.user_id AND b.id=mm.mailbox_id
       WHERE m.user_id=$1 AND m.account_id=$2 AND m.remote_key=ANY($3::text[]) GROUP BY m.id`,
      [account.user_id, account.id, [...deltas.keys()]],
    )
  ).rows;
  for (const row of rows) {
    const labels = new Set(row.paths.filter((path) => path !== ARCHIVE));
    if (!row.flags.includes('\\Seen')) labels.add('UNREAD');
    if (row.flags.includes('\\Flagged')) labels.add('STARRED');
    if (row.flags.includes('\\Draft')) labels.add('DRAFT');
    for (const [add, changed] of deltas.get(row.remote_key) ?? [])
      for (const label of changed)
        if (add) labels.add(label);
        else labels.delete(label);
    const mirrored = mirror([...labels], boxes);
    if (mirrored.targets.length)
      await writeMemberships(db, account, row.id, mirrored);
  }
  return rows.map((row) => row.id);
}

// Access tokens (about one hour) are reused across jobs in this worker's
// memory only, never stored; a reconnect's new credential invalidates them.
// ponytail: per-process cache; each worker refreshes independently.
const accessTokens = new Map<
  string,
  { credential: string; token: string; until: number }
>();

export type GmailApi = <T>(
  path: string,
  query?: Record<string, string> | URLSearchParams,
  request?: GoogleRequest & {
    upload?: GoogleRequest['upload'];
    once?: boolean;
  },
) => Promise<T>;

// One job's Gmail client: a fresh access token, request pacing under the
// per-user quota, and bounded retries for rate limits and server errors.
// `once` disables retries for non-idempotent calls (send).
export async function openGmail(
  google: GoogleConfig | null,
  keys: MailKeys,
  account: MailAccount,
  hardDeadline: number,
): Promise<GmailApi> {
  if (!google) throw new Error('Gmail is not configured');
  const fresh = async () => {
    const { token, expiresIn } = await refreshAccessToken(
      google,
      decryptCredential(account.credential, account.user_id, account.id, keys),
    );
    accessTokens.set(account.id, {
      credential: account.credential,
      token,
      until: Date.now() + (expiresIn - 300) * 1000,
    });
    return token;
  };
  const cached = accessTokens.get(account.id);
  let reused =
    cached?.credential === account.credential && cached.until > Date.now();
  let token = reused && cached ? cached.token : await fresh();
  let slot = 0;
  return async (path, query = {}, request = {}) => {
    const { once, ...init } = request;
    const search = new URLSearchParams(query).toString();
    const base = init.upload ? google.uploadUrl : google.gmailUrl;
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      slot = Math.max(slot, now) + SPACING_MS;
      if (slot - SPACING_MS > now)
        await new Promise((resolve) =>
          setTimeout(resolve, slot - SPACING_MS - now),
        );
      if (Date.now() > hardDeadline) throw new GmailPause(1);
      try {
        return await googleJson(`${base}${path}${search ? `?${search}` : ''}`, {
          ...init,
          token,
        });
      } catch (error) {
        // A reused token may have been revoked; Google rejected the request
        // without acting on it, so one retry with a fresh token is safe even
        // for a send. A 401 with a fresh token still means reconnect.
        if (reused && error instanceof GoogleError && error.status === 401) {
          accessTokens.delete(account.id);
          reused = false;
          token = await fresh();
          continue;
        }
        if (once || !(error instanceof GoogleError) || !retryable(error))
          throw error;
        // Exponential backoff with jitter, or Google's Retry-After.
        const wait =
          (error.retryAfter ?? 2 ** attempt) * 1000 + Math.random() * 250;
        if (attempt + 1 >= RETRIES || Date.now() + wait > hardDeadline)
          throw new GmailPause(
            error.status === 429 || error.status === 403 ? 60 : 30,
          );
        // Back off the whole job, not just this request.
        slot = Math.max(slot, Date.now() + wait);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  };
}

// Resolves true when the pass completed, false when it could not run, paused or failed.
export async function syncGmailAccount(
  pool: Pool,
  keys: MailKeys,
  google: GoogleConfig | null,
  owner: string,
  id: string,
) {
  const account = await claimAccount(pool, owner, id);
  if (!account) return false;
  // The 90-second lease outlives the soft deadline plus one bounded page.
  const started = Date.now();
  const deadline = started + 40000;
  const hardDeadline = started + 75000;
  try {
    const api = await openGmail(google, keys, account, hardDeadline);
    const fetchOne = async (remote: string) => {
      const query = new URLSearchParams({ format: 'metadata' });
      for (const name of HEADERS) query.append('metadataHeaders', name);
      try {
        const message = await api<GmailMessage>(`/messages/${remote}`, query);
        if (message.id !== remote) throw new Error('Invalid Gmail response');
        return message;
      } catch (error) {
        // Deleted between listing and fetch.
        if (error instanceof GoogleError && error.status === 404) return null;
        throw error;
      }
    };
    // ponytail: one paced request per message (~40/s); use the batch endpoint if initial sync speed matters.
    const fetchAll = async (list: string[]) => {
      const results: (GmailMessage | null)[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, list.length) }, async () => {
          while (next < list.length) {
            const index = next++;
            results[index] = await fetchOne(list[index] as string);
          }
        }),
      );
      return results;
    };

    const labels = await api<{ labels?: unknown }>('/labels');
    if (!Array.isArray(labels.labels) || labels.labels.length > 1000)
      throw new Error('Invalid Gmail labels');
    const folders: [string, string, string | null][] = [
      [ARCHIVE, 'Archive', '\\Archive'],
    ];
    for (const label of labels.labels as {
      id?: unknown;
      name?: unknown;
      type?: unknown;
    }[]) {
      if (
        typeof label.id !== 'string' ||
        typeof label.name !== 'string' ||
        label.id.length > 255 ||
        label.id.includes('\0')
      )
        throw new Error('Invalid Gmail labels');
      const system = SYSTEM_FOLDERS[label.id];
      if (system) folders.push([label.id, system[0], system[1]]);
      else if (label.type === 'user')
        folders.push([label.id, text(label.name, 1000), null]);
    }
    let legacyArchive = false;
    await withLease(pool, account, async (db) => {
      await db.query(
        'INSERT INTO mail_gmail_sync(user_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [owner, id],
      );
      const complete = (
        await db.query(
          'SELECT initial_complete FROM mail_gmail_sync WHERE account_id=$1',
          [id],
        )
      ).rows[0].initial_complete;
      legacyArchive = Boolean(
        (
          await db.query(
            "SELECT 1 FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND path=$3 AND role='\\All'",
            [owner, id, ARCHIVE],
          )
        ).rowCount,
      );
      for (const [path, name, role] of folders)
        await db.query(
          `INSERT INTO mailboxes(user_id,account_id,path,name,role,initial_complete) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT(account_id,path) DO UPDATE SET name=EXCLUDED.name,role=EXCLUDED.role`,
          [owner, id, path, name, role, complete],
        );
      // Label removal only removes the local mirror.
      await db.query(
        'DELETE FROM mailboxes WHERE user_id=$1 AND account_id=$2 AND NOT(path=ANY($3::text[]))',
        [owner, id, folders.map(([path]) => path)],
      );
    });
    const boxes = new Map(
      (
        await pool.query<{ id: string; path: string }>(
          'SELECT id,path FROM mailboxes WHERE user_id=$1 AND account_id=$2',
          [owner, id],
        )
      ).rows.map((row) => [row.path, row.id]),
    );
    // One-time local recompute for the pre-D040 All Mail folder: inbox mail
    // leaves it and archived mail stays. No Gmail request is needed.
    if (legacyArchive) {
      const remotes = (
        await pool.query<{ remote_key: string }>(
          'SELECT remote_key FROM mail_messages WHERE user_id=$1 AND account_id=$2',
          [owner, id],
        )
      ).rows.map((row) => row.remote_key);
      for (let start = 0; start < remotes.length; start += 500)
        await withLease(pool, account, (db) =>
          applyLabelDeltas(
            db,
            account,
            boxes,
            new Map(remotes.slice(start, start + 500).map((key) => [key, []])),
          ),
        );
    }
    // Sender name for the From header; optional, so failures are ignored.
    try {
      const sendAs = await api<{ sendAs?: unknown }>('/settings/sendAs');
      const entries = Array.isArray(sendAs.sendAs)
        ? (sendAs.sendAs as {
            displayName?: unknown;
            isDefault?: unknown;
            isPrimary?: unknown;
          }[])
        : [];
      const chosen =
        entries.find((entry) => entry.isDefault === true) ??
        entries.find((entry) => entry.isPrimary === true);
      if (typeof chosen?.displayName === 'string')
        await withLease(pool, account, (db) =>
          db.query(
            'UPDATE mail_gmail_sync SET display_name=$2 WHERE account_id=$1',
            [id, defaultSenderName(chosen.displayName as string)],
          ),
        );
    } catch (error) {
      if (error instanceof GmailPause) throw error;
    }
    // Full resync: local mail stays visible until the new listing replaces it.
    const resync = () =>
      withLease(pool, account, async (db) => {
        await db.query(
          'UPDATE mail_gmail_sync SET history_id=NULL,page_token=NULL,initial_complete=false,updated_at=clock_timestamp() WHERE account_id=$1',
          [id],
        );
        await db.query(
          'UPDATE mailboxes SET initial_complete=false WHERE user_id=$1 AND account_id=$2',
          [owner, id],
        );
      });
    const save = async (
      db: PoolClient,
      messages: (GmailMessage | null)[],
      remotes: string[],
      notify: boolean,
    ) => {
      const anchors: string[] = [];
      for (const [index, message] of messages.entries()) {
        if (!message) {
          await db.query(
            'DELETE FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key=$3',
            [owner, id, remotes[index]],
          );
          continue;
        }
        const local = await saveGmailMessage(
          db,
          account,
          boxes,
          message,
          notify,
        );
        if (local) anchors.push(local);
      }
      await reconcileConversationState(db, owner, id, anchors);
    };
    while (Date.now() < deadline) {
      // A reader waiting on a body outranks another metadata page.
      if ((await pool.query(bodyPending, [owner, id])).rowCount) break;
      const state = (
        await pool.query<{
          history_id: string | null;
          page_token: string | null;
          initial_complete: boolean;
        }>(
          'SELECT history_id,page_token,initial_complete FROM mail_gmail_sync WHERE account_id=$1',
          [id],
        )
      ).rows[0];
      if (!state) throw new Error('Gmail checkpoint missing');
      if (!state.initial_complete) {
        if (!state.history_id) {
          // Record the checkpoint before listing so changes made during a
          // long initial sync replay from history afterwards.
          const profile = await api<{ historyId?: unknown }>('/profile');
          if (
            typeof profile.historyId !== 'string' ||
            !historyId.test(profile.historyId)
          )
            throw new Error('Invalid Gmail profile');
          await withLease(pool, account, async (db) => {
            await db.query(
              'DELETE FROM mail_gmail_listed WHERE account_id=$1',
              [id],
            );
            await db.query(
              'UPDATE mail_gmail_sync SET history_id=$2,page_token=NULL,updated_at=clock_timestamp() WHERE account_id=$1',
              [id, profile.historyId],
            );
          });
          continue;
        }
        let page: { messages?: unknown; nextPageToken?: unknown };
        try {
          page = await api('/messages', {
            maxResults: String(PAGE),
            includeSpamTrash: 'true',
            ...(account.history_since
              ? {
                  q: `after:${Math.floor(account.history_since.getTime() / 1000)}`,
                }
              : {}),
            ...(state.page_token ? { pageToken: state.page_token } : {}),
          });
        } catch (error) {
          // A stale page token restarts the listing; upserts are idempotent.
          if (
            error instanceof GoogleError &&
            error.status === 400 &&
            state.page_token
          ) {
            await withLease(pool, account, (db) =>
              db.query(
                'UPDATE mail_gmail_sync SET page_token=NULL WHERE account_id=$1',
                [id],
              ),
            );
            continue;
          }
          throw error;
        }
        const remotes = ids(page.messages, 500);
        const next =
          typeof page.nextPageToken === 'string' &&
          page.nextPageToken.length <= 1000
            ? page.nextPageToken
            : null;
        const messages = await fetchAll(remotes);
        await withLease(pool, account, async (db) => {
          await save(db, messages, remotes, false);
          await db.query(
            `INSERT INTO mail_gmail_listed(user_id,account_id,remote_key)
             SELECT $1,$2,unnest($3::text[]) ON CONFLICT DO NOTHING`,
            [owner, id, remotes],
          );
          if (next) {
            await db.query(
              'UPDATE mail_gmail_sync SET page_token=$2,updated_at=clock_timestamp() WHERE account_id=$1',
              [id, next],
            );
            return;
          }
          // Listing finished: anything unlisted was deleted at Google.
          await db.query(
            `DELETE FROM mail_messages m WHERE m.user_id=$1 AND m.account_id=$2
             AND NOT EXISTS(SELECT 1 FROM mail_gmail_listed l WHERE l.account_id=$2 AND l.remote_key=m.remote_key)`,
            [owner, id],
          );
          await db.query('DELETE FROM mail_gmail_listed WHERE account_id=$1', [
            id,
          ]);
          await db.query(
            'UPDATE mail_gmail_sync SET page_token=NULL,initial_complete=true,updated_at=clock_timestamp() WHERE account_id=$1',
            [id],
          );
          await db.query(
            'UPDATE mailboxes SET initial_complete=true WHERE user_id=$1 AND account_id=$2',
            [owner, id],
          );
        });
        continue;
      }
      let page: {
        history?: unknown;
        nextPageToken?: unknown;
        historyId?: unknown;
      };
      try {
        page = await api('/history', {
          startHistoryId: state.history_id ?? '',
          maxResults: '100',
          ...(state.page_token ? { pageToken: state.page_token } : {}),
        });
      } catch (error) {
        // Expired history (404) or a stale page token: full resync. Local
        // mail stays visible until the new listing replaces it.
        if (
          error instanceof GoogleError &&
          (error.status === 404 || (error.status === 400 && state.page_token))
        ) {
          await resync();
          continue;
        }
        throw error;
      }
      if (
        (page.history !== undefined &&
          (!Array.isArray(page.history) || page.history.length > 100)) ||
        typeof page.historyId !== 'string' ||
        !historyId.test(page.historyId)
      )
        throw new Error('Invalid Gmail history');
      // Records apply in order: additions are fetched (their current state
      // already includes later label changes), deletions win, and label-only
      // changes become deltas on the local label set.
      const added = new Set<string>();
      const deleted = new Set<string>();
      const deltas = new Map<string, [boolean, string[]][]>();
      let entries = 0;
      for (const record of (page.history ?? []) as HistoryRecord[]) {
        for (const entry of [
          ...(record.messagesAdded ?? []).map(
            (item) => ['added', item] as const,
          ),
          ...(record.labelsAdded ?? []).map((item) => ['add', item] as const),
          ...(record.labelsRemoved ?? []).map(
            (item) => ['remove', item] as const,
          ),
          ...(record.messagesDeleted ?? []).map(
            (item) => ['deleted', item] as const,
          ),
        ]) {
          if (++entries > 50000)
            throw new Error('Gmail history page too large');
          const [kind, item] = entry;
          const [remote] = ids([item.message], 1);
          if (!remote) continue;
          if (kind === 'deleted') {
            deleted.add(remote);
            added.delete(remote);
            deltas.delete(remote);
          } else if (kind === 'added') {
            added.add(remote);
            deltas.delete(remote);
          } else if (!added.has(remote) && !deleted.has(remote)) {
            const labels = Array.isArray(item.labelIds)
              ? item.labelIds.filter(
                  (label): label is string =>
                    typeof label === 'string' && label.length <= 255,
                )
              : [];
            // Leaving Trash or Spam restores labels the local mirror hid, so
            // that message's current labels are fetched instead.
            if (
              kind === 'remove' &&
              labels.some((label) => label === 'TRASH' || label === 'SPAM')
            ) {
              added.add(remote);
              deltas.delete(remote);
            } else
              deltas.set(remote, [
                ...(deltas.get(remote) ?? []),
                [kind === 'add', labels],
              ]);
          }
        }
      }
      // Too many fetches for one job: a resumable listing is cheaper.
      if (added.size > 1000) {
        await resync();
        continue;
      }
      const remotes = [...added];
      const messages = await fetchAll(remotes);
      const next =
        typeof page.nextPageToken === 'string' &&
        page.nextPageToken.length <= 1000
          ? page.nextPageToken
          : null;
      await withLease(pool, account, async (db) => {
        await db.query(
          'DELETE FROM mail_messages WHERE user_id=$1 AND account_id=$2 AND remote_key=ANY($3::text[])',
          [owner, id, [...deleted]],
        );
        await save(db, messages, remotes, true);
        await reconcileConversationState(
          db,
          owner,
          id,
          await applyLabelDeltas(db, account, boxes, deltas),
        );
        await db.query(
          'UPDATE mail_gmail_sync SET history_id=CASE WHEN $3::text IS NULL THEN $2 ELSE history_id END,page_token=$3,updated_at=clock_timestamp() WHERE account_id=$1',
          [id, page.historyId, next],
        );
      });
      if (!next) break;
    }
    await withLease(pool, account, async (db) => {
      const state = (
        await db.query(
          'SELECT initial_complete AND page_token IS NULL AS done FROM mail_gmail_sync WHERE account_id=$1',
          [id],
        )
      ).rows[0];
      await db.query(
        `UPDATE mail_accounts SET status=CASE WHEN $4 THEN 'ready' ELSE 'syncing' END,
         next_sync_at=clock_timestamp()+CASE WHEN $4 AND sync_request=$3 THEN interval '60 seconds' ELSE interval '1 second' END,
         sync_completed=$3,error_code=NULL,failures=0,last_synced_at=clock_timestamp(),lease_token=NULL,lease_until=NULL
         WHERE user_id=$1 AND id=$2`,
        [owner, id, account.sync_request, Boolean(state?.done)],
      );
    });
    return true;
  } catch (error) {
    if (error instanceof GmailPause) {
      await pool.query(
        `UPDATE mail_accounts SET status='syncing',error_code=NULL,next_sync_at=clock_timestamp()+make_interval(secs=>$4),
         lease_token=NULL,lease_until=NULL
         WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
        [owner, id, account.lease_token, error.delaySeconds],
      );
      return false;
    }
    // Revoked or expired consent needs the user; other failures back off.
    const reconnect = needsReconnect(error);
    // Redacted diagnostic: HTTP status and enum-like Google codes only.
    logger.warn(
      error instanceof GoogleError
        ? {
            account: id,
            status: error.status,
            code: error.code,
            reason: error.reason,
          }
        : {
            account: id,
            error: error instanceof Error ? error.message : 'unknown',
          },
      'Gmail sync failed',
    );
    await pool.query(
      `UPDATE mail_accounts SET status='error',error_code=$4,failures=LEAST(failures+1,10),
       next_sync_at=clock_timestamp()+make_interval(secs=>$5),lease_token=NULL,lease_until=NULL
       WHERE user_id=$1 AND id=$2 AND lease_token=$3 AND lease_until>clock_timestamp()`,
      [
        owner,
        id,
        account.lease_token,
        reconnect ? 'reconnect_required' : 'sync_failed',
        reconnect
          ? 30 * 86400
          : Math.min(3600, 30 * 2 ** Math.min(account.failures, 7)) +
            Math.floor(Math.random() * 15),
      ],
    );
    return false;
  }
}
