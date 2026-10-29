# Live mail updates

Signed-in, verified users automatically receive local changes through one native EventSource per mail tab at `GET /api/mail/events`. IMAP IDLE still signals the worker to synchronize authoritative provider metadata; SSE makes committed local changes visible without waiting for the browser's former ten-second refresh. Lists, searches and counts continue to read Postgres only.

## Protocol and recovery

The endpoint accepts the existing session cookie, no query parameters and no cross-origin requests. Events contain topic names only, never mail content, credentials, owner IDs or session IDs:

```text
retry: 5000

id: <stream-uuid>:1
event: reset
data: {"topics":["mail","accounts","actions","outbox","drafts","files","searches"]}

id: <stream-uuid>:2
event: change
data: {"topics":["mail"]}
```

Each connection, including reconnections, starts with `reset`: refetch authoritative owned local state. IDs order frames within a transport connection; the browser ignores malformed, duplicate and out-of-order change frames. `Last-Event-ID` is format-validated but is neither an authorization token nor a replay cursor. There is no durable event log or promise to deliver each notification. Durable database state plus reset/refetch and polling provide recovery.

Migration `0021_mail_events.sql` adds selective row triggers using transactional Postgres NOTIFY. Rollbacks emit nothing, and identical owner/topic notifications coalesce within a transaction. Every API instance listens to the same channel and routes notifications only to that owner's authenticated streams. Worker/API changes therefore work across processes without sticky routing. Lost LISTEN connections close affected streams; reconnect establishes LISTEN before reset so changes committed during a gap are recovered by refetch.

| Topic      | Observable changes                                                               |
| ---------- | -------------------------------------------------------------------------------- |
| `mail`     | Mailboxes, message metadata/memberships, cached-content and attachment readiness |
| `accounts` | Account sync/status/settings, SMTP identity/readiness and signatures             |
| `actions`  | Pending/completed/failed/conflict action feedback and dismissal                  |
| `drafts`   | Draft revisions and provider Drafts reconciliation                               |
| `outbox`   | Sending and Sent-copy outcomes                                                   |
| `files`    | Upload/scanning states and draft attachment links                                |
| `searches` | Private saved searches                                                           |

Read timestamps, leases, IDLE scheduling, retry timers and chunk writes do not generate events. New writers that expose different observable columns must extend trigger coverage with an appended migration.

The browser coalesces invalidations over roughly two seconds and reuses existing guarded reads. Live updates preserve navigation, typed search, unsaved/recovery text, conflict checks, the reader iframe and per-message image consent. Compose waits for the first successful account lookup so sender/signature defaults are available. Foreground/online transitions also invalidate local views. Healthy streams reduce list/conversation/status polling to about 30 seconds; existing draft safety polling remains. Disconnected streams retain automatic refresh and display a reconnecting notice. Network failures preserve cached mail; authoritative session denial triggers an authentication refresh.

## Authorization and bounds

Existing Better Auth middleware authorizes the initial connection. Before each event and at least every two seconds when idle, the API rechecks that the same owned session exists, is unexpired and belongs to a verified user. Revocation, expiry or verification removal emits `session-ended` and closes the stream. Admins have no implicit access to other users' events or mail. Normal account/message requests still enforce current ownership.

Each API process allows four streams per user and 100 total, returning 429 beyond those limits. These are process-local limits, not deployment-wide quotas. Streams send idle heartbeat comments around every 15 seconds, close after five minutes and reconnect with a five-second retry. Slow clients are closed on native write backpressure rather than accumulating mail events. Shutdown closes streams and releases the listener.

## Deployment and rollback

Apply migrations before deploying the new API/web app. No new environment variables, dependency, worker queue or provider connection is required. After the first stream opens, each API process reserves one additional connection from its existing Postgres pool for LISTEN. Use a direct database connection or session-persistent pool; transaction-mode poolers cannot preserve LISTEN state. Budget this connection plus the normal request/session-check traffic for every API replica.

Serve `/api/mail/events` through the same application origin with streaming and proxy buffering disabled. The endpoint sets `text/event-stream`, `private, no-store, no-transform` and `X-Accel-Buffering: no`; proxies must honor streaming, avoid caching/compression buffering and allow idle/read timeouts beyond the heartbeat interval. A timeout longer than the five-minute stream lifetime is convenient. Deployments still need real proxy/restart and concurrency measurements.

Roll back application code while retaining the additive migration and existing data. Older APIs/workers safely ignore notifications; older browsers keep polling. Do not reset mail, drafts, queues or immutable Outbox records, and do not edit applied migrations.

## Verification — 2026-10-29

Disposable-database API tests exercise real HTTP streams and two API instances: commit/rollback, foreign-user/admin denial, malformed requests, no-op/bookkeeping silence, reconnect/reset, killed LISTEN recovery, caps/cleanup, revocation during notification storms and shutdown. Chromium covers two private tabs, foreign-owner isolation, malformed/duplicate frames, saved-search/read-state updates, dirty draft preservation, API restart/missed commits and revoked sessions. Focused IDLE and conversation journeys verify earlier visible arrival and unchanged iframe/image consent/search focus; composer testing delays account lookup to verify correct sender defaults.

All 177 integration tests passed; the focused SSE API suite passed again after its notification-storm scheduling correction. Focused SSE, IDLE, conversations, search, composer and provider Drafts browser journeys passed. `npm run check` verifies lint/typechecks, 39 unit tests and both builds. Local application/replay of 0021 preserved 3,736 messages/memberships, eleven cached bodies, existing users/sessions/drafts/signatures/credentials/uploads and six immutable Outbox records. Tests used synthetic mail and sent no real-recipient messages.

Full-browser, live-provider, production proxy and large deployment/load acceptance remain pending. The knowledge graph is marked stale for a later rebuild.
