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

The initial audience, ownership, login and fresh-start decisions are settled. The local foundation, authentication and first read-only IMAP slice are implemented. See [authentication setup and behavior](authentication.md) and [IMAP setup](imap.md); live mailbox review remains pending.

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

Claude Design will supply the design system later; its export format and framework requirements are not yet known. Native temporary styling avoids committing to a competing design system.

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

## D009 — cached, isolated IMAP reader

Status: agent implementation choices for the user's requested navigation, caching, sanitization and image controls.

Keep bounded parsed bodies and supported image blobs in Postgres with seven-day expiry, owner-scoped LRU eviction and a 128 MiB / 1,000-message cache limit. Reuse pg-boss and account fencing for lazy MIME fetches. List and reader navigation share the same owned membership filter and preserve list/history state. Fetching leaves provider read flags unchanged.

Use Mailparser and sanitize-html, with explicit input/output/structure limits. Serve formatted HTML from a separate hostname through a script-free opaque sandbox and strict CSP. Session/message/version-scoped short-lived grants authorize body/image access without app cookies. Images start blocked and are enabled per message; supported raster images use a bounded SSRF-protected proxy/cache. Keep hosted content-host/TLS setup, object-storage/KMS, attachments, mutations and threads at their owning release gates. See [reader behavior and setup](reader.md). The user confirmed IMAP connection works; that does not by itself establish full live sync or reader acceptance.

Newsletter rendering correction: preserve parsed/filtered inline CSS, style blocks, responsive rules and table/image layout attributes. CSS image URLs share the per-message opt-in proxy; imports and external fonts remain blocked. A cache sanitizer revision causes previously stripped HTML to be refetched on opening. This corrects rendering without changing private ownership, image consent or iframe isolation.
