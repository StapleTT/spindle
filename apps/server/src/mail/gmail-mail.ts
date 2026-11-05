import type { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { type ActionKind, moveKinds, settle } from './actions.js';
import type { ContentSource } from './content-worker.js';
import type { MailKeys } from './credentials.js';
import {
  ARCHIVE,
  type GmailApi,
  GmailPause,
  headerBlock,
  mirror,
  openGmail,
  writeMemberships,
} from './gmail.js';
import { type GoogleConfig, GoogleError } from './google.js';
import { MAX_RAW_BYTES, parseReplyHeaders, rawAttachments } from './parse.js';
import {
  claimAccount,
  type MailAccount,
  releaseLease,
  withLease,
} from './store.js';

// From-header name for a Gmail account: Gmail's default "Send mail as" name,
// else the Spindle profile name (the IMAP default). SQL over alias `a`.
export const gmailSenderName = (a: string) =>
  `COALESCE((SELECT g.display_name FROM mail_gmail_sync g WHERE g.account_id=${a}.id),
    (SELECT u.name FROM users u WHERE u.id=${a}.user_id),'')`;

// D040: Gmail reader, actions and sending on the shared pipelines. Each job
// opens one paced client (fresh access token) and holds the account lease.
const JOB_MS = 75000;
const lazyClient = (
  account: MailAccount,
  keys: MailKeys,
  google: GoogleConfig | null,
) => {
  let client: Promise<GmailApi> | undefined;
  return () => {
    client ??= openGmail(google, keys, account, Date.now() + JOB_MS);
    return client;
  };
};

const REPLY_HEADERS = [
  'From',
  'To',
  'Cc',
  'Reply-To',
  'Subject',
  'Message-ID',
  'In-Reply-To',
  'References',
];

async function rawMessage(api: GmailApi, remote: string) {
  const { raw } = await api<{ raw?: unknown }>(
    `/messages/${remote}`,
    { format: 'raw' },
    // Base64url grows the message by a third.
    { maxBytes: Math.ceil((MAX_RAW_BYTES * 4) / 3) + 65536, timeout: 30000 },
  );
  if (typeof raw !== 'string') throw new Error('Invalid Gmail response');
  const source = Buffer.from(raw, 'base64url');
  if (source.length > MAX_RAW_BYTES) throw new Error('Message size limit');
  return source;
}

export function gmailContentSource(
  account: MailAccount,
  keys: MailKeys,
  google: GoogleConfig | null,
): ContentSource {
  const client = lazyClient(account, keys, google);
  return {
    async replyHeaders(message) {
      const query = new URLSearchParams({ format: 'metadata' });
      for (const name of REPLY_HEADERS) query.append('metadataHeaders', name);
      const fetched = await (await client())<{
        payload?: { headers?: unknown };
      }>(`/messages/${message.remote_key}`, query);
      return parseReplyHeaders(
        headerBlock(fetched.payload?.headers, REPLY_HEADERS).block,
      );
    },
    async message(message) {
      const source = await rawMessage(await client(), message.remote_key);
      return {
        source,
        attachments: (await rawAttachments(source)).map((file) => file.info),
      };
    },
    // ponytail: re-reads the raw message (≤10 MiB) per attachment; use
    // attachments.get with stable part IDs if larger files are needed.
    async attachment(message, part, max) {
      const files = await rawAttachments(
        await rawMessage(await client(), message.remote_key),
      );
      const content = files[Number(part)]?.content;
      if (!content) throw new Error('Attachment unavailable');
      if (content.length > max) throw new Error('Content size limit');
      return content;
    },
  };
}

// Spindle's folder intents as Gmail label changes. Archive is the synthetic
// no-Inbox folder; Sent and Drafts are Gmail-managed and cannot be targets.
const managed = new Set(['SENT', 'DRAFT', 'TRASH', ARCHIVE]);
function labelChange(
  kind: ActionKind,
  source: string | null,
  target: string | null,
) {
  if (kind === 'read') return { remove: ['UNREAD'], add: [] };
  if (kind === 'unread') return { remove: [], add: ['UNREAD'] };
  const add = target && !managed.has(target) ? [target] : [];
  const remove = new Set<string>();
  if (source && !managed.has(source) && source !== target) remove.add(source);
  // Archive and spam leave the inbox, as in Gmail.
  if (target === ARCHIVE || target === 'SPAM') remove.add('INBOX');
  if (target === ARCHIVE) remove.add('SPAM');
  return { add, remove: [...remove] };
}

type Pending = {
  id: string;
  kind: ActionKind;
  message_id: string | null;
  remote_key: string | null;
  source_path: string | null;
  target_path: string | null;
  target_mailbox_id: string | null;
  due: boolean;
};

export async function applyGmailActions(
  pool: Pool,
  keys: MailKeys,
  google: GoogleConfig | null,
  owner: string,
  accountId: string,
) {
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  const remaining = new Set<string>();
  try {
    const actions = (
      await pool.query<Pending>(
        `SELECT a.id,a.kind,a.message_id,m.remote_key,s.path AS source_path,t.path AS target_path,a.target_mailbox_id,
        a.next_attempt_at<=clock_timestamp() AS due FROM mail_actions a
        LEFT JOIN mail_messages m ON m.user_id=a.user_id AND m.account_id=a.account_id AND m.id=a.message_id
        LEFT JOIN mailboxes s ON s.user_id=a.user_id AND s.account_id=a.account_id AND s.id=a.source_mailbox_id
        LEFT JOIN mailboxes t ON t.user_id=a.user_id AND t.account_id=a.account_id AND t.id=a.target_mailbox_id
        WHERE a.user_id=$1 AND a.account_id=$2 AND a.state='pending' ORDER BY a.seq LIMIT 50`,
        [owner, accountId],
      )
    ).rows;
    // Same ordering rule as IMAP: a later intent waits for an earlier backoff.
    const waiting = actions.findIndex((action) => !action.due);
    if (waiting !== -1) actions.splice(waiting);
    if (!actions.length) return;
    const claimed = await withLease(pool, account, (db) =>
      db.query<{ id: string }>(
        `UPDATE mail_actions SET next_attempt_at=clock_timestamp()+interval '90 seconds'
        WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' AND next_attempt_at<=clock_timestamp()
        RETURNING id`,
        [owner, actions.map((action) => action.id)],
      ),
    );
    for (const row of claimed.rows) remaining.add(row.id);
    const client = lazyClient(account, keys, google);
    const boxes = new Map(
      (
        await pool.query<{ id: string; path: string }>(
          'SELECT id,path FROM mailboxes WHERE user_id=$1 AND account_id=$2',
          [owner, accountId],
        )
      ).rows.map((row) => [row.path, row.id]),
    );
    const finish = async (
      action: Pending,
      state: 'applied' | 'failed' | 'conflict',
      code: string | null = null,
      labels?: string[],
    ) => {
      await withLease(pool, account, async (db) => {
        // Gmail returns the resulting labels: they become local truth at once.
        if (labels && action.message_id)
          await writeMemberships(
            db,
            account,
            action.message_id,
            mirror(labels, boxes),
          );
        await settle(db, owner, [action.id], state, code);
        if (state !== 'applied')
          await db.query(
            'UPDATE mail_accounts SET next_sync_at=clock_timestamp() WHERE user_id=$1 AND id=$2',
            [owner, accountId],
          );
      });
      remaining.delete(action.id);
    };
    for (const action of actions) {
      if (!remaining.has(action.id)) continue;
      if (!action.remote_key) {
        await finish(action, 'conflict', 'message_missing');
        continue;
      }
      if (moveKinds.includes(action.kind) && !action.target_path) {
        await finish(action, 'conflict', 'folder_missing');
        continue;
      }
      if (action.target_path === 'SENT' || action.target_path === 'DRAFT') {
        await finish(action, 'failed', 'label_unsupported');
        continue;
      }
      const api = await client();
      const path = `/messages/${action.remote_key}`;
      try {
        // Label changes, trash and untrash are idempotent, so a redelivered
        // intent cannot duplicate mail (unlike IMAP COPY).
        let result: { labelIds?: unknown };
        if (action.target_path === 'TRASH')
          result = await api(`${path}/trash`, {}, { method: 'POST', json: {} });
        else {
          if (action.source_path === 'TRASH' && moveKinds.includes(action.kind))
            await api(`${path}/untrash`, {}, { method: 'POST', json: {} });
          const { add, remove } = labelChange(
            action.kind,
            action.source_path,
            action.target_path,
          );
          result = await api(
            `${path}/modify`,
            {},
            { json: { addLabelIds: add, removeLabelIds: remove } },
          );
        }
        const labels = Array.isArray(result.labelIds)
          ? result.labelIds.filter(
              (label): label is string => typeof label === 'string',
            )
          : null;
        if (!labels) throw new Error('Invalid Gmail response');
        await finish(action, 'applied', null, labels);
      } catch (error) {
        if (error instanceof GoogleError && error.status === 404) {
          await finish(action, 'conflict', 'message_missing');
          continue;
        }
        // An unknown label: the destination was deleted in Gmail.
        if (error instanceof GoogleError && error.status === 400) {
          await finish(action, 'conflict', 'folder_missing');
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    // Quota pauses wait without spending an attempt; other failures back off
    // and the fifth reverts the local change, as for IMAP.
    await withLease(pool, account, async (db) => {
      if (error instanceof GmailPause) {
        await db.query(
          `UPDATE mail_actions SET next_attempt_at=clock_timestamp()+make_interval(secs=>$3)
          WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending'`,
          [owner, [...remaining], error.delaySeconds],
        );
        return;
      }
      const failed = (
        await db.query<{ id: string; attempts: number }>(
          `UPDATE mail_actions SET attempts=attempts+1,
          next_attempt_at=clock_timestamp()+make_interval(secs=>15*power(2,attempts))
          WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' RETURNING id,attempts`,
          [owner, [...remaining]],
        )
      ).rows.filter((row) => row.attempts >= 5);
      if (failed.length) {
        await settle(
          db,
          owner,
          failed.map((row) => row.id),
          'failed',
          'provider_unavailable',
        );
        await db.query(
          'UPDATE mail_accounts SET next_sync_at=clock_timestamp() WHERE user_id=$1 AND id=$2',
          [owner, accountId],
        );
      }
    }).catch(() => {});
  } finally {
    await releaseLease(pool, account);
  }
}

// SMTP-shaped transport for the outgoing worker. Gmail reports no
// per-recipient result: acceptance covers every recipient. Responses map onto
// SMTP-style codes so the worker's known/unknown rules stay in one place:
// 429 is temporary, other 4xx are permanent, and 5xx or a lost response stays
// unknown (never resent).
// Opening refreshes the token first, so its failures happen before the
// worker marks the send as started (known, retryable, never "unknown").
export async function gmailTransport(
  account: MailAccount,
  keys: MailKeys,
  google: GoogleConfig | null,
) {
  const client = lazyClient(account, keys, google);
  await client();
  return {
    async send(_sender: string, recipients: string[], raw: Buffer | Readable) {
      // ponytail: buffers one bounded (30 MiB) snapshot; stream the upload if memory matters.
      let data = raw as Buffer;
      if (!Buffer.isBuffer(raw)) {
        const chunks: Buffer[] = [];
        for await (const chunk of raw) chunks.push(chunk as Buffer);
        data = Buffer.concat(chunks);
      }
      const api = await client();
      try {
        // ponytail: Gmail threads by In-Reply-To/References and subject; send a
        // multipart upload with threadId if replies are seen misthreading.
        const sent = await api<{ id?: unknown }>(
          '/messages/send',
          { uploadType: 'media' },
          {
            once: true,
            timeout: 120000,
            upload: { type: 'message/rfc822', data },
          },
        );
        if (typeof sent.id !== 'string') throw new Error('No Gmail receipt');
        return { accepted: recipients, rejected: [] as string[] };
      } catch (error) {
        // A pause is raised before the request starts: nothing was sent.
        if (error instanceof GmailPause)
          throw Object.assign(new Error('Gmail send deferred'), {
            responseCode: 451,
          });
        if (error instanceof GoogleError && error.status < 500)
          throw Object.assign(new Error('Gmail rejected the message'), {
            responseCode: error.status === 429 ? 451 : 550,
          });
        throw error;
      }
    },
    // Gmail files sent mail itself; an unknown delivery is only searched for.
    async sentCopyExists(messageId: string) {
      const found = await (await client())<{ messages?: unknown }>(
        '/messages',
        {
          q: `rfc822msgid:${messageId.replace(/^<|>$/g, '')}`,
          includeSpamTrash: 'true',
          maxResults: '1',
        },
      );
      return Array.isArray(found.messages) && found.messages.length > 0;
    },
    close() {},
  };
}
