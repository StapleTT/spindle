<img src="public/img/spindle_banner.png" alt="Spindle" width="100%">

Spindle is a self-hosted, centralized email client that lets you manage multiple email accounts from a single interface. Connect Gmail, Outlook, iCloud, Yahoo, or any standard IMAP/SMTP provider, all in one place, on your own server.

---

## Features

- **Multi-account inbox:** connect as many email accounts as you want; read them individually or through a unified All Inboxes view
- **Folder trees:** browse any folder or label per account (Inbox, Sent, Drafts, Archive, Trash, Spam, custom labels); loads on first selection and caches for the session; per-folder unread counts
- **OAuth 2.0 for Gmail and Outlook:** one-click connect with no password stored; tokens are encrypted at rest
- **IMAP/SMTP for everything else:** iCloud, Yahoo, and any standard mail server; credentials are AES-256-GCM encrypted
- **Compose, reply, forward:** full compose window with Cc/Bcc, reply-all, and forward support; sends via Gmail API, Microsoft Graph, or SMTP depending on account type
- **Attachments:** read and download attachments from any provider; attach files when composing (10 MB per file, 25 MB total)
- **Search:** search by sender, recipient, subject, or full text across one inbox or all accounts at once
- **Account recovery:** users can request a password reset link sent to their registered recovery email
- **Invite-only registration:** accounts require a valid `XXXX-XXXX-XXXX` invite code; the admin panel generates and revokes codes
- **Admin panel:** manage users (toggle roles, pause accounts, delete), issue and revoke invite codes, all from within the app
- **Dark/light/system theme:** respects your OS preference by default, overrideable per account
- **Keyboard shortcuts:** `c` compose, `r` reply, `e` archive, `#` delete, `u` mark unread

---

## How It Works

Spindle runs as a Node.js/Express server. On the backend it speaks IMAP (via `imap-simple`) and the Gmail/Microsoft Graph APIs directly, so email never touches a third-party proxy. A SQLite database (using Node's built-in `node:sqlite` module, no native compilation required) stores accounts, session state, and user preferences. All credentials and OAuth tokens are encrypted with AES-256-GCM before being written to disk.

The frontend is plain HTML, CSS, and vanilla JavaScript with no framework and no build step. The three-panel layout (sidebar, message list, reading pane) loads entirely from static files served by Express.

```
Browser  -->  Express (server.js)
                ├── /api/auth        session-based login, registration, recovery
                ├── /api/accounts    add/remove/reorder email accounts
                ├── /api/email       read, send, archive, delete, search
                ├── /api/oauth       Gmail and Outlook OAuth flows
                ├── /api/settings    theme, images, account deletion
                └── /api/admin       user management, invite codes
```

Sessions are stored in the same SQLite database as all other application data, no separate session files, no filesystem locking issues.

---

## Requirements

- **Node.js 22.5 or later** -- required for the built-in `node:sqlite` module
- A server or machine to host it on (Linux, macOS, or Windows)
- (Optional) Gmail and/or Outlook OAuth credentials if you want one-click OAuth login for those providers
- (Optional) A local MTA such as Postfix if you want self-hosted password recovery emails

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/StapleTT/spindle.git
cd spindle
npm install
```

### 2. Configure environment variables

Copy the example file and fill in every value:

```bash
cp .env.example .env
```

Open `.env` and set the following:

| Variable | Description |
|---|---|
| `SESSION_SECRET` | Long random string used to sign session cookies |
| `ENCRYPTION_KEY` | 64-character hex string (32 bytes) for AES-256-GCM -- generate with `openssl rand -hex 32` |
| `APP_URL` | The public URL of your instance (e.g. `https://mail.yourdomain.com`) -- used for OAuth callbacks and recovery links |
| `SYSTEM_SMTP_HOST` | Hostname of the SMTP server used to send recovery emails (use `127.0.0.1` for local Postfix) |
| `SYSTEM_SMTP_PORT` | SMTP port -- `25` for local Postfix, `587` for external relay with STARTTLS, `465` for SSL |
| `SYSTEM_SMTP_USER` | SMTP username -- leave blank when using local Postfix |
| `SYSTEM_SMTP_PASS` | SMTP password -- leave blank when using local Postfix |
| `SYSTEM_FROM_EMAIL` | The From address for recovery emails, e.g. `Spindle <noreply@yourdomain.com>` |

> **These variables are critical.** Without `ENCRYPTION_KEY`, stored credentials cannot be decrypted. Without `APP_URL` set to your real domain, OAuth callbacks and recovery links will point to the wrong address.

### 3. Set up OAuth (optional, but required for Gmail/Outlook)

OAuth credentials are issued by the provider and must be created manually. Spindle never stores plaintext passwords for OAuth accounts, only encrypted refresh tokens.

#### Gmail (Google Cloud Console)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) -> **APIs and Services -> Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application)
3. Add `{APP_URL}/api/oauth/gmail/callback` as an authorized redirect URI
4. Copy the client ID and secret into `.env`:
   ```
   GMAIL_CLIENT_ID=your_client_id
   GMAIL_CLIENT_SECRET=your_client_secret
   ```
5. Enable the **Gmail API** under APIs and Services -> Library

#### Outlook (Azure App Registration)

1. Go to [portal.azure.com](https://portal.azure.com) -> **Azure Active Directory -> App registrations -> New registration**
2. Under **Authentication**, add `{APP_URL}/api/oauth/outlook/callback` as a redirect URI (Web platform)
3. Under **Certificates and secrets**, create a new client secret
4. Copy the Application (client) ID, Directory (tenant) ID, and secret into `.env`:
   ```
   OUTLOOK_CLIENT_ID=your_application_id
   OUTLOOK_CLIENT_SECRET=your_client_secret
   OUTLOOK_TENANT_ID=common
   ```
5. Under **API permissions**, add `Mail.ReadWrite`, `Mail.Send`, and `offline_access` (Microsoft Graph, delegated)

### 4. Set up recovery email (optional, but recommended)

Spindle can send password reset links to users who registered with a recovery email address. This requires an outbound mail server. The recommended approach is a local Postfix instance on the same machine, which requires no external accounts or services.

#### On Debian/Ubuntu

```bash
apt install postfix opendkim opendkim-tools -y
# Choose "Internet Site" and set the hostname to your domain when prompted
```

#### On Alpine Linux

```bash
apk add postfix opendkim opendkim-utils
rc-update add postfix default
rc-update add opendkim default
```

#### Generate a DKIM signing key

```bash
mkdir -p /etc/opendkim/keys/yourdomain.com
opendkim-genkey -D /etc/opendkim/keys/yourdomain.com/ -s mail -d yourdomain.com
chmod 600 /etc/opendkim/keys/yourdomain.com/mail.private
```

#### Configure OpenDKIM

```bash
cat > /etc/opendkim/opendkim.conf << 'EOF'
Domain                  yourdomain.com
KeyFile                 /etc/opendkim/keys/yourdomain.com/mail.private
Selector                mail
Socket                  inet:8891@127.0.0.1
Canonicalization        relaxed/simple
Mode                    sv
OversignHeaders         From
EOF
```

#### Configure Postfix

```bash
postconf -e "myhostname = yourdomain.com"
postconf -e "myorigin = yourdomain.com"
postconf -e "inet_interfaces = loopback-only"
postconf -e "inet_protocols = ipv4"
postconf -e "milter_protocol = 6"
postconf -e "milter_default_action = accept"
postconf -e "smtpd_milters = inet:127.0.0.1:8891"
postconf -e "non_smtpd_milters = inet:127.0.0.1:8891"
```

#### Start the services

Debian/Ubuntu:
```bash
systemctl restart postfix opendkim
```

Alpine Linux:
```bash
rc-service opendkim restart
rc-service postfix restart
```

#### Add DNS records

These records tell receiving mail servers that your Spindle instance is authorized to send email and has not been tampered with.

| Type | Name | Value |
|---|---|---|
| PTR | your server IP | `yourdomain.com` (set in your VPS control panel) |
| TXT | `yourdomain.com` | `v=spf1 ip4:YOUR_SERVER_IP -all` |
| TXT | `mail._domainkey.yourdomain.com` | contents of `/etc/opendkim/keys/yourdomain.com/mail.txt` (one continuous string, no quotes or parentheses) |
| TXT | `_dmarc.yourdomain.com` | `v=DMARC1; p=none;` |

View your generated DKIM record with:
```bash
cat /etc/opendkim/keys/yourdomain.com/mail.txt
```

Paste the `p=...` value as a single unbroken string in your DNS panel.

#### Configure Spindle to use local Postfix

In your `.env`:
```
SYSTEM_SMTP_HOST=127.0.0.1
SYSTEM_SMTP_PORT=25
SYSTEM_SMTP_USER=
SYSTEM_SMTP_PASS=
SYSTEM_FROM_EMAIL=Spindle <noreply@yourdomain.com>
```

When `SYSTEM_SMTP_USER` and `SYSTEM_SMTP_PASS` are blank, Spindle skips SMTP authentication automatically, which is correct for a local Postfix relay.

### 5. Start the server

```bash
npm start
```

The server starts on `http://localhost:3000` by default (or the `PORT` you set in `.env`).

### 6. Create the first account

Navigate to `/auth` in your browser and register. **The first registered user is automatically granted admin privileges.** You will be prompted for an invite code -- generate one via the API before registering:

```bash
curl -s -X POST http://localhost:3000/api/admin/invite-codes
```

The response contains a `XXXX-XXXX-XXXX` hex code ready to use. Once logged in, all subsequent invite codes can be generated and managed from the **admin panel** in the sidebar.

---

## Security

Spindle is built with security as a first-class concern:

- **AES-256-GCM encryption:** all IMAP passwords and OAuth tokens are encrypted with a key that never leaves your server. Even if the database file is compromised, credentials cannot be read without the `ENCRYPTION_KEY`.
- **Bcrypt password hashing:** user passwords are hashed with bcrypt at 12 rounds before storage. Plaintext passwords are never written anywhere.
- **Session-based auth:** sessions are stored in the SQLite database; cookies are `httpOnly`, `sameSite: lax`, and `secure` in production. No session files are written to disk.
- **Invite-only registration:** new accounts require a one-time `XXXX-XXXX-XXXX` hex invite code generated by an admin. Codes are permanently deleted from the database after use and cannot be reused.
- **Content Security Policy:** HTTP security headers set via `helmet`, including a strict CSP that blocks inline scripts from external origins.
- **Rate limiting:** authentication mutation endpoints (login, register, recovery) are rate-limited to 20 requests per 15 minutes per IP. The session check endpoint is excluded.
- **HTML sanitization:** incoming email HTML is sanitized with DOMPurify before rendering, and displayed in a sandboxed `<iframe>` to prevent script injection.
- **OAuth CSRF protection:** a cryptographic `state` parameter is validated on every OAuth callback.
- **CSRF tokens:** all state-changing API requests require a per-session CSRF token supplied as the `X-CSRF-Token` header.

---

## Running Behind a Reverse Proxy

Spindle supports nginx (or any reverse proxy) out of the box. `app.set('trust proxy', 1)` is already configured so rate limiting uses real client IPs from `X-Forwarded-For`. Make sure your proxy forwards the `Host` and `X-Forwarded-Proto` headers.

Example nginx block:

```nginx
server {
    listen 443 ssl;
    server_name mail.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Development

```bash
npm run dev   # starts with nodemon; watches src/ and server.js only
```

The database is created automatically at `./data/spindle.db` on first run. Sessions are stored in the same SQLite database -- no session files are written to disk.
