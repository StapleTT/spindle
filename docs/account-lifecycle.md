# Account lifecycle: security activity, export and deletion

Settings → Security adds Security activity, Export your data and Delete account cards below the device sessions. Settings → Admin adds deletion of suspended users and a Sign-ins tab. Decision: [D037](decisions.md#d037--account-export-scheduled-deletion-and-security-activity).

## Security activity

`security_events` records the owner's stable user ID, event type, client IP (`x-spindle-client-ip`, set by the API proxy) and a 512-character user agent. It never stores passwords, tokens, mail content or recipients.

| Event                                                                           | Recorded by                                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `account.created`                                                               | Registration user hook, in the signup transaction                    |
| `sign_in.succeeded`, `sign_in.failed`                                           | Better Auth after-hook on `/sign-in/email`; only known accounts fail |
| `sign_out`                                                                      | Before-hook on `/sign-out`                                           |
| `password.reset`                                                                | `onPasswordReset`, after the reset commits                           |
| `password.changed`, `email.*`, `session.revoked`, `sessions.revoked_others`     | Account endpoints, in the same transaction as the change             |
| `export.created`, `deletion.scheduled`, `deletion.cancelled`, `account.deleted` | Lifecycle endpoints / deletion                                       |

Users read their own events at `GET /api/auth/account/activity?cursor=…` (25 per page). Administrators read all events, with the owner's email and IP but no user agent, at `GET /api/admin/security` behind the existing unlock. The dispatcher deletes events older than 180 days. Failed sign-ins for unknown addresses are not stored, so the table cannot be used to probe or flood arbitrary addresses; known-address failures stay bounded by Better Auth's per-IP sign-in limit.

## Data export

`POST /api/account/export {currentPassword}` requires the exact app Origin, a verified active session, the current password and a two-per-minute owner budget. It streams `spindle-export-YYYY-MM-DD.json.gz` from one repeatable-read snapshot using server-side cursors, so memory is bounded per batch (one draft or outbox row at a time).

Contents: profile, mail preferences, connected accounts with IMAP/SMTP host, port, transport, username, sender name and signature; folders; message headers, folder flags and local pin/mute/snooze state; drafts with ready attachment files (base64); outbox entries with their MIME (base64); saved searches; security activity. Exports select explicit columns: encrypted provider credentials, password hashes, sessions, verification tokens, leases, mail action internals and cached message bodies/attachments/images are never included. Mail bodies remain with the provider; users export them with an IMAP client. A disconnected download destroys the stream and releases the snapshot.

## Self-service deletion

`POST /api/auth/account/deletion {currentPassword}` (the UI also requires typing `DELETE`) sets `suspended=true` and `deletion_due_at=now()+7 days` on the owner row. The existing suspension trigger immediately revokes every session and user-bound link and fences account leases, uploads, IDLE, dispatch and worker commits; queued and scheduled sends are held. A notice email goes to the sign-in address; delivery failure does not undo the schedule. The last active administrator is refused by the existing database guard.

During the grace period, sign-in with the correct password returns `ACCOUNT_DELETION_PENDING` (only after password verification, so it reveals nothing to someone without the password). The sign-in page then offers **Cancel deletion and sign in**, which calls `POST /api/auth/account/deletion/cancel {email,password}` (5/minute per IP), rechecks and locks the credential, clears both columns and signs in. Password recovery still works during the grace period. A CHECK constraint keeps `deletion_due_at` only on suspended rows, and a trigger bumps `admin_revision` on every schedule change so stale admin actions fail.

The worker dispatcher deletes due users each minute (20 per pass, one transaction per user), rechecking `suspended AND deletion_due_at<=now()` under the row lock, so a concurrent cancellation wins or loses atomically.

## Administrator deletion

Admins delete only suspended, non-self users: `POST /api/admin/users/:id {action:'delete',expectedRevision,operationId}` through the existing replay-safe, unlocked, audited mutation path. Suspend first so provider work is already fenced. Users with a pending self-deletion cannot be suspended or resumed by an admin (they cancel by signing in); admins may delete them immediately.

## What deletion removes and keeps

`deleteUserData` deletes the `users` row; every owned table cascades from it (connected accounts and encrypted credentials, folders, messages, memberships, cached content, attachments, images, actions, drafts, provider-draft mappings, uploads and chunks, outbox and chunks, signatures, saved searches, preferences, rate-limit rows, sessions, credential accounts, email changes). It also removes invitations for the address, user-bound verification rows and the user's security events, and scrubs the address from `admin_audit` details/targets. It retains:

- one `account.deleted` security event keyed by the stable user ID, without IP or user agent, purged after 180 days;
- existing `admin_audit` rows (actor, action, time, target user ID) without the email address; deleted actors become “Former administrator”.

Mail at providers is never touched. Leftover pg-boss jobs reference only IDs and find no account or lease. Backups are not rewritten: deleted data remains in database backups until they expire under the operator's backup retention, which the deployment runbook must state.

## Upgrade and rollback

Append migration `0034_account_lifecycle.sql`: nullable `users.deletion_due_at`, its CHECK/index and revision trigger, `security_events`, and `user.delete` in the admin audit action check. No existing row changes. Run `npm run db:migrate`, then deploy API, worker and web together. An older worker ignores `deletion_due_at` but still honours suspension, so pending users stay fenced; due deletions simply wait for the new worker. For application rollback, keep the columns, table and data; old code cannot cancel pending deletions, so either roll forward or have an operator clear `deletion_due_at` and `suspended` together for users who ask. Never reset the database to roll back.

## Proof

`apps/server/test/account-lifecycle.integration.ts` covers activity privacy, metadata and unknown-address suppression; export origin/session/password/schema checks, contents, base64 files, absent credentials/bodies/tokens and another user's data; scheduling, session revocation, notice email, blocked sign-in, cancellation with wrong/unknown/not-pending credentials, last-admin refusal, not-yet-due skip, complete row removal across every `user_id` table, invitation removal, retained minimal event; admin self/active refusals, audit scrubbing, pending-user resume refusal, user listing and Sign-ins feed. `apps/web/test/account-lifecycle.browser.ts` exercises the Security cards, real download parsing, typed confirmation, scheduled-deletion login and cancellation, and admin deletion with the Sign-ins tab in Chromium.
