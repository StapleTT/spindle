# Per-account email signatures

Choose **Email signature** beneath an account in the mail sidebar. Enter a signature with the shared rich-text editor, or choose **Plain text** for simple text. **Save signature** stores it privately for that account. Each account has its own signature and separate **Use for new messages** and **Use for replies and forwards** defaults. Both defaults initially appear enabled with an empty signature; no text is inserted until a signature is configured.

Rich signatures support the composer's formatting, lists, quotes and HTTP/HTTPS/mailto links. The plain-text preview follows the same text, and outgoing MIME includes the matching text alternative. Choosing Plain text removes formatting. Paste inserts plain text; images, scripts, styles and arbitrary pasted HTML are excluded. Clearing the signature saves an empty value.

## One-time insertion

**Compose** takes the selected account's signature from the local account settings and places it after an initial blank paragraph for your note. New Reply, Reply all and Forward drafts take the receiving account's reply/forward default on the server, placing it above the quoted or separately preserved original. Drafts created without a selected account start without a signature.

The inserted signature becomes ordinary editable draft content. Edit or delete it directly in the message body. Autosave, recovery, copied drafts, reopening, provider Drafts synchronization and SMTP sending reuse that content, without another insertion. Native imported drafts and existing drafts retain their existing bodies. Settings changes apply to future drafts. Switching a draft's account preserves the text already there; edit the signature manually or start a new draft from the other account to use its default.

Each settings save carries a revision. Concurrent stale saves fail visibly and preserve the editor's unsaved settings; **Reload saved signature** explicitly discards those edits after confirmation. New-message creation uses the app's periodically refreshed account settings, with immediate local updates after saving in the same window. Reply/forward creation reads the current settings in its existing owned transaction.

## Ownership and limits

The verified-session, exact-origin and user/account ownership checks apply to both read and write routes. Platform admins cannot access another user's signature. Settings writes use the existing general write budget. The server applies the same small HTML vocabulary and plain-text derivation as the composer. Requests are bounded to 32 KiB, input HTML to 10,000 characters, and canonical HTML and text to 20,000 UTF-8 bytes each. Existing draft and outgoing-MIME limits still apply after insertion; oversized content fails visibly rather than silently truncating a signature or quote.

Signatures belong to mail accounts independently of SMTP credentials. Saving one does not change From, sender display names, passwords, connection checks or existing immutable Outbox snapshots. Disconnecting an account removes its settings through the ownership foreign key while preserving inserted text in local drafts.

## Upgrade and rollback

Apply additive `0017_account_signatures.sql` before deploying the updated API/web. It adds `mail_signatures` with the owner/account foreign key, bounded content, defaults and a revision. It does not backfill signatures or rewrite existing drafts, credentials or frozen MIME. No new dependency, environment setting or worker behavior is needed; workers synchronize/send ordinary draft body content.

For application rollback, retain the table and its rows. Earlier API/web versions ignore the settings and preserve signatures already present in message bodies. Keep existing draft and Outbox recovery rules unchanged.

## Proof

Synthetic unit/integration checks verify owner/admin/origin/verification denial, sanitization, NUL/size refusal, revision conflicts, independent account/default settings, response placement and creation replay, editable snapshots surviving autosave/settings changes, one copy in provider/outgoing rich/plain MIME, and account-removal cleanup. The signature Chromium journey covers rich/plain editing, per-account defaults, edited signatures surviving reopen/offline recovery/provider sync, independent new-message and reply/forward defaults, and account switching without replacement. The shared editor is also exercised by the existing composer, replies, provider-draft and SMTP browser journeys.

The local migration was applied and replayed with existing row counts and protected draft, SMTP/credential, Outbox and upload/chunk data unchanged. No existing account signature was configured and no real-recipient email was sent during implementation.

Final checks: `npm run check` passed with 38 unit tests and both builds; all 140 integration tests and five affected Chromium journeys passed. Local health/readiness and signature/shared-editor modules returned 200.

Scope update (D018): send-as aliases/alternate From identities are excluded. Signatures and sender display names continue to use each account’s checked primary sender.
