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
- Require email verification before granting access to connected mail or mail operations. Verification and resend flows use expiring single-use tokens and rate limits.
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

The initial audience, ownership, login and fresh-start decisions are settled. The repository/local foundation is underway. The next functional slice is verified-email/password authentication and the user-owned database schema.

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

Only dependencies used by this slice are installed. Domain migrations, sessions/authentication, mail adapters, storage, query caching and the final design components will be added when their owning features are implemented. The API's compiled entry point currently serves API routes only; production frontend hosting is still pending.

Claude Design will supply the design system later; its export format and framework requirements are not yet known. Native temporary styling avoids committing to a competing design system.
