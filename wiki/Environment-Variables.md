# Environment Variables

Copy `.env.example` to `.env` and set every value before starting Spindle.

```bash
cp .env.example .env
```

---

## Core

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Port the server listens on. Defaults to `3000`. |
| `SESSION_SECRET` | **Yes** | Long random string used to sign session cookies. Generate with `openssl rand -hex 32`. **Spindle will not start if this is missing.** |
| `ENCRYPTION_KEY` | **Yes** | 64-character hex string (32 bytes) for AES-256-GCM encryption of stored credentials. Generate with `openssl rand -hex 32`. **Spindle will not start if this is missing or not exactly 64 hex characters.** |
| `APP_URL` | Yes | Public URL of your instance, e.g. `https://mail.yourdomain.com`. Used for OAuth callbacks and recovery links. |

> `ENCRYPTION_KEY` is critical. Spindle now **refuses to start** if it is absent or malformed — there is no insecure fallback. If you change the key, all connected accounts will need to be re-added because the stored credentials cannot be decrypted with a different key.

> `SESSION_SECRET` is equally critical. It is used to sign session cookies; anyone who knows it can forge a valid cookie for any user. Spindle **refuses to start** if it is absent. Rotate it immediately if you suspect it has been exposed, then invalidate all active sessions by restarting the server (sessions stored in the DB will be orphaned and re-login will be required).

> `APP_URL` must match the exact URL your users access. OAuth callbacks and password reset links are built from this value.

---

## System SMTP (recovery email)

These variables control the outbound mail server used to send password reset emails.

| Variable | Description |
|---|---|
| `SYSTEM_SMTP_HOST` | Hostname or IP of the SMTP server. Use `127.0.0.1` for local Postfix. |
| `SYSTEM_SMTP_PORT` | SMTP port: `25` for local Postfix, `587` for STARTTLS relay, `465` for SSL. |
| `SYSTEM_SMTP_USER` | SMTP username. Leave blank when using local Postfix. |
| `SYSTEM_SMTP_PASS` | SMTP password. Leave blank when using local Postfix. |
| `SYSTEM_FROM_EMAIL` | From address for recovery emails, e.g. `Spindle <noreply@yourdomain.com>`. |

When `SYSTEM_SMTP_USER` and `SYSTEM_SMTP_PASS` are both blank, Spindle skips SMTP authentication automatically. This is correct for a local Postfix relay.

If `SYSTEM_SMTP_HOST` is not set, recovery emails are skipped with a warning in the server log.

See [Recovery Email](Recovery-Email.md) for full setup instructions.

---

## Gmail OAuth

| Variable | Description |
|---|---|
| `GMAIL_CLIENT_ID` | OAuth 2.0 client ID from Google Cloud Console. |
| `GMAIL_CLIENT_SECRET` | OAuth 2.0 client secret from Google Cloud Console. |

Callback URL to register: `{APP_URL}/api/oauth/gmail/callback`

See [Gmail OAuth](Gmail-OAuth.md) for setup instructions.

---

## Outlook OAuth

| Variable | Description |
|---|---|
| `OUTLOOK_CLIENT_ID` | Application (client) ID from Azure App Registration. |
| `OUTLOOK_CLIENT_SECRET` | Client secret from Azure App Registration. |
| `OUTLOOK_TENANT_ID` | Directory (tenant) ID. Use `common` to allow any Microsoft account. |

Callback URL to register: `{APP_URL}/api/oauth/outlook/callback`

See [Outlook OAuth](Outlook-OAuth.md) for setup instructions.
