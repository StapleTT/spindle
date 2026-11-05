# Gmail (Gmail API)

Gmail accounts connect with Google OAuth and sync through the Gmail REST API. Decision: [D038](decisions.md#d038--gmail-via-the-gmail-api-slice-1). Gmail ships in vertical slices, and each slice says exactly what works:

| Slice               | Scope                                                                                                                                        | Status          |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1                   | Connect, reconnect and disconnect; labels as folders; read-only message list, counts and search over synced metadata; `history.list` polling | Implemented     |
| 2 — reader          | `messages.get?format=raw` into the existing parse/sanitize/cache pipeline, plus attachments                                                  | Not implemented |
| 3 — actions         | Read/unread, archive, trash, move/restore through `messages.modify` under the existing action/undo model                                     | Not implemented |
| 4 — drafts, sending | `users.drafts.*` and `messages.send` with immutable-outbox semantics                                                                         | Not implemented |
| 5 — push            | `users.watch` and Pub/Sub, once a public HTTPS domain exists (U05)                                                                           | Not implemented |

Until a slice lands, the matching API routes answer `409` with "This is not available for Gmail accounts yet." for Gmail messages and accounts: message content, attachments, images, actions, batch actions, reply/forward compose, SMTP settings/test and draft send. The reader shows "Opening Gmail messages arrives in the next update.", and its action and reply controls are disabled with that reason. Local drafts may still select a Gmail account; the composer explains that sending from Gmail is not available yet.

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

The worker owns all mailbox I/O. The dispatcher sends due Gmail accounts to the existing `mail-sync` queue, and the job branches on `provider`. IMAP-only queries (provider drafts, draft imports, outgoing, actions, content, attachments, forwarded files and IDLE) carry one shared `imapAccount` SQL fragment (`src/mail/store.ts`), so Gmail rows never reach an IMAP/SMTP connection.

Each job claims the account lease, refreshes an access token and lists labels. Label mapping:

| Gmail label                               | Folder                                               | Role                                         |
| ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------- |
| `INBOX`, `SENT`, `DRAFT`, `SPAM`, `TRASH` | Inbox, Sent, Drafts, Spam, Trash                     | inbox, `\Sent`, `\Drafts`, `\Junk`, `\Trash` |
| User labels                               | Label name (path is the label ID)                    | none                                         |
| (synthetic) `[All Mail]`                  | All Mail: every message outside Spam and Trash       | `\All`                                       |
| `UNREAD`, `STARRED`                       | Flags: no `\Seen`, `\Flagged`; `DRAFT` adds `\Draft` | —                                            |
| `IMPORTANT`, `CATEGORY_*`, `CHAT`         | Not mirrored                                         | —                                            |

A message has one `mail_messages` row (`remote_key` is the Gmail message ID) and one membership per mirrored label. Gmail memberships have no IMAP UID. Removed labels delete only the local folder.

The checkpoint is `mail_gmail_sync(history_id, page_token, initial_complete)`:

- **Initial sync** records the `getProfile` historyId first. It then pages `messages.list` (100 per page, `includeSpamTrash`, `q=after:<epoch>` for the 90-day horizon) and fetches `format=metadata` headers (From/To/Cc/Subject/Date/Message-ID/In-Reply-To/References) through the paced request pool described under Quota. Every committed page persists `page_token`, so a crash resumes from the last page. Listed IDs go to `mail_gmail_listed`; when the listing completes, local messages that were not listed are removed.
- **Incremental sync** pages `history.list` (100 records per page) from `history_id`. New messages are fetched. Label-only changes are applied as deltas to the local label set, which is recovered from folder paths and the `\Seen`/`\Flagged`/`\Draft` flags, so bulk changes such as "mark all read" or a filter need no refetch and have no size cap. Deleted messages are removed locally. If one page adds more than 1,000 messages, the account switches to a resumable full listing. The new `history_id` is stored after the last page, and page progress persists in the same way.
- **Expired history** (404) or a stale page token resets the checkpoint for a full resync. Existing local mail stays visible until the new listing replaces it.
- **Revoked consent** (`invalid_grant`, a Gmail 401, or 403 `insufficientPermissions`) sets `status='error'`, `error_code='reconnect_required'` and defers sync 30 days or until reconnect. Other failures use the IMAP backoff and log a redacted `Gmail sync failed` line with the account ID, HTTP status and Google's enum-like `code`/`reason`, never message text or tokens.

Limits: 40-second soft and 75-second hard job deadlines inside the 90-second lease; 4 MiB per Google response; 1,000 labels; 500 IDs per list page; 1,000 new messages per history page. Polling uses the existing `next_sync_at` cadence (1 second while syncing, 60 seconds when ready, immediately for Sync now). There is no Gmail IDLE; push is slice 5.

Quota: Gmail allows 250 units per user per second, and `messages.get` costs 5. A job uses a pool of 5 requests and starts at most one every 25 ms (about 40 requests and 200 units per second). A 429, 5xx, or 403 `rateLimitExceeded`/`userRateLimitExceeded` is retried up to 4 times with exponential backoff or `Retry-After`, and the whole job slows down with it. If retries run out or the hard deadline arrives, the job **pauses**: committed pages stay, the account remains `syncing` with no error, and the next job runs after 60 seconds (rate limit), 30 seconds (server error) or 1 second (deadline). Before 2026-11-05 the job used 10 unpaced requests and turned every rate-limit response into a sync failure, which is why automatic syncs failed after the first. If initial sync speed matters, switch to the batch endpoint (`ponytail:` note in `gmail.ts`).

Committed changes fire the existing SSE triggers; lists, counts and search read only Postgres.

## Schema and rollout

Migration `0035_gmail_accounts.sql` is additive apart from the membership key:

- `mail_accounts`: adds `provider` and `provider_account`; host/port/transport become nullable, with a CHECK keeping them required for IMAP and absent for Gmail; adds a unique Gmail identity per user.
- `mail_memberships`: the primary key becomes `(mailbox_id, message_id)`, which was already unique. `UNIQUE (mailbox_id, uid_validity, uid)` remains the IMAP conflict target. UIDs are nullable as a pair.
- New tables `mail_gmail_sync`, `mail_gmail_listed` and `mail_oauth_states`, all cascading from their owner.

Deploy: stop the old API and workers, run `npm run db:migrate`, then start the new API, worker and web together. Set the Google variables on both API and worker.

Rollback: keep the migration (never edit or reverse it). Old workers and APIs assume a non-null host, so they must stay stopped while any Gmail account exists. Prefer a forward fix; otherwise disconnect the Gmail accounts before running older code. The export includes `provider` but never tokens.

## Tests

`apps/server/test/gmail.integration.ts` runs against a fake Google (`test/google-fixture.ts`, local Fastify on an ephemeral port) with synthetic labels, messages and history. It covers:

- PKCE/redirect/scope parameters and the single-use, user/session/expiry-bound state.
- Denial, missing scope, account substitution, omitted refresh tokens and the five-account limit.
- Label/flag mapping, the 90-day filter, crash resume from the persisted page, history adds/label changes/deletes, expired-history resync that removes unlisted mail, and `invalid_grant` leading to reconnect required.
- The fake enforces Gmail's 50 `messages.get` per second; sync must stay under it, and unpaced requests fail the test.
- A 1,600-entry label record applies with zero fetches.
- Quota exhaustion pauses without an error state and resumes.
- Display-name edits survive reconnect.
- 409 refusals, worker routing that never dispatches IMAP work for Gmail, revocation after scheduled deletion, and disconnect that revokes only unshared grants.

`apps/web/test/gmail.browser.ts` drives Connect Gmail through a fake consent redirect, then checks the provider logos, renaming (Escape cancels and focus returns), the read-only reader and the Reconnect status. No real Google accounts, tokens or mail are used. Live acceptance needs the U07 setup above.
