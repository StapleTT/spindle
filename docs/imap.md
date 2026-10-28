# IMAP accounts and local mail

This is the first read-only mail slice. Verified users can connect up to five private IMAP accounts, browse their unified inbox and individual folders, and request background refreshes. The API reads mail lists and counts from Postgres; provider failures do not remove already synchronized mail. Presentation remains temporary until the Claude Design export arrives.

The [message reader](reader.md) now fetches and caches bodies on demand, with navigation, isolated sanitized HTML and per-message image controls. The user has confirmed that a live IMAP connection works; complete live sync/reader acceptance is still pending.

## Setup

Run `npm ci` and `npm run db:migrate`, configure an encryption key, then restart `npm run dev` so both the API and worker receive it. Existing authentication and Resend settings stay unchanged.

Generate a separate 32-byte key ring in your terminal:

```bash
node --input-type=module -e 'import { randomBytes } from "node:crypto"; console.log(JSON.stringify({v1: randomBytes(32).toString("base64")}))'
```

Store the result privately in `.env`:

```dotenv
MAIL_ENCRYPTION_KEY_ID=v1
MAIL_ENCRYPTION_KEYS={"v1":"<generated base64 key>"}
```

The implementation session added a fresh random key to the existing local `.env` without changing prior values. Never commit that file. Back up keys separately from Postgres: losing a key makes its stored credentials unreadable, and database backups alone cannot restore them. Without a configured key, authentication still works but new mailbox connections are disabled.

Sign in at the configured `APP_URL`, choose **Connect IMAP account**, and enter your provider's host, port, username and password. Use a provider app password where required. Choose implicit TLS (usually 993) or **required** STARTTLS (usually 143). Certificates must validate; there is no plaintext or self-signed-certificate option. Connecting and reconnecting save credentials and schedule a worker check; watch the account's status for the result. A stopped worker leaves the account pending until it returns.

IMAP destinations must resolve exclusively to public addresses. The worker checks every DNS answer and pins an approved IP while preserving the hostname for TLS validation. Loopback, private networks, cloud metadata, mapped IPv4 and transition ranges are blocked, including for self-hosted deployments. The test suite redirects transport to a local synthetic server only inside its test harness; the app exposes no bypass. Hosted deployment still needs independent network egress rules.

## Mail coverage and behavior

- Choose **last 90 days** or **all available mail** when connecting. The 90-day cutoff is fixed at connection time; subsequent new mail is included. It is a synchronization boundary, not an automatic retention/deletion policy. Reconnecting preserves the original boundary and local IDs.
- All selectable folders are discovered. The unified inbox includes only inbox membership across the user's accounts; choosing a folder shows that folder. Subjects, decoded senders/recipients, dates, RFC Message-ID/In-Reply-To, byte size, IMAP identity and flags are stored. Background metadata sync does not download bodies; opening a message requests its bounded cached body through the reader worker. Raw MIME is not retained; attachment files are cached only on explicit download (see the [reader](reader.md)).
- Backfill starts with recent UIDs and commits batches of at most 500 UID positions. Up to ten batches run per leased connection, with time and response-size limits. Progress survives process death; messages and the associated UID checkpoint commit in one transaction. Large or sparse UID spaces can take multiple jobs to scan.
- After backfill, polling discovers new UIDs and reconciles external flag changes and removals through bounded scans. Accounts are normally checked about once per minute; large scans or provider failures increase that delay. A five-second dispatcher tick picks up pending work, with a durable minute schedule as recovery. The browser refreshes local data every ten seconds.
- **Sync now** records a new durable request, including when a worker is already active. A disconnected provider does not block cached lists/counts. Generic error states retry with increasing delay and jitter, capped at approximately one hour; reconnect replaces credentials on the existing account identity.
- UID identity includes the account, mailbox, UIDVALIDITY and UID. Reused UIDs after a UIDVALIDITY reset replace that folder's local mirror. Matching RFC Message-IDs never collapse different accounts or IMAP folders. Stable identity across provider-side moves is future work; this slice sends no move/read/delete operations.
- Pagination uses descending received date plus internal ID, preserving database timestamp precision. New arrivals before a page's cursor appear on returning to the newest page. Lists/counts cover synchronized metadata only, and folder counts can change while sync runs.
- Disconnect requires the current Spindle password. It deletes that owned account's credentials and local mirror, invalidates active work through the account's deletion, and never deletes provider mail. Jobs recheck owner and verified identity, hold expiring fenced leases and cannot recreate a deleted account.

Connections are limited to two concurrently per worker, five accounts per user and 1,000 selectable folders per account. Connection setup, DNS, socket activity and total connected work have timeouts. Individual protocol responses are capped at 512 KiB with token/line/literal bounds; a metadata batch is capped at 8 MiB. Oversized or malformed responses fail visibly instead of advancing their checkpoint.

## Keys and database upgrades

Credentials use AES-256-GCM with a fresh nonce and user/account IDs as authenticated context. They are separate from Better Auth login credentials. Mail headers themselves are ordinary private Postgres data, so database access and backup protection remain necessary. This operator-key setup is suitable for the current local/self-hosted slice; hosted KMS wrapping and its recovery proof remain release work.

For key rotation, add a new ID/key to `MAIL_ENCRYPTION_KEYS`, select it with `MAIL_ENCRYPTION_KEY_ID`, and restart both processes while retaining previous keys. Reconnecting each existing account reencrypts its credential under the active key. Check counts grouped by `split_part(credential, '.', 1)` before removing any old key. Missing keys or tampering fail closed; do not replace lost keys with new bytes under the same ID.

`0001_mail.sql` is additive and leaves authentication tables untouched. Apply migrations before deploying the API/worker. To roll back application code, stop the new worker and deploy the previous version while retaining mail tables and keys; the previous auth-only version ignores them. Reapply compatible code to resume synchronization. No data reset or destructive down migration is part of this upgrade.

## Verification and remaining gates

`npm run check`, `npm run test:integration` and `npm run test:browser` include mail checks. Integration/browser runners create and drop isolated `spindle_test_*` databases. ImapKit provides synthetic TLS IMAP mail; nothing sends messages to real recipients. Tests cover ownership (including foreign platform admins), transport downgrade/certificate rejection, reconnect/account limits, two-account identity, UIDVALIDITY, external flags/expunges, interrupted batch recovery, stale leases, timestamp pagination, durable worker dispatch and password-confirmed disconnect. Chromium exercises connection, automatic background display, folder navigation, pagination, hostile subject escaping and phone layout.

The user confirmed a live IMAP connection. Full live provider acceptance still requires reviewing folders, incoming updates and messages. HTML/plain-text reading is now implemented separately in the [reader](reader.md). Gmail/Graph OAuth, attachments, sending, provider mutations, IDLE/CONDSTORE optimization, hosted egress/KMS, and the five-account/100k performance gate remain separate milestones. This does not complete the broader M1 gate, which also requires Gmail and real-account review.

Local evidence on 2026-10-27: lint, both typechecks, 11 unit tests, 36 integration tests (including outer tests), both builds and two Chromium journeys passed. The mail migration was applied twice to the local project database; all five mail tables exist and user/login-credential/session counts were unchanged. The actual app origin returned 200 for the web page and readiness, and 401 for unauthenticated account/message requests. API, web and worker startup were verified. Local proof used the installed Node 26.12.0 runtime; CI remains configured for the Node 24 target.
