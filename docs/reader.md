# Message reader

Open any synchronized message to read its cached plain-text or formatted body. Previous/next follows the current account/folder view across list pages. **Back to message list** preserves that list's filters and page. Browser Back/Forward and message links use the URL fragment. Slow requests for a previously selected message cannot replace the current one.

The reader remains read-only: fetching uses IMAP's non-mutating download and a read-only mailbox lock. Opening mail does not change its provider read flag. Attachments are listed and downloaded on demand (see below); threads and mail actions have separate implementation gates. Styles remain temporary pending Claude Design.

## Local setup and hosted content origin

Run `npm ci`, `npm run db:migrate`, then restart `npm run dev`. Preserve `.env`, authentication settings and the existing mail encryption key ring. The API starts a second Fastify listener for isolated content on `127.0.0.1:3001`; the worker performs body retrieval.

For the default app at `http://127.0.0.1:5173`, content is served at `http://localhost:3001`. If the app uses `localhost`, the automatic content hostname is `127.0.0.1`. The hostnames must differ: a different port alone does not isolate host-only cookies. HTTP development content must bind to loopback. `CONTENT_PORT` changes both the listener port and the automatic local URL.

For HTTPS hosting, set a separate hostname, for example:

```dotenv
CONTENT_URL=https://mail-content.example.com
CONTENT_HOST=127.0.0.1
CONTENT_PORT=3001
```

Terminate TLS at the proxy and forward that hostname to the content listener. Expose only `/body`, `/image` and `/attachment` there. The app origin must permit that exact content origin in its `frame-src` CSP; production frontend hosting must preserve the same policy as the API's configured Helmet policy. Keep app cookies host-only, without a parent Domain. Do not put the content listener behind a gateway that adds application cookies or shared authenticated caching. With no hosted content URL, plain text works and formatted reading reports its configuration prerequisite; it never falls back to rendering email HTML inside the app.

## Retrieval and cache behavior

An authenticated POST records a deduplicated body request in Postgres. The existing pg-boss dispatcher recovers pending requests after restart. Body work takes the same expiring account lease as metadata sync, validates ownership/verified identity and rechecks mailbox UIDVALIDITY before downloading the UID. Pending body requests take priority over another metadata pass. One metadata and one body job run concurrently per worker; account leases serialize work for the same account.

Only the worker contacts IMAP for bodies. The API exposes missing/pending/ready/failed states; the reader polls while waiting and provides explicit retry after failure. Cached reading works while the provider or worker is unavailable. Failed retrieval never clears synchronized headers. Disconnect, deleted membership, lease takeover, changed cache version and account removal prevent stale fetches from recreating content.

The first cache uses existing Postgres storage for bounded parsed text/HTML and supported inline/image blobs. It stores no raw MIME; attachment files are cached only after their owner requests a download. Entries expire seven days after retrieval and are removed by the worker's dispatcher. Each user has a 128 MiB / 1,000-message cache budget; least-recently-accessed entries are evicted first. Eviction removes downloaded copies, preserving synchronized metadata and provider mail. Versions invalidate old content grants when an entry is replaced. Access does not extend its seven-day expiry.

Limits are enforced before publishing a ready entry:

- Raw MIME: 10 MiB, downloaded in 64 KiB chunks. Large attachments count toward this bound even though they are not retained; an oversized message fails visibly. Text-part-only retrieval for larger messages remains future work.
- Decoded plain text plus HTML, and sanitized output: 2 MiB.
- MIME headers: 64 KiB per part; at most 100 MIME nodes, which also bounds nested structure. Mailparser handles charsets, multipart alternatives and malformed input with its native guards.
- At most 20 image references per message. Supported inline images total at most 8 MiB. Individual image data is at most 5 MiB.
- Connection setup and connected IMAP work retain their existing timeouts; connected body work is closed after 45 seconds. Parser input, node count and output are bounded; HTML sanitization limits nesting to 40.

Mail content is private application data in Postgres, without separate application-layer encryption for the body cache. Protect database access, volumes and backups accordingly. Hosted KMS/object-storage/operational acceptance remain release gates; this implementation adds no object-store service.

## Attachments

The body fetch records attachment metadata from the IMAP BODYSTRUCTURE: parts with `Content-Disposition: attachment`, named parts without a Content-ID (including Apple-style inline PDFs) and forwarded `message/rfc822` parts. Content-ID parts stay embedded body resources. At most 100 are listed. Names are decoded (RFC 2047/2231) and made safe: Unicode NFC, control/format characters (including bidi overrides used for extension spoofing) and path or shell-hostile characters become `_`, leading/trailing dots and spaces are removed and names are capped at 200 characters. Sizes are estimates from the encoded part size.

**Download** posts a deduplicated request; the worker fetches only that MIME part with the same account lease, read-only lock and UIDVALIDITY check as bodies, decoding transfer encoding into at most 10 MiB. Ready files are cached in Postgres beside the body and count toward the 128 MiB / 1,000-message budget; expiry, eviction, body refetch and account removal delete them. The UI shows fetching, failed-with-retry and unavailable (no isolated content server) states and starts the download when the file is ready. Opening attachments does not change provider read flags.

Downloads are served only by the content origin with a five-minute grant bound to the user, live session, message, cache version and attachment index. Responses are `application/octet-stream` with `Content-Disposition: attachment` (ASCII fallback plus UTF-8 `filename*`), `nosniff`, the sandboxing CSP and `no-store`; declared MIME types are displayed but never served. Downloads are rate limited to 60 per minute per user. Malware scanning/quarantine is not implemented: files are provider mail delivered as downloads, never rendered by Spindle. Hosted object storage remains a release gate.

## HTML and image isolation

Mailparser decodes MIME; sanitize-html applies an explicit tag/attribute policy. Scripts, forms, frames, SVG/MathML, source sets and uncontrolled external loads are removed. Links use a new tab with `noopener noreferrer`. HTML is sanitized before storage and again when constructing the isolated document. Plain text is rendered as text by React.

Newsletter styling is preserved through a separate CSS sanitizer: inline styles, class/ID selectors, fonts/colors, spacing, table presentation attributes, image dimensions, and responsive `@media`/`@supports` rules. Style blocks are extracted with the HTML parser; the HTML sanitizer discards the original tags and only parsed/filtered CSS is used to rebuild them. Body selectors target the email's body wrapper. The CSS parser rejects imports, external font definitions, unsupported executable/resource-loading functions and selectors that inspect generated image/style grant attributes. Background images, including legacy table backgrounds, share the normal message image resources and proxy; they become `none` while images are blocked. CSS parsing is bounded to 64 style blocks / 256 KiB total styles, 10,000 nodes, four nested rule levels, 16 nested value functions and limited selector/value lengths. Remote fonts and Outlook-only VML are not rendered.

Formatted content uses a sandboxed iframe with no script or same-origin permission. The content response independently applies CSP sandboxing, denies scripts, forms, nested frames, objects, fonts, media and connections, and permits framing only by the configured app origin. Images can only come from the content service. Responses use `no-store`, `nosniff` and `no-referrer`.

Five-minute signed grants bind a user, current session, message, cache version and body/image scope. The content server checks the live session, verification, membership and cache expiry on access. It sets no cookies and needs no app cookies. Revoked sessions, removed accounts and replaced cache versions invalidate access. Grant query strings are excluded from logs.

Images are blocked by default, including inline CIDs. **Display images** explicitly enables supported inline and remote images for that message. Switching messages or reloading resets the choice. **Hide images** removes the current frame immediately and loads a blocked-image document. It cannot undo tracking requests already sent.

By default, remote images go through an authenticated, bounded proxy after per-message consent. [Saved image preferences](mail-preferences.md) can instead allow automatic loading or direct browser HTTPS loading. The proxy permits HTTP/HTTPS on their standard ports, validates every DNS answer against public-address rules, pins an approved IP, preserves TLS hostname/certificate checks and validates each of at most three redirects. It forwards no user cookies, authorization or referrer. Remote fetching can still notify a sender's tracking server, which the image control explains before opting in.

Only PNG, JPEG, GIF and WebP signatures are served with their matching image type. SVG and other formats fail closed. Remote responses are streamed with a 5 MiB cap and a shared 15-second network deadline across redirects. The content service allows eight active remote fetches with at most 32 distinct in-flight/queued image requests; duplicate requests share work and stored images are reused. Every image access is rate limited, and a session/cache check after a remote download prevents publishing data after revocation or deletion.

## Proof and upgrade

Unit tests exercise hostile HTML, image URL/type restrictions, content-origin configuration, expiring grants, MIME charset/alternative/CID handling, MIME bounds, pinned image transport and redirect rejection. Postgres tests exercise lazy-fetch deduplication, cache reuse/expiry/retry, ownership, navigation, account lease loss, durable queue dispatch, image caching, session revocation during fetch, owner-scoped LRU eviction and disconnect during fetch. Chromium exercises the complete reader, history/page navigation, format/image controls, opaque sandbox origin, cookie separation, automatic tracking-load blocking, cached reading without a worker and stale-response protection.

`0002_reader.sql` adds two cache tables and indexes; it never edits prior migrations or existing users/mail metadata. Apply it before starting updated processes. For application rollback, stop the updated API/content listener and worker, deploy the prior version and retain the cache tables; earlier code ignores them. Cached entries may safely expire or be evicted, and provider mail is unchanged. No destructive rollback or data reset is required.

`0004_attachments.sql` adds an attachment-metadata column and an attachment cache table cascading from the body cache; it changes no existing rows. The content revision increases, so each previously cached body is fetched once more on open to collect attachment metadata. Apply the migration and deploy the API/content listener and worker together. For application rollback, keep the column and table; earlier code ignores them, although content cached by the newer revision is refetched by the older code.

`0003_reader_styles.sql` adds a sanitizer-policy revision to existing cache rows. Previously cached HTML already lost its original styling, so reopening such a message requests one fresh provider fetch. Headers, accounts, sessions and provider messages are preserved. Pending requests remain deduplicated; grants for obsolete cached HTML/images are rejected. The worker marks newly parsed content with the current revision, so older workers cannot falsely label stripped HTML as current. Apply the migration and deploy the updated API/content listener and worker together. Keep the additive column for application rollback; earlier code ignores it.

Newsletter-fix proof: 20 unit tests, 50 integration tests (including outer tests), three Chromium journeys, both typechecks, server build and lint passed. Browser computed-style checks verify desktop table width, typography, image sizing, hidden preheaders, responsive phone styles and blocked/proxied CSS backgrounds; unit tests also cover CTA styling. The local cache migration was applied twice with existing users, sessions and mail metadata counts preserved; restarted API readiness and content-grant denial were confirmed.

Live provider connection has been confirmed by the user. Live reader/image acceptance still awaits the user's review of their own mail; automated proof uses synthetic messages only.

Local proof on 2026-10-27: lint, both typechecks, 17 unit tests, 49 integration tests (including outer tests), three Chromium journeys and both builds passed. The additive reader migration was applied twice to the local database with user, login-credential, session, account, folder, message and membership counts preserved. The restarted app returned 200 for readiness and 401 for anonymous mail access; the content service rejected an invalid grant with 403 and set no cookies. A live pg-boss worker heartbeat was confirmed. Checks used installed Node 26.12.0; CI remains configured for Node 24.

## Search navigation

The reader accepts the active local search/account/folder scope. Previous/Next shares the list's filters and received-date/UUID ordering, and Back restores list focus. Read/unread actions that remove the current search result advance to its neighbor. Optional split view preserves row versus reader keyboard context; [search and keyboard triage](search.md) documents coverage and shortcuts.

## Conversation context

The [conversation timeline](conversations.md) connects owned messages across folders in one account. Select a member to use this same reader and its per-message image consent, attachment controls and action/reply paths. The original source anchors search/folder navigation; opening the timeline itself never fetches other bodies or marks mail read.


## Saved image defaults — 2026-10-30

**Settings › Security** now controls privacy proxying and default blocking per user. Both stay on by default. With blocking off, the reader's initial signed body grant enables images; manual Hide still generates a blocked grant instead of falling back to the automatic default. With proxying off, allowed remote HTTPS sources and CSS backgrounds go directly to approved public image origins under a body-specific CSP; inline images remain on owned content endpoints. Direct fetches expose the reader's IP and use browser networking. Defaults apply to newly opened views. Sandbox, scripts/forms/fonts restrictions, no-referrer and owner/session/cache grants remain enforced. See [behavior, direct-mode limits and upgrade](mail-preferences.md).
