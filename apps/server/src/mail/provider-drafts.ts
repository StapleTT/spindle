import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MailKeys } from './credentials.js';
import { decryptCredential } from './credentials.js';
import {
  CHUNK_BYTES,
  fileStream,
  fixedChunks,
  MIME_BYTES,
  OUTGOING_STORAGE_BYTES,
  outgoingStorage,
  setDraftAttachments,
} from './file-storage.js';
import { connectImap } from './imap.js';
import {
  composeProviderDraft,
  type DraftValue,
  draftContentHash,
  draftHash,
  parseProviderDraft,
} from './provider-draft-mime.js';
import { defaultSenderName, emailAddress } from './smtp.js';
import {
  claimAccount,
  type MailAccount,
  releaseLease,
  withLease,
} from './store.js';

type Client = Awaited<ReturnType<typeof connectImap>>;
export type RemoteCopy = {
  id: string;
  user_id: string;
  link_id: string;
  state: string;
  path: string;
  uid_validity: string;
  uid: string | null;
  message_id: string | null;
  marker: string | null;
  hash: string;
  size_bytes: number;
  revision: number;
  modseq: string | null;
  content_hash?: string | null;
  content_hash_source?: string | null;
};
type Link = {
  id: string;
  user_id: string;
  account_id: string;
  draft_id: string | null;
  source_draft_id: string;
  state: string;
  synced_revision: number;
  desired_revision: number;
  active_copy_id: string | null;
  candidate: Candidate | null;
};
export type Candidate = {
  content: DraftValue['content'];
  replyContext: DraftValue['replyContext'];
  forward: DraftValue['forward'];
  attachmentIds: string[];
  copy: RemoteCopy;
};
export const providerDraftErrors: Record<string, string> = {
  draft_sync_unavailable:
    'Provider Drafts could not be reached. Your local draft is safe.',
  drafts_folder_unavailable:
    'The provider has no accessible designated Drafts folder. The draft stays in Spindle.',
  draft_changed:
    'Both versions changed. Review the provider version before sending.',
  draft_removed:
    'The provider draft was removed or sent in another client. Review before sending again.',
  draft_ambiguous:
    'More than one provider copy matches this draft. Review the copies in your mail client.',
  append_unknown:
    'The provider did not confirm saving this draft. Check again before creating another copy.',
  safe_delete_unavailable:
    'This server cannot safely remove just this draft. The provider copy has been kept.',
  draft_too_large:
    'The provider draft exceeds Spindle’s content limit. It remains available in your other mail client.',
  draft_files_too_large:
    'The provider draft exceeds attachment limits. It remains available in your other mail client.',
  unsupported_draft_image:
    'This draft contains an unsupported embedded image. Continue editing it in your other mail client.',
  draft_quota:
    'Draft or attachment storage is full. The provider version has been kept.',
  attachments_pending:
    'Waiting for attachment uploads and security checks before syncing.',
  draft_check_failed:
    'The provider draft could not be checked before sending. Retry when the provider is reachable.',
};
const failure = (error: unknown) =>
  error instanceof Error && providerDraftErrors[error.message]
    ? error.message
    : 'draft_sync_unavailable';
const json = (value: unknown) =>
  value === null ? null : JSON.stringify(value);

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

async function locate(
  client: Client,
  copy: RemoteCopy,
  force = false,
  includeDeleted = false,
): Promise<{ copy: RemoteCopy; changed: boolean; raw?: Buffer } | null> {
  // An older worker may have refreshed the raw hash without this derived cache.
  if (copy.content_hash_source !== copy.hash)
    copy = { ...copy, content_hash: null, content_hash_source: null };
  if (!client.mailbox) throw new Error('draft_sync_unavailable');
  const validity = String(client.mailbox.uidValidity);
  let uid = copy.uid_validity === validity ? copy.uid : null;
  let metadata = uid
    ? await client.fetchOne(
        uid,
        { uid: true, size: true, flags: true, envelope: true },
        { uid: true },
      )
    : false;
  // biome-ignore lint/complexity/useOptionalChain: ImapFlow returns false for a missing UID.
  if (metadata && metadata.flags?.has('\\Deleted') && !includeDeleted)
    metadata = false;
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
    metadata = await client.fetchOne(
      uid,
      { uid: true, size: true, flags: true, envelope: true },
      { uid: true },
    );
  }
  if (!uid || !metadata) return null;
  if (Number(metadata.size) > MIME_BYTES) throw new Error('draft_too_large');
  const next = {
    ...copy,
    uid,
    uid_validity: validity,
    modseq: metadata.modseq?.toString() ?? null,
  };
  // IMAP message bodies are immutable for a UID. Fetch again for a replacement
  // UID, changed size/modseq, or immediately before an external mutation.
  if (
    !force &&
    copy.uid === uid &&
    copy.uid_validity === validity &&
    copy.size_bytes === metadata.size &&
    copy.modseq === next.modseq
  )
    return { copy: next, changed: false };
  const raw = await download(client, uid),
    hash = draftHash(raw);
  return {
    copy: { ...next, hash, size_bytes: raw.length },
    changed: hash !== copy.hash,
    raw,
  };
}

async function folders(client: Client) {
  return (await client.list()).filter(
    (folder) =>
      folder.specialUse === '\\Drafts' && !folder.flags.has('\\Noselect'),
  );
}
async function locked<T>(
  client: Client,
  path: string,
  run: () => Promise<T>,
  readOnly = false,
) {
  const lock = await client.getMailboxLock(path, { readOnly });
  try {
    return await run();
  } finally {
    lock.release();
  }
}
async function fence(pool: Pool, account: MailAccount) {
  await withLease(pool, account, async () => {});
}

async function saveCopy(db: PoolClient, copy: RemoteCopy) {
  await db.query(
    'UPDATE mail_draft_copies SET uid=$3,uid_validity=$4,hash=$5,size_bytes=$6,modseq=$7,content_hash=$8,content_hash_source=$9 WHERE user_id=$1 AND id=$2',
    [
      copy.user_id,
      copy.id,
      copy.uid,
      copy.uid_validity,
      copy.hash,
      copy.size_bytes,
      copy.modseq,
      copy.content_hash ?? null,
      copy.content_hash_source ?? null,
    ],
  );
}
async function localDraft(
  db: Pool | PoolClient,
  owner: string,
  id: string | null,
) {
  if (!id) return null;
  return (
    await db.query(
      `SELECT d.*,COALESCE((SELECT jsonb_agg(a.file_id ORDER BY a.position) FROM mail_draft_attachments a WHERE a.user_id=d.user_id AND a.draft_id=d.id),'[]') AS attachment_ids FROM mail_drafts d WHERE d.user_id=$1 AND d.id=$2`,
      [owner, id],
    )
  ).rows[0];
}
async function frozen(db: Pool | PoolClient, owner: string, id: string | null) {
  return !!(
    await db.query(
      "SELECT 1 FROM mail_outbox WHERE user_id=$1 AND draft_id=$2 AND state NOT IN ('failed','cancelled') LIMIT 1",
      [owner, id],
    )
  ).rowCount;
}

function fileFingerprint(data: Buffer) {
  const hashes = [];
  for (let offset = 0; offset < data.length; offset += CHUNK_BYTES)
    hashes.push(
      createHash('sha256')
        .update(data.subarray(offset, offset + CHUNK_BYTES))
        .digest('hex'),
    );
  return createHash('sha256').update(hashes.join(',')).digest('hex');
}
async function storeValue(
  db: PoolClient,
  owner: string,
  link: Link | null,
  value: DraftValue,
  copy: RemoteCopy,
): Promise<Candidate> {
  const existing = link
    ? (
        await db.query(
          `SELECT DISTINCT f.id,f.filename,f.size_bytes FROM mail_uploads f WHERE f.user_id=$1 AND f.state IN ('pending_scan','scanning','ready') AND
    (EXISTS(SELECT 1 FROM mail_draft_attachments d WHERE d.user_id=f.user_id AND d.file_id=f.id AND d.draft_id=$2)
     OR EXISTS(SELECT 1 FROM mail_draft_conflict_files c WHERE c.user_id=f.user_id AND c.file_id=f.id AND c.link_id=$3))`,
          [owner, link.draft_id, link.id],
        )
      ).rows
    : [];
  const ids: string[] = [];
  let storage = await outgoingStorage(db, owner);
  for (const file of value.files) {
    let id: string | undefined;
    for (const candidate of existing.filter(
      (item) =>
        item.filename === file.filename && item.size_bytes === file.data.length,
    )) {
      const hash = (
        await db.query(
          "SELECT encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(data),'hex'),',' ORDER BY position),''),'UTF8')),'hex') AS hash FROM mail_upload_chunks WHERE user_id=$1 AND file_id=$2",
          [owner, candidate.id],
        )
      ).rows[0].hash;
      if (hash === fileFingerprint(file.data)) {
        id = candidate.id;
        break;
      }
    }
    if (!id) {
      if (
        storage + file.data.length > OUTGOING_STORAGE_BYTES ||
        (
          await db.query(
            'SELECT count(*)::int AS count FROM mail_uploads WHERE user_id=$1',
            [owner],
          )
        ).rows[0].count >= 1000
      )
        throw new Error('draft_quota');
      id = randomUUID();
      await db.query(
        "INSERT INTO mail_uploads(id,user_id,filename,size_bytes,reserved_bytes,state) VALUES($1,$2,$3,$4,$4,'pending_scan')",
        [id, owner, file.filename, file.data.length],
      );
      for (
        let offset = 0, position = 0;
        offset < file.data.length;
        offset += CHUNK_BYTES, position++
      )
        await db.query(
          'INSERT INTO mail_upload_chunks(user_id,file_id,position,data) VALUES($1,$2,$3,$4)',
          [
            owner,
            id,
            position,
            file.data.subarray(offset, offset + CHUNK_BYTES),
          ],
        );
      storage += file.data.length;
    }
    ids.push(id);
  }
  return {
    content: value.content,
    replyContext: value.replyContext,
    forward: value.forward,
    attachmentIds: ids,
    copy,
  };
}

export async function adoptProviderValue(
  db: PoolClient,
  owner: string,
  draft: string,
  value: Candidate,
) {
  await setDraftAttachments(db, owner, draft, value.attachmentIds);
  return (
    await db.query(
      `UPDATE mail_drafts SET content=$3,reply_context=$4,forward_content=$5,last_save_id=NULL
    WHERE user_id=$1 AND id=$2 RETURNING revision`,
      [
        owner,
        draft,
        json(value.content),
        json(value.replyContext),
        json(value.forward),
      ],
    )
  ).rows[0]?.revision as number | undefined;
}

async function acceptRemote(
  pool: Pool,
  account: MailAccount,
  link: Link,
  copy: RemoteCopy,
  raw: Buffer,
) {
  const parsed = await parseProviderDraft(raw);
  await withLease(pool, account, async (db) => {
    const current = (
      await db.query(
        'SELECT * FROM mail_draft_links WHERE user_id=$1 AND id=$2 FOR UPDATE',
        [account.user_id, link.id],
      )
    ).rows[0] as Link | undefined;
    if (!current) return;
    const draft = await localDraft(db, account.user_id, current.draft_id);
    const contentHash = draftContentHash(parsed);
    if (copy.content_hash && copy.content_hash === contentHash) {
      await saveCopy(db, { ...copy, content_hash_source: copy.hash });
      if (
        current.active_copy_id === copy.id &&
        !['conflict', 'unknown'].includes(current.state)
      ) {
        const synced =
          draft?.account_id === account.id &&
          draft.revision === current.synced_revision;
        await db.query(
          `UPDATE mail_draft_links SET state=$3,error_code=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $4 THEN interval '60 seconds' ELSE interval '1 second' END
          WHERE user_id=$1 AND id=$2`,
          [
            account.user_id,
            current.id,
            synced ? 'synced' : 'pending',
            Boolean(synced),
          ],
        );
      }
      return;
    }
    copy = {
      ...copy,
      content_hash: contentHash,
      content_hash_source: copy.hash,
    };
    const candidate = await storeValue(
      db,
      account.user_id,
      current,
      parsed,
      copy,
    );
    if (
      current.active_copy_id === copy.id &&
      draft &&
      draft.account_id === account.id &&
      draft.revision === current.synced_revision &&
      !(await frozen(db, account.user_id, draft.id))
    ) {
      const revision = await adoptProviderValue(
        db,
        account.user_id,
        draft.id,
        candidate,
      );
      await saveCopy(db, copy);
      await db.query(
        "UPDATE mail_draft_links SET synced_revision=$3,desired_revision=$3,state='synced',error_code=NULL,candidate=NULL,next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE user_id=$1 AND id=$2",
        [account.user_id, current.id, revision],
      );
      await db.query(
        'DELETE FROM mail_draft_conflict_files WHERE user_id=$1 AND link_id=$2',
        [account.user_id, current.id],
      );
    } else {
      await db.query(
        "UPDATE mail_draft_links SET state='conflict',error_code='draft_changed',candidate=$3 WHERE user_id=$1 AND id=$2",
        [account.user_id, current.id, json(candidate)],
      );
      await db.query(
        'DELETE FROM mail_draft_conflict_files WHERE user_id=$1 AND link_id=$2',
        [account.user_id, current.id],
      );
      for (const id of candidate.attachmentIds)
        await db.query(
          'INSERT INTO mail_draft_conflict_files(user_id,link_id,file_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
          [account.user_id, current.id, id],
        );
      await db.query(
        "UPDATE mail_outbox SET state='failed',error_code='provider_draft_changed',completed_at=clock_timestamp() WHERE user_id=$1 AND draft_id=$2 AND state='queued'",
        [account.user_id, current.draft_id],
      );
    }
  });
}

async function removeCopy(
  pool: Pool,
  account: MailAccount,
  client: Client,
  copy: RemoteCopy,
) {
  return locked(client, copy.path, async () => {
    const found = await locate(client, copy, true, true);
    if (!found) {
      await withLease(pool, account, (db) =>
        db.query(
          "UPDATE mail_draft_copies SET state='removed' WHERE user_id=$1 AND id=$2",
          [account.user_id, copy.id],
        ),
      );
      return;
    }
    if (found.changed) throw new Error('draft_changed');
    if (!client.capabilities.has('UIDPLUS'))
      throw new Error('safe_delete_unavailable');
    await fence(pool, account);
    if (found.copy.modseq) {
      const marked = await client.messageFlagsAdd(
        found.copy.uid ?? '',
        ['\\Deleted'],
        { uid: true, unchangedSince: BigInt(found.copy.modseq) },
      );
      if (!marked) throw new Error('draft_changed');
    }
    if (!(await client.messageDelete(found.copy.uid ?? '', { uid: true })))
      throw new Error('draft_sync_unavailable');
    await withLease(pool, account, (db) =>
      db.query(
        "UPDATE mail_draft_copies SET state='removed' WHERE user_id=$1 AND id=$2",
        [account.user_id, copy.id],
      ),
    );
  });
}

async function recoverAppend(
  pool: Pool,
  account: MailAccount,
  client: Client,
  link: Link,
  copy: RemoteCopy,
) {
  const found = await locked(client, copy.path, () =>
    locate(client, copy, true),
  );
  if (!found) {
    await withLease(pool, account, async (db) => {
      await db.query(
        "UPDATE mail_draft_copies SET state='unknown' WHERE user_id=$1 AND id=$2",
        [account.user_id, copy.id],
      );
      await db.query(
        "UPDATE mail_draft_links SET state='unknown',error_code='append_unknown' WHERE user_id=$1 AND id=$2",
        [account.user_id, link.id],
      );
    });
    return false;
  }
  await withLease(pool, account, async (db) => {
    await saveCopy(db, found.copy);
    await db.query(
      "UPDATE mail_draft_copies SET state='obsolete' WHERE user_id=$1 AND link_id=$2 AND state='active' AND id<>$3",
      [account.user_id, link.id, copy.id],
    );
    await db.query(
      "UPDATE mail_draft_copies SET state='active' WHERE user_id=$1 AND id=$2",
      [account.user_id, copy.id],
    );
    await db.query(
      "UPDATE mail_draft_links SET active_copy_id=$3,synced_revision=$4,state='pending',error_code=NULL WHERE user_id=$1 AND id=$2",
      [account.user_id, link.id, copy.id, copy.revision],
    );
  });
  if (found.changed)
    await acceptRemote(
      pool,
      account,
      { ...link, active_copy_id: copy.id, synced_revision: copy.revision },
      found.copy,
      found.raw ??
        (await locked(client, copy.path, () =>
          download(client, found.copy.uid ?? ''),
        )),
    );
  return true;
}

async function processLink(
  pool: Pool,
  account: MailAccount,
  client: Client,
  link: Link,
  folderPaths: Set<string>,
  preferred: string,
) {
  const unfinished = (
    await pool.query(
      "SELECT * FROM mail_draft_copies WHERE user_id=$1 AND link_id=$2 AND state IN ('appending','unknown') ORDER BY created_at LIMIT 1",
      [account.user_id, link.id],
    )
  ).rows[0] as RemoteCopy | undefined;
  if (unfinished) {
    if (!folderPaths.has(unfinished.path))
      throw new Error('drafts_folder_unavailable');
    if (!(await recoverAppend(pool, account, client, link, unfinished))) return;
    link = (
      await pool.query(
        'SELECT * FROM mail_draft_links WHERE user_id=$1 AND id=$2',
        [account.user_id, link.id],
      )
    ).rows[0];
    if (link.state === 'conflict') return;
  }
  for (const copy of (
    await pool.query(
      "SELECT * FROM mail_draft_copies WHERE user_id=$1 AND link_id=$2 AND state='obsolete'",
      [account.user_id, link.id],
    )
  ).rows as RemoteCopy[]) {
    if (!folderPaths.has(copy.path))
      throw new Error('drafts_folder_unavailable');
    try {
      await removeCopy(pool, account, client, copy);
    } catch (error) {
      if (failure(error) === 'draft_changed') {
        const found = await locked(client, copy.path, () =>
          locate(client, copy, true),
        );
        if (found?.raw)
          await acceptRemote(pool, account, link, found.copy, found.raw);
        return;
      }
      throw error;
    }
  }
  const draft = await localDraft(pool, account.user_id, link.draft_id);
  let active = link.active_copy_id
    ? ((
        await pool.query(
          "SELECT * FROM mail_draft_copies WHERE user_id=$1 AND id=$2 AND state='active'",
          [account.user_id, link.active_copy_id],
        )
      ).rows[0] as RemoteCopy | undefined)
    : undefined;
  if (active) {
    if (!folderPaths.has(active.path))
      throw new Error('drafts_folder_unavailable');
    const activeCopy = active;
    const found = await locked(client, active.path, () =>
      locate(client, activeCopy),
    );
    if (!found) {
      if (draft?.account_id === account.id) throw new Error('draft_removed');
      await withLease(pool, account, (db) =>
        db.query(
          "UPDATE mail_draft_copies SET state='removed' WHERE user_id=$1 AND id=$2",
          [account.user_id, activeCopy.id],
        ),
      );
      active = undefined;
    } else if (found.changed) {
      await acceptRemote(
        pool,
        account,
        link,
        found.copy,
        found.raw ??
          (await locked(client, active.path, () =>
            download(client, found.copy.uid ?? ''),
          )),
      );
      return;
    } else {
      active = found.copy;
      await withLease(pool, account, (db) => saveCopy(db, found.copy));
    }
  }
  if (!draft || draft.account_id !== account.id) {
    if (active) await removeCopy(pool, account, client, active);
    await withLease(pool, account, (db) =>
      db.query(
        "UPDATE mail_draft_links SET state='removed',error_code=NULL,next_attempt_at=clock_timestamp()+interval '1 day' WHERE user_id=$1 AND id=$2",
        [account.user_id, link.id],
      ),
    );
    return;
  }
  if (await frozen(pool, account.user_id, draft.id)) {
    await withLease(pool, account, (db) =>
      db.query(
        "UPDATE mail_draft_links SET next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE user_id=$1 AND id=$2",
        [account.user_id, link.id],
      ),
    );
    return;
  }
  if (draft.revision === link.synced_revision) {
    await withLease(pool, account, (db) =>
      db.query(
        "UPDATE mail_draft_links SET state='synced',error_code=NULL,next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE user_id=$1 AND id=$2",
        [account.user_id, link.id],
      ),
    );
    return;
  }
  if (active && !client.capabilities.has('UIDPLUS'))
    throw new Error('safe_delete_unavailable');
  const snapshot = await withLease(pool, account, async (db) => {
    const current = await localDraft(db, account.user_id, draft.id);
    if (
      !current ||
      current.account_id !== account.id ||
      (await frozen(db, account.user_id, current.id))
    )
      return null;
    const files = (
      await db.query(
        `SELECT f.id,f.filename,f.state FROM mail_draft_attachments d JOIN mail_uploads f ON f.user_id=d.user_id AND f.id=d.file_id WHERE d.user_id=$1 AND d.draft_id=$2 ORDER BY d.position`,
        [account.user_id, current.id],
      )
    ).rows;
    if (files.some((file) => file.state !== 'ready')) {
      await db.query(
        "UPDATE mail_draft_links SET state='waiting',error_code='attachments_pending',next_attempt_at=clock_timestamp()+interval '10 seconds' WHERE user_id=$1 AND id=$2",
        [account.user_id, link.id],
      );
      return null;
    }
    const smtp = (
      await db.query(
        'SELECT username,display_name FROM mail_smtp WHERE user_id=$1 AND account_id=$2',
        [account.user_id, account.id],
      )
    ).rows[0];
    const profile = (
      await db.query('SELECT name FROM users WHERE id=$1', [account.user_id])
    ).rows[0];
    const address =
        smtp?.username ??
        (emailAddress(account.username) ? account.username : null),
      id = randomUUID();
    const compiled = composeProviderDraft(
      id,
      link.id,
      address
        ? {
            address,
            name: smtp?.display_name ?? defaultSenderName(profile.name),
          }
        : null,
      current.content,
      current.reply_context,
      current.forward_content,
      files.map((file) => ({
        filename: file.filename,
        contentType: 'application/octet-stream',
        content: fileStream(db, account.user_id, file.id),
      })),
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const data of fixedChunks(compiled.createReadStream())) {
      bytes += data.length;
      if (bytes > MIME_BYTES) throw new Error('draft_too_large');
      chunks.push(data);
    }
    const raw = Buffer.concat(chunks);
    let contentHash: string | null = null;
    try {
      contentHash = draftContentHash(await parseProviderDraft(raw));
    } catch {
      /* Older oversized/unsupported drafts keep conservative raw-change handling. */
    }
    return { id, revision: current.revision, raw, contentHash };
  });
  if (!snapshot) return;
  await locked(client, active?.path ?? preferred, async () => {
    if (active) {
      const latest = await locate(client, active, true);
      if (!latest || latest.changed) {
        if (latest?.raw)
          await acceptRemote(pool, account, link, latest.copy, latest.raw);
        else throw new Error('draft_removed');
        return;
      }
    }
    if (!client.mailbox) throw new Error('draft_sync_unavailable');
    const validity = String(client.mailbox.uidValidity);
    const inserted = await withLease(pool, account, async (db) => {
      const current = await localDraft(db, account.user_id, draft.id);
      if (
        !current ||
        current.account_id !== account.id ||
        current.revision !== snapshot.revision ||
        (await frozen(db, account.user_id, current.id))
      )
        return false;
      await db.query(
        `INSERT INTO mail_draft_copies(id,user_id,link_id,state,path,uid_validity,message_id,marker,hash,size_bytes,revision,content_hash,content_hash_source)
        VALUES($1,$2,$3,'appending',$4,$5,$6,$1,$7,$8,$9,$10,CASE WHEN $10::text IS NULL THEN NULL ELSE $7 END)`,
        [
          snapshot.id,
          account.user_id,
          link.id,
          active?.path ?? preferred,
          validity,
          `<${snapshot.id}@spindle-draft.invalid>`,
          draftHash(snapshot.raw),
          snapshot.raw.length,
          snapshot.revision,
          snapshot.contentHash,
        ],
      );
      return true;
    });
    if (!inserted) return;
    await client.append(active?.path ?? preferred, snapshot.raw, ['\\Draft']);
  });
  const published = (
    await pool.query(
      'SELECT * FROM mail_draft_copies WHERE user_id=$1 AND id=$2',
      [account.user_id, snapshot.id],
    )
  ).rows[0] as RemoteCopy | undefined;
  if (
    published &&
    (await recoverAppend(pool, account, client, link, published))
  ) {
    const current = (
      await pool.query(
        'SELECT * FROM mail_draft_links WHERE user_id=$1 AND id=$2',
        [account.user_id, link.id],
      )
    ).rows[0] as Link;
    if (current.state === 'conflict') return;
    for (const old of (
      await pool.query(
        "SELECT * FROM mail_draft_copies WHERE user_id=$1 AND link_id=$2 AND state='obsolete'",
        [account.user_id, link.id],
      )
    ).rows as RemoteCopy[]) {
      try {
        await removeCopy(pool, account, client, old);
      } catch (error) {
        if (failure(error) === 'draft_changed') {
          const found = await locked(client, old.path, () =>
            locate(client, old, true),
          );
          if (found?.raw)
            await acceptRemote(pool, account, current, found.copy, found.raw);
          return;
        }
        throw error;
      }
    }
    await withLease(pool, account, async (db) => {
      const latest = await localDraft(db, account.user_id, current.draft_id);
      const synced =
        latest &&
        latest.account_id === account.id &&
        latest.revision === current.synced_revision;
      await db.query(
        "UPDATE mail_draft_links SET state=$3,error_code=NULL,next_attempt_at=clock_timestamp()+CASE WHEN $3='synced' THEN interval '60 seconds' ELSE interval '1 second' END WHERE user_id=$1 AND id=$2",
        [account.user_id, link.id, synced ? 'synced' : 'pending'],
      );
    });
  }
}

async function importNative(
  pool: Pool,
  account: MailAccount,
  client: Client,
  entry: { id: string; path: string; uid: string; uid_validity: string },
  folderPaths: Set<string>,
) {
  if (!folderPaths.has(entry.path))
    throw new Error('drafts_folder_unavailable');
  await locked(client, entry.path, async () => {
    if (
      !client.mailbox ||
      String(client.mailbox.uidValidity) !== entry.uid_validity
    )
      throw new Error('draft_removed');
    const raw = await download(client, entry.uid),
      value = await parseProviderDraft(raw);
    const headerEnd = raw.indexOf('\r\n\r\n');
    const headers = raw
      .subarray(0, Math.min(headerEnd < 0 ? raw.length : headerEnd, 65536))
      .toString('utf8');
    const operation = /^X-Spindle-Operation:\s*([a-f\d-]{36})\s*$/im.exec(
      headers,
    )?.[1];
    await withLease(pool, account, async (db) => {
      if (
        (
          await db.query(
            `SELECT 1 FROM mail_draft_copies c JOIN mail_draft_links l ON l.user_id=c.user_id AND l.id=c.link_id WHERE c.user_id=$1 AND l.account_id=$2 AND (c.marker=$3 OR (c.path=$4 AND c.uid_validity=$5 AND c.uid=$6))`,
            [
              account.user_id,
              account.id,
              operation ?? null,
              entry.path,
              entry.uid_validity,
              entry.uid,
            ],
          )
        ).rowCount
      ) {
        await db.query(
          "UPDATE mail_draft_imports SET state='imported',error_code=NULL WHERE user_id=$1 AND id=$2",
          [account.user_id, entry.id],
        );
        return;
      }
      if (
        (
          await db.query(
            'SELECT count(*)::int AS count FROM mail_drafts WHERE user_id=$1',
            [account.user_id],
          )
        ).rows[0].count >= 100
      )
        throw new Error('draft_quota');
      const draft = randomUUID(),
        copyId = randomUUID();
      const copy: RemoteCopy = {
        id: copyId,
        user_id: account.user_id,
        link_id: '',
        state: 'active',
        path: entry.path,
        uid_validity: entry.uid_validity,
        uid: entry.uid,
        message_id:
          /^Message-ID:\s*(<[^\r\n]+>)\s*$/im.exec(headers)?.[1] ?? null,
        marker: null,
        hash: draftHash(raw),
        size_bytes: raw.length,
        revision: 1,
        modseq: null,
      };
      const candidate = await storeValue(
        db,
        account.user_id,
        null,
        value,
        copy,
      );
      await db.query(
        'INSERT INTO mail_drafts(id,user_id,account_id,content,reply_context,forward_content) VALUES($1,$2,$3,$4,$5,$6)',
        [
          draft,
          account.user_id,
          account.id,
          json(candidate.content),
          json(candidate.replyContext),
          json(candidate.forward),
        ],
      );
      await setDraftAttachments(
        db,
        account.user_id,
        draft,
        candidate.attachmentIds,
      );
      const link = (
        await db.query(
          'SELECT id FROM mail_draft_links WHERE user_id=$1 AND draft_id=$2 AND account_id=$3',
          [account.user_id, draft, account.id],
        )
      ).rows[0].id;
      await db.query(
        `INSERT INTO mail_draft_copies(id,user_id,link_id,state,path,uid_validity,uid,message_id,hash,size_bytes,revision,content_hash,content_hash_source) VALUES($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,1,$10,$8)`,
        [
          copyId,
          account.user_id,
          link,
          entry.path,
          entry.uid_validity,
          entry.uid,
          copy.message_id,
          copy.hash,
          copy.size_bytes,
          draftContentHash(value),
        ],
      );
      await db.query(
        "UPDATE mail_draft_links SET state='synced',synced_revision=1,active_copy_id=$3,next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE user_id=$1 AND id=$2",
        [account.user_id, link, copyId],
      );
      await db.query(
        "UPDATE mail_draft_imports SET state='imported',error_code=NULL WHERE user_id=$1 AND id=$2",
        [account.user_id, entry.id],
      );
    });
  });
}

export async function syncProviderDrafts(
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
  let links: Link[] = [];
  let imports: {
    id: string;
    path: string;
    uid: string;
    uid_validity: string;
  }[] = [];
  try {
    links = (
      await pool.query(
        "SELECT * FROM mail_draft_links WHERE user_id=$1 AND account_id=$2 AND state NOT IN ('conflict','removed','unknown') AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at LIMIT 4",
        [owner, accountId],
      )
    ).rows as Link[];
    imports = (
      await pool.query(
        "SELECT * FROM mail_draft_imports WHERE user_id=$1 AND account_id=$2 AND state='pending' AND next_attempt_at<=clock_timestamp() LIMIT 2",
        [owner, accountId],
      )
    ).rows;
    if (!links.length && !imports.length) return;
    client = await connect(
      account,
      decryptCredential(account.credential, owner, accountId, keys),
    );
    timer = setTimeout(() => client?.close(), 45000);
    const discovered = await folders(client),
      paths = new Set(discovered.map((folder) => folder.path));
    if (!discovered.length) throw new Error('drafts_folder_unavailable');
    for (const link of links) {
      try {
        await processLink(
          pool,
          account,
          client,
          link,
          paths,
          discovered[0]?.path ?? '',
        );
      } catch (error) {
        await markFailure(pool, account, link, failure(error));
      }
    }
    for (const entry of imports) {
      try {
        await importNative(pool, account, client, entry, paths);
      } catch (error) {
        await withLease(pool, account, (db) =>
          db.query(
            "UPDATE mail_draft_imports SET state='failed',error_code=$3 WHERE user_id=$1 AND id=$2",
            [owner, entry.id, failure(error)],
          ),
        );
      }
    }
  } catch (error) {
    for (const link of links)
      await markFailure(pool, account, link, failure(error)).catch(() => {});
    for (const entry of imports)
      await withLease(pool, account, (db) =>
        db.query(
          "UPDATE mail_draft_imports SET state='failed',error_code=$3 WHERE user_id=$1 AND id=$2",
          [owner, entry.id, failure(error)],
        ),
      ).catch(() => {});
  } finally {
    clearTimeout(timer);
    client?.close();
    await releaseLease(pool, account);
  }
}

async function markFailure(
  pool: Pool,
  account: MailAccount,
  link: Link,
  code: string,
) {
  const conflict = [
    'draft_changed',
    'draft_removed',
    'draft_ambiguous',
    'safe_delete_unavailable',
  ].includes(code);
  await withLease(pool, account, (db) =>
    db.query(
      `UPDATE mail_draft_links SET state=CASE WHEN EXISTS(SELECT 1 FROM mail_draft_copies c WHERE c.user_id=$1 AND c.link_id=$2 AND c.state IN ('appending','unknown')) THEN 'unknown' ELSE $3 END,
    error_code=CASE WHEN EXISTS(SELECT 1 FROM mail_draft_copies c WHERE c.user_id=$1 AND c.link_id=$2 AND c.state IN ('appending','unknown')) THEN 'append_unknown' ELSE $4 END,
    attempts=attempts+1,next_attempt_at=clock_timestamp()+interval '60 seconds' WHERE user_id=$1 AND id=$2 AND state<>'removed'`,
      [account.user_id, link.id, conflict ? 'conflict' : 'failed', code],
    ),
  );
}

export async function checkProviderDraftBeforeSend(
  pool: Pool,
  keys: MailKeys,
  account: MailAccount,
  draft: string,
  connect = connectImap,
) {
  const link = (
    await pool.query(
      'SELECT * FROM mail_draft_links WHERE user_id=$1 AND account_id=$2 AND source_draft_id=$3',
      [account.user_id, account.id, draft],
    )
  ).rows[0] as Link | undefined;
  if (!link) return null;
  if (['conflict', 'unknown'].includes(link.state))
    return 'provider_draft_changed';
  const copy = link.active_copy_id
    ? ((
        await pool.query(
          'SELECT * FROM mail_draft_copies WHERE user_id=$1 AND id=$2',
          [account.user_id, link.active_copy_id],
        )
      ).rows[0] as RemoteCopy | undefined)
    : undefined;
  if (!copy) return null;
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = await connect(
      account,
      decryptCredential(account.credential, account.user_id, account.id, keys),
    );
    timer = setTimeout(() => client?.close(), 45000);
    if (!(await folders(client)).some((folder) => folder.path === copy.path))
      return 'draft_check_failed';
    const found = await locked(
      client,
      copy.path,
      () => locate(client as Client, copy, true),
      true,
    );
    if (!found) {
      await markFailure(pool, account, link, 'draft_removed');
      return 'provider_draft_changed';
    }
    if (found.changed) {
      await acceptRemote(
        pool,
        account,
        link,
        found.copy,
        found.raw ?? Buffer.alloc(0),
      );
      return 'provider_draft_changed';
    }
    return null;
  } catch {
    return 'draft_check_failed';
  } finally {
    clearTimeout(timer);
    client?.close();
  }
}
