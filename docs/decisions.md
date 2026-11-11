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

Status: superseded on 2026-11-11 by [D044](#d044--drafts-stay-in-spindle). Retained as history; the behavior below no longer runs.

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

Reader correction requested on 2026-11-01: a standalone email must not look like a thread or repeat its selected header. Show only other related messages in the timeline; combine matching Inbox/All Mail envelopes for display while retaining all physical IDs, individual actions, local list/count/search semantics and scoped navigation. Copy hints require a valid exact Message-ID and matching account/envelope/date/size metadata; differing metadata and same-folder deliveries stay separate. Prefer a matching current-view copy and a regular folder over virtual All Mail for links. Hide the timeline when no other loaded entries or earlier pages remain. No data merge, migration or provider mutation is authorized or needed for this display correction.

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


## D029 — custom account colours and honest settings controls

Status: custom styled picker and suggested colours requested by the user on 2026-10-30; implementation choices by the agent.

Persist one nullable six-digit hex colour per owned connected account. Use a custom modal with suggested token-based swatches, live preview, HSL sliders, hex input and explicit save/cancel/reset; no native browser colour picker. Apply it consistently across app identity markers, keep theme-aware readable text and propagate saves through existing local account reads/SSE. Cosmetic concurrent changes use last-writer-wins. The additive 0028 migration is retained on rollback; reconnect preserves the preference.

The Settings Security switches were intentionally disabled under D027. Represent fixed image-proxy/default-image-blocking/send-delay protections as Always on labels and future 2FA as Coming soon. Only implemented preferences appear interactive; desktop notifications use a functional permission-aware switch. This change preserves per-message remote-image consent and the five-second send floor. See [design details and proof](design.md#settings-controls-and-account-colours--2026-10-30).


## D030 — functional image privacy and Undo send preferences

Status: explicitly requested by the user on 2026-10-30, superseding D029's fixed-switch choice.

Provide real saved per-user toggles for loading images through the privacy proxy, blocking remote images by default, and Undo send. All start on. With proxying off, permitted remote HTTPS images load directly in the browser and can expose its IP/opens; automatic image loading is permitted when default blocking is off. Preserve sanitized CSS/HTML, separate content origin, opaque sandbox, no-referrer, strict per-body image CSP and owned live grants. Direct hosts must pass public-address validation; browser DNS/fetch behavior and unapproved redirects differ from the proxy. Per-view Display/Hide remains available. Defaults apply to new views.

Undo send off removes the five-second grace period for future immediate enqueues and safe explicit retries. Existing queued times and scheduled UTC deadlines remain authoritative; MIME snapshots, claim/cancel ordering, access/scan/quota checks and uncertain-send protections are unchanged. Triage undo remains separate. Persist only these three owned booleans in an additive 0029 table, with existing accounts-topic invalidation and defaults for absent rows. Keep the migration on rollback. See [mail preferences](mail-preferences.md).

User follow-up on 2026-10-30: show no warning/notice when remote images are enabled or loaded automatically. Reader and formatted original previews retain a quiet Hide images control; blocked-image notices and Settings descriptions remain.

Further user follow-up on 2026-10-30: omit Hide images entirely for automatically loaded images in reader and original previews; retain manual Display/Hide for views that start blocked. Collapse From/To/Cc/Account header details by default behind a keyboard-accessible Message details disclosure, keeping the sender summary and timestamp visible.


## D031 — automatic reader format and neutral HTML fallback

Status: requested by the user on 2026-10-30.

Remove the received-message formatted/plain-text selector. Use plain text when no HTML MIME body exists; otherwise display sanitized HTML on the isolated content origin, retaining the plain fallback when that service is unconfigured. Composer output-format choices remain separate.

Replace the forced-white HTML canvas with a muted light fallback and a dark fallback for uncoloured HTML in the app's dark theme. Preserve explicit sender palettes, text/background pairing and newsletter layout rather than inverting or overwriting authored styles. A validated appearance-only theme parameter crosses the content boundary; theme changes renew grants with existing image consent and keep cached content readable during outages. Sandbox, CSP, content ownership and image preferences remain intact. This supersedes D027's always-white canvas choice.

## D032 — saved account ordering

Status: requested by the user on 2026-10-31; implementation and focused automated checks complete.

Provide Move up/Move down controls in Settings → Accounts, usable with keyboard and touch. Save per-user ordering across devices and apply it to the shared account list used by the sidebar, filters, search and composer selectors. Keep focus on the move control and announce the saved position inline. Existing accounts retain creation order until reordered, new accounts append, reconnect preserves position and disconnect preserves the other accounts' relative order. Reordering does not change an open draft's selected account or provider state.

Use an additive nullable account position and existing accounts-topic SSE invalidation. Validate the complete owned account set and expected previous order under existing owner-first locks; reject stale writes atomically and accept an already-satisfied replay. Preserve all mail, credentials, drafts and immutable sends. See [account ordering](account-ordering.md) for API, rollout/rollback and proof. Remaining K07 preferences/admin/help/legal work stays open.

User follow-up on 2026-10-31: replace the visible arrows with draggable accounts using a three-line handle on the right, and remove the saved-position feedback. Mouse/touch drag and drop, edge scrolling and keyboard Up/Down use the existing persistence path. Preserve focus, cancellation, failure feedback and stale-write protections; show no success/position message.

## D033 — quiet read actions and one-second reader dwell

Status: explicitly requested by the user on 2026-11-01.

Hide routine read/unread pending and success toasts, retaining folder-move and sending feedback. Keep failures/conflicts visible and read/unread history/Undo available on demand and by keyboard. Routine inline read progress/completion and read Undo confirmations are quiet as well.

After one continuous second viewing loaded content in the visible, focused reader, queue the existing owned durable read action for that physical message. Wait for plain content or the isolated HTML frame; cancel on navigation, backgrounding, obscuring overlays or pending actions. Attempt once per opening; explicit reader actions prevent re-marking a message the user leaves unread. Auto-read failures remain visible without a loop. If auto-reading removes a message from an unread search, return to the results instead of starting an automatic chain through its neighbors. Body fetches/conversation lists alone still never change flags. This supersedes D010's earlier explicit-controls-only opening rule. Existing authorization, grace deadlines, worker/provider behavior and uncertain-operation protections remain in place; no migration is needed.

User follow-up on 2026-11-01: suppress all pending mail-action toasts, including folder actions; outgoing queued/sending feedback is the exception. Expanded action history offers standalone Undo controls during the grace window without pending status banners. Keyboard Undo, completed folder-action feedback, failures/conflicts and durable provider work remain. Cancelled outcomes must be labelled Cancelled rather than Pending.

Completed-read correction on 2026-11-01: expanded history must apply the same quiet-outcome rules as the collapsed stack. Successful/cancelled read and unread actions remain hidden after expansion, refresh and reload; only their available Undo controls or failures/conflicts can appear. Retain completed folder actions and outgoing-send feedback. The initial collapsed-stack filter did not cover expanded history; the screenshot and new browser regression reproduced that path.

Further user correction on 2026-11-01: hide read/unread Undo buttons as well, including expanded history. Pending read/unread actions must not create a visible history affordance by themselves. Folder Undo controls, keyboard Undo, failures/conflicts and outgoing-send feedback remain available. This supersedes the earlier visible read/unread Undo exception.


## D034 — account profile, credentials and device sessions

Status: explicitly requested by the user on 2026-11-01; implementation choices below.

Add profile-name editing, current-password-confirmed password changes, replacement-verified login email changes and active session review/sign-out in the existing Security settings pane, following the imported design. Keep all controls private to the verified owner, including against foreign admins. Passkeys/2FA remain deferred under D003.

Implementation: password changes sign out every device. Email requests keep the current login active until an explicit one-use, one-hour confirmation at the replacement address; cancellation/new requests invalidate the previous link. Confirmation signs out every device without automatically signing in. Bind tokens to stable user IDs and use Better Auth verification/password/session primitives with the existing transactional adapter. Preserve mail ownership, profile role and connected-account sender/signature settings. Device revocation requires the current password and preserves this device; session listings expose safe metadata, never bearer tokens. Use additive migration 0031 and retain it on application rollback. See [behavior, limits and proof](account-security.md).


## D035 — administration as a Settings tab

Status: explicitly requested by the user on 2026-11-01, following the proposed initial admin-panel scope.

Add an administrator-only tab inside Settings, following the imported design. Ship user search/status, regular-user invitations with send/resend/revoke, pause/resume access, session revocation, guarded role changes and administration audit history. Preserve private mail ownership: administration exposes access and aggregate account/session metadata, never other users' mail or credentials. Initial administrator designation stays explicit and operator controlled.

Implementation: require the acting administrator's current password for every mutation, reject self access changes, protect the last active administrator and serialize concurrent privilege changes. Suspension preserves mail/drafts, revokes sessions/links and fences new provider work and stale commits; work already submitted externally may still complete. Resume permits fresh login/background work and may dispatch held queued/overdue scheduled sends. Use expected versions, replay-safe operation IDs and transactional audit records. Delivery failures remain visible and explicit resends recover invitations. Append migration 0032 and deploy API/worker/web together; old workers must remain stopped while suspended users exist. See [administration behavior and rollout](admin.md). User deletion/export, broader monitoring and full authentication auditing remain separate C06/C08/C09/L07 work.


## D036 — unlock administration once per sign-in session

Status: explicitly requested by the user on 2026-11-01; supersedes D035's password-per-mutation choice.

Hide all administration content and data behind one current-password gate. After a successful unlock, further administration actions do not ask for a password. Keep normal action confirmation, authorization, self/last-admin protection, audit and replay safety.

Implementation: store the unlock on the current Better Auth database session, with no separate bearer token or client-storage flag. It persists across tabs/reloads/server restarts for that sign-in session, and a new device/sign-in starts locked. Require the unlock for all admin reads and writes; recheck it inside mutation transactions. Role/verification changes clear it; password/email changes, suspension, sign-out and session expiry/revocation invalidate it with the session. Before unlocking, request only the access boolean and render only the gate; mount the management component afterward. Personal Account & security controls keep their existing password confirmations. Append migration 0033. See [administration](admin.md).


## D037 — account export, scheduled deletion and security activity

Status: requested by the user on 2026-11-03 ("add the rest of the account/admin work"); scope choices confirmed by the user the same day: seven-day grace period for self-deletion, admin deletion of suspended users only, export of Spindle-owned data (not cached bodies), security activity visible to the owner and to administrators.

Self-service deletion requires the current password and typed confirmation, then suspends the account immediately (reusing the D035 suspension fence) and deletes it after seven days unless the user signs in and cancels. Sign-in during the grace period reveals the pending state only after password verification. The last active administrator cannot schedule deletion. Administrators may delete suspended, non-self users immediately through the audited admin mutation path; they cannot suspend/resume a pending self-deletion. Deletion removes all owned rows by cascade, invitations and the user's security events, scrubs the address from admin audit and keeps one `account.deleted` event keyed by user ID for 180 days. Provider mail is never touched.

The export is an on-request gzipped JSON stream from one database snapshot with explicit columns: profile, preferences, connected-account settings (no secrets), folders, message headers/flags/local state, drafts with attachments, outbox MIME, signatures, saved searches and security activity. Cached bodies and all credentials/tokens are excluded.

Security activity records sign-ins (including failures for known accounts), sign-outs, password/email changes and resets, session revocations, export and deletion lifecycle with IP and user agent only, retained 180 days. Append migration 0034. See [account lifecycle](account-lifecycle.md).

## D038 — Gmail via the Gmail API (slice 1)

Status: user chose the Gmail REST API with a proper OAuth flow (option B) and approved the slice-1 plan on 2026-11-04.

Gmail lands in vertical slices that keep Gmail accounts honest about what works, following the D008 precedent: (1) OAuth connect/reconnect/disconnect, labels as folders and a read-only list, counts and search over synced metadata with `history.list` polling; (2) reader; (3) actions; (4) drafts and sending; (5) watch/Pub/Sub push once a public HTTPS domain exists. There is no adapter refactor up front: Gmail has its own functions, the dispatcher branches on `mail_accounts.provider`, and D01's shared contract grows from code that two providers actually share.

- **Scopes:** `openid email https://www.googleapis.com/auth/gmail.modify`. This is the single restricted scope that later slices need (read, labels, drafts and send, but no permanent delete). The callback rejects grants without it.
- **Who does provider I/O:** the API performs only the code exchange, the userinfo lookup and best-effort revocation. All mailbox I/O stays in the worker.
- **Identity:** the Google `sub` is the provider identity, and reconnect is keyed by `(user_id, sub)`; a reconnect into another Google account is refused. The address is stored as `username`.
- **Tokens:** the refresh token is encrypted into `credential` with the existing key ring and AAD. Access tokens are refreshed per job and never stored. Revocation runs after commit and is skipped while another connection uses the same Google account.
- **History:** the existing 90-day/all choice maps to `q=after:<epoch>`. Spam and Trash are included. A synthetic All Mail folder (`\All`) holds every message outside Spam and Trash.
- **State:** a sha256-hashed state that is single-use, expires after 10 minutes and is bound to the user, the sign-in session and the target account, with a PKCE S256 verifier.
- **Dependencies:** none new. Native `fetch` with timeouts reaches fixed Google hosts.

Until their slices land, IMAP-only routes answer 409 for Gmail resources, the reader disables actions with a stated reason, and every IMAP dispatcher query is limited to `provider='imap'` through one shared fragment. Append migration 0035 (Gmail identity columns, a membership key that no longer needs UIDs, durable checkpoint/listing/OAuth-state tables). Old workers and APIs must stay stopped while Gmail rows exist. See [Gmail](gmail.md) for setup, limits, rollout and proof.

User-reported failure on 2026-11-05: Gmail synced once and then failed on automatic syncs. Two likely causes were found:

- The worker sent 10 unpaced `messages.get` requests and treated every rate-limit response as a sync failure. Gmail's per-user limit is 250 units/s, and each get costs 5 units.
- History records larger than fixed caps threw on every retry, for example a bulk "mark all read". The account could never pass that history page.

The failing account had already been disconnected and errors were not logged, so neither cause was confirmed from the user's data. Fix:

- Requests are paced (pool of 5, one start per 25 ms).
- Rate-limit and 5xx responses are retried with backoff or `Retry-After`. Once retries run out, the job pauses without an error state.
- Label-only history changes apply as local deltas with no refetch or size cap. More than 1,000 additions in one page falls back to a resumable listing.
- Failures log a redacted status and Google reason code.

## D039 — editable account display names and provider logos

Status: requested by the user on 2026-11-05.

Settings → Accounts adds Rename for every account. `PATCH /api/mail/accounts/:id/name` stores a trimmed, printable, non-blank display name of up to 100 characters for the owner only. It changes only `mail_accounts.name`; the address, provider identity, credentials, sender name and ordering are untouched. Reconnect keeps the chosen name, and the existing accounts SSE topic updates other tabs. No migration is needed.

The Add an account cards use the real Gmail and Outlook marks from Wikimedia Commons, self-hosted under `apps/web/src/assets`, as the documented exception to token-only colours. See [design: provider logos](design.md#provider-logos).

## D040 — Gmail reader, actions and sending

Status: requested by the user on 2026-11-05 ("I actually want to be able to read my emails, mark them as read/unread, archive, send emails, etc."). This implements D038 slices 2–4. Provider draft sync (`users.drafts`) and push remain open.

Gmail plugs into the existing pipelines and replaces only the provider step:

- **Reader:** a small `ContentSource` (reply headers, message with attachment list, one attachment) has IMAP and Gmail implementations behind the shared parse, sanitize, cache and content-origin code. Gmail uses `format=raw`. Attachments are addressed by their position in the parsed raw message, so the list and the download cannot disagree and no unstable Gmail attachment ID is stored.
- **Actions:** the shared durable intents, undo and ordering map to idempotent `modify`, `trash` and `untrash` calls, and Gmail's returned labels become local truth.
- **Sending:** the shared Outbox and its unknown-outcome rules call `messages.send` once per claim. The MIME snapshot keeps `Bcc`, and Gmail files the Sent copy itself.

Folder model:

- The synthetic `[All Mail]` folder becomes Archive (`\Archive`): mail with none of Inbox, Spam or Trash, which is Gmail's meaning of archived and gives archive/restore a real target. Existing accounts are recomputed locally on their next sync.
- Trash and Spam are exclusive in the mirror, as in Gmail's views. Leaving them refetches labels.

Sender identity: the sender is the connected address, and the display name comes from Gmail's default "Send mail as" (`users.settings.sendAs`, covered by `gmail.modify`), falling back to the Spindle profile name. Append additive migration 0036 for that name.

Gmail sync, like IMAP, yields to pending user work. Old (D038-only) workers never touch Gmail mail but leave queued Gmail work pending. See [Gmail](gmail.md).

## D041 — prompt message content fetching

Status: requested by the user on 2026-11-05 ("Fetching message content (all providers) is incredibly slow").

Measured with synthetic local IMAP: a requested body took about 5 s on a quiet account and 8.8 s during a large sync. Causes:

- An IMAP IDLE watch usually held the account lease, so the body job could not claim it. The watch yielded within a second, but nothing redispatched the job until the next 5-second dispatcher tick.
- IMAP sync did not yield between folder batches.
- The reader rechecked only every 1.5 s.

Fix, without new dependencies:

- Append migration 0037: a `spindle_mail_work` NOTIFY fires when a body or attachment is newly requested or retried. The worker LISTENs on its own connection (one per worker process, re-established after errors) and dispatches.
- pg-boss `useListenNotify` and per-queue `notify` wake the dispatch and content queues.
- A metadata job that yields to user work dispatches again at once.
- IMAP sync now yields between batches when a body or attachment is waiting. Actions do not trigger the mid-job yield, because they sit in a five-second undo window; they still prevent a new sync from starting, as before.
- The reader reloads on the committed SSE content change.
- Gmail access tokens are reused from worker memory until five minutes before expiry. They are never stored, a reconnect invalidates them, and a 401 retries once with a fresh token.

The timer, polling and the minute schedule remain fallbacks. Result: about 0.4 s quiet and 1.2–1.8 s during a 4,000-message sync, plus provider fetch time. The IMAP TLS connection per body job is unchanged; reuse it if login time dominates. A per-worker body concurrency of one also stays unchanged, to preserve the two-connection budget.

## D042 — bodies cached before they are opened

Status: requested by the user on 2026-11-09 ("How can we make emails load in under 1 second when clicked, all the time?", then "Do steps 1 and 2"). This replaces the lazy-only retrieval and the seven-day expiry of the reader decision above; the 128 MiB / 1,000-message budget is unchanged.

D041 shortened dispatch, but a first open still paid a provider connection and a full download. Only a body already in Postgres opens instantly.

- **Worker prefetch:** after each completed metadata sync the same job runs one bounded pass (15 seconds) that downloads the account's newest uncached messages, newest first. It uses the on-demand source, parser, sanitizer and cache writes, so a prefetched body is identical to an opened one. IMAP uses one connection for the pass. A failed or paused sync skips the pass and keeps its backoff. Remaining candidates bring the next sync forward.
- **Priority:** prefetch runs in the metadata slot, so the content queue and the two-connection budget are untouched. It never starts while the account has pending user work, writes no pending rows and fires no `spindle_mail_work` notification. A reader's request ends a running pass within about a second.
- **What is cached:** the cache keeps its least-recently-used eviction. A prefetched row ranks by its message's received time and an opened row by its last access. A message is prefetched only while the rows ranked above it leave room for it, so prefetch cannot evict a body and then fetch it again. Trash and Junk mail and messages over the 10 MiB raw limit are fetched on demand only.
- **Expiry:** ready bodies no longer expire by age. With prefetch an expired body would simply be downloaded again, so the budget is the bound. Migration 0038 lifts the expiry of existing ready bodies. Failed requests still expire.
- **Failures:** a body prefetch cannot fetch is recorded as a failed row with code `prefetch_unavailable` and retried after a day. The reader treats that row as missing and requests the body itself, so the user only ever sees the result of a real attempt.
- **Events:** body-cache changes notify a new `content` SSE topic instead of `mail`. Only the reader and active searches listen, so continuous background caching does not refetch every open list or spend the read rate budget.
- **Client:** the reader requests its Previous and Next messages once its own body is shown, and the list requests a row after the pointer or keyboard focus rests on it. These use `POST /api/mail/messages/:id/prefetch`, the same deduplicated request as opening, on its own rate-limit bucket.

Consequences: up to the budget, recent mail is held in Postgres continuously instead of only after opening, and body search covers it. Mail outside the budget, in Trash or Junk, or opened before its first prefetch pass still takes the on-demand path. See [reader](reader.md#prefetch).

## D043 — Microsoft OAuth and Graph polling mail

Status: user requested Microsoft OAuth and Graph API integration on 2026-11-10.

Support Outlook.com personal and Microsoft 365 mailbox connections through delegated Microsoft OAuth and Graph v1.0. Reuse the existing worker queues, fenced leases, local mirror/search/SSE, reader isolation, durable actions/undo, local composer, signatures and immutable Outbox. Mailbox I/O stays in the worker; the API performs only OAuth exchange/identity discovery.

- Request `openid profile email offline_access User.Read Mail.ReadWrite Mail.Send`; use common Microsoft endpoints and exact redirects. Bind hashed expiring single-use PKCE state to provider/user/session/target. Keep Microsoft mailbox consent separate from Spindle login.
- Use app-scoped userinfo `sub` as the provider identity and `/me` for the connected address/name. Refuse reconnect substitution. Encrypt refresh tokens with the existing owner/account AAD; persist rotations under the lease. Disconnect/deletion removes tokens locally without broad Microsoft session revocation.
- Persist folder-hierarchy and per-folder message delta checkpoints atomically with pages. Use immutable IDs and reconcile removals against current message location before deleting; retain message identity, caches and local conversation state across moves. Honor throttling and recover expired delta without clearing visible mail first.
- Keep the fixed 90-day/all choice. Traverse unfiltered delta and apply the horizon locally to avoid the provider's filtered-delta cap. Use native fetch; add no dependency/service.
- Reader, actions and sending replace only the provider step. Read/unread is PATCH; moves carry durable unknown-move protection. Send base64 MIME once, retain Bcc, reuse cancellation/scheduling/unknown-send safeguards and let Microsoft create Sent copies.
- Bound outgoing MIME to 3,000,000 bytes before transport base64 for Graph's 4 MB request limit. Larger attachment upload sessions, native Outlook Drafts synchronization and subscriptions/push remain separate. No shared/delegated mailboxes, aliases, on-premises Exchange or national clouds.

Append migration 0039; deploy API/worker/web together. Old workers must never run against Microsoft accounts. Live personal/Microsoft 365 acceptance and tenant consent/publisher verification remain open; K01/K02/M5 are not marked complete. See [Outlook setup and behavior](outlook.md).

## D044 — drafts stay in Spindle

Status: confirmed by the user on 2026-11-11 ("Syncing with providers can cause some issues depending on who it is, so let's just keep drafts synced with Spindle"). Supersedes D016. The user chose a one-time cleanup of earlier copies and hiding provider Drafts folders.

- Drafts are saved only in Spindle for IMAP, Gmail and Microsoft accounts. There is no provider Drafts upload, no import of drafts written in other clients, and no provider-copy check before sending. Gmail slice 4b and native Outlook Drafts synchronization are excluded rather than pending.
- Provider `\Drafts` folders are omitted from the folder list for every provider. Drafts written in other clients stay at the provider, untouched.
- Migration 0040 drops the draft save/delete triggers and marks earlier tracked IMAP copies for one-time cleanup. It detaches links from local drafts so nothing can re-upload them, and releases conflict-file references. Link, copy and import history is retained.
- The worker deletes a copy only when its bytes are unchanged and UIDPLUS allows a targeted expunge. It uses a conditional STORE when CONDSTORE is available, under the existing lease and connection budget. Changed, ambiguous, oversized, unlisted-folder, non-UIDPLUS and user-kept copies are kept. Transient failures retry at most five times, then the copies are kept.

Older workers must not run after 0040. See [drafts stay in Spindle](provider-drafts.md).
