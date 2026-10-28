# Mail actions

Mail actions change provider mail on the user's behalf. Read/unread, archive, move to trash, restore and move to a chosen folder are implemented; five-second undo and the broader action-status view are the next triage steps.

## Read and unread

**Mark as read** / **Mark as unread** appear in the reader and on each list row. Opening a message still leaves its read state unchanged; only these explicit controls change it.

Each click carries a client-generated operation ID. The API checks that the signed-in, verified user owns the message, then in one transaction records a pending `mail_actions` row and applies the `\Seen` change to the local membership. Lists, folder unread counts and the reader reflect it immediately. Replaying the same operation ID returns the original action; reusing it for another message or state is rejected. Actions are ordered per message.

The pg-boss dispatcher sends pending actions through the existing body-fetch queue, so a worker still opens at most two provider connections. The worker takes the account's fenced lease, checks the folder's UIDVALIDITY and sends `UID STORE +FLAGS`/`-FLAGS (\Seen)`. This changes only `\Seen`; other flags set by other clients are preserved. Redelivery after a crash repeats an idempotent store. Pending actions take priority over the next metadata pass.

Until the provider confirms, a metadata pass keeps the latest pending intent instead of the provider's older flag. Once applied, provider state is authoritative again, so changes made later in another client reconcile through the normal scans. Provider or connection failures retry with exponential backoff (15 seconds doubling) and fail after five attempts. A failure, or a message whose IMAP identity changed, marks the action failed and reverts the local change unless a newer action for that message exists. The reader shows pending, completed and failed states and offers **Try again**. Completed and failed actions are deleted after seven days.

## Archive and move to trash

**Archive** and **Move to trash** appear in the reader and on list rows. They use only the folders the provider designates with the IMAP SPECIAL-USE `\Archive` and `\Trash` attributes; folder names are never matched. If the account has no such folder, or the message is already there, the control is disabled and the API answers 409. Trash is a move, not permanent deletion, which stays a separate, not-yet-implemented operation.

Requesting a move records the action with its destination and sets the membership's pending folder in the same transaction. Lists, counts and reader navigation use that effective folder, so the message leaves the current view at once; the reader continues to the next message and the list shows a notice. A metadata pass before dispatch keeps the pending destination.

The worker re-reads each message's current folder and UID per action, so a read or second move queued behind a move reaches the moved copy. It sends `UID MOVE`. With the provider's COPYUID response it records the destination UIDVALIDITY/UID on the same local message, preserving its ID, cached body and action history; without COPYUID it removes the old local copy and rescans the destination folder, which then appears as a new local message. Servers with neither MOVE nor UIDPLUS are refused (`move_unsupported`): imapflow's COPY/EXPUNGE fallback would use a plain EXPUNGE that also permanently removes messages other clients marked `\Deleted`. A failed or refused move clears the pending folder, so the message reappears where it was. If a destination folder disappears, its pending actions are removed with it.

## Move and restore

The reader's **Move to folder** list offers every synchronized folder of the message's own account except its current one; moves between accounts are not supported. The API rejects a folder from another account or the current folder.

Every move-type action (archive, trash, move, restore) records the message's effective source folder. **Restore to …** names its destination before you click: the source of the most recent non-failed move that brought the message to its current folder. So Receipts → Trash restores to Receipts, and a restore can itself be restored. Mail that was already in a provider `\Archive` or `\Trash` folder when Spindle first saw it, or whose move history was lost through a no-COPYUID move, restores to the account's INBOX. Elsewhere, without a recorded origin, restore is unavailable. List rows in Archive and Trash views offer **Restore** directly. If a recorded source folder is later deleted, its reference is cleared and the INBOX rule applies.

Move and restore use the same worker path as archive and trash. A retried request with the same operation ID is answered from the recorded intent before any destination is resolved, so a replay still succeeds after the first request has moved the message.

## Upgrade and rollback

`0007_mail_restore.sql` adds the move/restore kinds and a source-folder column; existing rows are unchanged. Apply it, then deploy the API and worker together; for rollback, stop the new worker first and keep the column. Earlier code ignores recorded sources, and pending move/restore actions wait for compatible code.

`0006_mail_moves.sql` adds the archive/trash action kinds, an action destination column and a membership pending-folder column with foreign keys; existing rows are unchanged. Deploy the API and worker together after applying it. For rollback, stop the new worker first and keep the columns. Earlier code ignores pending destinations, so a pending move then shows the message in its original folder and is not sent until compatible code returns.

`0005_mail_actions.sql` adds the `mail_actions` table and indexes; it changes no existing rows. Apply it, then deploy the API and worker together. For application rollback, stop the new worker first. Earlier code ignores the table; pending actions remain recorded and resume when compatible code returns, although local read state they changed may be overwritten by the older worker's sync.

## Proof

`apps/server/test/mail-actions.integration.ts` covers ownership (anonymous, foreign administrator, cross-origin and invalid input), immediate local state and counts, idempotent replay and conflicts, sync before dispatch, provider `\Seen` changes, ordered consecutive intents, external-client changes, retry exhaustion with revert, changed UIDVALIDITY and durable pg-boss dispatch. Archive/trash tests cover designated-folder resolution and its absence, pending destinations across sync, COPYUID identity preservation without duplicates, a read queued behind a move, the no-COPYUID rescan, refused servers without MOVE/UIDPLUS and failure revert. Move/restore tests cover input validation, foreign/current folders, replay after the message moved, origin-based and chained restore, the INBOX fallback, provider state and preserved identity. The reader Chromium journey marks messages read from the reader and a list row, archives from the reader (continuing to the next message), trashes and restores from list rows, moves to a chosen folder, and checks counts and provider state. All tests use synthetic ImapKit mail.
