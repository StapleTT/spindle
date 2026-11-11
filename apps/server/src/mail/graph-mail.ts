import type { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { type ActionKind, moveKinds, settle } from './actions.js';
import type { ContentSource } from './content-worker.js';
import type { MailKeys } from './credentials.js';
import { graphMessage, saveGraphMessage } from './graph.js';
import {
  type MicrosoftApi,
  type MicrosoftConfig,
  MicrosoftError,
  MicrosoftPause,
  openMicrosoft,
} from './microsoft.js';
import {
  headerBlock,
  MAX_RAW_BYTES,
  parseReplyHeaders,
  rawAttachments,
} from './parse.js';
import {
  claimAccount,
  type MailAccount,
  releaseLease,
  withLease,
} from './store.js';

// shortcut: MIME is capped to fit Graph's 4 MB request limit, add upload sessions for larger files.
export const GRAPH_MIME_BYTES = 3_000_000;

const lazyClient = (
  pool: Pool,
  account: MailAccount,
  keys: MailKeys,
  microsoft: MicrosoftConfig | null,
) => {
  let client: Promise<MicrosoftApi> | undefined;
  return () => {
    client ??= openMicrosoft(
      pool,
      microsoft,
      keys,
      account,
      Date.now() + 75000,
    );
    return client;
  };
};

export function graphContentSource(
  pool: Pool,
  account: MailAccount,
  keys: MailKeys,
  microsoft: MicrosoftConfig | null,
): ContentSource {
  const client = lazyClient(pool, account, keys, microsoft);
  const raw = (remote: string) =>
    client().then((api) =>
      api<Buffer>(
        `/messages/${encodeURIComponent(remote)}/$value`,
        {},
        { raw: true, maxBytes: MAX_RAW_BYTES, timeout: 30000 },
      ),
    );
  return {
    async replyHeaders(message) {
      const fetched = await graphMessage(await client(), message.remote_key);
      return parseReplyHeaders(
        headerBlock(fetched.internetMessageHeaders, [
          'From',
          'To',
          'Cc',
          'Reply-To',
          'Subject',
          'Message-ID',
          'In-Reply-To',
          'References',
        ]).block,
      );
    },
    async message(message) {
      const source = await raw(message.remote_key);
      return {
        source,
        attachments: (await rawAttachments(source)).map((file) => file.info),
      };
    },
    async attachment(message, part, max) {
      // shortcut: rereads bounded raw MIME per attachment, use Graph attachment IDs for larger files.
      const files = await rawAttachments(await raw(message.remote_key));
      const content = files[Number(part)]?.content;
      if (!content || content.length > max)
        throw new Error('Attachment unavailable or too large');
      return content;
    },
  };
}

type Pending = {
  id: string;
  kind: ActionKind;
  message_id: string | null;
  remote_key: string | null;
  source_path: string | null;
  target_path: string | null;
  due: boolean;
  error_code: string | null;
};

export async function applyGraphActions(
  pool: Pool,
  keys: MailKeys,
  microsoft: MicrosoftConfig | null,
  owner: string,
  accountId: string,
) {
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  const remaining = new Set<string>();
  try {
    const actions = (
      await pool.query<Pending>(
        `SELECT a.id,a.kind,a.message_id,m.remote_key,s.path source_path,t.path target_path,a.error_code,a.next_attempt_at<=clock_timestamp() due
      FROM mail_actions a LEFT JOIN mail_messages m ON m.user_id=a.user_id AND m.account_id=a.account_id AND m.id=a.message_id
      LEFT JOIN mailboxes s ON s.user_id=a.user_id AND s.account_id=a.account_id AND s.id=a.source_mailbox_id
      LEFT JOIN mailboxes t ON t.user_id=a.user_id AND t.account_id=a.account_id AND t.id=a.target_mailbox_id
      WHERE a.user_id=$1 AND a.account_id=$2 AND a.state='pending' ORDER BY a.seq LIMIT 50`,
        [owner, accountId],
      )
    ).rows;
    const waiting = actions.findIndex((action) => !action.due);
    if (waiting !== -1) actions.splice(waiting);
    if (!actions.length) return;
    const claimed = await withLease(pool, account, (db) =>
      db.query<{ id: string }>(
        `UPDATE mail_actions SET next_attempt_at=clock_timestamp()+interval '90 seconds'
      WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending' AND next_attempt_at<=clock_timestamp() RETURNING id`,
        [owner, actions.map((action) => action.id)],
      ),
    );
    for (const row of claimed.rows) remaining.add(row.id);
    const client = lazyClient(pool, account, keys, microsoft);
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
      message?: Awaited<ReturnType<typeof graphMessage>>,
    ) => {
      await withLease(pool, account, async (db) => {
        if (message) await saveGraphMessage(db, account, boxes, message);
        await settle(db, owner, [action.id], state, code);
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
      const moving = moveKinds.includes(action.kind);
      if (moving && !action.target_path) {
        await finish(action, 'conflict', 'folder_missing');
        continue;
      }
      try {
        const api = await client();
        let current = await graphMessage(api, action.remote_key);
        if (moving && current.parentFolderId === action.target_path) {
          await finish(action, 'applied', null, current);
          continue;
        }
        if (
          moving &&
          (action.error_code === 'move_unconfirmed' ||
            current.parentFolderId !== action.source_path)
        ) {
          await finish(action, 'conflict', 'move_unconfirmed', current);
          continue;
        }
        const path = `/messages/${encodeURIComponent(action.remote_key)}`;
        // Fence immediately before mailbox writes; an interrupted move is search-only.
        await withLease(pool, account, (db) =>
          db.query(
            "UPDATE mail_actions SET error_code=$3 WHERE user_id=$1 AND id=$2 AND state='pending'",
            [owner, action.id, moving ? 'move_unconfirmed' : null],
          ),
        );
        try {
          if (moving) {
            const moved = await api<{ id?: unknown }>(
              `${path}/move`,
              {},
              { once: true, json: { destinationId: action.target_path } },
            );
            if (moved.id !== action.remote_key)
              throw new MicrosoftError(502, 'identity_changed');
          } else
            await api(
              path,
              {},
              { method: 'PATCH', json: { isRead: action.kind === 'read' } },
            );
          current = await graphMessage(api, action.remote_key);
        } catch (error) {
          if (
            moving &&
            !(
              error instanceof MicrosoftError &&
              error.status >= 400 &&
              error.status < 500
            )
          ) {
            await finish(action, 'conflict', 'move_unconfirmed');
            continue;
          }
          // Known refusals are safe to retry after backoff; unknown moves are never repeated.
          if (moving)
            await withLease(pool, account, (db) =>
              db.query(
                'UPDATE mail_actions SET error_code=NULL WHERE user_id=$1 AND id=$2',
                [owner, action.id],
              ),
            );
          throw error;
        }
        const confirmed = moving
          ? current.parentFolderId === action.target_path
          : current.isRead === (action.kind === 'read');
        await finish(
          action,
          confirmed ? 'applied' : 'conflict',
          confirmed ? null : moving ? 'move_unconfirmed' : 'flags_changed',
          current,
        );
      } catch (error) {
        if (error instanceof MicrosoftError && error.status === 404) {
          await finish(action, 'conflict', 'message_missing');
          continue;
        }
        if (error instanceof MicrosoftError && error.status === 400) {
          await finish(action, 'conflict', 'folder_missing');
          continue;
        }
        throw error;
      }
    }
  } catch (error) {
    await withLease(pool, account, async (db) => {
      if (
        error instanceof MicrosoftPause ||
        (error instanceof MicrosoftError && error.status === 429)
      ) {
        await db.query(
          `UPDATE mail_actions SET next_attempt_at=clock_timestamp()+make_interval(secs=>$3)
          WHERE user_id=$1 AND id=ANY($2::uuid[]) AND state='pending'`,
          [
            owner,
            [...remaining],
            error instanceof MicrosoftPause
              ? error.delaySeconds
              : (error.retryAfter ?? 60),
          ],
        );
        return;
      }
      const failed = (
        await db.query<{ id: string; attempts: number }>(
          `UPDATE mail_actions SET attempts=attempts+1,next_attempt_at=clock_timestamp()+make_interval(secs=>15*power(2,attempts))
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
    await releaseLease(pool, account);
  }
}

// SMTP-shaped transport keeps acceptance/unknown-send decisions in the Outbox worker.
export async function graphTransport(
  pool: Pool,
  account: MailAccount,
  keys: MailKeys,
  microsoft: MicrosoftConfig | null,
) {
  const client = lazyClient(pool, account, keys, microsoft);
  await client(); // Refresh failures precede the worker's send-start marker.
  return {
    async send(_sender: string, recipients: string[], raw: Buffer | Readable) {
      let bytes = 0;
      const chunks: Buffer[] = [];
      if (Buffer.isBuffer(raw)) {
        bytes = raw.length;
        chunks.push(raw);
      } else
        for await (const chunk of raw) {
          const data = Buffer.from(chunk);
          bytes += data.length;
          if (bytes > GRAPH_MIME_BYTES) break;
          chunks.push(data);
        }
      if (bytes > GRAPH_MIME_BYTES)
        throw Object.assign(new Error('Graph message size limit'), {
          code: 'EMESSAGE',
          command: 'MAIL FROM',
        });
      try {
        await (await client())(
          '/sendMail',
          {},
          {
            once: true,
            timeout: 60000,
            upload: {
              type: 'text/plain',
              data: Buffer.from(Buffer.concat(chunks).toString('base64')),
            },
          },
        );
        return { accepted: recipients, rejected: [] as string[] };
      } catch (error) {
        if (error instanceof MicrosoftPause)
          throw Object.assign(new Error('Microsoft send deferred'), {
            responseCode: 451,
            retryAfter: error.delaySeconds,
          });
        if (
          error instanceof MicrosoftError &&
          error.status >= 400 &&
          error.status < 500
        )
          throw Object.assign(new Error('Microsoft rejected message'), {
            responseCode: error.status === 429 ? 451 : 550,
            retryAfter: error.retryAfter,
          });
        throw error; // Lost responses and 5xx remain unknown and are never resent.
      }
    },
    async sentCopyExists(messageId: string) {
      const found = await (await client())<{
        value?: { internetMessageId?: unknown }[];
      }>('/mailFolders/sentitems/messages', {
        $filter: `internetMessageId eq '${messageId.replace(/'/g, "''")}'`,
        $select: 'id,internetMessageId',
        $top: '20',
      });
      return (
        Array.isArray(found.value) &&
        found.value.some((message) => message.internetMessageId === messageId)
      );
    },
    close() {},
  };
}
