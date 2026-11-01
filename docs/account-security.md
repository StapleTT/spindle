# Account and security

Settings → Security contains Account & security: profile name, password, sign-in email and active device sessions. The existing privacy and send preferences follow these cards. All cards use the site's shared typography, theme tokens, icons, rounded panels, forms and focus styles; fields stack on phones. Passkeys and 2FA remain deferred.

## Behavior

- **Profile:** save a trimmed name of 1–100 characters without control characters. The account menu updates after saving. This is the Spindle profile; connected-account sender names and signatures have their own settings.
- **Password:** confirm the current password and enter a matching new password of 15–128 characters. All sessions are revoked, including this device; sign in again. Password changes also invalidate outstanding recovery and email-change links.
- **Email:** confirm the current password to request a verification link at a replacement address. The current verified address remains the login until confirmation. Each new request replaces the previous link. Pending changes can be cancelled with the current password. Links expire after one hour and work once. Opening the email link displays a confirmation form; only explicitly submitting it changes the address, so link scanners cannot consume it. Confirmation signs out every device and does not create a session. Sign in with the verified new email and existing password. The user ID, role, connected mail, drafts and outbox remain attached to the same user.
- **Sessions:** show current device first, then newest sign-ins, 25 per page. Show IP, sign-in/refreshed/expiry timestamps and expandable browser details; these are informational, not verified device identity or location. Only unexpired sessions appear. Current-password confirmation is required to sign out one other device or all other devices. This device stays signed in; its row has no revoke button. Normal Sign out remains in the account menu.

Forms preserve typed values during background refresh and failed saves. Passwords are not stored in browser storage. Successful operations clear sensitive fields; changing password/email returns to sign-in. Reads refresh on focus and every 30 seconds while the pane is visible. Revocation takes effect at the database boundary; existing SSE session checks also close revoked streams.

## API and security

All routes are under `/api/auth`. Writes require the exact configured Origin. Account reads/writes require an authoritative verified Better Auth session; confirmation accepts the one-use token without requiring a session, and refuses a different signed-in user. Unknown body/query fields are rejected. No endpoint accepts a target user ID or grants admins access to someone else's account.

| Method | Account route                     | Body / result                                          |
| ------ | --------------------------------- | ------------------------------------------------------ |
| GET    | `/account`                        | Own ID/name/email and pending replacement email/expiry |
| POST   | `/account/profile`                | `{name}`                                               |
| POST   | `/account/password`               | `{currentPassword,newPassword}`                        |
| POST   | `/account/email`                  | `{currentPassword,newEmail}`                           |
| POST   | `/account/email/cancel`           | `{currentPassword}`                                    |
| POST   | `/account/email/confirm`          | `{token}`; no automatic login                          |
| GET    | `/account/sessions?cursor=…`      | Owned session metadata and next cursor                 |
| POST   | `/account/sessions/revoke`        | `{currentPassword,sessionId}`; own other session only  |
| POST   | `/account/sessions/revoke-others` | `{currentPassword}`; preserves this session            |

Existing-target email requests return the same generic success as available targets and send no mail to the existing owner. Email delivery failures return a generic service error without relay details and leave the current login active. A retry replaces the pending link. Confirmation rechecks availability and old address transactionally; collisions preserve the original login. GET confirmation routes are not exposed. Pages remove the raw token from address/history and use a no-referrer policy; API responses are no-store. Tokens are in POST bodies, not API URLs or request logs.

Reuse Better Auth password hashing/verification, verification creation/consumption, session cookies and the existing transactional Drizzle adapter. Email tokens are random 256-bit values; Better Auth hashes their identifiers in `auth_verifications`. Token values bind the stable user ID, and `auth_email_changes` stores the original/replacement addresses and verification relationship. Deleted or re-registered addresses cannot inherit an earlier user's token. Credential/email mutations serialize through the owner row and confirmed credential, recheck session validity and reject stale credentials. Session bulk deletion uses the transactional adapter, without the library's default list-page limit; there is no secondary session cache.

Owner-scoped persistent budgets: 60 settings reads/minute, 10 writes/minute, 5 current-password confirmations/minute. Better Auth also applies per-IP route limits (30/minute for account subroutes and 10/minute for email confirmation), alongside existing login/recovery limits. No parallel auth framework or new runtime service is introduced. Zod, already present through Better Auth, is declared directly for plugin boundary schemas.

## Upgrade and rollback

Run `npm run db:migrate` before deploying the new API and web build. Additive migration `0031_account_security.sql` creates `auth_email_changes` and an email-change trigger. Actual email changes atomically revoke all owner sessions and outstanding user-bound recovery/email-change records; the existing password trigger retains its behavior. Applying the migration changes no existing account, credential, session or mail rows. The worker needs no new provider behavior.

For application rollback, deploy the previous API/web build and leave the additive table and trigger in place. Old code ignores pending email changes; completed changes retain their verified address and stable identity. Do not reverse a verified change, restore revoked sessions, edit migration history or drop user data. Pending links require the new application to confirm and otherwise expire. A rollback is not a reason to reset Postgres.

## Proof

Automated coverage uses disposable Postgres databases, synthetic users and an in-memory email transport, never real inboxes. API coverage includes ownership/verification/origin/schema checks, current-password denial, paging/foreign cursors/no bearer leakage, all-other revocation above 100 sessions, hashed single-use tokens, expiry/cancellation/replacement, delivery failure/retry, reused addresses, confirmation/password races and session/link revocation. Chromium covers failed profile saves, persistence, password validation, individual/all-other revocation, explicit email confirmation/new login, changed-password login, focus, preserved edits and narrow layout in light/dark themes.

Actual final check results and migration preservation evidence are recorded in `REBUILD_TASKS.md`. Live delivery of this new template, final visual acceptance, manual screen-reader review and browsers other than Chromium remain to be accepted.
