# Drafts stay in Spindle

Drafts are saved only in Spindle ([D044](decisions.md#d044--drafts-stay-in-spindle)). Spindle does not copy drafts to any provider's Drafts folder, import drafts written in other mail clients, or check a provider copy before sending. This applies to IMAP, Gmail and Microsoft accounts. Provider Drafts folders are hidden from the folder list. Drafts written elsewhere stay with the provider and remain available in the client that wrote them.

Autosave, revision checks, tab recovery, signatures, Outbox, Undo send and Send later are unchanged; see [compose](compose.md) and [sending](sending.md).

## One-time cleanup of earlier copies

Earlier IMAP Drafts synchronization (D016, superseded) wrote copies of Spindle drafts to designated `\Drafts` folders. After upgrading, the worker removes each tracked copy once, under the account lease and the existing connection budget:

- A copy is deleted only when its bytes still match what Spindle last recorded and the server supports UIDPLUS for a targeted expunge. With CONDSTORE, the delete is also conditional on the copy being unchanged since it was checked.
- Copies are found by recorded UID, then by their `X-Spindle-Operation` marker or exact Spindle Message-ID. Unconfirmed earlier uploads are found the same way. If a copy is already gone, nothing else is changed.
- Copies are kept and never touched again if they were edited in another client, match more than once, are oversized, are in a folder that is no longer the designated Drafts folder, are on a server without UIDPLUS, or were previously marked **Leave original provider copy**.
- Transient provider failures retry every five minutes, up to five attempts. After that the remaining copies are kept.
- Drafts written in other clients are never deleted.

Kept copies stay in the provider's Drafts folder. Delete them in another mail client if they are not wanted.

## Upgrade and rollback

Stop the worker, apply `0040_local_only_drafts.sql`, then deploy the new API/web/worker together. The migration drops the save/delete triggers that queued provider Drafts work. It marks tracked copies for cleanup, clears conflict and candidate state, and releases conflict-file references so unused uploads can expire normally. It also detaches each link from its local draft. No worker version can treat a local draft as something to upload again. Local draft text, revisions, Outbox rows and attachment files are unchanged. Link, copy and import history is retained.

Do not run an older worker after 0040. Without the triggers, older code has no new work to sync. It could still try to reconcile copies that are mid-cleanup. Rolling back the application means stopping workers until the newer version is redeployed. Do not re-create the triggers or delete the history tables as a rollback shortcut.

## Proof

`provider-draft-cleanup.integration.ts` applies 0040's data step to seeded earlier rows. It then checks the following against a synthetic ImapKit server:

- An unchanged copy is removed.
- An unconfirmed copy is removed after being found by its marker.
- Externally edited, user-kept and native drafts are kept.
- A server without UIDPLUS keeps its copy.
- New saves queue no provider work.
- Drafts folders are absent from `/api/mail/mailboxes`.
- The old `draft-sync` routes no longer exist.
