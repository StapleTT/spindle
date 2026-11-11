# Outlook and Microsoft 365

Microsoft accounts connect using Microsoft OAuth and use Microsoft Graph v1.0 for mailbox operations. The API handles authorization code exchange and identity discovery; only the worker reads or changes mail. Spindle sign-in remains verified email/password. Shared/delegated mailboxes, send-as aliases, Exchange on-premises and sovereign Microsoft clouds are outside this integration.

Implemented: connect/reconnect/disconnect, resumable folder and message delta polling, local lists/counts/search, isolated MIME reader, attachments/forwarded files, read/unread/archive/trash/move/restore with five-second undo, local composer drafts, signatures, immutable Outbox sending, Undo send and Send later. Native Outlook Drafts synchronization, subscription/webhook push, large attachment uploads and live personal/work-account acceptance remain open. Outlook mail can be read from Drafts, but is not imported as an editable Spindle draft.

## Operator setup

1. Open the [Azure portal](https://portal.azure.com/), search for **App registrations**, and select **New registration**. Register a **Web** application, preferably separately for development and production. Select **Accounts in any organizational directory and personal Microsoft accounts** to cover Outlook.com and Microsoft 365. A work/school account also needs an Exchange Online mailbox.
2. Register the exact redirect URI `<APP_URL>/api/mail/oauth/microsoft/callback`. With the example local origin this is `http://127.0.0.1:5173/api/mail/oauth/microsoft/callback`. Microsoft can require adding a loopback HTTP redirect through the app manifest; the URI must match the actual browser origin. Production uses HTTPS.
3. Add Microsoft Graph **delegated** permissions `User.Read`, `Mail.ReadWrite` and `Mail.Send`. The flow also requests `openid profile email offline_access`. Do not add application-wide or shared-mailbox permissions. Tenant policy can require administrator approval despite the delegated permissions being user-consentable. Complete applicable publisher/consent verification before announcing broad availability.
4. From the app's **Overview**, copy **Application (client) ID**. Then create a client secret under **Certificates & secrets** and copy its **Value**. The **Secret ID** is neither of these configuration values. Put the two values into the local ignored `.env` or the deployment secret store:

   ```dotenv
   MICROSOFT_CLIENT_ID=<Application (client) ID from Overview>
   MICROSOFT_CLIENT_SECRET=<client secret value>
   ```

   Configure the API and worker identically; preserve existing settings and never paste secrets into chat. Setting only one variable fails startup. Both absent keeps Microsoft disabled with “Needs operator setup”. Existing `MAIL_ENCRYPTION_KEYS` configuration is also required. Track secret expiration and replace it before expiry.
5. Stop old APIs/workers, run `npm run db:migrate`, and start the new API/worker/web together. In Settings → Accounts choose Microsoft, select history and continue to Microsoft. Test one personal mailbox and one Microsoft 365 mailbox before advertising both.

The application uses the global `/common/oauth2/v2.0` authorization/token endpoints, Graph OIDC userinfo and `/v1.0/me`. Requests are server-side; no client secret or token reaches the browser.

If Microsoft shows `unauthorized_client: The client does not exist or is not enabled for consumers` after account selection, first verify that `MICROSOFT_CLIENT_ID` is the **Application (client) ID** from **Overview**, rather than a Secret ID, Object ID or Directory ID. Restart API and worker processes after changing `.env`, then start a fresh connection from Settings. If the correct client ID still fails for a personal account, check that the app's supported account types include personal Microsoft accounts (`signInAudience: AzureADandPersonalMicrosoftAccount`).

## Identity, tokens and lifecycle

`POST /api/mail/oauth/microsoft` uses the existing verified-owner/exact-Origin guards, rate limit and five-account limit. State is a hashed random value, single-use, bound to the user, current sign-in session and reconnect target, expires after ten minutes and includes a PKCE S256 verifier. Shared OAuth states carry a provider discriminator; Google and Microsoft callbacks cannot consume each other's state.

The callback requires all three delegated Graph scopes, gets the stable app-scoped `sub` from Microsoft's userinfo endpoint and the mailbox address/display name from `/me`. It uses `mail`, falling back to `userPrincipalName`, as the sending/self identity; this does not verify or change the Spindle login email. Reconnect into a different provider subject is refused. The account is keyed by `(user_id, provider='microsoft', provider_account=sub)` and retains its custom name/history on reconnect. The callback rechecks the user and locks the live session after network requests, before committing.

Refresh tokens are AES-GCM encrypted with the existing key ring and owner/account AAD. Worker refreshes persist any rotated token under the fenced account lease before mailbox requests. Access tokens live only within the job. Provider errors expose only generic result codes; no provider text, tokens or mail content enter logs or redirect URLs.

Password-confirmed disconnect deletes the local account, its encrypted token, checkpoints and mirror by cascade, leaving provider mail untouched. Scheduled/admin user deletion uses the same cascades. Microsoft has no equivalent of Google's per-token revocation endpoint: Spindle does not revoke unrelated Microsoft sessions or request broad directory permissions. Users can remove Spindle's consent in Microsoft account/application settings when desired. There are no subscriptions to clean up in this polling version. Export includes provider metadata and the sender display name, never credentials, tokens or delta links.

## Sync and identity

The existing dispatcher/metadata queue owns Graph polling. Jobs hold the ordinary 90-second fenced account lease, use a 40-second soft/75-second hard budget, pace requests at one per 100 ms and yield between pages to reader work. Graph uses `Prefer: IdType="ImmutableId"`, including delta requests and move responses. IDs remain case-sensitive and are URL-encoded when used as path segments. Folder roles come from well-known folder IDs, never localized names.

`mail_graph_sync` stores a checkpoint for the folder hierarchy (empty scope) and each folder's message collection (scope is its Graph ID). Every page commits metadata and its next/delta link atomically. Initial/resync listings use `mail_graph_listed` to remove stale memberships only after completion; old local data remains visible during recovery. Removed folder checkpoints are deleted with their listing rows. All tables cascade from the owning account.

Graph reports moves as a source-folder removal and destination-folder addition. Sync fetches each changed message by its immutable ID to find its current folder; only a definite 404 removes the global message. Moves preserve its local ID, cache and conversation state. Orphaned messages after a removed-folder/full-list reconciliation are checked in bounded, individually committed steps.

Delta links are opaque and retained exactly. Links must stay on the configured Graph origin under the owned `/me/mailFolders` path; redirects and cross-origin continuation links are refused. Pages request at most 50 entries; response bytes and structures are bounded. HTTP 410/expired delta resets only that scope and resumes a full listing. Rate limits honor Retry-After without spending action attempts. Revoked consent sets “Reconnect”; other errors retain local mail and back off.

The 90-day boundary is fixed at connection time and enforced locally. Delta is intentionally unfiltered to avoid Graph's limit on date-filtered message delta; a large old mailbox can therefore take longer to traverse even when only recent mail is mirrored. Polling reconciles ready accounts every 60 seconds; Sync now uses the existing durable request. Browser updates use the existing local SSE triggers, with polling recovery. Rendering never calls Microsoft.

## Reader, actions and sending

Graph `$value` supplies bounded raw MIME to the same parser, sanitizer, content origin, image preferences, attachment rules and cache used by other providers. Reading does not change flags. Raw messages are limited to 10 MiB; downloads/forwarded files reread that bounded MIME using the attachment's parsed position. Body prefetch reuses the same source and existing cache/priority rules.

Read/unread maps to `PATCH isRead`; folder actions map to Graph `move`. The worker checks the current immutable location before moving, persists a move marker before I/O and checks the returned identity/current state. An interrupted move is reconciled or reported as unconfirmed; it is never blindly repeated. Provider flags and local pin/mute/snooze remain independent. Undo cancels before dispatch, as for IMAP/Gmail.

Sending preserves the immutable MIME snapshot (including Bcc), scanned attachments, recipient/daily limits and schedule deadline. `POST /me/sendMail` receives base64 MIME exactly once per claim, with the default provider-managed Sent copy. HTTP 202 means accepted for processing, not delivered. Explicit 4xx refusals fail safely; 429 defers; lost responses/5xx are unknown and never automatically resent. Unknown sends are searched in Sent by the exact escaped `internetMessageId`; finding a copy does not change unknown delivery into a delivery guarantee.

Encoded MIME is limited to **3,000,000 bytes before transport base64** so the request fits Graph's 4 MB limit. The send route rejects oversized snapshots and preserves the draft/files; the transport rechecks the limit. Larger messages need a separate draft/upload-session implementation. Local drafts are not written to Outlook Drafts.

## Rollout and proof

Migration `0039_microsoft_graph.sql` extends provider checks and adds only the Microsoft identity index, nullable sender name, OAuth provider discriminator and cascading Graph checkpoint/listing tables. Keep applied migrations on rollback. Earlier workers can fall through to IMAP for unfamiliar providers, so **never run old API/worker code while Microsoft rows exist**. Drain sends and prefer a forward repair; database restore cannot undo provider effects and restored sending/unknown rows must never resend automatically.

Proof on 2026-11-10: `npm run check` passed 49 unit tests and both builds; the full integration suite passed 303 checks; the final focused Microsoft suite passed 18 checks, including the send Retry-After regression; Microsoft/Gmail/Settings Chromium runs passed 16 checks. Migration 0039 was applied/replayed locally with original-column hashes and row counts preserved across all 35 existing public tables. Synthetic integration/browser fixtures cover the implemented workflows without real credentials or recipient delivery. Live acceptance still needs operator-configured Microsoft applications and separate personal/Microsoft 365 test mailboxes, including tenant-admin consent restrictions. K01/K02 remain open for push, native Drafts and live parity.

References: [Azure portal](https://portal.azure.com/), [Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference), [immutable IDs](https://learn.microsoft.com/en-us/graph/outlook-immutable-id), [message delta](https://learn.microsoft.com/en-us/graph/delta-query-messages), [sendMail](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0).
