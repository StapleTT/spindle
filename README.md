<img src="public/img/spindle_banner.png" alt="Spindle" width="100%">

Spindle is a self-hosted, centralized email client. Connect Gmail, Outlook, iCloud, Yahoo, or any standard IMAP/SMTP provider and manage all your accounts from a single interface on your own server.

---

## Features

- **Multi-account inbox:** read accounts individually or through a unified All Inboxes view
- **OAuth 2.0 for Gmail and Outlook:** one-click connect; no password stored, tokens encrypted at rest
- **IMAP/SMTP for everything else:** iCloud, Yahoo, and any standard mail server; credentials AES-256-GCM encrypted
- **Compose, reply, forward:** full compose window with Cc/Bcc, reply-all, and forward; sends via Gmail API, Microsoft Graph, or SMTP
- **Attachments:** read, download, and send attachments across all providers (10 MB per file, 25 MB total)
- **Search:** search by sender, recipient, subject, or full text across one inbox or all accounts at once
- **Folder trees:** browse any folder or label per account with per-folder unread counts
- **Account recovery:** password reset links sent to a registered recovery email
- **Invite-only registration:** accounts require an admin-issued `XXXX-XXXX-XXXX` invite code
- **Admin panel:** manage users, pause accounts, issue and revoke invite codes
- **Dark/light/system theme:** follows OS preference by default, overrideable per user
- **Keyboard shortcuts:** `c` compose, `r` reply, `e` archive, `#` delete, `u` mark unread, `/` search

---

## How It Works

Spindle runs as a Node.js/Express server. The backend speaks IMAP (via `imap-simple`) and the Gmail/Microsoft Graph APIs directly -- email never touches a third-party proxy. A SQLite database (Node's built-in `node:sqlite`, no native compilation required) stores accounts, sessions, and user preferences. All credentials and OAuth tokens are AES-256-GCM encrypted before being written to disk.

The frontend is plain HTML, CSS, and vanilla JavaScript with no framework and no build step.

```
Browser  -->  Express (server.js)
                ├── /api/auth        login, registration, recovery
                ├── /api/accounts    add/remove/reorder email accounts
                ├── /api/email       read, send, archive, delete, search
                ├── /api/oauth       Gmail and Outlook OAuth flows
                ├── /api/settings    theme, images, account deletion
                └── /api/admin       user management, invite codes
```

---

## Requirements

- **Node.js 22.5 or later** -- required for the built-in `node:sqlite` module
- A Linux, macOS, or Windows server or machine to host it on
- Gmail and/or Outlook OAuth credentials (optional, required only for those providers)
- A local MTA such as Postfix (optional, required only for password recovery emails)

---

## Quick Start

```bash
git clone https://github.com/StapleTT/spindle.git
cd spindle
npm install
cp .env.example .env
# edit .env, then:
npm start
```

The server starts on `http://localhost:3000` by default. The first registered user is automatically granted admin privileges. Generate an invite code before registering:

```bash
curl -s -X POST http://localhost:3000/api/admin/invite-codes
```

For full setup instructions, see the [wiki](wiki/Home.md).

---

## Security

- AES-256-GCM encryption for all stored credentials and OAuth tokens
- Bcrypt password hashing (12 rounds)
- Session cookies: `httpOnly`, `sameSite: lax`, `secure` in production
- Invite-only registration with single-use codes
- Strict Content Security Policy via `helmet`
- Rate limiting on all auth mutation endpoints (20 requests per 15 minutes per IP)
- HTML email sanitized with DOMPurify and rendered in a sandboxed `<iframe>`
- CSRF tokens required on all state-changing API requests
- Cryptographic `state` parameter validated on every OAuth callback

---

## Development

```bash
npm run dev   # nodemon, watches src/ and server.js only
```

The database is created automatically at `./data/spindle.db` on first run.
