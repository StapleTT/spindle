# Spindle — Centralized Email Client
## CLAUDE.md · Project Roadmap & Implementation Checklist

> **Stack:** Node.js (Express) · SQLite (`node:sqlite` built-in, Node ≥ 22.5) · Vanilla JS frontend (no framework)
> **Auth:** Session-based (express-session + session-file-store)
> **Email protocols:** IMAP (imap-simple) · SMTP (nodemailer) · OAuth2 (Gmail, Outlook)
> **Design:** Refer to the Spindle Prototype HTML for all UI/UX decisions. If unavailable, match a clean two-panel email client layout (sidebar + email list + reading pane).
> **SQLite note:** Uses `node:sqlite` (built into Node 22.5+) — zero native deps, no compilation needed on Windows or Linux. `better-sqlite3` and `connect-sqlite3` are NOT used.

---

## ⚠️ Notes Before Starting

- The design prototype URL returned a 404 at project creation time. Before creating any web page content, ask for the Claude Design URL.
- All secrets (OAuth client IDs, session secrets, SMTP credentials) must go in a `.env` file. Never commit `.env`.
- Run `npm install` before starting. See `package.json` for all dependencies.
- SQLite DB file lives at `./data/spindle.db` — created automatically on first run.
- All passwords must be hashed with **bcrypt** (12 rounds minimum).
- The first registered user is automatically assigned `role = 'admin'`.

---

## Project Structure (Target)

```
spindle/
├── CLAUDE.md
├── .env.example
├── .gitignore
├── package.json
├── server.js                  # Entry point
├── data/
│   └── spindle.db             # Auto-created SQLite database
├── src/
│   ├── db/
│   │   ├── schema.js          # DB init & migrations
│   │   └── queries.js         # All prepared statements
│   ├── routes/
│   │   ├── auth.js            # Login, register, logout, recovery
│   │   ├── email.js           # Read, send, actions (mark/archive/delete/etc.)
│   │   ├── accounts.js        # Add/remove/reorder inbox accounts
│   │   ├── admin.js           # Admin-only: users, invite codes
│   │   └── settings.js        # User settings (theme, delete account)
│   ├── middleware/
│   │   ├── requireAuth.js     # Session check middleware
│   │   └── requireAdmin.js    # Admin role check middleware
│   ├── services/
│   │   ├── imap.js            # IMAP connection pool & fetch logic
│   │   ├── smtp.js            # SMTP send via nodemailer
│   │   ├── oauth/
│   │   │   ├── gmail.js       # Gmail OAuth2 flow
│   │   │   └── outlook.js     # Outlook OAuth2 flow
│   │   └── recovery.js        # Password recovery email sender
│   └── utils/
│       ├── crypto.js          # Token generation (invite codes, recovery tokens)
│       └── sanitize.js        # HTML email sanitization (DOMPurify server-side)
└── public/
    ├── index.html             # Main app shell (requires login)
    ├── auth.html             # Login / Register page
    ├── recovery.html          # Account recovery page
    ├── css/
    │   ├── main.css           # Base styles, CSS variables, light/dark themes
    │   ├── layout.css         # Three-panel layout
    │   ├── components.css     # Buttons, modals, forms, badges
    │   └── email.css          # Email list rows, reading pane styles
    └── js/
        ├── app.js             # Main app init, routing, state
        ├── sidebar.js         # Sidebar: account list, folder nav
        ├── emailList.js       # Email list panel rendering & pagination
        ├── reader.js          # Email reading pane, web content rendering
        ├── composer.js        # Compose window: new/reply/forward
        ├── accounts.js        # Add inbox modal & OAuth redirect handling
        ├── settings.js        # Settings panel interactions
        ├── admin.js           # Admin panel (users + invite codes)
        └── api.js             # Centralized fetch wrapper for all API calls
```

---

## Phase 1 — Project Scaffold & Database

### 1.1 Project Init
- [x] `package.json` with all dependencies listed below
- [x] `.env.example` with all required env vars documented
- [x] `.gitignore` (node_modules, .env, data/*.db)
- [x] `server.js` entry point with Express app, session middleware, static files, route mounting

**Dependencies installed:**
```
express express-session session-file-store
bcrypt nodemailer imap-simple mailparser
googleapis @azure/msal-node
dotenv helmet cors express-rate-limit
isomorphic-dompurify
```
_(node:sqlite is built into Node ≥ 22.5 — no package needed)_

### 1.2 Database Schema (`src/db/schema.js`)
Create all tables on startup if they don't exist:

- [x] **users** table
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `username` TEXT UNIQUE NOT NULL
  - `password_hash` TEXT NOT NULL
  - `recovery_email` TEXT
  - `role` TEXT DEFAULT 'user' — set to `'admin'` for user id=1
  - `theme` TEXT DEFAULT 'light'
  - `invite_code_used` TEXT — the code they registered with
  - `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP

- [x] **invite_codes** table
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `code` TEXT UNIQUE NOT NULL
  - `created_by` INTEGER REFERENCES users(id)
  - `used_by` INTEGER REFERENCES users(id) — NULL if unused
  - `revoked` INTEGER DEFAULT 0
  - `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP

- [x] **email_accounts** table
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `user_id` INTEGER REFERENCES users(id) ON DELETE CASCADE
  - `display_name` TEXT
  - `email_address` TEXT NOT NULL
  - `provider` TEXT — 'imap', 'gmail', 'outlook', 'yahoo', 'icloud'
  - `sort_order` INTEGER DEFAULT 0
  - `imap_host` TEXT
  - `imap_port` INTEGER
  - `imap_secure` INTEGER DEFAULT 1
  - `smtp_host` TEXT
  - `smtp_port` INTEGER
  - `smtp_secure` INTEGER DEFAULT 1
  - `imap_user` TEXT
  - `imap_password_encrypted` TEXT — AES-256 encrypted, key from env
  - `oauth_access_token` TEXT
  - `oauth_refresh_token` TEXT
  - `oauth_token_expiry` DATETIME
  - `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP

- [x] **recovery_tokens** table
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `user_id` INTEGER REFERENCES users(id) ON DELETE CASCADE
  - `token_hash` TEXT NOT NULL
  - `expires_at` DATETIME NOT NULL
  - `used` INTEGER DEFAULT 0

- [x] `src/db/queries.js` — all DB operations as prepared statements (no raw SQL in routes)

---

## Phase 2 — Authentication

### 2.1 Registration (`POST /api/auth/register`)
- [ ] Validate invite code exists, is unused, and is not revoked
- [ ] Check username is unique
- [ ] Hash password with bcrypt (12 rounds)
- [ ] Insert user; if `SELECT COUNT(*) FROM users` was 0, set role to `'admin'`
- [ ] Mark invite code as used (`used_by = new user id`)
- [ ] Store `invite_code_used` on user record
- [ ] Auto-login after registration (create session)

### 2.2 Login (`POST /api/auth/login`)
- [ ] Find user by username
- [ ] bcrypt.compare password
- [ ] Create session with `req.session.userId` and `req.session.role`
- [ ] Return user info (id, username, role, theme)

### 2.3 Logout (`POST /api/auth/logout`)
- [ ] Destroy session

### 2.4 Session Check (`GET /api/auth/me`)
- [ ] Return current user info if session exists, else 401

### 2.5 Auth Middleware (`src/middleware/requireAuth.js`)
- [ ] Check `req.session.userId` — if missing, return 401
- [ ] Attach `req.user` from DB lookup

### 2.6 Admin Middleware (`src/middleware/requireAdmin.js`)
- [ ] Check `req.user.role === 'admin'` — if not, return 403

### 2.7 Frontend Auth Pages
- [x] `public/auth.html` — login form + register form (toggle between)
- [x] Register form includes invite code field
- [x] Client-side validation before submit
- [x] Redirect to `index.html` on success; show error messages inline on failure

---

## Phase 3 — Account Recovery

### 3.1 Recovery Request (`POST /api/auth/recovery/request`)
- [ ] Accept `username` + `recovery_email`
- [ ] Look up user by username; verify `recovery_email` matches (case-insensitive)
- [ ] If match: generate a secure random token, hash it, store in `recovery_tokens` with 1-hour expiry
- [ ] Send recovery email via nodemailer using a configured system SMTP account (env vars)
- [ ] **Always return a generic success message** regardless of whether user was found (prevent enumeration)

### 3.2 Recovery Token Validation & Password Reset
- [ ] `GET /recovery?token=...` — serve `public/recovery.html` with token in URL
- [ ] `POST /api/auth/recovery/reset` — accept `token` + `new_password`
  - Find matching unused, unexpired token
  - Hash new password, update user
  - Mark token as used
  - Return success

### 3.3 Frontend Recovery Page
- [ ] `public/recovery.html` — two states:
  1. Request form: username + recovery email fields
  2. Reset form: shown when `?token=` is in URL — new password + confirm

---

## Phase 4 — Email Account Management

### 4.1 Add Account Modal (Frontend)
- [ ] Provider selection screen: Gmail, Outlook, Yahoo, iCloud, Custom IMAP
- [ ] **OAuth providers (Gmail, Outlook):** Show "Connect with Google/Microsoft" button → redirect to OAuth flow
- [ ] **IMAP/SMTP providers:** Form with fields:
  - Display name, Email address
  - IMAP host, port, TLS toggle
  - SMTP host, port, TLS toggle
  - Username, Password
- [ ] Pre-fill known IMAP/SMTP settings for Yahoo (`imap.mail.yahoo.com:993`) and iCloud (`imap.mail.me.com:993`)
- [ ] Test connection before saving (call `POST /api/accounts/test`)
- [ ] On success, add to sidebar without page reload

### 4.2 IMAP/SMTP Account API (`src/routes/accounts.js`)
- [ ] `GET /api/accounts` — list all accounts for logged-in user (no credentials in response)
- [ ] `POST /api/accounts` — add new IMAP/SMTP account; encrypt password before storing
- [ ] `POST /api/accounts/test` — test IMAP connection; return success/failure with error message
- [ ] `DELETE /api/accounts/:id` — remove account (verify ownership)
- [ ] `PATCH /api/accounts/reorder` — accept array of `{id, sort_order}` pairs, update in bulk

### 4.3 Gmail OAuth Flow (`src/services/oauth/gmail.js`)
- [ ] `GET /api/oauth/gmail/init` — generate Google OAuth URL with scopes: `gmail.readonly`, `gmail.send`, `gmail.modify`; redirect user
- [ ] `GET /api/oauth/gmail/callback` — exchange code for tokens; store encrypted refresh token; redirect to app
- [ ] Token refresh logic: check expiry before each API call, refresh if needed

### 4.4 Outlook OAuth Flow (`src/services/oauth/outlook.js`)
- [ ] `GET /api/oauth/outlook/init` — MSAL redirect to Microsoft login
- [ ] `GET /api/oauth/outlook/callback` — exchange code for tokens; store; redirect
- [ ] Token refresh logic using MSAL refresh token

### 4.5 Credential Encryption (`src/utils/crypto.js`)
- [ ] AES-256-GCM encryption/decryption for stored IMAP passwords and OAuth tokens
- [ ] Encryption key loaded from `ENCRYPTION_KEY` env var (32-byte hex)

---

## Phase 5 — Email Reading (IMAP + Gmail API + Outlook API)

### 5.1 IMAP Service (`src/services/imap.js`)
- [ ] Connection pool keyed by `email_account_id` — reuse open connections
- [ ] `fetchMessages(accountId, folder, options)` — fetch message list with headers (from, subject, date, read status, flags)
- [ ] `fetchMessage(accountId, folder, uid)` — fetch full message (headers + body, text + HTML parts)
- [ ] `fetchFolders(accountId)` — list all IMAP mailboxes/folders
- [ ] `markRead(accountId, folder, uid, isRead)` — set/unset \Seen flag
- [ ] `archiveMessage(accountId, folder, uid)` — move to Archive folder (create if absent)
- [ ] `deleteMessage(accountId, folder, uid)` — move to Trash / expunge
- [ ] `moveMessage(accountId, fromFolder, toFolder, uid)` — generic move

### 5.2 Email Routes (`src/routes/email.js`)
- [ ] `GET /api/email/:accountId/folders` — list folders
- [ ] `GET /api/email/:accountId/messages?folder=INBOX&page=1&limit=50` — paginated message list
- [ ] `GET /api/email/:accountId/messages/:uid?folder=INBOX` — full message fetch; mark as read on open
- [ ] `PATCH /api/email/:accountId/messages/:uid/read` — toggle read/unread
- [ ] `POST /api/email/:accountId/messages/:uid/archive` — archive
- [ ] `DELETE /api/email/:accountId/messages/:uid` — delete (move to trash)
- [ ] `GET /api/email/unified?page=1&limit=50` — fetch recent messages across all accounts, merge & sort by date

### 5.3 Gmail API Service
- [ ] Use `googleapis` to call Gmail REST API instead of IMAP for Gmail accounts
- [ ] Implement same interface as IMAP service (fetchMessages, fetchMessage, markRead, archive, delete)
- [ ] Handle pagination with `nextPageToken`

### 5.4 Outlook API Service
- [ ] Use Microsoft Graph API (`https://graph.microsoft.com/v1.0/me/messages`)
- [ ] Implement same interface as IMAP service
- [ ] Handle pagination with `@odata.nextLink`

### 5.5 Email Sanitization
- [ ] All HTML email bodies must be sanitized with `isomorphic-dompurify` before sending to client
- [ ] Strip `<script>`, event handlers, external image tracking pixels (or make them opt-in)
- [ ] Render sanitized HTML in an isolated `<iframe srcdoc>` in the reading pane

---

## Phase 6 — Email Sending (SMTP + Gmail API + Outlook API)

### 6.1 SMTP Service (`src/services/smtp.js`)
- [ ] Create nodemailer transporter per account (using decrypted credentials)
- [ ] `sendEmail(accountId, {to, cc, bcc, subject, body, replyTo, attachments})`

### 6.2 Compose API (`POST /api/email/:accountId/send`)
- [ ] Validate `from` account belongs to logged-in user
- [ ] Accept: `to`, `cc`, `bcc`, `subject`, `body` (HTML), `replyToMessageId` (for threading)
- [ ] For Gmail accounts: use Gmail API `users.messages.send` with base64 MIME
- [ ] For Outlook accounts: use Graph API `POST /me/sendMail`
- [ ] For IMAP accounts: use nodemailer SMTP
- [ ] Copy sent message to Sent folder (IMAP APPEND or via API)

### 6.3 Compose Window (Frontend — `public/js/composer.js`)
- [ ] Floating compose window (draggable, minimizable)
- [ ] **From:** dropdown — select which account/address to send from
- [ ] **To:** tag-input field (type email, press Enter/comma to add)
- [ ] **Cc / Bcc:** toggle fields (hidden by default, button to show)
- [ ] **Subject:** plain text input
- [ ] **Body:** rich text editor (use Quill.js or Trix — load from CDN)
- [ ] Reply mode: pre-populate To, Subject (Re:), quote original body
- [ ] Forward mode: pre-populate Subject (Fwd:), quote original body, To is empty
- [ ] Send button → `POST /api/email/:accountId/send` → close composer on success

---

## Phase 7 — Frontend App Shell

### 7.1 Layout (`public/index.html`, `public/css/layout.css`)
- [ ] Three-panel layout:
  1. **Left sidebar** (~220px): Spindle logo, account list with folder tree, Compose button
  2. **Center panel** (~340px): Email list for selected folder/account
  3. **Right panel** (flex-grow): Email reading pane
- [ ] Responsive collapse: on narrow viewports, panels slide (sidebar → list → reader)
- [ ] CSS custom properties for all colors; `[data-theme="dark"]` on `<html>` for dark mode
- [ ] Smooth transitions on theme change (CSS transition on background-color, color)

### 7.2 Sidebar (`public/js/sidebar.js`)
- [ ] Load accounts via `GET /api/accounts` on app init
- [ ] Render each account with its email address, provider icon, unread count badge
- [ ] Expandable folder tree per account (Inbox, Sent, Drafts, Archive, Trash, custom)
- [ ] "All Inboxes" unified view at the top
- [ ] "+ Add Account" button at bottom → opens Add Account modal
- [ ] Active folder highlighted

### 7.3 Email List (`public/js/emailList.js`)
- [ ] Render list of messages (sender name, subject, preview snippet, date, read/unread indicator)
- [ ] Unread messages visually distinct (bold, dot indicator)
- [ ] Click row → load full message in reading pane; mark as read
- [ ] Right-click / swipe → context menu: Mark unread, Archive, Delete
- [ ] Infinite scroll or pagination (load more button)
- [ ] Loading skeleton while fetching

### 7.4 Reading Pane (`public/js/reader.js`)
- [ ] Display: From (with avatar initial), To, Cc, Subject, Date
- [ ] Render sanitized HTML body in `<iframe srcdoc>` (isolated)
- [ ] Action toolbar: Reply · Reply All · Forward · Archive · Delete · Mark Unread
- [ ] "Show images" toggle (block remote images by default)
- [ ] Thread view: collapsible previous messages below current

### 7.5 Global State & API (`public/js/app.js`, `public/js/api.js`)
- [ ] `api.js`: thin fetch wrapper — handles auth errors (redirect to login on 401), JSON parsing, error toasts
- [ ] `app.js`: global state (currentAccount, currentFolder, currentMessage, user, theme)
- [ ] On load: call `GET /api/auth/me` — redirect to `auth.html` if 401
- [ ] Theme: read from user record; apply `data-theme` attribute; persist via `PATCH /api/settings/theme`

---

## Phase 8 — Settings Panel

### 8.1 Settings Routes (`src/routes/settings.js`)
- [ ] `PATCH /api/settings/theme` — toggle `'light'` / `'dark'`; update DB; return new theme
- [ ] `DELETE /api/settings/account` — delete user account; require `password` in body (bcrypt verify); cascade deletes all email_accounts

### 8.2 Settings UI (`public/js/settings.js`)
- [ ] Slide-in settings panel (triggered from gear icon in sidebar)
- [ ] **Appearance section:** Light/Dark mode toggle switch
- [ ] **Inboxes section:** List all connected inboxes with drag-to-reorder (use SortableJS from CDN); delete button per inbox (confirm dialog)
- [ ] **Danger Zone section:**
  - "Delete Account" button → modal: enter password to confirm → `DELETE /api/settings/account` → logout and redirect to login

---

## Phase 9 — Admin Panel

### 9.1 Admin Routes (`src/routes/admin.js`)
- [ ] All routes protected by `requireAdmin` middleware
- [ ] `GET /api/admin/users` — list all users: id, username, role, created_at, invite_code_used
- [ ] `GET /api/admin/invite-codes` — list all codes: code, created_at, used_by username (or null), revoked status
- [ ] `POST /api/admin/invite-codes` — generate new invite code (random 12-char alphanumeric); store with `created_by = req.user.id`
- [ ] `DELETE /api/admin/invite-codes/:code` — revoke code (set `revoked = 1`)

### 9.2 Admin UI (`public/js/admin.js`)
- [ ] Admin section only rendered if `user.role === 'admin'` (server enforces; client just hides UI)
- [ ] **Users tab:** Table showing username, joined date, invite code used
- [ ] **Invite Codes tab:**
  - Table of all active codes: code value (monospace), created date, used by (username or "Unused")
  - "Generate Code" button → POST → append to table
  - "Revoke" button per code → DELETE → remove from table

---

## Phase 10 — Security Hardening

- [ ] `helmet()` middleware — sets security headers (CSP, HSTS, X-Frame-Options, etc.)
- [ ] `express-rate-limit` on all `/api/auth/*` routes (max 10 req/15min per IP)
- [ ] CSRF protection for state-changing routes (use `csurf` or double-submit cookie pattern)
- [ ] All DB queries use prepared statements (no string concatenation)
- [ ] Validate and sanitize all user inputs server-side (check types, lengths, formats)
- [ ] OAuth `state` parameter validated on callback (prevent CSRF on OAuth flow)
- [ ] Recovery tokens expire after 1 hour; one-time use only
- [ ] Invite codes are cryptographically random (use `crypto.randomBytes`)
- [ ] Session cookie: `httpOnly: true`, `secure: true` (in production), `sameSite: 'lax'`
- [ ] Encryption key for stored credentials loaded from env, never hardcoded
- [ ] Never return password hashes or raw OAuth tokens in API responses

---

## Phase 11 — Polish & UX

- [ ] Toast notification system (success, error, info) — vanilla JS, CSS animations
- [ ] Loading states on all async actions (spinner on buttons, skeleton loaders on lists)
- [ ] Empty states (no emails, no accounts added yet) with helpful prompts
- [ ] Error boundary: if one account fails to load, show error inline for that account only (don't break others)
- [ ] Keyboard shortcuts: `c` = compose, `r` = reply, `e` = archive, `#` = delete, `u` = mark unread, `/` = search (future)
- [ ] Favicon + `<title>` update with unread count ("(12) Spindle")

---

## Environment Variables (`.env.example`)

```
# Server
PORT=3000
SESSION_SECRET=change_me_to_a_random_string
ENCRYPTION_KEY=64_char_hex_string_for_aes256

# System SMTP (for sending recovery emails)
SYSTEM_SMTP_HOST=smtp.example.com
SYSTEM_SMTP_PORT=587
SYSTEM_SMTP_USER=noreply@yourdomain.com
SYSTEM_SMTP_PASS=yourpassword
SYSTEM_FROM_EMAIL=Spindle <noreply@yourdomain.com>

# App URL (used for OAuth callbacks and recovery links)
APP_URL=http://localhost:3000

# Gmail OAuth (Google Cloud Console)
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
# Callback: APP_URL/api/oauth/gmail/callback

# Outlook OAuth (Azure App Registration)
OUTLOOK_CLIENT_ID=
OUTLOOK_CLIENT_SECRET=
OUTLOOK_TENANT_ID=common
# Callback: APP_URL/api/oauth/outlook/callback
```

---

## Implementation Order (Recommended for Claude Code)

Work through phases in this order. Each phase is independently testable before moving on.

1. **Phase 1** — Scaffold, package.json, server.js, DB schema
2. **Phase 2** — Auth routes + login/register UI (get sessions working)
3. **Phase 3** — Recovery flow
4. **Phase 7 (partial)** — App shell HTML/CSS layout + `api.js` (so you have a UI to test against)
5. **Phase 4** — Account management (IMAP/SMTP first; OAuth second)
6. **Phase 5** — Email reading (IMAP first; Gmail/Outlook API second)
7. **Phase 6** — Compose/send
8. **Phase 7 (complete)** — Wire up all frontend JS modules
9. **Phase 8** — Settings panel
10. **Phase 9** — Admin panel
11. **Phase 10** — Security hardening (apply throughout, finalize here)
12. **Phase 11** — Polish

---

## Status Legend

- `[ ]` Not started
- `[~]` In progress
- `[x]` Complete
- `[!]` Blocked / needs attention

---

## Known Issues / Decisions Pending

- [ ] **Design prototype inaccessible** — URL returned 404. Implement standard three-panel email layout until prototype is available. When accessible, update CSS to match.
- [ ] **Attachment support** — Reading and downloading attachments is not in initial scope. Add `[FUTURE]` placeholder in reader.js.
- [ ] **Search** — Full-text email search not in initial scope. IMAP SEARCH command available for future implementation.
- [ ] **Push notifications** — Real-time new email alerts not in scope (would require IMAP IDLE or polling). Add polling every 60s as a baseline.
- [ ] **Mobile responsive** — Desktop-first. Basic responsive breakpoints for tablet/mobile as a stretch goal.
