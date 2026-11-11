import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { MailKeys } from './credentials.js';
import { decryptCredential } from './credentials.js';
import { MIME_BYTES } from './file-storage.js';
import { connectImap } from './imap.js';
import {
  claimAccount,
  type MailAccount,
  releaseLease,
  withLease,
} from './store.js';

// Drafts are Spindle-only (D044). This module is the one-time removal of copies
// that earlier provider Drafts sync (D016) wrote and still tracks. It deletes a
// copy only when its bytes are unchanged and UIDPLUS allows a targeted expunge;
// anything changed, ambiguous or unsafe is kept and never retried.

type Client = Awaited<ReturnType<typeof connectImap>>;
type RemoteCopy = {
  id: string;
  user_id: string;
  link_id: string;
  path: string;
  uid_validity: string;
  uid: string | null;
  message_id: string | null;
  marker: string | null;
  hash: string;
};
type Link = { id: string; attempts: number };

export const draftHash = (raw: Buffer) =>
  createHash('sha256').update(raw).digest('hex');
const KEEP = new Set([
  'draft_changed',
  'draft_ambiguous',
  'draft_too_large',
  'safe_delete_unavailable',
]);
const ATTEMPTS = 5;

async function download(client: Client, uid: string) {
  const result = await client.download(uid, undefined, {
    uid: true,
    maxBytes: MIME_BYTES + 1,
    chunkSize: 64 * 1024,
  });
  if (!result.content) throw new Error('draft_sync_unavailable');
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const value of result.content) {
      const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += data.length;
      if (bytes > MIME_BYTES) throw new Error('draft_too_large');
      chunks.push(data);
    }
  } finally {
    result.content.destroy();
  }
  return Buffer.concat(chunks);
}

// Finds the tracked copy by UID, then by its operation marker or exact Message-ID.
async function locate(client: Client, copy: RemoteCopy) {
  if (!client.mailbox) throw new Error('draft_sync_unavailable');
  const validity = String(client.mailbox.uidValidity);
  let uid = copy.uid_validity === validity ? copy.uid : null;
  const fields = { uid: true, size: true, flags: true, envelope: true };
  let metadata = uid
    ? await client.fetchOne(uid, fields, { uid: true })
    : false;
  if (!metadata) {
    let uids = copy.marker
      ? await client.search(
          { header: { 'X-Spindle-Operation': copy.marker }, deleted: false },
          { uid: true },
        )
      : [];
    // biome-ignore lint/complexity/useOptionalChain: ImapFlow search can return false.
    if ((!uids || !uids.length) && copy.message_id)
      uids = await client.search(
        { header: { 'Message-ID': copy.message_id }, deleted: false },
        { uid: true },
      );
    if (!uids || uids.length === 0) return null;
    if (uids.length !== 1) throw new Error('draft_ambiguous');
    uid = String(uids[0]);
    metadata = await client.fetchOne(uid, fields, { uid: true });
  }
  if (!uid || !metadata) return null;
  if (Number(metadata.size) > MIME_BYTES) throw new Error('draft_too_large');
  return {
    uid,
    modseq: metadata.modseq?.toString() ?? null,
    changed: draftHash(await download(client, uid)) !== copy.hash,
  };
}

async function setCopy(
  pool: Pool,
  account: MailAccount,
  copy: RemoteCopy,
  state: 'removed' | 'kept',
) {
  await withLease(pool, account, (db) =>
    db.query(
      'UPDATE mail_draft_copies SET state=$3 WHERE user_id=$1 AND id=$2',
      [account.user_id, copy.id, state],
    ),
  );
}

async function removeCopy(
  pool: Pool,
  account: MailAccount,
  client: Client,
  copy: RemoteCopy,
) {
  const lock = await client.getMailboxLock(copy.path);
  try {
    const found = await locate(client, copy);
    if (!found) return setCopy(pool, account, copy, 'removed');
    if (found.changed) throw new Error('draft_changed');
    if (!client.capabilities.has('UIDPLUS'))
      throw new Error('safe_delete_unavailable');
    await withLease(pool, account, async () => {});
    if (
      found.modseq &&
      !(await client.messageFlagsAdd(found.uid, ['\\Deleted'], {
        uid: true,
        unchangedSince: BigInt(found.modseq),
      }))
    )
      throw new Error('draft_changed');
    if (!(await client.messageDelete(found.uid, { uid: true })))
      throw new Error('draft_sync_unavailable');
    await setCopy(pool, account, copy, 'removed');
  } finally {
    lock.release();
  }
}

export async function cleanupProviderDrafts(
  pool: Pool,
  keys: MailKeys,
  owner: string,
  accountId: string,
  connect = connectImap,
) {
  const account = await claimAccount(pool, owner, accountId, false);
  if (!account) return;
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const links = (
      await pool.query(
        "SELECT id,attempts FROM mail_draft_links WHERE user_id=$1 AND account_id=$2 AND state IN ('pending','failed') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at LIMIT 4",
        [owner, accountId],
      )
    ).rows as Link[];
    if (!links.length) return;
    let paths = new Set<string>();
    try {
      client = await connect(
        account,
        decryptCredential(account.credential, owner, accountId, keys),
      );
      timer = setTimeout(() => client?.close(), 45000);
      paths = new Set(
        (await client.list())
          .filter(
            (folder) =>
              folder.specialUse === '\\Drafts' &&
              !folder.flags.has('\\Noselect'),
          )
          .map((folder) => folder.path),
      );
    } catch {
      for (const link of links) await retry(pool, account, link);
      return;
    }
    for (const link of links) {
      let transient = false;
      for (const copy of (
        await pool.query(
          "SELECT * FROM mail_draft_copies WHERE user_id=$1 AND link_id=$2 AND state IN ('active','obsolete','appending','unknown')",
          [owner, link.id],
        )
      ).rows as RemoteCopy[]) {
        // Never guess another folder: an unlisted Drafts path is left untouched.
        if (!paths.has(copy.path)) {
          await setCopy(pool, account, copy, 'kept');
          continue;
        }
        try {
          await removeCopy(pool, account, client, copy);
        } catch (error) {
          if (error instanceof Error && KEEP.has(error.message))
            await setCopy(pool, account, copy, 'kept');
          else transient = true;
        }
      }
      if (transient) await retry(pool, account, link);
      else await finish(pool, account, link.id);
    }
  } finally {
    clearTimeout(timer);
    client?.close();
    await releaseLease(pool, account);
  }
}

async function finish(pool: Pool, account: MailAccount, link: string) {
  await withLease(pool, account, (db) =>
    db.query(
      "UPDATE mail_draft_links SET state='removed',error_code=NULL WHERE user_id=$1 AND id=$2",
      [account.user_id, link],
    ),
  );
}

// Transient provider failures retry a bounded number of times, then the
// remaining copies are kept rather than retried forever.
async function retry(pool: Pool, account: MailAccount, link: Link) {
  if (link.attempts + 1 >= ATTEMPTS) {
    await withLease(pool, account, (db) =>
      db.query(
        "UPDATE mail_draft_copies SET state='kept' WHERE user_id=$1 AND link_id=$2 AND state IN ('active','obsolete','appending','unknown')",
        [account.user_id, link.id],
      ),
    );
    return finish(pool, account, link.id);
  }
  await withLease(pool, account, (db) =>
    db.query(
      "UPDATE mail_draft_links SET state='failed',attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '5 minutes' WHERE user_id=$1 AND id=$2",
      [account.user_id, link.id],
    ),
  );
}
