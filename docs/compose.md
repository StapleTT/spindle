# Composer and local drafts

Choose **Compose** to start a private draft. **Local drafts** lists saved drafts and recovery edits from the current browser tab. This slice implements I01 and the local-storage portion of I03/I09. It does not send mail, upload attachments, synchronize provider Drafts, or implement replies, signatures or send-as identities.

## Editing and saving

The composer offers a sending-account selector, To/Cc/Bcc, subject, rich text and plain text. Account selection is limited to the user's connected accounts; it is a draft association, not verification that the IMAP username is an authorized SMTP From address. A draft can have no account. Partial recipient strings can be saved while editing; complete recipient and sender validation belongs to sending.

Tiptap supplies schema-based rich editing: bold, italic, strikethrough, lists, quotes, links and typing undo/redo. Paste inserts plain text only, and drops are ignored. No pasted HTML, images, styles, embedded resources or scripts enter the app document. Link creation allows complete HTTP, HTTPS and mailto URLs. The server independently sanitizes rich HTML to the same small tag vocabulary and derives its plain alternative. Plain-text drafts retain literal text. Switching to plain text removes rich formatting.

After 750 ms without edits, autosave writes to Postgres. **Saved to Spindle** appears only after acknowledgement. **Unsaved**, **Saving**, **Failed** and **Conflict** describe other states. Saves are serialized per open editor; edits made during an in-flight save are saved afterwards. Failures retry every five seconds, on browser online events, or through **Retry save**. **Save and close** waits until the current text is saved. **Discard draft** requires explicit confirmation and a matching server revision. An unconfirmed save must first be acknowledged through retry; discard never guesses that a lost create response means no server draft exists.

## Recovery and concurrent editors

Before each save, the composer keeps its current text, base revision and operation ID in user/draft-scoped `sessionStorage`. Recovery survives in-app navigation and reloads in that tab, including a lost save response. It is not a server backup and is not guaranteed to survive closing the tab, clearing browser storage or browser failure. Saved Postgres drafts survive API/browser restarts. The app warns before unloading with unsaved changes. If browser storage is full/disabled while editing, it warns to keep the page open until saved; starting a new recovery-backed draft requires working browser storage. Recovery text is never included in URLs or logs, and another signed-in user's draft list cannot expose it.

Every save carries a client operation ID and base revision. Replaying an acknowledged request returns that saved revision without another write. A stale revision cannot overwrite a newer save or recreate a deleted draft. Conflicts stop autosave and preserve local edits, including across reloads. The user can compare the server copy, **Save my edits as a new draft**, or explicitly **Discard my edits and load saved version**. A conflict must be resolved before discarding the server draft.

Removing a connected account preserves draft text, clears its account selection, increments its revision and invalidates stale editors. The composer never contacts a provider; no credentials or provider folder mappings are added by this slice.

## Limits and ownership

All draft routes share existing verified-session, origin and owner checks. Platform admins cannot access other users' drafts. An additive migration creates `mail_drafts` with an owner/account foreign key and a revision trigger. The owner lock serializes draft creation quotas; updates and deletes enforce revision checks. Users can keep 100 server drafts. Autosave has a separate persistent budget of 120 writes/minute; existing action limits are unchanged.

Requests are bounded to 128 KiB and canonical draft content to 120,000 bytes, including HTML and its text alternative. Subject length is 1,000 characters, each recipient field 4,000, and each body field 100,000, subject to the aggregate byte cap. Header fields reject CR/LF/NUL and body fields reject NUL. These are draft limits, not future SMTP message/attachment limits.

## Upgrade and proof

Apply `0010_local_drafts.sql`, then deploy API and web together. It adds a table, index and trigger without modifying existing mail or action records. For application rollback, keep the migration and draft rows; earlier code ignores them. No provider state changes or worker deployment are needed.

The disposable-database integration suite verifies ownership, foreign admin/account denial, verification/CSRF, persistence across API instances, sanitization, Unicode/partial recipients, size limits, idempotent replay, concurrent revisions, stale deletion/recreation, quotas, write budgets and preservation after account removal. The Chromium composer journey covers rich/plain editing, safe links/paste, reload/navigation, offline recovery, edits during a save, lost acknowledgements, two-tab conflicts, loading the saved version, saving a copy, safe discard and phone width. All fixtures are synthetic; these tests never send email.
