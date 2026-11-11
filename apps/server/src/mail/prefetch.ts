import type { Pool } from 'pg';
import {
  CACHE_BYTES,
  CACHE_MESSAGES,
  PREFETCH_FAILED,
  trimContentCache,
} from './content-cache.js';
import {
  type ContentSource,
  imapSource,
  inMailbox,
  type Located,
  publishContent,
} from './content-worker.js';
import { decryptCredential, type MailKeys } from './credentials.js';
import { GmailPause } from './gmail.js';
import { gmailContentSource } from './gmail-mail.js';
import { type GoogleConfig, GoogleError } from './google.js';
import { graphContentSource } from './graph-mail.js';
import { connectImap } from './imap.js';
import {
  type MicrosoftConfig,
  MicrosoftError,
  MicrosoftPause,
} from './microsoft.js';
import { MAX_BODY_BYTES, MAX_RAW_BYTES, parseMessage } from './parse.js';
import { SANITIZER_VERSION } from './sanitize.js';
import { claimAccount, releaseLease, withLease } from './store.js';
import { bodyPending, contentPending } from './work-pending.js';

// D042: bodies are cached before they are opened. After a metadata sync the
// worker downloads the account's newest uncached messages through the same
// source, parser, sanitizer and cache writes as an opened message.
//
// Rank: a prefetched row's accessed_at is its message's received time and an
// opened row's is its last access, so the cache's least-recently-used
// eviction keeps recent mail plus what the user actually reads. A message is
// prefetched only while the rows ranked above it leave room for it, so storing
// one never evicts a row that would be prefetched again.
const BUDGET_MS = 15000;
// The largest body row parseMessage can produce: text and HTML, plus inline
// images and reply headers that all come out of the raw message.
const PREFETCH_BYTES = CACHE_BYTES - MAX_BODY_BYTES - MAX_RAW_BYTES;

type Candidate = Located & { id: string };

const current = (row: string) =>
  `${row}.expires_at>clock_timestamp() AND (${row}.state<>'ready' OR ${row}.sanitizer_version=${SANITIZER_VERSION})`;

// Newest first. Trash and Junk are left to on-demand fetching.
const candidates = `WITH ranked AS (
    SELECT accessed_at,count(*) OVER w AS messages,sum(byte_size) OVER w AS bytes
    FROM mail_content WHERE user_id=$1 WINDOW w AS (ORDER BY accessed_at DESC,message_id DESC)
  ), edge AS (SELECT max(accessed_at) AS floor FROM ranked WHERE messages>=$3 OR bytes>$4)
  SELECT m.id,m.remote_key,mm.uid::text,mm.uid_validity::text,mm.path
  FROM mail_messages m CROSS JOIN edge
  JOIN LATERAL (SELECT x.uid,x.uid_validity,b.path FROM mail_memberships x
    JOIN mailboxes b ON b.user_id=x.user_id AND b.account_id=x.account_id AND b.id=x.mailbox_id
    WHERE x.user_id=m.user_id AND x.account_id=m.account_id AND x.message_id=m.id
    AND b.role IS DISTINCT FROM '\\Trash' AND b.role IS DISTINCT FROM '\\Junk'
    ORDER BY x.mailbox_id LIMIT 1) mm ON true
  WHERE m.user_id=$1 AND m.account_id=$2 AND m.size_bytes<=$5
  AND (edge.floor IS NULL OR m.received_at>edge.floor)
  AND NOT EXISTS(SELECT 1 FROM mail_content c WHERE c.message_id=m.id AND ${current('c')})
  ORDER BY m.received_at DESC,m.id DESC LIMIT $6`;

const waiting = (pool: Pool, owner: string, id: string, limit: number) =>
  pool
    .query<Candidate>(candidates, [
      owner,
      id,
      CACHE_MESSAGES,
      PREFETCH_BYTES,
      MAX_RAW_BYTES,
      limit,
    ])
    .then((result) => result.rows);

// An expired row or one from an older sanitizer is replaced, as on opening.
const dropStale = `DELETE FROM mail_content c WHERE c.user_id=$1 AND c.message_id=$2 AND NOT (${current('c')})`;

// A reader may have requested the same body meanwhile: its pending row is
// completed in place. Any other existing row is left alone.
const store = `INSERT INTO mail_content(user_id,account_id,message_id,state,plain_text,html,resources,byte_size,attachments,reply_metadata,sanitizer_version,accessed_at,expires_at)
  SELECT m.user_id,m.account_id,m.id,'ready',$4::text,$5::text,$6::jsonb,$7::int,$8::jsonb,$9::jsonb,${SANITIZER_VERSION},LEAST(m.received_at,clock_timestamp()),'infinity'
  FROM mail_messages m WHERE m.user_id=$1 AND m.account_id=$2 AND m.id=$3
  ON CONFLICT (message_id) DO UPDATE SET state='ready',plain_text=EXCLUDED.plain_text,html=EXCLUDED.html,resources=EXCLUDED.resources,
    byte_size=EXCLUDED.byte_size,attachments=EXCLUDED.attachments,reply_metadata=EXCLUDED.reply_metadata,sanitizer_version=EXCLUDED.sanitizer_version,
    reply_headers_pending=false,error_code=NULL,expires_at='infinity',accessed_at=clock_timestamp()
  WHERE mail_content.state='pending' RETURNING message_id`;

const storeFailure = `INSERT INTO mail_content(user_id,account_id,message_id,state,error_code,accessed_at,expires_at)
  SELECT m.user_id,m.account_id,m.id,'failed','${PREFETCH_FAILED}',LEAST(m.received_at,clock_timestamp()),clock_timestamp()+interval '1 day'
  FROM mail_messages m WHERE m.user_id=$1 AND m.account_id=$2 AND m.id=$3
  ON CONFLICT (message_id) DO NOTHING RETURNING message_id`;

// Quota, authorization and network failures concern the account, not the
// message; only the provider reporting the message gone does.
const providerUnavailable = (error: unknown) =>
  error instanceof MicrosoftPause ||
  (error instanceof MicrosoftError && error.status !== 404) ||
  error instanceof GmailPause ||
  (error instanceof GoogleError && error.status !== 404) ||
  error instanceof TypeError ||
  error instanceof DOMException;

export async function prefetchAccount(
  pool: Pool,
  keys: MailKeys,
  google: GoogleConfig | null,
  owner: string,
  id: string,
  signal?: AbortSignal,
  connect = connectImap,
  microsoft: MicrosoftConfig | null = null,
) {
  if (signal?.aborted) return;
  try {
    // User work on the account goes first, as it does for metadata sync.
    if ((await pool.query(contentPending, [owner, id])).rowCount) return;
    if (!(await waiting(pool, owner, id, 1)).length) return;
  } catch {
    return;
  }
  const account = await claimAccount(pool, owner, id, false);
  if (!account) return;
  let client: Awaited<ReturnType<typeof connectImap>> | undefined;
  let stopped = false;
  let more = false;
  const stop = () => {
    stopped = true;
    client?.close();
  };
  signal?.addEventListener('abort', stop, { once: true });
  // A reader's request must not wait behind a background download: once a
  // second, a waiting body or attachment ends this pass and its connection.
  const watch = setInterval(() => {
    pool.query(bodyPending, [owner, id]).then((requested) => {
      if (requested.rowCount) stop();
    }, stop);
  }, 1000);
  const hard = setTimeout(stop, BUDGET_MS + 15000);
  try {
    let source: ContentSource;
    if (account.provider === 'gmail')
      source = gmailContentSource(account, keys, google);
    else if (account.provider === 'microsoft')
      source = graphContentSource(pool, account, keys, microsoft);
    else {
      const opened = await connect(
        account,
        decryptCredential(account.credential, owner, id, keys),
        signal,
      );
      client = opened;
      if (stopped) return;
      source = imapSource((message, operation) =>
        inMailbox(opened, message, operation),
      );
    }
    const deadline = Date.now() + BUDGET_MS;
    let queue: Candidate[] = [];
    let failures = 0;
    while (!stopped) {
      if (!queue.length) queue = await waiting(pool, owner, id, 20);
      const message = queue.shift();
      if (!message) break;
      if (Date.now() > deadline) {
        more = true;
        break;
      }
      let parsed: Awaited<ReturnType<typeof parseMessage>> | undefined;
      let attachments: unknown;
      try {
        const fetched = await source.message(message);
        attachments = fetched.attachments;
        parsed = await parseMessage(fetched.source);
      } catch (error) {
        // An interrupted pass or a failing connection says nothing about
        // this message; it stays a candidate for the next pass.
        if (stopped || (client ? !client.usable : providerUnavailable(error)))
          break;
      }
      await withLease(pool, account, async (db) => {
        await db.query(dropStale, [owner, message.id]);
        if (!parsed) {
          // Retried when this row expires; opening the message fetches it
          // for real and reports any error then.
          if ((await db.query(storeFailure, [owner, id, message.id])).rowCount)
            await trimContentCache(db, owner, message.id);
          return;
        }
        const stored = await db.query(store, [
          owner,
          id,
          message.id,
          parsed.plain,
          parsed.html,
          JSON.stringify(parsed.resources),
          parsed.bytes,
          JSON.stringify(attachments),
          JSON.stringify(parsed.reply),
        ]);
        if (stored.rowCount)
          await publishContent(db, owner, id, message.id, parsed);
      });
      // Repeated per-message failures on a working connection look like a
      // provider problem: stop rather than mark the whole window failed.
      failures = parsed ? 0 : failures + 1;
      if (failures >= 3) break;
    }
  } catch {
    // Lost lease, removed account or provider outage: the next sync retries.
  } finally {
    clearInterval(watch);
    clearTimeout(hard);
    signal?.removeEventListener('abort', stop);
    client?.close();
    try {
      // Remaining candidates continue on the next dispatch instead of
      // waiting out the polling interval, as does a pass cut short for a
      // reader once that request is served.
      if (more || (stopped && !signal?.aborted))
        await pool.query(
          `UPDATE mail_accounts SET next_sync_at=LEAST(next_sync_at,clock_timestamp()+interval '1 second')
          WHERE user_id=$1 AND id=$2 AND lease_token=$3`,
          [owner, id, account.lease_token],
        );
    } finally {
      await releaseLease(pool, account);
    }
  }
}
