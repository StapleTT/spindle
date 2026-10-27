# Authentication and signup

Spindle uses Better Auth with its transactional Drizzle/Postgres adapter. The application owns registration policy, email-address-bound invitations, server-controlled roles and its protected profile endpoint. Passkeys, 2FA, social login and mailbox OAuth are outside this slice.

## Development setup

The current workspace has a generated auth secret in the ignored `.env`. For a new checkout, copy `.env.example`, generate a random secret with `openssl rand -base64 48`, and set `AUTH_SECRET` before starting the API. Never commit `.env` or reuse the example database password for hosting.

```bash
npm run db:up
npm run db:migrate
npm run auth:invite -- you@example.com --admin
npm run dev
```

If Docker requires sudo, run `sudo docker compose up -d --wait` instead of `npm run db:up`. It starts Postgres and Mailpit without removing the database volume. Run npm/application commands as your regular user.

Use the same email throughout. With the example Mailpit settings, development email is captured at http://127.0.0.1:8025; the application is http://127.0.0.1:5173. Open the invitation, register, open the verification email, then sign in. Active Resend settings deliver to the real recipient instead; see [Resend setup](resend.md).

Issue another invitation with `npm run auth:invite -- friend@example.com`. Invitations expire after seven days and are tied to the normalized email address; there is no transferable invite code. Reissuing the command renews a pending invitation. To renew the initial admin invitation, include `--admin` again. Existing accounts use verification resend or password recovery instead of re-registration.

The admin flag designates one initial admin explicitly. A transaction/advisory lock prevents simultaneous initial-admin commands from designating different addresses. Subsequent admin management is future scope. No HTTP request can set its own role, and an admin role grants no access to another user's mailbox.

## Configuration

| Variable                                             | Behavior                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `APP_URL`                                            | Exact browser origin, without path/credentials/query/fragment. Used for auth links and trusted-origin checks                                                             |
| `AUTH_SECRET`                                        | Required persistent random secret, at least 32 characters. Signs cookies and email-verification links                                                                    |
| `REGISTRATION_MODE`                                  | `invite` by default; `public` enables public registration while keeping existing users and ownership unchanged                                                           |
| `ALLOW_INSECURE_LOCALHOST`                           | Explicit local HTTP exception. Only applies to loopback app origin and bind address outside `NODE_ENV=production`                                                        |
| `TRUST_PROXY`                                        | Optional comma-separated trusted proxy IPs/CIDRs, parsed by Fastify. Unset trusts none. Only configure actual ingress proxies and restrict direct API access accordingly |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `MAIL_FROM` | Required relay settings. `SMTP_SECURE=true` uses implicit TLS; otherwise STARTTLS is required except for the explicit loopback development relay                         |
| `SMTP_USER`, `SMTP_PASSWORD`                         | Optional relay credentials; provide both or neither                                                                                                                      |

Hosted use requires HTTPS and a real relay. Secure host-only `__Host-spindle.*` cookies have `HttpOnly`, `Secure`, `SameSite=Lax`, path `/`, and no Domain. Local development uses unprefixed cookies over explicit loopback HTTP. Auth/session responses are not cacheable. The API does not enable cross-origin browser access; host the frontend and `/api` under the configured origin.

The development Vite proxy shares the loopback IP bucket. Per-IP login/signup limits are five requests per minute; reset/resend requests are three per minute. Counters live in Postgres and cannot be bypassed by supplying an arbitrary client-IP header. Fastify determines the client address using the configured proxy policy; the auth bridge overwrites the internal IP header. Additional distributed-abuse controls remain tracked separately in the rebuild plan.

## Flows and boundaries

- Signup normalizes email, enforces the invitation/public policy inside the signup transaction, hashes the password through Better Auth, and sends verification mail. Passwords must contain 15–128 characters. The account remains unverified and no login session is created.
- Signup returns a generic response for duplicate, uninvited or expired-invite addresses, without creating unauthorized accounts or disclosing invitation membership. A successful-looking response does not guarantee an email was eligible for registration.
- Verification links are signed and expire after one hour. Verification is idempotent and never automatically logs the recipient in; replay cannot grant a session. This uses the library's native verification flow rather than adding a second token framework.
- Login requires both the password and verified email. Each successful login receives a fresh server-backed session. Sessions expire after seven days; validation reads the database instead of trusting a cached user cookie.
- Logout revokes the current session. Other sessions remain valid until logout, expiry, or credential reset.
- Password recovery returns the same response for present/absent accounts, including relay failures. Errors are logged without SMTP details. Reset token identifiers are hashed in the database, expire after one hour, and are consumed atomically once.
- A database trigger on credential changes revokes **all** user sessions and outstanding recovery records in the same transaction as the password update. Another user's sessions remain untouched. Concurrent use of one recovery link has one winner.
- Verification queries and recovery token path segments are removed from request logs. Pages use a no-referrer policy, and the browser removes a recovery token from its address/history after loading it.
- Email messages are plain text and do not interpolate untrusted HTML. The SMTP transport has bounded timeouts. A failed invitation delivery can be retried by reissuing the command; the pending invitation may already be saved.

Only these auth routes are exposed:

| Method | Route                                                                   | Access                                                                               |
| ------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/api/auth-config`                                                      | Public registration-mode information only                                            |
| POST   | `/api/auth/sign-up/email`, `/api/auth/sign-in/email`                    | Public, validated and rate-limited; exact trusted Origin required                    |
| GET    | `/api/auth/verify-email`                                                | Valid signed verification link; callbacks restricted to trusted origin               |
| POST   | `/api/auth/send-verification-email`, `/api/auth/request-password-reset` | Generic responses, validated and rate-limited                                        |
| GET    | `/api/auth/reset-password/:token`                                       | Valid recovery link; redirects to the reset form                                     |
| POST   | `/api/auth/reset-password`                                              | Valid unexpired single-use token plus new password                                   |
| GET    | `/api/auth/get-session`                                                 | Current session only; no session returns null                                        |
| POST   | `/api/auth/sign-out`                                                    | Current session, exact trusted Origin required                                       |
| GET    | `/api/me`                                                               | Current verified user's ID/email/role only; 401 without a session, 403 if unverified |

Unused Better Auth endpoints are not exposed. There are no user-by-ID lookup, admin management, email-change, social-login or passkey endpoints in this slice.

## Storage, migrations and proof

Tables are `users`, `auth_sessions`, `auth_accounts`, `auth_verifications`, `auth_rate_limits`, and `invites`. `auth_accounts` contains login credential records; it is not a connected-mailbox table. Foreign keys and unique constraints protect user/session/credential relationships. Existing pg-boss tables are separate and preserved.

Versioned SQL lives in `apps/server/drizzle`. Drizzle's migrator applies it transactionally under an advisory lock. Run `npm run db:migrate` explicitly before API startup; do not edit an applied migration, delete its history or drop user tables to upgrade. Future changes must append migrations. Production rollback/restore still needs its own release proof.

`npm run check` covers lint, strict typechecks, unit tests and both builds. `npm run test:integration` creates a randomly named `spindle_test_*` database, runs the real Postgres tests, and drops only that database afterward. The development test role requires CREATEDB; application runtime roles do not. Tests exercise invites, privileges, verification/expiry, input attacks, sessions, cross-user isolation, CSRF/redirects, throttling/IP spoofing, recovery, relay failures, public registration and concurrent requests.

Install Chromium once with `npm exec -- playwright install chromium`, then run `npm run test:browser` for the full form/verification/login/reload/reset/logout journey and phone-width layout check. It also uses a disposable database and temporary servers. Browser/API tests capture synthetic email via a test transport; live relay connectivity is checked separately. CI runs both suites with Postgres and Chromium.

The UI intentionally uses temporary native styling while Claude Design is pending. Mail connections and platform-admin screens are future features; the signed-in screen does not pretend those controls already exist.
