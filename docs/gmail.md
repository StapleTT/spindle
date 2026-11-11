# Gmail (Gmail API)

Gmail accounts connect with Google OAuth and sync through the Gmail REST API. Decision: [D038](decisions.md#d038--gmail-via-the-gmail-api-slice-1). Gmail ships in vertical slices, and each slice says exactly what works:

| Slice                | Scope                                                                                                                              | Status             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1                    | Connect, reconnect and disconnect; labels as folders; message list, counts and search over synced metadata; `history.list` polling | Implemented (D038) |
| 2 — reader           | `messages.get?format=raw` into the shared parse/sanitize/cache pipeline, plus attachments and forwarded files                      | Implemented (D040) |
| 3 — actions          | Read/unread, archive, trash, move and restore through `messages.modify`/`trash`/`untrash` under the shared action/undo model       | Implemented (D040) |
| 4 — sending          | `messages.send` with immutable-outbox semantics, scheduling, Undo send and unknown-outcome protection                              | Implemented (D040) |
| 4b — provider drafts | Not planned: drafts stay in Spindle by design ([D044](decisions.md#d044--drafts-stay-in-spindle))                                  | Excluded           |
| 5 — push             | `users.watch` and Pub/Sub, once a public HTTPS domain exists (U05)                                                                 | Not implemented    |

Only SMTP settings and the SMTP test answer `409` for Gmail accounts ("Gmail accounts send through Gmail; SMTP settings do not apply."). Drafts written in Gmail's own interface are not imported, and Spindle drafts are not copied to Gmail's Drafts. Sent mail appears in Gmail's Sent label automatically.

## Google Cloud setup (SET02 checklist)

Create these yourself in the Google Cloud console. Never paste the secret into chat or commit it.

1. Create (or choose) a project per environment: one for development and one for production.
2. Enable the **Gmail API** (APIs & Services → Library). Pub/Sub is for slice 5 only.
3. Configure the **OAuth consent screen**: External user type, app name, support email, and the scopes `openid`, `email` and `https://www.googleapis.com/auth/gmail.modify`.
4. Create an **OAuth client ID** of type **Web application** with these exact **Authorized redirect URIs**:
   - Development: `http://127.0.0.1:5173/api/mail/oauth/google/callback` (must match `APP_URL` exactly, including host and port)
   - Production: `https://<your app host>/api/mail/oauth/google/callback`

   No JavaScript origins are needed; the browser never calls Google APIs.
5. Put the values in `.env` (locally) or the hosted secret store, for both the API and the worker:

   ```
   GOOGLE_CLIENT_ID=<client id>
   GOOGLE_CLIENT_SECRET=<client secret>
   ```

   Setting only one of the two fails startup. With neither set, the Google card in Settings shows "Needs operator setup". Mail encryption (`MAIL_ENCRYPTION_KEYS`) is also required.
6. While the app is in **Testing** publishing status, add each Gmail address as a **test user** (100 at most). Google expires Testing-mode refresh tokens after **7 days**; affected accounts show "Reconnect" in Settings. Production use of `gmail.modify`, a restricted scope, requires Google's verification and a security assessment before publishing.

## Connection flow

`POST /api/mail/oauth/google {history:'90d'|'all', accountId?}` runs behind the mail session guard (verified, not suspended, exact Origin, rate limit). It returns 503 if Google or mail encryption is not configured. Under the owner row lock it checks the five-account limit (skipped for reconnect) and that a reconnect target is an owned Gmail account. It then stores a sha256 hash of a 32-byte random state with the user, the current sign-in session, the target account, the history choice and a PKCE verifier. The state expires after 10 minutes. The response is the Google authorization URL with an S256 challenge, `access_type=offline`, `prompt=consent`, the exact redirect URI and `login_hint` on reconnect.

`GET /api/mail/oauth/google/callback` consumes the state with one `DELETE … RETURNING` bound to the state hash, user, session and expiry. That makes the state single-use and useless from another user, another device session or after sign-out, because session deletion cascades to it. The callback then:

1. Exchanges the code with the verifier (10-second timeout).
2. Requires `sub` and a verified email from userinfo.
3. Requires `gmail.modify` in the granted scope; granular consent can leave it unchecked.
4. In one owner-locked transaction, looks up the account by `(user_id, Google sub)`.
   - A reconnect into a different Google account is refused, which prevents account substitution.
   - An existing account gets the new refresh token, or keeps its stored one if Google omitted it. It is set back to pending with a fresh sync request.
   - A new account rechecks the limit and is appended to the account order.

Every outcome redirects (303) to `/inbox#view=settings&gmail=<result>`. The result is one of `connected`, `denied`, `scope`, `mismatch`, `limit`, `expired` or `failed`. Provider text, codes and tokens never appear in URLs or logs. Refused grants are revoked unless another Spindle connection uses the same Google account.

Identity: `mail_accounts.provider='gmail'`, `provider_account` is the Google `sub`, and `username`/`name` are the Google address. That keeps self-address and contact exclusions working. The refresh token is encrypted into `credential` with the mail key ring (AAD `owner:account`). Access tokens are obtained per worker job and never stored.

## Disconnect, deletion and revocation

Disconnect (password-confirmed, unchanged) deletes the account; the cascade removes the mirror, checkpoint and pending states. After commit the API revokes the refresh token at `oauth2.googleapis.com/revoke` (5-second timeout, best effort). Scheduled self-deletion collects Gmail grants inside the deletion transaction and the worker revokes them after commit.

Google grants are per Google account and OAuth client, so revocation is skipped while any other Spindle connection, of this or another user, uses the same Google account. Admin deletion of suspended users does not revoke yet. The tokens are deleted with the user, and Google expires unused grants.

## Sync

The worker owns all mailbox I/O. The dispatcher sends due Gmail accounts to the existing `mail-sync` queue, and the job branches on `provider`. Like IMAP sync, a Gmail sync job yields to pending user work (opening a message, an action, a send), and it also checks between pages, so an opened message waits at most one page. The IMAP-only queries (provider drafts, draft imports and SMTP checks) carry one shared `imapAccount` SQL fragment (`src/mail/store.ts`), and IDLE selects only IMAP accounts.

Each job claims the account lease, refreshes an access token and lists labels. Label mapping:

| Gmail label                               | Folder                                               | Role                                         |
| ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH` | Inbox, Sent, Drafts, Spam, Trash                     | inbox, `\Sent`, `\Drafts`, `\Junk`, `\Trash` |
| User labels                               | Label name (path is the label ID)                    | none                                         |
| (synthetic) `[All Mail]`                  | Archive: mail with none of Inbox, Spam or Trash      | `\Archive`                                   |
| `UNREAD`, `STARRED`                       | Flags: no `\Seen`, `\Flagged`; `DRAFT` adds `\Draft` | —                                            |
| `IMPORTANT`, `CATEGORY_*`, `CHAT`         | Not mirrored                                         | —                                            |

A message has one `mail_messages` row (`remote_key` is the Gmail message ID) and one membership per mirrored label. Gmail memberships have no IMAP UID. Trash and Spam are exclusive: mail in either appears only there, as in Gmail. A history entry that takes mail out of Trash or Spam therefore refetches that message's labels instead of applying a local delta. Removed labels delete only the local folder.

The `[All Mail]` path predates D040. Slice 1 used it for all mail outside Spam and Trash, which gave Spindle's Archive action no target. The first sync after upgrading recomputes memberships locally, with no Gmail requests, then renames the folder Archive with role `\Archive`. Gmail sync also stores the default "Send mail as" display name (`users.settings.sendAs`).

The checkpoint is `mail_gmail_sync(history_id, page_token, initial_complete)`:

- **Initial sync** records the `getProfile` historyId first. It then pages `messages.list` (100 per page, `includeSpamTrash`, `q=after:<epoch>` for the 90-day horizon) and fetches `format=metadata` headers (From/To/Cc/Subject/Date/Message-ID/In-Reply-To/References) through the paced request pool described under Quota. Every committed page persists `page_token`, so a crash resumes from the last page. Listed IDs go to `mail_gmail_listed`; when the listing completes, local messages that were not listed are removed.
- **Incremental sync** pages `history.list` (100 records per page) from `history_id`. New messages are fetched. Label-only changes are applied as deltas to the local label set, which is recovered from folder paths and the `\Seen`/`\Flagged`/`\Draft` flags, so bulk changes such as "mark all read" or a filter need no refetch and have no size cap. Deleted messages are removed locally. If one page adds more than 1,000 messages, the account switches to a resumable full listing. The new `history_id` is stored after the last page, and page progress persists in the same way.
- **Expired history** (404) or a stale page token resets the checkpoint for a full resync. Existing local mail stays visible until the new listing replaces it.
- **Revoked consent** (`invalid_grant`, a Gmail 401, or 403 `insufficientPermissions`) sets `status='error'`, `error_code='reconnect_required'` and defers sync 30 days or until reconnect. Other failures use the IMAP backoff and log a redacted `Gmail sync failed` line with the account ID, HTTP status and Google's enum-like `code`/`reason`, never message text or tokens.

Limits: 40-second soft and 75-second hard job deadlines inside the 90-second lease; 4 MiB per Google response; 1,000 labels; 500 IDs per list page; 1,000 new messages per history page. Polling uses the existing `next_sync_at` cadence (1 second while syncing, 60 seconds when ready, immediately for Sync now). There is no Gmail IDLE; push is slice 5.

Quota: Gmail allows 250 units per user per second, and `messages.get` costs 5. A job uses a pool of 5 requests and starts at most one every 25 ms (about 40 requests and 200 units per second). A 429, 5xx, or 403 `rateLimitExceeded`/`userRateLimitExceeded` is retried up to 4 times with exponential backoff or `Retry-After`, and the whole job slows down with it. If retries run out or the hard deadline arrives, the job **pauses**: committed pages stay, the account remains `syncing` with no error, and the next job runs after 60 seconds (rate limit), 30 seconds (server error) or 1 second (deadline). Before 2026-11-05 the job used 10 unpaced requests and turned every rate-limit response into a sync failure, which is why automatic syncs failed after the first. If initial sync speed matters, switch to the batch endpoint (`ponytail:` note in `gmail.ts`).

Committed changes fire the existing SSE triggers; lists, counts and search read only Postgres.

## Reader

Opening a message queues the shared `mail_content` row; nothing reaches Gmail from the API. The content job uses `ContentSource` (`content-worker.ts`): IMAP supplies UID-addressed fetches, and Gmail supplies `format=raw` (10 MiB limit, base64url decoded and bounded) plus `format=metadata` reply headers. The parse, sanitizer, isolated content origin, image proxy, 7-day cache and per-user limits are the same code for both.

Attachments are listed from the raw message with the IMAP rules (Content-ID parts are embedded unless explicitly attached). Each attachment's position is stored as its `part`. A download or a forwarded file re-reads the raw message and takes that position, so the list and the download always agree, and Gmail's unstable `attachmentId` values are never stored. A `ponytail:` note covers switching to `attachments.get` if attachments larger than 10 MiB are needed. Reading never changes Gmail labels; the reader's one-second dwell creates an ordinary read action.

## Actions

Read/unread, archive, trash, move and restore use the shared durable intents: optimistic local state, five-second Undo, ordering, batches and keyboard triage. Only the provider step differs (`applyGmailActions` in `gmail-mail.ts`):

| Intent                         | Gmail call                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------- |
| Read / unread                  | `modify` removes / adds `UNREAD`                                                |
| Archive                        | `modify` removes `INBOX` (and `SPAM`)                                           |
| Trash                          | `trash`                                                                         |
| Move to a label, Inbox or Spam | `modify` adds the target and removes the source label (Spam also removes Inbox) |
| Restore                        | `untrash` when leaving Trash, then `modify` adds the original folder's label    |
| Move to Sent or Drafts         | Refused with `label_unsupported`; Gmail manages those labels                    |

Gmail returns the resulting labels, which become local memberships in the same transaction that settles the intent. Label changes, trash and untrash are idempotent, so a redelivered intent cannot duplicate mail; that is why there is no "move unconfirmed" state as there is for IMAP. A 404 means the message was deleted elsewhere (conflict `message_missing`). A 400 means the destination label was deleted (`folder_missing`). Rate limits pause the intent without spending one of its five attempts.

A Gmail message can carry several labels, so the action's source folder is chosen in a fixed order: Inbox, then user labels, then the rest. Moving from a label view while the message is also in the Inbox therefore moves it out of the Inbox, which matches Gmail's "Move to".

## Sending

Composer, Undo send, Send later, attachments, scanning, limits and the immutable Outbox snapshot are unchanged. For a Gmail account, the send route uses fixed settings instead of a `mail_smtp` row:

- The sender is the connected address.
- The display name is Gmail's default "Send mail as" name, or the Spindle profile name before the first sync.
- The account ID is the settings version.
- The MIME snapshot keeps the `Bcc` header, because `messages.send` reads recipients from the headers and removes Bcc from the delivered copies; SMTP takes recipients from the envelope instead.

The worker uploads the snapshot to `upload/.../messages/send?uploadType=media` exactly once (no automatic retry). It opens the Gmail client before marking the send as started, so token failures are known and retryable. Outcomes:

| Gmail response                     | Outbox                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 200 with a message ID              | `accepted` for every recipient; `sent_copy='saved'` (Gmail files Sent itself); draft removed                |
| 429, or a pause before the request | Queued again (up to three attempts), nothing sent                                                           |
| Other 4xx                          | `failed`, `gmail_rejected`; draft kept                                                                      |
| 5xx, timeout or lost response      | `unknown`, never resent. Later passes search `rfc822msgid:` and record a found copy as `sent_copy='saved'`. |

Gmail threads replies through `In-Reply-To`/`References` and the subject. Sending does not pass a `threadId` yet; a `ponytail:` note marks the multipart-upload upgrade if Gmail misthreads.

## Schema and rollout

Migration `0035_gmail_accounts.sql` is additive apart from the membership key:

- `mail_accounts`: adds `provider` and `provider_account`; host/port/transport become nullable, with a CHECK keeping them required for IMAP and absent for Gmail; adds a unique Gmail identity per user.
- `mail_memberships`: the primary key becomes `(mailbox_id, message_id)`, which was already unique. `UNIQUE (mailbox_id, uid_validity, uid)` remains the IMAP conflict target. UIDs are nullable as a pair.
- New tables `mail_gmail_sync`, `mail_gmail_listed` and `mail_oauth_states`, all cascading from their owner.

Migration `0036_gmail_mail.sql` (D040) adds the nullable `mail_gmail_sync.display_name`. It is additive; keep it on rollback.

Deploy: stop the old API and workers, run `npm run db:migrate`, then start the new API, worker and web together. Set the Google variables on both API and worker.

Rollback: keep the migrations (never edit or reverse them). Old workers and APIs assume a non-null host, so they must stay stopped while any Gmail account exists. A D038-only worker never sends or modifies Gmail mail. Rolling back to it leaves queued Gmail actions and sends pending, and it would keep showing inbox mail in the old All Mail folder until upgraded again. Prefer a forward fix; otherwise disconnect the Gmail accounts before running older code. The export includes `provider` but never tokens.

## Tests

`apps/server/test/gmail.integration.ts` runs against a fake Google (`test/google-fixture.ts`, local Fastify on an ephemeral port) with synthetic labels, messages and history. It covers:

- PKCE/redirect/scope parameters and the single-use, user/session/expiry-bound state.
- Denial, missing scope, account substitution, omitted refresh tokens and the five-account limit.
- Label/flag mapping, the 90-day filter, crash resume from the persisted page, history adds/label changes/deletes, expired-history resync that removes unlisted mail, and `invalid_grant` leading to reconnect required.
- The fake enforces Gmail's 50 `messages.get` per second; sync must stay under it, and unpaced requests fail the test.
- A 1,600-entry label record applies with zero fetches.
- Quota exhaustion pauses without an error state and resumes.
- Display-name edits survive reconnect.
- The reader caches sanitized bodies and downloads attachments without changing Gmail labels, and replies compose from cached headers.
- Read/unread, archive, restore, trash, restore-from-trash and move as label changes; a refused move to Sent; a conflict for mail deleted elsewhere.
- Undo inside the grace period never reaches Gmail; quota pauses keep the attempt count and the optimistic read state.
- Sending: sender name, `Bcc` header, Sent copy, rejection, rate limiting, and a lost response that stays unknown, is never resent and is later found in Sent.
- The pre-D040 All Mail recompute needs no requests; leaving Trash refetches labels.
- Worker routing (content first, then sync; no IMAP job for Gmail), revocation after scheduled deletion, and disconnect that revokes only unshared grants.

`apps/web/test/gmail.browser.ts` drives Connect Gmail through a fake consent redirect, then checks the provider logos and renaming (Escape cancels and focus returns). It then opens a Gmail message, shows its fetched body, archives it from the reader and confirms the label change at the fake Gmail, and finally checks the Reconnect status. No real Google accounts, tokens or mail are used. Live acceptance needs the U07 setup above.
