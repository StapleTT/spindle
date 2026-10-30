# Notifications while Spindle is open

Notifications are off by default. Open **Settings › Security › Notifications** and turn on **Desktop notifications**. Only that switch requests browser permission. Denied or dismissed permission leaves alerts disabled and explains how to try again. Browser permission alone does not enable Spindle alerts.

The preference is private to the signed-in user in this browser, shared across its tabs. Sender/subject previews have a separate opt-in and start hidden. Notification bodies never include recipients, message text, attachments or Bcc. Preview text is bounded and strips control/bidirectional override characters. Clearing site data resets these preferences.

## Delivery and unread counts

- Alerts use the browser's native page Notification API. Spindle must remain open; background tabs can receive alerts while the browser allows them to run. There is no service worker, subscription, Web Push endpoint or closed-app delivery.
- Only newly synchronized unread INBOX mail after initial history completion qualifies. Existing unread mail, backfill, UIDVALIDITY resets, opening/reopening the app and enabling alerts establish a baseline without replaying history. Messages whose provider receipt is over five minutes older than synchronization are treated as imports or delayed history and stay quiet.
- Reading, deletion flags, moving out of the inbox, muting or snoozing consumes a pending arrival. Undoing these changes or waking a snoozed conversation does not replay it. New replies inherit existing account-scoped conversation mute/snooze settings before the sync transaction commits.
- The browser title and Notifications summary use the same local owned unread predicate as unified inbox counts. Muted mail still counts as unread; snoozed mail stays outside inbox counts until awake. Notifications do not mark mail read.
- An authenticated local feed refreshes on existing mail/account SSE invalidations with polling recovery (ten seconds without SSE, thirty seconds with it). No provider connection or rendering-path provider I/O is added.
- Same-origin browser locks serialize receipt claims in shared local storage, preventing duplicate popups across tabs. Shared receipts contain only message IDs/timestamps. A batch becomes one alert, and a newer batch replaces the previous alert. A click focuses Spindle and opens the first eligible message after rechecking the signed-in user and owned message access.
- Disabling notifications, changing preview preference, session rejection, page closure/navigation and permission revocation observed on refresh close the page's active popup. Restoring a page from the back/forward cache starts a new baseline. Session/user changes cannot reuse another user's preference or navigation permission.

Delivery is best effort: page suspension, OS settings, browser permission and crashes can suppress popups. The bounded feed covers the newest fifty eligible arrivals within five minutes, and shared receipts retain six minutes with a 1,000-entry cap. Claims occur before popup construction, so a closed/crashed tab can miss an alert rather than duplicate it. These limits never change inbox storage or unread counts. Notification clicks can be refused if the message is removed or access changes.

Desktop notifications require a secure context, the Notification API, browser locks and functioning local storage. Unsupported browsers keep ordinary inbox updates/unread counts. A browser that exposes the API but refuses page notifications reports a visible error. Mobile/OS and production HTTPS acceptance remain manual checks.

## Upgrade and rollback

Apply additive migration `0027_open_app_notifications.sql`, then deploy the compatible API/worker before the web bundle. Existing messages get a null arrival marker and cannot generate historical alerts. Triggers clear pending markers when local/provider state suppresses them. No dependencies, environment variables, queues, mail credentials or provider connection budgets change.

Retain migration 0027 on rollback. Older workers omit the nullable marker and simply stop producing new alerts; all mail, drafts, settings and immutable Outbox snapshots remain intact. Redeploying compatible code resumes new arrival detection without resetting user data.

## Deferred: notifications after closing Spindle

The user explicitly deferred closed-app/closed-browser notifications. A later task must design and implement Web Push/service-worker delivery, explicit subscription consent and revocation, private payloads, expiry/deduplication, logout/device cleanup and supported-browser/OS acceptance. This is outside the current beta notification slice; do not advertise closed-app delivery.

## Verification

Automated tests use synthetic IMAP mail and mocked desktop notifications. The server suite checks owner/admin isolation, verified sessions, baseline/history/reset handling, inherited mute state, read/move/delete suppression, snooze/wakeup behavior, preview sanitization, bounded bursts and unread-count consistency. The browser suite exercises explicit permission requests/denial, private previews, shared-tab receipt claims, click authorization, disable/revoke cleanup and page/session lifecycle. See the dated K06 proof in `REBUILD_TASKS.md` for actual run results and remaining acceptance.
