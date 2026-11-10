# Message reader

Open any synchronized message to read its cached body. Recent mail is cached before it is opened ([prefetch](#prefetch)); other mail is fetched when opened. Format selection is automatic: plain-only messages display escaped plain text; messages with HTML display their isolated sanitized formatting. There is no manual format switch. Previous/next follows the current account/folder view across list pages. **Back to message list** preserves that list's filters and page. Browser Back/Forward and message links use the URL fragment. Slow requests for a previously selected message cannot replace the current one.

Body fetching uses IMAP's non-mutating download and a read-only mailbox lock. The web reader separately queues the existing durable read action after one continuous second of foreground viewing of loaded content (D033); listing or fetching mail alone does not change provider flags. Explicit read/unread, move and reply controls remain available. Attachments are listed and downloaded on demand (see below).

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

For a body that is not cached yet, an authenticated POST records a deduplicated body request in Postgres. The existing pg-boss dispatcher recovers pending requests after restart. Body work takes the same expiring account lease as metadata sync, validates ownership/verified identity and rechecks mailbox UIDVALIDITY before downloading the UID. Pending body requests take priority over another metadata pass. One metadata and one body job run concurrently per worker; account leases serialize work for the same account.

Latency (D041): a new body or attachment request fires a `spindle_mail_work` notification at commit (migration 0037). Only transitions into pending fire, so worker writes never loop. The worker LISTENs on its own connection and dispatches at once, and pg-boss wakes the dispatch and content queues over LISTEN/NOTIFY (`useListenNotify`). Metadata work yields to the request: IMAP IDLE within about a second, IMAP sync between folder batches, Gmail sync between pages. Whichever job yields dispatches again immediately, instead of waiting for the 5-second timer, which remains the fallback alongside polling. The reader reloads on the committed content change (SSE), with its 1.5-second poll as the fallback. With synthetic local IMAP, measured request-to-cache times fell from about 5 s to 0.4 s with IDLE holding the lease, and from 8.8 s to about 1.2–1.8 s during a 4,000-message sync. Provider fetch time is extra: TLS login per IMAP body job, or one Gmail request using an access token reused from worker memory.

Only the worker contacts IMAP for bodies. The API exposes missing/pending/ready/failed states; the reader polls while waiting and provides explicit retry after failure. Cached reading works while the provider or worker is unavailable. Failed retrieval never clears synchronized headers. Disconnect, deleted membership, lease takeover, changed cache version and account removal prevent stale fetches from recreating content.

The first cache uses existing Postgres storage for bounded parsed text/HTML and supported inline/image blobs. It stores no raw MIME; attachment files are cached only after their owner requests a download. Each user has a 128 MiB / 1,000-message cache budget; least-recently-accessed entries are evicted first. Ready entries do not expire by age (D042); failed requests expire after seven days, or one day for a failed prefetch, and are removed by the worker's dispatcher. Eviction removes downloaded copies, preserving synchronized metadata and provider mail. Versions invalidate old content grants when an entry is replaced.

Limits are enforced before publishing a ready entry:

- Raw MIME: 10 MiB, downloaded in 64 KiB chunks. Large attachments count toward this bound even though they are not retained; an oversized message fails visibly. Text-part-only retrieval for larger messages remains future work.
- Decoded plain text plus HTML, and sanitized output: 2 MiB.
- MIME headers: 64 KiB per part; at most 100 MIME nodes, which also bounds nested structure. Mailparser handles charsets, multipart alternatives and malformed input with its native guards.
- At most 20 image references per message. Supported inline images total at most 8 MiB. Individual image data is at most 5 MiB.
- Connection setup and connected IMAP work retain their existing timeouts; connected body work is closed after 45 seconds. Parser input, node count and output are bounded; HTML sanitization limits nesting to 40.

Mail content is private application data in Postgres, without separate application-layer encryption for the body cache. Protect database access, volumes and backups accordingly. Hosted KMS/object-storage/operational acceptance remain release gates; this implementation adds no object-store service.

## Prefetch

Bodies are cached before they are opened (D042), so opening recent mail reads Postgres only.

After each completed metadata sync, the worker spends up to 15 seconds downloading the account's newest uncached messages, newest first, through the same source, parser, sanitizer and cache writes as an opened message. IMAP uses one connection per pass. New mail is therefore cached right after the sync that discovers it, including syncs triggered by IDLE. A backlog continues on the following syncs, which are brought forward while candidates remain. A failed or paused sync skips the pass.

Prefetch is background work:

- It runs in the metadata slot, never starts while the account has pending user work and wakes no worker.
- A reader's body or attachment request ends a running pass within about a second; the pass resumes afterwards.
- It does not change provider flags, and prefetched mail stays unread until the reader's one-second viewing rule marks it.

The cache budget decides what is kept. A prefetched entry ranks by its message's received time, an opened entry by its last access, and the lowest-ranked entries are evicted first. A message is prefetched only while the entries ranked above it leave room, so prefetch settles on the newest mail plus what was recently read instead of evicting and refetching. Prefetch skips Trash and Junk mail and messages over the 10 MiB raw limit; those are fetched when opened.

A body that prefetch could not fetch is retried after a day. Until then the reader treats it as not cached and fetches it on opening, so any error shown comes from a real attempt.

The web app adds two requests for mail prefetch has not reached: the reader asks for its Previous and Next messages once its own body is shown, and the list asks for a row when the pointer or keyboard focus rests on it for 150 ms. Both use `POST /api/mail/messages/:id/prefetch`, the same owned, deduplicated request as opening a message, limited to 120 per minute separately from reader actions.

Still fetched on opening: mail beyond the budget, Trash and Junk, and mail opened before its first prefetch pass. Those opens cost a provider round trip as before (D041).

`0038_content_prefetch.sql` lifts the expiry of existing ready bodies and moves body-cache notifications to their own [`content` event topic](events.md#content-topic--2026-11-09), so background caching does not make open lists refetch. It changes no tables. Apply it and deploy the API, worker and web app together. For application rollback keep the data: older code reads those rows as unexpired and resumes lazy fetching.

Proof (2026-11-09): `prefetch.integration.ts` on synthetic IMAP covers caching without any request or worker wake-up, received-time ranking, Trash exclusion, inline images and attachment lists, byte-for-byte equality with on-demand content, the failed-prefetch path, the prefetch route's ownership and rate bucket, new-mail caching, a reader request served in under five seconds during a 1,200-message backlog, and a full 1,000-entry cache that stays unchanged across further passes. Locally a pass stored about 11 bodies per second. Real-provider timing has not been measured.

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

## Viewing and quiet read feedback — 2026-11-01

The one-second timer starts only once plain content is ready or the formatted frame has loaded, with a visible, focused document and unobscured reader. Backgrounding, navigation, an open drawer/composer, pending actions or content errors cancel it. Returning starts a fresh second. Only the opened physical message is marked, with existing authentication/ownership/origin checks, five-second Undo, worker fencing and IMAP STORE semantics. An already-read message adds no action. Manual reader actions disarm automatic marking for that opening, and a failed read does not cause a retry loop. Auto-reading out of an unread filter returns to the results rather than advancing through the remaining unread messages.

Routine read/unread pending/completed messages and Undo confirmations are silent. Their history/Undo remain under All recent actions, including keyboard Undo. Failures/conflicts remain visible; folder changes and Outbox/sending keep their toast feedback. See [mail actions](actions.md). No schema, provider protocol, dependency or environment change is required.

Pending-toast follow-up: pending folder actions are quiet too. Expanded action history shows only their available Undo controls, without Pending/Marking banners; completed folder actions and failures/conflicts still produce feedback. Outbox queued/sending notifications remain visible. No read timer or provider behavior changes.

Follow-up proof: the six attention/feedback checks and nine keyboard/search checks passed, including hidden pending banners in expanded history, retained Undo, completed move/failure feedback and a synthetic sending-progress response. Workspace gates passed with 49 unit tests and both builds. The longer provider-backed reader journey was not rerun for this presentation-only follow-up.

Completed-read correction: expanded history previously bypassed the quiet-outcome filter and displayed Completed/Marked as read notifications. A new regression reproduced that leak, then passed with the shared filtering rule. Successful read/unread rows stay hidden during expansion, refresh and reload; Undo and failures remain available. Sixteen focused attention/search Chromium checks passed. The provider-backed fixture now checks successful read retries without expecting or dismissing a completed-read toast.

Read-Undo follow-up: read/unread actions now have no visible Undo button or routine history entry in either mode. Folder Undo controls and the keyboard shortcut remain. Seven attention/feedback checks and nine keyboard/search checks passed, covering an actual pending read while folder history is expanded, completed outcomes/reload, manual unread preservation and unchanged failures/send feedback. Workspace gates passed with 49 unit tests and both builds. The accelerated-clock completion phase resets its read budget so simulated time does not exhaust the real server's minute window.

Proof: `npm run check` passed lint, both typechecks, 49 unit tests and both builds. Twenty-three focused Chromium checks passed across the new controlled-clock attention journey, conversations/loaded HTML, keyboard search/Undo and the existing IMAP reader/provider journey. Coverage includes brief versus sustained viewing, simulated visibility transitions, loading content, manual unread preservation, one attempt per opening, quiet outcomes after reload, visible failures, move toasts, unread-search return without cascading reads, and provider STORE/move/retry/conflict/Undo behavior. The long reader fixture starts its triage phase with a fresh read budget and checks dynamic unread counts because its newly opened neighbors now become read. Real browser/OS focus transitions and manual cross-browser/screen-reader acceptance remain pending.


## Saved image defaults — 2026-10-30

**Settings › Security** now controls privacy proxying and default blocking per user. Both stay on by default. With blocking off, the reader's initial signed body grant enables images; manual Hide still generates a blocked grant instead of falling back to the automatic default. With proxying off, allowed remote HTTPS sources and CSS backgrounds go directly to approved public image origins under a body-specific CSP; inline images remain on owned content endpoints. Direct fetches expose the reader's IP and use browser networking. Defaults apply to newly opened views. Sandbox, scripts/forms/fonts restrictions, no-referrer and owner/session/cache grants remain enforced. See [behavior, direct-mode limits and upgrade](mail-preferences.md).


## Automatic format and neutral canvas — 2026-10-30

The MIME parser does not manufacture HTML from text-only mail, so cached HTML availability determines the reader's format. Missing content-host configuration still falls back to plain text. The isolated document defaults to a muted light canvas (`#f1f2f7`) rather than white; uncoloured HTML adopts a dark canvas (`#222222`) and light text in the app's dark theme. Sender-authored palettes retain their explicit colours, backgrounds and table layout, with a neutral light fallback to avoid mismatched inherited foreground/background colours.

The app passes an enum-validated `theme=light|dark` appearance parameter to body/forward content requests. Theme changes renew the existing owned content grant with the current image choice; cached images are reused. Failed renewal keeps the existing readable frame. Theme input cannot change ownership, image permission, CSP isolation or resource validation. No scripts, same-origin sandbox permissions, cache/schema changes or new dependencies are added.
