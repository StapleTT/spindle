# Spindle — Centralized Email Client
## CLAUDE.md · Project Roadmap & Implementation Checklist

> **Stack:** Node.js (Express) · SQLite (`node:sqlite` built-in, Node ≥ 22.5) · Vanilla JS frontend (no framework)
> **Auth:** Session-based (express-session + session-file-store)
> **Email protocols:** IMAP (imap-simple) · SMTP (nodemailer) · OAuth2 (Gmail, Outlook)
> **Design:** Spindle Prototype obtained from Claude Design and implemented. See `data/design-dump.txt` for full bundle.
> **SQLite note:** Uses `node:sqlite` (built into Node 22.5+) — zero native deps, no compilation needed on Windows or Linux. `better-sqlite3` and `connect-sqlite3` are NOT used.

---

## ⚠️ Notes Before Starting

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
│   ├── spindle.db             # Auto-created SQLite database
│   └── design-dump.txt        # Full Claude Design prototype bundle
├── src/
│   ├── db/
│   │   ├── schema.js          # DB init & migrations
│   │   └── queries.js         # All prepared statements
│   ├── routes/
│   │   ├── auth.js            # Login, register, logout, recovery
│   │   ├── email.js           # Read, send, actions (mark/archive/delete/etc.)
│   │   ├── accounts.js        # Add/remove/reorder inbox accounts
│   │   ├── oauth.js           # Gmail + Outlook OAuth flows
│   │   ├── admin.js           # Admin-only: users, invite codes (STUB)
│   │   └── settings.js        # User settings (theme, images, delete account)
│   ├── middleware/
│   │   ├── requireAuth.js     # Session check middleware
│   │   └── requireAdmin.js    # Admin role check middleware
│   ├── services/
│   │   ├── imap.js            # IMAP connection pool & fetch logic
│   │   ├── smtp.js            # SMTP send via nodemailer
│   │   ├── oauth/
│   │   │   ├── gmail.js       # Gmail OAuth2 flow
│   │   │   └── outlook.js     # Outlook OAuth2 flow + graphFetch helper
│   │   └── recovery.js        # Password recovery email sender
│   └── utils/
│       ├── crypto.js          # AES-256-GCM encryption + token generation
│       └── sanitize.js        # HTML email sanitization (DOMPurify server-side)
└── public/
    ├── index.html             # Homepage (auth-aware, light/dark, animations)
    ├── inbox.html             # Main app shell (requires login)
    ├── auth.html              # Login / Register page
    ├── recovery.html          # Account recovery page
    ├── privacy-policy.html    # Privacy Policy (Google OAuth verification)
    ├── tos.html               # Terms of Service
    ├── 404.html               # 404 error page
    ├── css/
    │   ├── main.css           # Base styles, CSS variables, light/dark themes
    │   ├── home.css           # Homepage-specific styles & animations
    │   ├── layout.css         # Three-panel layout
    │   ├── components.css     # Buttons, modals, forms, badges
    │   └── email.css          # Email list rows, reading pane styles
    └── js/
        ├── app.js             # Main app init, routing, state
        ├── home.js            # Homepage auth check script
        ├── sidebar.js         # Sidebar: account list, folder nav
        ├── emailList.js       # Email list panel rendering & pagination
        ├── reader.js          # Email reading pane, web content rendering
        ├── composer.js        # Compose window: new/reply/forward
        ├── accounts.js        # Add inbox modal & OAuth redirect handling
        ├── settings.js        # Settings panel interactions
        ├── admin.js           # Admin panel (stub)
        └── api.js             # Centralized fetch wrapper + Toast system
```

---

## Phase 1 — Project Scaffold & Database

### 1.1 Project Init
- [x] `package.json` with all dependencies listed below
- [x] `.env.example` with all required env vars documented
- [x] `.gitignore` (node_modules, .env, data/*.db)
- [x] `server.js` entry point with Express app, session middleware, static files, route mounting
- [x] `trust proxy` set for nginx reverse-proxy support
- [x] `nodemonConfig` in package.json — watches only `src/` and `server.js`; ignores `data/`, `public/`, `node_modules/`

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
  - `theme` TEXT DEFAULT 'system'
  - `auto_load_images` INTEGER DEFAULT 0 — migrated in on boot if absent
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
  - `imap_password_encrypted` TEXT — AES-256-GCM encrypted, key from env
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
- [x] Validate invite code exists, is unused, and is not revoked
- [x] Check username is unique
- [x] Hash password with bcrypt (12 rounds)
- [x] Insert user; if `SELECT COUNT(*) FROM users` was 0, set role to `'admin'`
- [x] Mark invite code as used (`used_by = new user id`)
- [x] Store `invite_code_used` on user record
- [x] Auto-login after registration (create session)

### 2.2 Login (`POST /api/auth/login`)
- [x] Find user by username
- [x] bcrypt.compare password
- [x] Create session with `req.session.userId` and `req.session.role`
- [x] Return user info (id, username, role, theme, auto_load_images)

### 2.3 Logout (`POST /api/auth/logout`)
- [x] Destroy session

### 2.4 Session Check (`GET /api/auth/me`)
- [x] Return current user info if session exists, else 401
- [x] Returns: id, username, role, theme, auto_load_images

### 2.5 Auth Middleware (`src/middleware/requireAuth.js`)
- [x] Check `req.session.userId` — if missing, return 401
- [x] Attach `req.user` from DB lookup

### 2.6 Admin Middleware (`src/middleware/requireAdmin.js`)
- [x] Check `req.user.role === 'admin'` — if not, return 403

### 2.7 Frontend Auth Pages
- [x] `public/auth.html` — login form + register form (toggle between)
- [x] Register form includes invite code field
- [x] Client-side validation before submit
- [x] Redirect to `/inbox` on success; show error messages inline on failure

---

## Phase 3 — Account Recovery

### 3.1 Recovery Request (`POST /api/auth/recovery/request`)
- [x] Accept `username` + `recovery_email`
- [x] Look up user by username; verify `recovery_email` matches (case-insensitive)
- [x] If match: generate a secure random token, hash it, store in `recovery_tokens` with 1-hour expiry
- [x] Send recovery email via nodemailer using a configured system SMTP account (env vars)
- [x] **Always return a generic success message** regardless of whether user was found (prevent enumeration)

### 3.2 Recovery Token Validation & Password Reset
- [x] `GET /recovery?token=...` — serve `public/recovery.html` with token in URL
- [x] `POST /api/auth/recovery/reset` — accept `token` + `new_password`
  - Find matching unused, unexpired token
  - Hash new password, update user
  - Mark token as used
  - Return success

### 3.3 Frontend Recovery Page
- [x] `public/recovery.html` — two states:
  1. Request form: username + recovery email fields
  2. Reset form: shown when `?token=` is in URL — new password + confirm

---

## Phase 4 — Email Account Management

### 4.1 Add Account Modal (Frontend)
- [x] Provider selection screen: Gmail, Outlook, Yahoo, iCloud, Custom IMAP
- [x] **OAuth providers (Gmail, Outlook):** Show "Connect with Google/Microsoft" button → redirect to OAuth flow
- [x] **IMAP/SMTP providers:** Form with fields:
  - Display name, Email address
  - IMAP host, port, TLS toggle
  - SMTP host, port, TLS toggle
  - Username, Password
- [x] Pre-fill known IMAP/SMTP settings for Yahoo (`imap.mail.yahoo.com:993`) and iCloud (`imap.mail.me.com:993`)
- [x] Test connection before saving (call `POST /api/accounts/test`)
- [x] On success, add to sidebar without page reload
- [x] After OAuth connect: show display name modal before adding to sidebar

### 4.2 IMAP/SMTP Account API (`src/routes/accounts.js`)
- [x] `GET /api/accounts` — list all accounts for logged-in user (no credentials in response)
- [x] `POST /api/accounts` — add new IMAP/SMTP account; encrypt password before storing
- [x] `POST /api/accounts/test` — test IMAP connection; return success/failure with error message
- [x] `DELETE /api/accounts/:id` — remove account (verify ownership, require password)
- [x] `PATCH /api/accounts/:id` — update display name
- [x] `PATCH /api/accounts/reorder` — update sort order for multiple accounts

### 4.3 Gmail OAuth Flow (`src/services/oauth/gmail.js` + `src/routes/oauth.js`)
- [x] `GET /api/oauth/gmail/init` — generate Google OAuth URL with scopes: `gmail.readonly`, `gmail.send`, `gmail.modify`; redirect user
- [x] `GET /api/oauth/gmail/callback` — exchange code for tokens; store encrypted refresh token; redirect to app
- [x] Token refresh logic: `tokens` event listener on OAuth2 client auto-persists refreshed tokens

### 4.4 Outlook OAuth Flow (`src/services/oauth/outlook.js`)
- [x] `GET /api/oauth/outlook/init` — redirect to Microsoft identity v2 consent screen; CSRF state token stored in session
- [x] `GET /api/oauth/outlook/callback` — exchange code for tokens; store AES-encrypted tokens; redirect to app
- [x] Token refresh logic — proactive refresh within 2 min of expiry + 401 retry; new tokens auto-persisted to DB via `updateOAuthTokens`; no MSAL dependency (raw fetch to token endpoint)

### 4.5 Credential Encryption (`src/utils/crypto.js`)
- [x] AES-256-GCM encryption/decryption for stored IMAP passwords and OAuth tokens
- [x] Encryption key loaded from `ENCRYPTION_KEY` env var (32-byte hex)

---

## Phase 5 — Email Reading (IMAP + Gmail API + Outlook API)

### 5.1 IMAP Service (`src/services/imap.js`)
- [x] Connection pool keyed by `email_account_id` — reuse open connections
- [x] `fetchMessages(accountId, folder, options)` — fetch message list with headers (from, subject, date, read status, flags)
- [x] `fetchMessage(accountId, folder, uid)` — fetch full message (headers + body, text + HTML parts)
- [ ] `fetchFolders(accountId)` — list all IMAP mailboxes/folders
- [x] `markRead(accountId, folder, uid, isRead)` — set/unset \Seen flag
- [x] `archiveMessage(accountId, folder, uid)` — move to Archive folder (create if absent)
- [x] `deleteMessage(accountId, folder, uid)` — move to Trash / expunge
- [ ] `moveMessage(accountId, fromFolder, toFolder, uid)` — generic move

### 5.2 Email Routes (`src/routes/email.js`)
- [x] `GET /api/email/:accountId/folders` — list folders (dispatches to correct service)
- [x] `GET /api/email/:accountId/messages?folder=INBOX&page=1&limit=20` — paginated message list (20/page, prev/next controls)
- [x] `GET /api/email/:accountId/messages/:uid?folder=INBOX` — full message fetch; mark as read on open
- [x] `PATCH /api/email/:accountId/messages/:uid/read` — toggle read/unread
- [x] `POST /api/email/:accountId/messages/:uid/archive` — archive
- [x] `DELETE /api/email/:accountId/messages/:uid` — delete (move to trash)
- [x] `GET /api/email/:accountId/unread` — lightweight unread count for sidebar badges; dispatches to per-service `getUnreadCount`
- [x] `getService(account)` helper — dispatches to `gmailService`, `outlookService`, or `imap` based on `account.provider`
- [x] `parseUid(account, raw)` helper — returns string UID for Gmail/Outlook, `parseInt` for IMAP
- [ ] `GET /api/email/unified?page=1&limit=50` — fetch recent messages across all accounts, merge & sort by date

### 5.3 Gmail API Service (`src/services/gmail.js`)
- [x] Uses `googleapis` (`google.gmail v1`) — no IMAP fallback for Gmail accounts
- [x] `fetchMessages` — `messages.list` with label filter + cursor-based `pageToken`; page tokens cached in memory map keyed by `${accountId}:${label}:${page}`; parallel `messages.get(format=metadata)` for summaries
- [x] `fetchMessage` — `messages.get(format=full)`; recursive multipart walk to extract `text/plain` + `text/html`; base64url decoding
- [x] `markRead` — `messages.modify` add/remove `UNREAD` label
- [x] `archiveMessage` — `messages.modify` remove `INBOX` label
- [x] `deleteMessage` — `messages.trash` (recoverable)
- [x] `getFolders` — `labels.list`; system labels sorted first; `labelHide` entries filtered out
- [x] `getUnreadCount` — `messages.list` with `INBOX`+`UNREAD` labels, `maxResults:1`; returns `resultSizeEstimate`
- [x] Normalised message shape matches IMAP service output (`uid`, `subject`, `from_name`, `from_addr`, `to`, `date`, `unread`, `preview`, `html`, `text`)

### 5.4 Outlook API Service (`src/services/outlook.js`)
- [x] Uses Microsoft Graph API (`https://graph.microsoft.com/v1.0/me`)
- [x] `fetchMessages` — `mailFolders/{folder}/messages` with `$top`/`$skip` offset pagination and `$count=true`; `ConsistencyLevel: eventual` header
- [x] `fetchMessage` — requests `body` field; handles `contentType html` vs `text` natively
- [x] `markRead` — `PATCH /messages/{id}` with `{ isRead }`
- [x] `archiveMessage` — `POST /messages/{id}/move` to `archive` well-known folder
- [x] `deleteMessage` — `POST /messages/{id}/move` to `deleteditems` (recoverable)
- [x] `getFolders` — `mailFolders` list; sorted by well-known folder order then alphabetical
- [x] `getUnreadCount` — `GET /mailFolders/inbox?$select=unreadItemCount`; reads `unreadItemCount` directly from folder object
- [x] Folder name mapping: `INBOX→inbox`, `SENT→sentitems`, `TRASH→deleteditems`, `SPAM→junkemail`, `DRAFTS→drafts`, `ARCHIVE→archive`
- [x] `graphFetch` helper in `oauth/outlook.js` — proactive token refresh, 401 retry, DB persistence

### 5.5 Email Sanitization
- [x] All HTML email bodies must be sanitized with `isomorphic-dompurify` before sending to client
- [x] Strip `<script>`, event handlers, external image tracking pixels (opt-in via per-user `auto_load_images` setting)
- [x] Render sanitized HTML in an isolated `<iframe srcdoc>` in the reading pane

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
- [~] Floating compose window (opens as modal; not yet draggable/minimizable)
- [x] **From:** dropdown — select which account/address to send from
- [x] **To:** input field
- [x] **Cc / Bcc:** toggle chips — reveal rows on click
- [x] **Subject:** plain text input
- [x] **Body:** plain textarea (rich text editor not yet integrated)
- [x] Reply mode: pre-populate To, Subject (Re:), quote original body
- [x] Forward mode: pre-populate Subject (Fwd:), quote original body, To is empty
- [ ] Send button wired to `POST /api/email/:accountId/send` (backend not yet implemented)

---

## Phase 7 — Frontend App Shell

### 7.1 Layout (`public/inbox.html`, `public/css/layout.css`)
- [x] Three-panel layout:
  1. **Left sidebar** (~220px): Spindle logo, account list with folder tree, Compose button
  2. **Center panel** (~340px): Email list for selected folder/account
  3. **Right panel** (flex-grow): Email reading pane
- [x] Responsive collapse: on narrow viewports, panels slide (sidebar → list → reader)
- [x] CSS custom properties for all colors; `[data-theme="dark"]` on `<html>` for dark mode
- [x] Smooth transitions on theme change

### 7.2 Sidebar (`public/js/sidebar.js`)
- [x] Load accounts via `GET /api/accounts` on app init
- [x] Render each account with its email address, display name, and unread count badge
- [ ] Expandable folder tree per account (Inbox, Starred, Sent, Drafts, Archive, Trash, custom)
- [x] "All Inboxes" unified view at the top
- [x] "+ Add Account" button at bottom → opens Add Account modal
- [x] Active folder highlighted

### 7.3 Email List (`public/js/emailList.js`)
- [x] Render list of messages (sender name, subject, preview snippet, date, read/unread indicator)
- [x] Unread messages visually distinct (bold sender/subject, dot indicator)
- [x] Click row → load full message in reading pane; mark as read
- [ ] Right-click context menu (hover quick-action buttons exist instead)
- [x] Pagination: 20 per page, prev/next controls pinned at bottom
- [x] Loading skeleton while fetching
- [x] Silent auto-refresh every 60s (only re-renders on UID change)
- [x] Hover quick actions: mark read/unread, delete
- [x] Clicking the already-active inbox does nothing (early-return guard in `selectAccount`, `selectFolder`, `selectAllInboxes`)
- [x] Mark read/unread is optimistic — UI updates instantly, reverts on API error
- [x] `adjustUnreadCount(accountId, delta)` — local ±1 update to `App.unreadCounts` + sidebar re-render on every read state change
- [x] `markUnreadInList(uid)` — mirror of `markReadInList` for toggling back to unread from reader toolbar

### 7.4 Reading Pane (`public/js/reader.js`)
- [x] Display: From (name + address), To, Subject, Date
- [x] Render sanitized HTML body in `<iframe srcdoc>` (isolated, sandbox="allow-same-origin")
- [x] Action toolbar: Reply · Reply All · Forward · Archive · Delete · Mark Unread
- [x] "Show images" button when remote images are blocked; auto-load respects per-user DB setting
- [ ] Thread view: collapsible previous messages below current
- [ ] Avatar initial beside sender name

### 7.5 Global State & API (`public/js/app.js`, `public/js/api.js`)
- [x] `api.js`: thin fetch wrapper — handles auth errors (redirect to `/auth` on 401), JSON parsing, error toasts
- [x] `app.js`: global state (activeAcct, activeFolder, activeMsg, user, accounts, unreadCounts)
- [x] On load: call `GET /api/auth/me` — redirect to `/auth` if 401
- [x] Theme: read from user record; apply `data-theme`; persist via `PATCH /api/settings/theme`
- [x] `App.toggleImages()` — persists `auto_load_images` to DB via `PATCH /api/settings/images`
- [x] `App.refreshUnreadCounts()` — parallel `GET /api/email/:id/unread` for all accounts via `Promise.allSettled`; updates `App.unreadCounts`, re-renders sidebar, updates doc title; called on boot and every 60s
- [x] `inbox.html` has early inline theme-detection script (same as `auth.html`) — sets `data-theme` before first paint so no light-mode flash on load

---

## Phase 8 — Settings Panel

### 8.1 Settings Routes (`src/routes/settings.js`)
- [x] `PATCH /api/settings/theme` — cycle `'system'` / `'dark'` / `'light'`; update DB
- [x] `PATCH /api/settings/images` — toggle `auto_load_images`; update DB
- [x] `DELETE /api/settings/account` — delete user account; require `password` in body (bcrypt verify); cascade deletes all email_accounts

### 8.2 Settings UI (`public/js/settings.js`)
- [x] Modal settings panel (triggered from gear icon in sidebar)
- [x] **Appearance section:** theme cycle (system → dark → light → system); remote images toggle
- [x] **Inboxes section:** list all connected inboxes, reorder with ↑/↓ buttons, delete with password confirmation
- [x] **Danger Zone:** "Delete Account" → password confirmation → `DELETE /api/settings/account` → redirect to login

---

## Phase 9 — Admin Panel

### 9.1 Admin Routes (`src/routes/admin.js`)
- [x] All routes protected by `requireAuth` + `requireAdmin` middleware
- [x] `GET /api/admin/users` — list all users: id, username, role, created_at, invite_code_used
- [x] `GET /api/admin/invite-codes` — list all codes: code, created_at, used_by username (or null), revoked status
- [x] `POST /api/admin/invite-codes` — generate new invite code in `XXXX-XXXX-XXXX` hex format; store with `created_by = req.user.id`
- [x] `DELETE /api/admin/invite-codes/:code` — revoke code (set `revoked = 1`); blocked if code already used

### 9.2 Admin UI (`public/js/admin.js`)
- [ ] Admin section only rendered if `user.role === 'admin'` (server enforces; client just hides UI)
- [ ] **Users tab:** Table showing username, joined date, invite code used
- [ ] **Invite Codes tab:**
  - Table of all active codes: code value (monospace), created date, used by (username or "Unused")
  - "Generate Code" button → POST → append to table
  - "Revoke" button per code → DELETE → remove from table

---

## Phase 10 — Security Hardening

- [x] `helmet()` middleware — sets security headers (CSP, HSTS, X-Frame-Options, etc.)
- [x] `express-rate-limit` on all `/api/auth/*` routes (max 10 req/15min per IP)
- [ ] CSRF protection for state-changing routes (use `csurf` or double-submit cookie pattern)
- [x] All DB queries use prepared statements (no string concatenation)
- [~] Validate and sanitize all user inputs server-side (auth routes done; email/account routes partial)
- [x] OAuth `state` parameter validated on callback (prevent CSRF on OAuth flow)
- [x] Recovery tokens expire after 1 hour; one-time use only
- [x] Invite codes are cryptographically random (use `crypto.randomBytes`)
- [x] Session cookie: `httpOnly: true`, `secure: true` (in production), `sameSite: 'lax'`
- [x] Encryption key for stored credentials loaded from env, never hardcoded
- [x] Never return password hashes or raw OAuth tokens in API responses

---

## Phase 11 — Polish & UX

- [x] Toast notification system (success, error, info) — vanilla JS, CSS animations
- [~] Loading states — skeleton loaders on email list; button disabled states on some actions
- [x] Empty states (no emails, no accounts added yet) with welcome greeting
- [~] Error boundary — per-account errors shown inline; not yet applied universally
- [x] Keyboard shortcuts: `c` = compose, `r` = reply, `e` = archive, `#` = delete, `u` = mark unread
- [x] Favicon + `<title>` update with unread count ("(12) Spindle")

---

## Extra — Completed Outside Original Scope

- [x] **Homepage** (`/` → `public/index.html`) — auth-aware CTA (sign in / open inbox), Spindle mark hero, fade-in + slide-up entrance animations, system light/dark mode, footer links
- [x] **Privacy Policy** (`/privacy-policy`) — Google API Limited Use compliance statement
- [x] **Terms of Service** (`/tos`)
- [x] **404 page** (`/404.html`) — styled, served with correct HTTP 404 status
- [x] **Clean URL routing** — all pages accessible without `.html`; legacy `.html` URLs 301 redirect
- [x] **nginx reverse-proxy support** — `app.set('trust proxy', 1)` so rate-limiting uses real client IPs
- [x] **Nodemon config** — watches only `src/` + `server.js`; ignores `data/` (sessions/DB) and `public/` to prevent restart loops
- [x] **`auto_load_images` persisted to DB** — migrated via safe `ALTER TABLE`; read/written via `PATCH /api/settings/images`; no longer stored in `localStorage`
- [x] **Custom select component** (`CustomSelect` in `api.js`) — fully site-rendered dropdown replacing native `<select>`; keyboard nav (arrows, enter, esc), aria attributes, outside-click to close, borderless variant for compose-row context; used in composer from-picker and IMAP/SMTP security selects
- [x] **Custom deletion modals** (`settings.js`) — replaced `prompt()`/`confirm()` with inline modals for both account deletion (checkbox acknowledgement + password field, delete button gated on both) and inbox removal (password field only); inline error display, Enter to submit, Esc to close
- [x] **Account deletion FK constraint fix** (`settings.js`, `queries.js`) — nullify `invite_codes.used_by` and `invite_codes.created_by` before `deleteUser` to avoid FK constraint failure; evict IMAP connections first; wrap in try/catch to return 500 instead of crashing
- [x] **Session-file-store EPERM noise suppressed** (`server.js`) — `logFn: () => {}` silences Windows atomic-rename race errors from session writes
- [x] **`PATCH /reorder` route ordering fix** (`accounts.js`) — moved `/reorder` above `/:id` so Express matches it correctly
- [x] **Unread count badges** — `getUnreadCount` added to all three services (IMAP: `SEARCH UNSEEN`; Gmail: `resultSizeEstimate`; Outlook: `unreadItemCount` on folder); proactive fetch on boot + every 60s; local ±1 delta on mark read/unread; sidebar always re-renders with active state preserved
- [x] **Sidebar active state preserved on render** — `Sidebar.render()` now calls `setActive(App.activeAcct, App.activeFolder)` internally so all callers get consistent state
- [x] **Invite code format enforced as `XXXX-XXXX-XXXX` hex** — `INVITE_CODE_REGEX` exported from `crypto.js`; registration rejects malformed codes before DB lookup; `randomInviteCode()` rewritten to produce hex format via `crypto.randomBytes`
- [x] **Invite code input formatting** (`auth.html`) — `keydown` blocks non-hex characters; `input` normalises, uppercases, and auto-inserts dashes while preserving cursor position; `paste` strips dashes/garbage and reformats regardless of clipboard format
- [x] **Invite code invalidated on account deletion** (`settings.js`) — `revokeInviteCode` is called before `clearInviteCodesUsedBy` so the consumed code is permanently marked `revoked=1` and cannot be reused if the user is later deleted
- [x] **Username 15-character limit** — backend rejects usernames > 15 chars; `maxlength="15"` on the register input prevents over-length input and paste
- [x] **Default theme follows system preference** — early inline `prefers-color-scheme` detection script added to `inbox.html` `<head>` (same pattern as `auth.html`); eliminates light-mode flash before `App.init()` resolves

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

1. **Phase 1** — Scaffold, package.json, server.js, DB schema ✅
2. **Phase 2** — Auth routes + login/register UI ✅
3. **Phase 3** — Recovery flow ✅
4. **Phase 7 (partial)** — App shell HTML/CSS layout + `api.js` ✅
5. **Phase 4** — Account management (IMAP/SMTP ✅; Gmail OAuth ✅; Outlook OAuth ✅)
6. **Phase 5** — Email reading (IMAP ✅; Gmail API ✅; Outlook Graph API ✅)
7. **Phase 6** — Compose/send (frontend [~]; backend ⬜)
8. **Phase 7 (complete)** — Wire up all frontend JS modules ✅ (minus folder tree, thread collapsing)
9. **Phase 8** — Settings panel ✅
10. **Phase 9** — Admin panel ⬜
11. **Phase 10** — Security hardening ([~] mostly done, CSRF outstanding)
12. **Phase 11** — Polish ([~] mostly done)

---

## Status Legend

- `[ ]` Not started
- `[~]` In progress / partial
- `[x]` Complete
- `[!]` Blocked / needs attention

---

## Known Issues / Decisions Pending

- [x] **Design prototype inaccessible** — RESOLVED. Design obtained from Claude Design API and implemented. Full bundle in `data/design-dump.txt`.
- [x] **Gmail/Outlook native API reading** — RESOLVED. `src/services/gmail.js` and `src/services/outlook.js` fully implemented. Email router dispatches based on `account.provider`.
- [x] **Outlook OAuth** — RESOLVED. `src/services/oauth/outlook.js` implemented with raw fetch (no MSAL). Init + callback routes added to `src/routes/oauth.js`. Outlook tile enabled in add-inbox modal.
- [x] **`PATCH /reorder` route ordering bug** — RESOLVED. Moved `PATCH /reorder` above `PATCH /:id` in `src/routes/accounts.js`.
- [ ] **Compose send backend** — Frontend compose UI exists; `POST /api/email/:accountId/send` and SMTP service not yet wired up (Phase 6.1/6.2).
- [ ] **Admin panel** — Routes and UI not yet implemented (Phase 9).
- [ ] **Attachment support** — Reading and downloading attachments is not in initial scope. `[FUTURE]` placeholder in reader.js.
- [ ] **Search** — Full-text email search not in scope. IMAP SEARCH command available for future implementation.
- [ ] **IMAP folder listing** — `getFolders` not yet implemented for IMAP accounts; only Gmail and Outlook support the folders endpoint.
- [~] **Push notifications** — 60s polling implemented as baseline. Real-time would require IMAP IDLE.
- [ ] **Mobile responsive** — Desktop-first. Basic responsive breakpoints for tablet/mobile as a stretch goal.
