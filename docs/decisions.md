# Spindle 2.0 decisions

Record confirmed decisions separately from proposals in [the rewrite plan](../REBUILD_TASKS.md). Unresolved choices remain open until answered or otherwise supported by project requirements.

## D001 — release audience

Status: confirmed by the user on 2026-10-27.

The initial release serves an invited group. The full release will be public.

Consequences:

- Registration requires an invitation during the beta.
- Public registration is part of the full hosted release.
- Changing registration availability must not change existing users' identities, connected accounts or ownership boundaries.
- Invitations control who can register; authorization still protects each user's data on every request and background job.
- Include invite-only and public registration paths in the implementation and release checks. Public signup remains disabled during the beta.

Expected group size, mailbox/storage volume, hosting budget and deployment region remain unresolved parts of U01. Public release does not by itself establish pricing or billing requirements.

## D002 — private ownership per user

Status: confirmed by the user on 2026-10-27.

Each user has their own private inboxes. Shared inboxes, team accounts and organizations are outside the project scope.

Consequences:

- Connected mail accounts and all associated mail, drafts, contacts, preferences and background work belong to one user.
- Use the user as the ownership boundary; do not add organization, seat, membership or separate workspace models.
- Every API, job, search result, realtime event and stored-content access must enforce that user's ownership.
- Platform administration remains separate from mailbox ownership; an admin role does not implicitly grant access to another user's mail content.
- References to tenants in the rewrite plan mean individual users, not organizations.

## D003 — verified email and password; additional factors later

Status: confirmed by the user on 2026-10-27.

Require a verified email address and password for Spindle login. Passkeys and two-factor authentication are optional future work, not initial or full 2.0 release requirements.

Consequences:

- Use email as the login identifier; do not require a legacy-style username for authentication.
- Require email verification before granting access to connected mail or mail operations. Verification/resend flows use expiring links and rate limits; recovery links are single-use. The library's signed verification links are idempotent and do not create sessions.
- Keep secure password hashing, non-enumerating email-based password recovery, session revocation and recent password reauthentication for sensitive operations in the release scope.
- Keep Google/Microsoft mailbox connection OAuth separate from Spindle login.
- Do not require TOTP, WebAuthn, passkey enrollment or MFA screens to complete the beta or public 2.0 release.
- Preserve stable user identities and keep authentication code separate from mailbox ownership so additional credentials/factors can be added later. Do not build unused credential tables or authentication frameworks solely for that possibility.

This confirmed scope supersedes the rebuild brief's suggested mandatory production MFA and the earlier plan's proposed MFA release gate.

## D004 — fresh start

Status: confirmed by the user on 2026-10-27.

Start Spindle 2.0 fresh. The legacy database no longer exists.

Consequences:

- Initialize a new database with versioned migrations; create new users, invites, settings and mail connections through 2.0 flows.
- Users verify their email and connect/authorize their mail accounts anew. Existing mail is synchronized from those providers within the chosen sync horizon.
- Do not build a legacy database importer, username/password migration, credential transfer or legacy-instance cutover.
- Keep legacy source as a behavioral and feature reference, outside the new runtime.
- Retain backup/restore, safe deployment rollback and database migrations for 2.0's own data and future upgrades. A fresh start does not remove those requirements.

This closes U04 and supersedes the original legacy migration phase in the task plan.

## Next work and remaining prerequisites

The initial audience, ownership, login and fresh-start decisions are settled. The local foundation, authentication, polling IMAP sync, cached reader/attachments, triage feedback and local composer/drafts are implemented. SMTP outbox/sending, [reply/reply-all/forward](replies.md) and [outgoing file attachments](attachments.md) are also implemented. The live ClamAV service is verified. IMAP Drafts synchronization is implemented and user-confirmed; per-account signatures are implemented and reviewed. Local search/keyboard triage and the account-scoped conversation reader are implemented; committed local updates now use authenticated SSE with reset/refetch and polling recovery (D022). Remaining live workflow/file/restart acceptance and other providers remain pending. Send-as aliases are excluded by D018; the checked primary sender remains authoritative.

| Plan item   | Remaining prerequisite                                                  | Owner                               | Needed by                                                               |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| A02–A08     | Finish local foundation verification and remaining environment/CI setup | Agent                               | Before M1; see the task plan's progress note                            |
| U01/U05/U06 | Deployment sizing/budget/region, domains and hosting services           | User, with agent recommendations    | Before staging provisioning or purchases; local development can proceed |
| U07–U10     | Provider applications/test mailboxes and system email relay             | User, with agent setup instructions | Before corresponding live OAuth/sync/verification tests                 |
| U11/U13/U14 | Data/limits policy, workflow defaults and operational targets           | User, with agent recommendations    | Before dependent storage/workflow/release acceptance work               |
| U12         | Claude Design export and assets                                         | User                                | Before final visual integration; backend/local setup can proceed        |
| U15         | Legal and provider-verification ownership                               | User, with agent setup instructions | Before external verification/public release                             |

## D005 — initial technical foundation

Status: selected by the agent on 2026-10-27 to implement the agreed scope; a technical choice, not a user-confirmed product decision.

- Node 24 LTS target, strict TypeScript and npm workspaces with a committed lockfile.
- React 19/Vite web app and Fastify 5 API; two workspaces, with API and worker entry points sharing the server package.
- Postgres 17 for local development and pg-boss for the separate durable queue worker. One database avoids adding Redis for the initial service.
- Biome for lint/format checks; Node's test runner through tsx for server tests.
- Local health/readiness endpoints, bounded database requests, security headers and structured logs with credential/header redaction.

Dependencies are added with their owning features. Authentication now adds Better Auth, its transaction-context package, Drizzle ORM and Nodemailer, with versioned SQL migrations. Mail adapters, storage, query caching and final design components remain future work. The API's compiled entry point currently serves API routes only; production frontend hosting is still pending.

Claude Design will supply the design system later; its export format and framework requirements are not yet known. Native temporary styling avoided committing to a competing design system until the export arrived (see D027).

## D006 — authentication implementation

Status: agent implementation choices on 2026-10-27, following D001–D004.

Use Better Auth's email/password, verification, recovery and Postgres session flows through its transactional Drizzle adapter. Email-bound, seven-day invitations and roles belong to Spindle; their lookup shares the signup transaction through the library's current adapter. An operator command explicitly designates the initial admin and sends invitations. Generic signup responses avoid exposing invitation membership or account existence.

Use the library's one-hour signed verification links with idempotent verification and no automatic login. Recovery identifiers are hashed, expire after one hour and are atomically single-use. A database credential-change trigger revokes all sessions and remaining recovery links atomically. Production cookies use exact `__Host-` names and secure attributes; an explicit loopback-only HTTP exception supports development. SMTP requires TLS except for the local development relay. See the authentication document for limits and exposed routes.

Use Drizzle's installed SQL migrator rather than its generator: this keeps initial migrations versioned without adding the generator's transitive dependency advisories. Mailpit supplies local email capture; Playwright verifies the browser flows. No organization model, passkey/2FA scaffolding, production email provider or admin web panel is introduced.

## D007 — Resend for system email

Status: provider selected by the user on 2026-10-27; SMTP authentication, domain verification and external receipt confirmed.

Send invitations, verification and recovery email directly through Resend SMTP from `noreply@spindle.staplett.xyz`, using the existing transport. Mailpit remains available for local capture; no relay hop or SDK is added. The existing ignored `.env` already contains Resend settings and a sending-only key. Preserve that restricted scope; domain-management access is unnecessary for routine sending.

SMTP authentication and published DKIM/SPF records are confirmed. The user confirmed domain verification, explicitly designated a test recipient, and confirmed receipt of the one authorized test in Proton Mail after Resend accepted it. DMARC was not found for the sender subdomain during the DNS check; its policy remains unconfirmed. Keep the working app origin until a public HTTPS deployment exists. See [the Resend checklist](resend.md) for proof, setup and rollback.

## D008 — first read-only IMAP slice

Status: agent implementation choices on 2026-10-27 within the user's requested IMAP, unified-inbox, storage and background-sync work.

Use ImapFlow with certificate-validated implicit TLS or required STARTTLS. Validate all DNS addresses with ipaddr.js and pin a public address while preserving TLS hostname checks. Store owned accounts, encrypted credentials, mailbox identity, normalized messages/memberships and durable checkpoints in an additive Postgres migration. Use the existing pg-boss worker with persisted sync requests, bounded polling/backfill and fenced account leases. Lists/counts use local data exclusively.

Let the user choose a fixed last-90-day boundary or all available history at connection time; reconnect preserves it. Keep bodies, attachments, IMAP mutations and OAuth separate. Up to five accounts per user and two concurrent connections per worker are initial implementation limits. ImapKit is a development-only protocol fixture. A separate versioned AES-GCM operator key ring protects IMAP credentials; hosted KMS and deployment egress remain future release gates. See [IMAP behavior and operational limits](imap.md).

## D010 — durable mail actions

Status: agent implementation choices for the user's requested triage sequence (read/unread first; archive, trash, restore, move, undo and feedback follow).

Record each action as a Postgres row with a client operation ID, applying its local effect in the same transaction. Only the worker changes provider mail, holding the fenced account lease and the existing two-connection worker budget. IMAP read state changes only `\Seen` with `STORE +/-FLAGS`. Pending intent survives metadata passes; after the provider confirms, provider state is authoritative. Five transient failures fail the action; changed or missing provider identity becomes a retained conflict. Both clear the optimistic effect and request a rescan. The persistent status view exposes all outcomes, owner-scoped retry and dismissal; stale retries cannot supersede newer choices. Unconfirmed moves become conflicts and are not automatically resent, including after a worker crash. Archive and trash move only to SPECIAL-USE `\Archive`/`\Trash` folders, show the destination through a pending membership folder, keep the local message through COPYUID and refuse servers without MOVE or UIDPLUS rather than risk a broad EXPUNGE. Move targets any folder of the same account. Each move records its source; restore returns to the source of the latest move into the current folder, or to INBOX for mail found in `\Archive`/`\Trash` without a recorded origin. Every action has a durable five-second undo deadline shared with its first dispatch time; undo cancels before dispatch and is refused afterwards, with no automatic compensation. Opening a message still does not mark it read. Real-account acceptance (E08/H07) remains user-owned. See [mail actions](actions.md).

## D009 — cached, isolated IMAP reader

Status: agent implementation choices for the user's requested navigation, caching, sanitization and image controls.

Keep bounded parsed bodies and supported image blobs in Postgres with seven-day expiry, owner-scoped LRU eviction and a 128 MiB / 1,000-message cache limit. Reuse pg-boss and account fencing for lazy MIME fetches. List and reader navigation share the same owned membership filter and preserve list/history state. Fetching leaves provider read flags unchanged.

Use Mailparser and sanitize-html, with explicit input/output/structure limits. Serve formatted HTML from a separate hostname through a script-free opaque sandbox and strict CSP. Session/message/version-scoped short-lived grants authorize body/image access without app cookies. Images start blocked and are enabled per message; supported raster images use a bounded SSRF-protected proxy/cache. Attachments are fetched per MIME part on demand and downloaded only from the content origin with an attachment-scoped grant. Keep hosted content-host/TLS setup, object-storage/KMS, attachment scanning, mutations and threads at their owning release gates. See [reader behavior and setup](reader.md). The user confirmed IMAP connection works; that does not by itself establish full live sync or reader acceptance.

Newsletter rendering correction: preserve parsed/filtered inline CSS, style blocks, responsive rules and table/image layout attributes. CSS image URLs share the per-message opt-in proxy; imports and external fonts remain blocked. A cache sanitizer revision causes previously stripped HTML to be refetched on opening. This corrects rendering without changing private ownership, image consent or iframe isolation.

## D011 — composer and local draft persistence

Status: agent implementation choices on 2026-10-28 for the requested composer + autosaved-drafts slice.

Use Tiptap for a small rich-text schema with a plain-text alternative, safe text-only paste and HTTP/HTTPS/mailto links. Persist owned local drafts in Postgres with revision checks and idempotent save tokens. Serialize autosaves, preserve text through account removal, and use user/draft-scoped tab recovery for interrupted writes. A stale tab cannot overwrite newer text; conflicts preserve local edits and offer an explicit copy or reload. Drafts have no provider effects or Send control. Provider Drafts synchronization, SMTP sending, recipient/identity verification, reply rules and attachments remain their owning Phase I work. See [composer behavior](compose.md).

## D012 — SMTP sending and immutable outbox

Status: agent implementation choices on 2026-10-28 for the user's requested SMTP sending.

Use the installed Nodemailer MIME/SMTP primitives with TLS, public DNS pinning, separately encrypted per-account credentials and a worker-only connection check. From is restricted to the authenticated SMTP login email; aliases/non-email logins/OAuth remain later scope. Freeze a saved owned draft into an immutable outbox snapshot with a stable Message-ID, five-second minimum dispatch delay and cancel-before-claim. Record full/partial acceptance, known failure or unknown delivery truthfully. Retry only definite safe failures; a durable sending marker makes crash redelivery unknown. Sent handling defaults to checking provider-managed copies; explicit Spindle copies use a one-APPEND marker and Message-ID reconciliation. Mail accepted by SMTP is not guaranteed delivered to the recipient. See [SMTP sending](sending.md) for limits, retention, recovery and acceptance.

User confirmation on 2026-10-28: messages send successfully from the connected account. Record this as live SMTP sending acceptance; the remaining M3/I11 workflows are still pending.

## D013 — IMAP response drafts and SMTP threading

Status: agent implementation choices on 2026-10-28 for the requested reply, reply all and forward work.

Create response drafts from owned cached content on the receiving account, using the existing composer, autosave and immutable SMTP Outbox. Honor Reply-To, exclude known self identities and deduplicate visible recipients; never propagate original Bcc. Preserve validated bounded In-Reply-To/References as immutable server-owned draft context. Forward starts with blank recipients and no reply headers. Quote escaped text, with an HTML-to-text fallback and visible truncation/attachment warnings. Original attachments are not included.

Fetch missing headers from older ready caches only after a response is requested, through the existing fenced worker and connection budget; preserve cached bodies, images, content versions/grants and read state even when the provider is offline. Stable operation IDs recover unacknowledged draft creation; conflict copies retain only owned context and explicitly warn when the original is gone. Unknown aliases require recipient review. Provider Drafts synchronization, outgoing attachments and real-client threading acceptance remain open. See [reply behavior and upgrade](replies.md).

Forwarding correction requested by the user on 2026-10-28: preserve the original HTML and styling instead of flattening HTML forwards into text. Store a bounded immutable sanitized original and supported inline image bytes separately from the editable note; preview it on the isolated content host with image opt-in, and append it to outgoing HTML. Preserve it through autosave/recovery and source deletion. Plain-text selection converts the outgoing forward explicitly; oversized originals fail visibly without silent shortening. Existing drafts are preserved. General file attachments and executable/unsafe email content remain excluded. This supersedes D013's initial plain-quote choice for HTML forwarding.

The user subsequently confirmed that the new forward flow works.

## D014 — outgoing file attachments and quarantine

Status: agent implementation choices for the user's requested outgoing attachments.

Store private file bytes and attachment-bearing immutable MIME snapshots in bounded Postgres chunks. Include attachment IDs in draft autosave, revision checks and tab recovery; share owned immutable file references across explicit copies. New forwards queue original file retrieval through the existing fenced IMAP worker and allow removal. Require a clean private ClamAV result for ordinary file attachments, with visible failure/retry and blocked states; scanner outages never permit sending. Add the loopback scanner service to local Compose without changing existing secrets.

Initial limits are ten files, 10 MiB/file, 20 MiB/draft, 30 MiB encoded attached MIME and 256 MiB outgoing storage/user. Preserve earlier raw Outbox rows and all ambiguous-send guards. Uploads, persistence, scanner and SMTP reads are streamed; optional ImapFlow Sent APPEND remains a single bounded 30 MiB buffer because the installed library requires bytes. Cleanup reclaims partial streams and unreferenced files while preserving linked drafts and uncertain deliveries. These limits/policies and upgrade requirements are detailed in [attachments](attachments.md). General provider Drafts sync, full M3 and release security/operational acceptance remain open.

Scanner startup acceptance: the user started the Docker service, and live checks verified harmless data as clean and EICAR as infected. The complete upload/storage/background-job path also passed in a disposable database against the real scanner, including removal of detected bytes. No existing uploads needed retry. Recipient-side file delivery remains user-owned acceptance; no real email was sent during this check.

## D015 — per-account sender display names

Status: agent implementation choices for the user's reported missing sender name, before provider Drafts work.

Store a bounded display name with each owned SMTP configuration and use Nodemailer's structured From field for both regular and attachment-bearing MIME. Default existing and new settings to the owner's normalized Spindle profile name; allow an explicit blank for email-only sending. The checked SMTP login remains the actual sender address. Expose the name in Outgoing SMTP and the composer preview; do not infer it from received mail or silently select an alternate sender address. Unicode names and punctuation are supported, controls are rejected, older clients preserve omitted names and blank-password edits preserve credentials under the existing connection rules. Existing immutable Outbox snapshots remain unchanged. See [sending](sending.md). Signatures were subsequently implemented under D017; alternate From identities were excluded by D018.

## D016 — IMAP provider Drafts synchronization

Status: agent implementation choices for the user's requested drafts synchronization.

Extend local revisions and pg-boss with owned durable links/copy intents/import intents. The worker mirrors selected-account drafts to designated SPECIAL-USE Drafts folders and imports native drafts from synchronized metadata within the chosen history horizon. Clean revisions adopt outside edits; concurrent changes and remote removals become visible conflicts. Unknown APPENDs reconcile by operation/Message-ID without a second blind write. Replacement/cleanup require UIDPLUS and content rechecks. SMTP preflight refuses known outside changes; full acceptance, discard and account changes schedule tracked-copy cleanup, while uncertain delivery preserves drafts.

Reuse MIME, isolated formatted-body preview/image consent, attachment quarantine, account fencing and connection limits. Complex imported HTML is preserved below an editable note; unsupported/oversized native drafts fail visibly. No new dependencies, provider adapters or environment settings. `0016_provider_drafts.sql` is additive and backfills existing selected-account drafts. See [provider drafts](provider-drafts.md) for recovery, upgrade/rollback, limitations and proof. Live I11 and M3 acceptance remain pending.

Draft-navigation correction: designated provider Drafts folders open the account’s editable local-draft workspace, rather than the received-mail reader. Received lists/counts/navigation exclude active drafts, including draft-flagged virtual copies. Deleted/sent copies remain readable. A removed provider copy pauses synchronization until the user explicitly chooses **Save to provider Drafts again**; retain the previous copy and local text. A recipient-free live save/cleanup check confirmed the provider APPEND path without SMTP.

User confirmation on 2026-10-28: drafts synchronization now works as intended after the navigation correction. This records live acceptance of the corrected drafts workflow; it does not close the remaining signatures/identities, other-provider or complete M3/I11 checks.

## D017 — per-account email signatures

Status: agent implementation choices for the user's requested rich/plain per-account signatures and separate new-message versus reply/forward defaults.

Use the existing rich editor and server draft sanitizer, with a matching plain-text alternative. Store one private signature/default pair per connected account with revision checks; signatures are independent of SMTP settings and never alter the checked sender identity. Insert a body snapshot once when a new message or response is created, above quoted/forwarded content. Autosave, recovery, copied/native drafts, reopening, provider sync and sending preserve ordinary message content. Settings/account changes preserve text already in a draft; future drafts use the selected/receiving account's defaults.

`0017_account_signatures.sql` is additive; no dependency, environment setting or worker feature is added. Rich/plain editing shares one lazy-loaded editor component. The migration preserves existing drafts, credentials and immutable MIME; rollback retains settings rows. See [signatures](signatures.md) for limits, defaults, upgrade and proof. Remaining M3/I11/provider acceptance stays separate. Alternate From identities are excluded by D018.

User review on 2026-10-28: the signature feature looks good. Record this as UI/workflow review; real-recipient signature acceptance and the remaining M3/I11 checks stay separate.

## D018 — send-as aliases excluded

Status: confirmed by the user on 2026-10-28.

Verified send-as aliases and alternate From identities are not required for this project. Do not build alias registration/verification, alternate-address selection or provider send-as management as a release prerequisite. Use the connected account's checked primary sender, with its display name and signature. Selecting among separately connected accounts remains supported.

This removes the alias portion of I02 and supersedes earlier next-step recommendations and identity proposals in the brief/task plan. I02's scoped IMAP/SMTP sender/signature work is complete; Gmail/Graph parity and the remaining live M3/I11 checks stay at their owning tasks. Existing self-address exclusion/deduplication in replies remains a correctness requirement, distinct from adding send-as identities.

## D019 — local search and keyboard triage

Status: agent implementation choices for the user's requested search and keyboard triage.

Use generated Postgres full-text vectors/GIN indexes over owned synchronized headers and current cached bodies, with 100,000-character index prefixes and visible cache/sync coverage. Lists and reader neighbors share filters and stable date/UUID ordering. Searches remain local; body/attachment matching never implies uncached mail has been searched. Persist up to 50 private named query/scopes; account/folder removal deletes the saved scope. Split reader is a user-scoped browser preference.

Use a native command dialog and shortcuts that invoke existing enabled controls, ignore editing/IME/handled events and preserve row/reader focus. Explicit selected-page batches queue up to 50 existing durable per-message action intents, report refusals individually and retain stable operation IDs for unconfirmed-response recovery. Provider completion/conflicts and individual five-second undo remain in the existing status/worker pipeline. No new provider connection or queue mechanism is introduced. Remote fallback, automatic saved-view heuristics, measured large-mailbox virtualization and manual performance/accessibility acceptance remain separate work. See [search and keyboard triage](search.md).

## D020 — account-scoped IMAP conversation reader

Status: agent implementation choices for the user's requested conversation threading.

Use exact validated Message-ID/In-Reply-To/References links within one owned connected account, without subject fallback. Persist bounded References independently of body caches through normal metadata sync and existing MIME/header fetches. Derive current connected components from an indexed local token graph; handle cycles and late/missing ancestors without a persistent merge registry. Cap expansion at 1,000 physical message copies and pages at 50. Preserve physical message identity, immutable Outbox outcomes and active Drafts separation.

The reader provides chronological cross-folder context, including synchronized Sent replies. Opening another member reuses safe per-message rendering, image consent, attachments, reply identity and actions. Inbox/search rows and batch scope stay per message. An owned source anchors the original search/folder and result navigation; context never grants cross-account or cross-user access. Inbox IDLE notifications are implemented under D021; authenticated SSE invalidates local browser views under D022, with polling recovery. See [conversation behavior and upgrade](conversations.md).

## D021 — bounded inbox IDLE refresh

Status: agent implementation choices for the user's requested IMAP IDLE refresh on 2026-10-29.

Run short read-only inbox watches in the existing metadata queue/connection slot, after current backfill/sync and ahead of the next normal poll. Notifications commit an owned, fenced rescan request and use the existing authoritative sync path; they never directly change message flags or identity. Preserve two provider connections per worker and rotate accounts with durable scheduling/backoff. Yield for account/user/lease changes, requested content/actions/sending/drafts, due metadata work and shutdown. Keep normal polling for unsupported IDLE, missed notifications and bounded reconciliation; failures use separate retries without disabling working mail. Reconnect resets watch backoff.

The additive `0020_imap_idle.sql` preserves mail, credentials, drafts and immutable Outbox data. The API remains local-only. D022 adds authenticated SSE with polling recovery; non-INBOX notifications and remaining CONDSTORE/QRESYNC/large-mailbox acceptance stay separate. See [IDLE behavior and upgrade](imap.md#inbox-idle-refresh--2026-10-29).


## D022 — authenticated local SSE invalidation

Status: agent implementation choices for the user's requested SSE on 2026-10-29.

Use native EventSource and committed Postgres NOTIFY triggers to invalidate owned local views across API instances. Send topic names only. Authenticate through Better Auth, recheck the owned session/expiry/verified user before events and while idle, deny cross-origin and query-selected streams, and bound connections/backpressure/lifetime. Platform admins gain no mailbox access.

Reconnect starts a new ordered transport with reset/refetch; durable database state and retained polling recover missed notifications rather than replaying an event log. Coalesce UI invalidations and reuse existing revision/dirty-state guards, preserving search/focus, draft recovery, iframe identity and image consent. Provider I/O, worker queues and connection budgets remain unchanged. Compose waits for initial account lookup to preserve sender/signature defaults.

The additive `0021_mail_events.sql` preserves existing mail and immutable Outbox data. Each API process reserves a session-persistent Postgres LISTEN connection; deployment needs unbuffered same-origin proxy streaming. Keep this migration on application rollback. See [protocol, recovery, deployment and proof](events.md). Production proxy/load and remaining live-provider acceptance remain open.


## D023 — local conversation pin, mute and snooze

Status: agent implementation choices for the user's requested pin/mute/snooze on 2026-10-29.

Apply private settings to the bounded header-linked conversation within one account, preserving per-message provider actions and physical identity. Pin orders its messages first. Mute records notification suppression without marking read or hiding mail; notification delivery remains K06. Snooze hides inbox membership/counts until an absolute UTC deadline, including new replies; explicit Snoozed/search views retain access. Wakeup does not undo provider moves/deletes or put archived mail into the inbox.

Store local settings and independent field versions on synchronized messages. Existing fenced metadata/header writes propagate the latest explicit choices, including false/null, into new copies and merged components. Splits retain snapshots on existing members; removed conversations do not leave permanent rules. Guard changes by the last-read version. Keep the 1,000-copy bound, ownership, verified sessions, provider connection budget, draft recovery and immutable Outbox guarantees.

Reuse the existing dispatcher for durable due scans and SSE for committed invalidation. Recheck ownership and due timestamps under user/account locks; database-clock list filtering also recovers overdue visibility when a worker is stopped. The UI previews local timezone/offset and UTC, rejects nonexistent DST times and stores one absolute instant. Keep additive migrations 0022/0023 on rollback. See [behavior, limits, upgrade and proof](conversation-state.md). Scheduled sending, notifications and remaining live/load/manual acceptance stay separate.


## D024 — scheduled SMTP sending

Status: agent implementation choices for the user's requested Send later on 2026-10-29.

Extend the immutable Outbox with a UTC scheduled lower bound and guarded schedule revision. Reuse existing enqueue, MIME/attachment freezing, provider Drafts preflight, dispatcher, account fencing, cancellation, retry and uncertain-delivery protections. Future schedules must not starve metadata/IDLE work. Recheck current ownership/settings/draft/file readiness and rolling dispatch limits before claim; no automatic resend after ambiguous acceptance.

The composer previews local timezone/offset and UTC, rejects nonexistent DST times, and flushes autosave before scheduling. Outbox reschedules only an unstarted intent. Cancel and edit releases the preserved draft and requires an explicit new enqueue; it carries the previous time into the composer. Recover unconfirmed enqueues using the original operation/revision/time across reloads. Reschedule changes dispatch metadata, preserving the original frozen MIME headers and bytes.

A database guard preserves the not-before bound for older queue writers. Deploy migration 0024, compatible API/worker, then web; retain data/guards on rollback and drain workers first. Closed browsers do not block delivery; overdue schedules resume when the worker returns, subject to live access and send checks. Native provider API parity and live/production/manual/load acceptance remain separate. See [Send later behavior, limits, upgrade and proof](send-later.md).

User confirmation on 2026-10-29: Send later works. This records user workflow acceptance; remaining production/restart/provider/manual K10 checks remain separate.


## D025 — private recipient autocomplete

Status: agent implementation choices for the user's requested contact autocomplete on 2026-10-29.

Derive suggestions from owned synchronized From/To/Cc participants, excluding active Drafts, deleted memberships, Trash/Junk and all Bcc/body/Outbox sources. Reuse local Postgres data and a generated participant-only full-text index, without adding a contact registry, provider lookup or new worker job. Prefix matches prefer the sending account within match quality, then frequency/recency; bound suggestions to eight contacts from 2,000 matching messages with visible coverage. Preserve distinct plus/dotted addresses and exclude known connected self identities. Send-as alias management remains excluded by D018.

Use one accessible recipient combobox for To/Cc/Bcc. Replace only the cursor's recipient, quote display names safely, filter already-entered addresses, preserve arbitrary manual entry and existing autosave/recovery, and reject overflowing insertion. Guard stale/aborted requests and IME; use the existing mail/account invalidations and a separate owner lookup budget. Deletion follows eligible source mail/account/user deletion; a paginated private JSON endpoint exports the same derived set. Full user export UI and manual address-book features remain separate.

Migration 0026 is additive and retained on rollback; no dependencies/environment/provider budget change. See [recipient behavior, privacy, bounds, export and proof](contacts.md). Final Claude Design and manual/large-mailbox/provider release acceptance stay open.


## D026 — opt-in notifications while Spindle is open

Status: open-app scope confirmed by the user on 2026-10-29; implementation choices by the agent.

Provide opt-in native browser notifications only while Spindle is open, including runnable background tabs. Require a user gesture for permission, store enable/preview preferences per user in this browser, hide sender/subject by default and deduplicate tabs with browser locks/shared receipts. Reuse authenticated local reads and existing SSE/polling; keep provider I/O in the worker. Mark only post-history new inbox arrivals, suppress read/moved/deleted/muted/snoozed mail and never replay consumed arrivals on undo/wakeup. Unread title/summary counts use the existing unified-inbox predicate. Recheck session ownership on notification clicks and close page-owned alerts on lifecycle cleanup.

Migration 0027 is additive and retained on rollback. Notifications are best effort with bounded arrival/receipt windows, supported secure browsers and OS permission; no delivery guarantee is implied. Notifications after closing the app are explicitly deferred: later Web Push/service-worker work must address subscription consent/revocation, privacy and session/device cleanup before it is advertised. See [behavior, upgrade and proof](notifications.md).

## D027 — Claude Design integration, first pass

Status: implemented 2026-10-29 from the user-supplied Claude Design export; visual acceptance (F10) pending.

Map the export's OKLCH tokens once into `apps/web/src/tokens.css` and skin existing semantic components instead of adopting the prototype runtime or its inline-style markup. Self-host Plus Jakarta Sans, JetBrains Mono and Material Symbols Rounded SVGs (new web dependencies: two `@fontsource-variable` packages and `@material-symbols/svg-400`); no CDN or tracker. Theme preference is a per-browser `spindle-theme` value with system default and pre-paint application. The landing page is a second Vite entry at `/landing/`; its final hosting origin stays open with production frontend hosting. Auth emails gain HTML templates with unchanged subjects and plain-text parts.

Follow-up the same day (user request): the signed-in app was rebuilt to the prototype's structure rather than skinned. Existing feature components keep their logic and are moved or portalled into the drawer, top bar, panes, Settings, compose sheet and snackbars. The user chose design visuals with true copy, and **disabled "Coming soon" controls** for prototype features that do not exist (Gmail/Microsoft accounts, passkeys, two-step verification, Needs reply, Newsletters). Browser tests were updated where names or navigation changed (All inboxes, Drafts, Settings tabs, Search options).

Shipped copy describes current capabilities: claims in the export about Gmail/Microsoft, passkeys, SQLite, KMS, audit logs, Docker packages, unavailable shortcuts and fabricated email details were rewritten. Mail HTML keeps its isolated white canvas in both themes. See [design](design.md) for tokens, rules, deviations, remaining layout work and proof.


## D028 — public home, login and inbox paths

Status: confirmed by the user on 2026-10-30.

Serve the landing page at `/`, account access at `/login`, and private mail at `/inbox` on the same origin. Public home remains visible when signed in. Session state guards the app URLs; unauthenticated inbox visits retain their mail fragment through sign-in, sign-in ends at `/inbox`, and sign-out/revocation returns to `/login`. Explicit password reset remains accessible under `/login`.

Update registration/invitation/verification/recovery links to `/login`. Preserve earlier root auth queries/mail bookmarks and redirect `/landing/` home. Keep `APP_URL` as an origin, `/api/auth` and all ownership/cookie checks unchanged, and retain the separate content hostname. Native Vite HTML entries share the current auth/mail code without a new router dependency; static hosting must map the two clean URLs to `login.html`/`inbox.html`. See [design routes](design.md#reaching-the-landing-page) and [hosting](network-access.md#static-build-routing). This supersedes the open landing-origin choice in D027.
