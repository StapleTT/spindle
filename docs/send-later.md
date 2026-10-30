# Send later

Compose a message, complete its recipients and attachments, choose a checked sending account, then open **Send later** (the arrow beside Send). Pick Tomorrow morning, Tomorrow afternoon or Monday morning to schedule at that local time immediately, or choose **Send at**, check the local timezone, and choose **Schedule send**. The composer flushes autosave before submitting. Existing recipient, provider-draft conflict, clean-attachment, MIME/storage and enqueue limits still apply.

The time must be at least five seconds ahead and within 366 days. Nonexistent daylight-saving times are rejected. For an ambiguous repeated hour, the browser chooses its first occurrence and previews the actual offset and UTC instant. The server accepts an explicit offset-bearing timestamp and stores an absolute UTC deadline. Changing browser timezone or crossing a daylight-saving boundary afterwards changes the displayed local time, not the saved deadline.

## Outbox controls

Scheduled entries show their deadline in **Outbox** and survive navigation/reload. Before the first dispatch claim:

- **Reschedule send** changes only the deadline. It checks the last-read schedule revision; another tab's newer choice produces a conflict. Replaying an acknowledged reschedule recovers it without applying it twice.
- **Cancel send** stops the queued intent and releases its preserved draft for editing. Cancellation is idempotent.
- **Cancel and edit** first confirms cancellation, then reopens the preserved draft with its previous time selected in Send later. Edit, review and explicitly schedule again; this creates a new immutable send intent. A past time must be replaced before scheduling. Leaving the draft does not automatically send it.

Once dispatch is claimed, cancellation/rescheduling cannot recall the message. After a known failed attempt, **Retry send** retains the saved deadline if it is still future, otherwise uses the ordinary minimum five-second delay. An attempted send cannot be rescheduled; review a definite failure or its draft instead. Partial and unknown delivery never offer a blind retry.

A lost enqueue response keeps the operation ID, draft revision and original UTC time in user/draft-scoped session storage. **Recover send request** retries that exact request, including after reload; the ordinary Send and Schedule controls wait for recovery. A reused send ID recovers its existing intent and current status/deadline rather than changing the time. Reschedule has its own guarded endpoint. Browser storage must be available before enqueue; storage/network failures preserve draft text. Check Outbox before creating a separate copy if delivery is uncertain.

## Durable dispatch and safety

Scheduling uses the existing immutable Outbox and worker dispatcher, with no new queue, provider connection, dependency or environment setting. `scheduled_at` is the requested lower bound and `next_attempt_at` is the next dispatch/retry time. The dispatcher scans on startup, roughly every five seconds and through the durable minute schedule. A closed browser does not prevent dispatch. An overdue queued intent sends when a compatible worker/account becomes available; the chosen time is not a guaranteed delivery appointment.

A database trigger clamps queued retry times to the scheduled lower bound and refuses early `sending` transitions, including from older queue writers. The current worker also rechecks the deadline at selection and at the transactional claim. Future schedules do not claim priority over inbox metadata/IDLE work. The existing two-provider-connection budget and account fencing remain intact.

At execution the worker rechecks verified ownership, account existence, checked/current SMTP settings, provider Drafts preflight, frozen draft revision/account, attachment readiness and daily dispatch limits. Actual dispatch is capped at 100 messages or 500 recipient submissions per rolling day across that user's accounts, in addition to existing enqueue limits. Distinct Outbox intents that have started count, including failed and uncertain outcomes; a dispatch-limit refusal is a definite failure that requires review/retry later. Settings changes or account removal cannot silently send the old snapshot. Logging out does not cancel an authorized persisted schedule; removing the account stops queued intents, while email-verification removal prevents worker claims until access is restored.

The message, recipient envelope, sender, signature, reply/forward context, MIME headers (including the composition Date) and attachment bytes freeze when scheduling. Reschedule changes dispatch metadata only. SMTP and Sent use the same frozen bytes and stable Message-ID. Cancel and edit is required to change content or headers. Scheduled mail retains the existing known-failure, partial acceptance and delivery-unknown rules: a durable `sending` marker left by a crash becomes unknown, never automatic redelivery. SMTP acceptance still does not prove recipient delivery.

## API and upgrade

- `POST /api/mail/drafts/:id/send` accepts the existing operation `id` and draft `revision`, plus optional ISO `scheduledAt`. Omitting it preserves Send now behavior.
- `PATCH /api/mail/outbox/:id/reschedule` accepts `revision` (the last-read `scheduleRevision`) and ISO `scheduledAt` for a scheduled queued intent that has never been claimed.
- Existing owned Outbox GET/cancel/retry endpoints remain authoritative. Metadata adds `scheduledAt`, `scheduleRevision` and `startedAt`; healthy SSE/polling refreshes other tabs. Admins gain no access to another user's schedules, drafts or recipients.

Apply additive `0024_send_later.sql` with `npm run db:migrate`, drain older workers, then deploy the compatible API/worker before enabling the web controls. It adds nullable scheduling metadata, a revision and guards/notification triggers. Existing ordinary sends stay unscheduled, with immutable MIME and existing data preserved. Existing due indexes and queues are reused.

For application rollback, stop/drain the sending worker first and retain the migration and all records. The database guard preserves the lower bound for older queue code, but older workers lack the new execution checks and older UIs do not expose schedule controls. Keep compatible workers for scheduled mail or cancel unstarted schedules before deliberately returning to an older sending release. Do not reset `sending`/`unknown` rows, replay SMTP after a restore, edit applied migrations or discard scheduled intents during rollback.

## Verification — 2026-10-29

Disposable synthetic SMTP/IMAP tests cover ownership/admin/origin/verification denial, date/schema bounds, long-date output, immutable and streamed attachment snapshots, idempotent enqueue/reschedule, cancellation/edit release, overdue startup recovery, no priority starvation, guarded races, Bcc privacy, current settings/dispatch quotas/account removal, file readiness and no repeat after uncertain acceptance. Chromium verifies lost-response recovery through reload, exact original operation/time reuse, cross-tab schedule updates, reschedule persistence, Cancel and edit, explicit requeue and one eventual synthetic send. Ordinary SMTP and snooze browser journeys remain regression checks for sending recovery and the shared timezone control.

Implementation proof: `npm run check` passed lint/typechecks, 39 unit tests and both builds. All 197 integration tests passed, followed by focused scheduled/ordinary SMTP checks after the cancellation-metadata correction. Three focused Chromium journeys passed across Send later, ordinary SMTP and snooze controls, including lost-response recovery, cross-tab reschedule, cancel/edit, restart persistence and shared DST validation. Migration application/replay preserved existing records and protected MIME; no real-recipient messages were sent.

Live-recipient schedule acceptance, the full browser suite, production downtime/restore and multi-worker/load/manual-accessibility acceptance remain pending.
