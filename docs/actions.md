# Mail actions

Mail actions change provider mail on the user's behalf. Read/unread is implemented; archive, trash, restore, move, five-second undo and the broader action-status view are the next triage steps.

## Read and unread

**Mark as read** / **Mark as unread** appear in the reader and on each list row. Opening a message still leaves its read state unchanged; only these explicit controls change it.

Each click carries a client-generated operation ID. The API checks that the signed-in, verified user owns the message, then in one transaction records a pending `mail_actions` row and applies the `\Seen` change to the local membership. Lists, folder unread counts and the reader reflect it immediately. Replaying the same operation ID returns the original action; reusing it for another message or state is rejected. Actions are ordered per message.

The pg-boss dispatcher sends pending actions through the existing body-fetch queue, so a worker still opens at most two provider connections. The worker takes the account's fenced lease, checks the folder's UIDVALIDITY and sends `UID STORE +FLAGS`/`-FLAGS (\Seen)`. This changes only `\Seen`; other flags set by other clients are preserved. Redelivery after a crash repeats an idempotent store. Pending actions take priority over the next metadata pass.

Until the provider confirms, a metadata pass keeps the latest pending intent instead of the provider's older flag. Once applied, provider state is authoritative again, so changes made later in another client reconcile through the normal scans. Provider or connection failures retry with exponential backoff (15 seconds doubling) and fail after five attempts. A failure, or a message whose IMAP identity changed, marks the action failed and reverts the local change unless a newer action for that message exists. The reader shows pending, completed and failed states and offers **Try again**. Completed and failed actions are deleted after seven days.

## Upgrade and rollback

`0005_mail_actions.sql` adds the `mail_actions` table and indexes; it changes no existing rows. Apply it, then deploy the API and worker together. For application rollback, stop the new worker first. Earlier code ignores the table; pending actions remain recorded and resume when compatible code returns, although local read state they changed may be overwritten by the older worker's sync.

## Proof

`apps/server/test/mail-actions.integration.ts` covers ownership (anonymous, foreign administrator, cross-origin and invalid input), immediate local state and counts, idempotent replay and conflicts, sync before dispatch, provider `\Seen` changes, ordered consecutive intents, external-client changes, retry exhaustion with revert, changed UIDVALIDITY and durable pg-boss dispatch. The reader Chromium journey marks a message read from the reader and from a list row and checks counts and provider flags. All tests use synthetic ImapKit mail.
