# SMTP sending and Outbox

## Set up an account

1. Under the connected mail account, choose **Outgoing SMTP**.
2. Enter the provider's SMTP hostname, port, encryption, login email and password/app password. Common choices are required STARTTLS on 587 or implicit TLS on 465. Plaintext and invalid certificates are refused.
3. Choose **Sent folder handling**. The default expects the provider to save Sent and only checks for its copy. Enable Spindle copies only when the provider does not save outgoing mail itself. Selecting both mechanisms can create duplicates; IMAP has no atomic append-if-absent operation shared with the provider's SMTP service.
4. Choose **Save and check SMTP**. The worker tests TLS and authentication without sending an email. Wait for **SMTP connection checked. Ready to send**.
5. Open a draft, complete its recipients, choose that account and select **Send**, or use [**Send later**](send-later.md) to schedule it. Review **Outbox** for its outcome.

The authenticated SMTP login must be a single email address and is the From address. This slice supports ASCII mailbox addresses with Unicode display names, subjects and bodies. It does not support non-email SMTP login names, arbitrary From addresses, aliases or OAuth SMTP login. The provider still enforces its sender policy when mail is submitted; a successful connection check cannot guarantee future availability or recipient delivery. Spindle's Resend system-email configuration is separate and unchanged.

**Sender display name** controls the name in `Your Name <you@example.com>`. It defaults to the user's Spindle profile name for new SMTP settings and is stored per connected account. Customize it under **Outgoing SMTP**, or leave it blank for email-only sending. The composer previews the complete From identity. IMAP/SMTP do not expose the display name configured in another mail client, so Spindle does not discover that setting automatically. Send-as aliases and alternate From identities are excluded from scope by D018; choose a separately connected account to use its primary sender.

Names support Unicode and punctuation, with a 200-character limit and no control/header-injection characters. Nodemailer builds the structured From header for ordinary mail, replies, forwards and attached messages; SMTP envelope addresses remain the checked login email. Editing a name can retain the existing password when connection fields are unchanged. Saving settings follows the existing version/recheck policy; older clients omitting the name preserve it. Queued MIME is immutable and is not rewritten when a name changes.

Passwords use the existing versioned AES-GCM key ring with a separate SMTP credential context. They are never returned by APIs or included in logs/errors. A blank password retains it only if the connection fields remain unchanged. DNS resolution rejects private/reserved/mixed address sets, pins the public address, and retains TLS hostname/certificate validation. These are the same public-network boundaries as IMAP; local/private SMTP relays are not exposed through this UI.

## Queue, cancel and draft safety

Send waits for autosave and submits a client operation ID with the saved draft revision. In one owned transaction, the API validates recipients/account/settings, constructs bounded MIME, records a stable Message-ID and immutable envelope/body snapshot, and freezes the draft. No provider is contacted by the request. Replayed submission IDs return their original result, even after acceptance removes the draft; a second operation cannot queue the same active draft revision.

Messages wait at least five seconds before dispatch. **Cancel send** remains valid while the row is queued, including while waiting for a safe connection retry. Cancel and worker claim use conditional state changes: whichever commits first wins. Once sending begins, cancellation is refused; there is no recall or compensating send.

Queued/sending drafts cannot be changed or discarded by another tab/API request. Local edits from a stale tab remain in its recovery buffer and can be preserved as a separate draft. Cancellation and definite failure unlock the draft. Full SMTP acceptance removes the original draft in the same transaction that records acceptance; partial/unknown outcomes preserve and freeze it so a blind resend cannot duplicate deliveries. After reviewing an uncertain outcome, an explicit new draft can be created from the preserved text. Review recipients carefully before doing so.

Changing SMTP settings changes their version and invalidates queued snapshots made with the old configuration. A retry requires the unchanged original draft revision and checked settings version. A newer queued intent prevents retrying an older failed one.

## Outcomes and retry policy

| State                   | Meaning and available action                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queued                  | Waiting for dispatch or a safe transient retry; cancel is available.                                                                                                                         |
| Sending                 | Provider I/O has begun; cancellation/recall is unavailable.                                                                                                                                  |
| Accepted by SMTP server | The provider acknowledged submission for every recipient. This is not proof of inbox delivery; bounces and filtering can still happen.                                                       |
| Partially accepted      | Some recipients were accepted, others rejected. The lists are shown privately to the owner. No whole-message retry is offered.                                                               |
| Failed                  | No acceptance was confirmed and the failure is known safe to retry. Review recipients/settings; retry only requeues an unchanged snapshot.                                                   |
| Delivery status unknown | A response was lost after submission may have begun, or a worker died in the send window. Check the provider's Sent folder and recipients. Spindle never automatically retries this outcome. |
| Cancelled               | Cancel committed before dispatch; the draft is editable again.                                                                                                                               |

Connection/TLS/login failures happen before message submission. Transient connection failures and explicit SMTP 4xx rejections retry at 15-second intervals, with three total attempts. Permanent 5xx rejections fail immediately. An unacknowledged DATA/send attempt is unknown, not a retryable failure. A durable `sending` marker survives process death; a subsequent leased worker marks it unknown rather than resending. A database failure after SMTP acceptance also leaves this conservative outcome.

Nodemailer constructs rich multipart/plain alternatives, UTF-8 headers, encodings and MIME boundaries. Bcc recipients are included in the envelope but omitted from transmitted MIME and the Sent copy. Input does not grant file/URL access. [Reply and reply-all drafts](replies.md) include validated In-Reply-To/References; forwards start without these headers. [Per-account signatures](signatures.md) are inserted once when drafts are created and become ordinary editable body text. Provider API sending remains later Phase I work. [Provider Drafts synchronization](provider-drafts.md) checks tracked copies before SMTP and cleans them up after full acceptance, preserving conflicts and uncertain delivery.

HTML forwards append the server-owned original after the editable note, preserving sanitized email styles/tables and embedding supported cached images as CID MIME parts. Remote images remain references to their original URLs and are not fetched while queuing or sending. [Outgoing file attachments](attachments.md) now persist privately with drafts, require a clean security check, and become part of the frozen MIME snapshot. Oversized sends preserve the draft and report an error.

## Sent reconciliation

The worker uses the same owned account lease and two-connection worker budget as IMAP. After closing SMTP, it finds the provider-designated `\Sent` folder; it never guesses a name or creates folders. It searches the stable Message-ID and checks the returned envelope before treating a copy as present.

In provider-managed mode it only searches, including when a copy appears after SMTP acknowledgement. In Spindle-managed mode, an acknowledged accepted/partial message without an existing copy may be appended once. A durable `appending` marker prevents another APPEND after an uncertain response or crash; subsequent jobs only search. Unknown SMTP deliveries are never appended because that could fabricate a Sent copy for mail the provider never accepted. Finding a Sent copy does not change delivery-unknown into accepted.

Copy checks retry every five minutes for up to a day. No designated folder is reported as unavailable; an unconfirmed copy is reported separately from SMTP acceptance. A successful or uncertain copy does not resend the message. Normal metadata sync discovers committed Sent mail afterwards.

## Ownership, limits and retention

Settings, drafts, outbox metadata, recipient outcomes and worker jobs enforce the signed-in verified user's ownership. Admins receive no access to another user's mail. UI lists read Postgres only. Outbox status persists across navigation/reload and is polled independently of the composer. Additional history uses keyset pagination.

Limits are 50 deduplicated recipients/message, 512 KiB encoded MIME without ordinary file attachments or 30 MiB with them, 10 enqueue requests/minute, and 100 submissions or 500 recipient submissions/day/user. Files also have per-file/draft/storage limits described in [attachments](attachments.md). Cancelled submissions count toward enqueue limits. The worker also rechecks 100 messages / 500 recipients per rolling day using actual dispatch attempts, including scheduled mail; a dispatch-limit refusal is reported as a definite failure. Draft limits continue to apply. Settings/cancel/retry use the existing general write budget. These conservative initial limits are stored/enforced across API instances; they are not a bulk-mail service.

Fully accepted rows with settled Sent-copy outcomes and cancelled rows are cleaned up after seven days. Unresolved failures, partial acceptance and unknown deliveries remain available. Disconnect removes SMTP credentials, stops queued sends, clears draft account associations and retains outbox history. Already-started provider operations cannot be recalled and may remain unknown; disconnect cannot undo an external acceptance. User deletion cascades the owned stored content.

## Upgrade, rollback and proof

Apply `0011_smtp_outbox.sql`, then deploy API, web and worker together. It adds SMTP settings/outbox tables, an owner index for drafts and draft/disconnect guards; existing users/mail/drafts/actions are preserved. For rollback, drain/stop the sending worker first, retain tables, and avoid older APIs overwriting queued drafts. Never reset a `sending` row to queued or replay its SMTP send after restoring a database. Reconcile it as unknown with sending disabled during restore.

Sender display names additionally require `0015_sender_display_name.sql`. It adds a bounded SMTP setting and initializes existing accounts from their owner's normalized profile name. It preserves credentials, connection checks/versions, draft text and all frozen outgoing MIME. Apply the migration before deploying the new API/web; retain the column during application rollback. Existing queued messages keep their earlier From header. Synthetic unit, API and browser checks verify Unicode/quoted names, defaults, ownership, header-control denial, credential retention, explicit blank names, legacy saves, composer preview and received SMTP headers, including attached messages.

Integration tests use synthetic TLS SMTP and IMAP servers. They cover encrypted/owned settings, TLS/STARTTLS refusal, recipient/revision validation, draft freezing, concurrent/replayed sends, MIME/Bcc privacy, cancellation, definite failure retry, partial and unknown outcomes, lost SMTP/APPEND acknowledgements, delayed provider copies, killed-worker markers, configuration changes, quotas, deletion and pg-boss dispatch. Chromium covers setup, lost submit responses, reload/cancel, successful acceptance, validation errors, safe retry and unknown delivery. No real recipients are used by automated tests. Real-account sender/recipient-side acceptance remains user-owned I11 work.

Local verification on 2026-10-28: 21 unit tests, 92 integration tests (including outer tests), five Chromium journeys and `npm run check` passed. Migration `0011` was applied and replayed with all existing record counts preserved, including 3,644 messages and four drafts; SMTP settings and outbox started empty.

Live-account update — 2026-10-28: the user confirmed that messages send successfully. This records working SMTP sending for the connected account. Remaining I11 acceptance covers recipient-side reply/threading, provider Drafts visibility, attachments, undo-send and restart recovery as those features are completed/reviewed.

[Send later](send-later.md) adds UTC deadlines, guarded reschedule/cancel-and-edit and startup recovery to the same immutable Outbox. It requires migration 0024 and compatible API/worker deployment.
