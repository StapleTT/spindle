# Reply, reply all and forward

Open a message and choose **Reply**, **Reply all** or **Forward** after its body loads. Spindle creates a private, autosaved draft on the receiving account, including when reading the unified inbox. Edit recipients and text, then send through that account's checked SMTP settings. The existing Outbox delay, cancellation, failure and unknown-delivery rules apply; see [sending](sending.md).

## Recipients and conversation headers

- Reply uses Reply-To when present, otherwise From. Replying to a known own-sent message uses its original To recipients.
- Reply all adds original To and Cc, deduplicates addresses without case sensitivity and excludes known self addresses. Known addresses come from the verified Spindle email, connected account email usernames and SMTP login emails. Unknown aliases and mailing-list policy cannot be inferred; review To/Cc before sending. Arbitrary send-as identities remain unsupported.
- Original Bcc is never copied into recipients or quoted forwarded headers. A user may explicitly add new Bcc recipients; sending keeps them out of transmitted MIME and Sent copies.
- Invalid or unsupported addresses are omitted with a warning. An oversized recipient set is refused rather than silently shortened. Existing limits of 50 recipients and 4,000 characters per recipient field still apply.
- Reply subjects receive Re: once; forwards receive Fwd: once, also recognizing an existing Fw: prefix.
- Replies get a new Message-ID and validated In-Reply-To/References. The direct parent is last; the root and recent ancestors are retained within count, header and persisted-byte limits. Missing/invalid original Message-ID produces an explicit warning that the response may start a new conversation.
- Forward starts with empty recipients and no In-Reply-To/References. Recipient applications ultimately decide how to group conversations.

Thread context belongs to the server-created draft, survives autosave, reload, API restart and deletion of the original message, and cannot be supplied or replaced by a normal draft update. Changing recipients or sending account preserves that context. Conflict recovery through **Save my edits as a new draft** copies context only from an owned draft. If the source draft is gone, recovery preserves text and clearly warns that the copy starts a new conversation.

## Quoting and attachments

Replies use escaped plain-text quotes, with an HTML-to-text fallback. Reply quotes and forwards of plain-only messages are limited to 10,000 Unicode characters including attribution, with a visible shortening warning.

HTML forwards preserve the sanitized original's tables, inline styles, style blocks, responsive CSS, links and supported embedded raster images. An immutable server-owned snapshot is stored separately from your editable note, so the editor and autosave do not strip the original formatting. It includes From, date, subject and visible To/Cc. The isolated **Forwarded original** preview uses the same script-free sandbox and content hostname as the reader; received HTML never enters the app document. Preview images follow the saved per-user blocking/proxy defaults (both on initially), with **Display images** and **Hide images** overriding the default for the current preview. Opening a preview can load images automatically only when the user turned default blocking off; sending itself does not fetch remote images. See [mail preferences](mail-preferences.md). Outgoing HTML references original remote image URLs, and the recipient's email client controls loading them. Cached supported inline images are included as CID MIME parts with new identifiers; unavailable images produce a warning.

The original HTML and embedded image bytes survive autosave, reload, owned recovery copies, source-message deletion and cache expiry. The snapshot is immutable through normal draft updates and is included below the note when Send freezes the MIME into Outbox. Choosing **Plain text** sends the note and complete stored original text without HTML or embedded images; switching back to rich text restores the formatted original. A deleted original draft cannot supply its snapshot to a recovery copy; the copy explicitly warns that the stored formatted original is missing. Existing plain forward drafts are preserved; start a new forward to include formatting.

The snapshot has a 512 KiB JSON limit and the existing 512 KiB encoded outgoing-message limit still applies, including the note and MIME encoding overhead. Oversized HTML forwards are refused rather than silently flattened or truncated. Scripts, forms, external fonts, imports and unsupported resources remain filtered by the reader's safety policy; this preserves supported email formatting, not executable content.

New forwards now include ordinary file attachments through the [outgoing attachment pipeline](attachments.md), subject to visible limits and security checks; each can be removed. Replies still omit original files and warn when they exist. This feature does not synchronize provider Drafts or introduce Gmail/Graph provider thread IDs.

## Cache, retries and ownership

Fresh MIME fetches cache bounded parsed reply metadata alongside the sanitized body. Existing ready body caches remain readable when metadata is absent. Choosing a response queues a header-only IMAP fetch through the existing content worker. This fetch uses the account lease, identity checks, read-only mailbox and existing connection budget. It preserves the body, images, attachment cache, content version, expiry and existing body/image grants. Provider failure leaves the cached body ready and offers a response retry. Fetching never changes Seen.

The reader polls local state while preparing headers, waits up to one minute, and stops navigating when the reader is closed. A late draft creation remains saved without pulling the user back. An operation ID stored per user/message/action in the browser tab recovers an unacknowledged create across reload. Replayed creates return the same draft, and submitted drafts are checked against retained Outbox history to avoid resurrecting a sent response. This is bounded by normal history retention and browser storage availability.

Composition routes require a verified owning user and the existing origin/write protections. Other users, including platform admins, cannot compose from private messages, read drafts or copy thread context. Requests read local data and queue provider work; the API never connects to IMAP.

## Upgrade, rollback and proof

Apply `0012_reply_drafts.sql` before deploying API, web and worker together. It adds nullable reply metadata/context and a header-fetch pending flag without rewriting cached bodies or existing drafts. Replaying the migration is safe. Retain these columns and rows during application rollback. Drain/stop sending before downgrading; older sending code cannot preserve reply headers, so do not submit response drafts through it. Never reset or replay existing sending/unknown Outbox rows.

Formatted forwards additionally require `0013_formatted_forwards.sql`, which adds a nullable bounded snapshot column without changing existing drafts or cached mail. Deploy the API, isolated content server and web together after migration. The existing worker sends the frozen MIME. Retain the column/snapshots for rollback and prevent sending formatted-forward drafts through older APIs, which cannot include their stored originals. No backfill or destructive schema rollback is needed.

Automated proof uses synthetic TLS IMAP and SMTP servers. Unit/API/browser checks cover Reply-To, own-sent mail, case-insensitive self exclusion/deduplication, Bcc privacy, hostile HTML/headers, Unicode quote and context limits, invalid IDs, owner/verification/origin denial, receiving-account selection, stable create retries, immutable thread context, conflict copies, navigation during creation, cache-preserving header refresh/offline retry, and received SMTP In-Reply-To/References for replies versus forwards. Real recipient-client conversation grouping remains user-owned I11 acceptance.

Formatted-forward regressions verify received SMTP HTML/CSS/tables/remote URLs/CID image bytes, plain-only and legacy empty-wrapper caches, explicit size refusal, immutable snapshots and copies, source deletion, expired-session and foreign-owner preview denial, image opt-in, rich/plain toggling, mobile responsive CSS, note editing and save/reopen/reload. All automated recipients and mail content are synthetic.
