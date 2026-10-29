# Pin, mute and snooze

Open a message and use **Conversation settings** above its timeline. These settings belong to the signed-in user and the connected account. They apply to the current header-linked conversation, including synchronized Sent/folder copies and new replies. The message list still shows individual messages; read/archive/trash/move actions still affect only the open message.

| Setting | Behavior                                                                                                                                                                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin     | Puts the conversation's messages before unpinned messages in inbox, folder and search results. Within each group, received date and message ID preserve stable ordering. **Pinned** finds pinned mail.                                                                                |
| Mute    | Records local notification suppression for the conversation. Mail stays visible, with its existing read flags and counts. **Muted** finds muted mail; **Unmute conversation** cancels it. Notification delivery is still a separate K06 feature; this slice sends no notifications.   |
| Snooze  | Hides the conversation's inbox messages from unified/account/folder inbox views and their counts until the chosen time. New replies stay snoozed. **Snoozed** finds the hidden mail and offers reschedule/unsnooze. Ordinary all-folder searches and other folders can still show it. |

These settings never change provider flags, folders or provider-native pin/mute/snooze state. Snooze leaves unread flags intact. When it expires or is cancelled, mail that still belongs to the inbox becomes visible again. Archived, moved, trashed or deleted mail is not moved back to the inbox. Pinning does not override an active inbox snooze. Pinned/Muted/Snoozed views exclude Trash/Junk unless a folder is explicitly selected; `in:anywhere` can find those messages.

The sidebar views use the existing searchable scopes `in:pinned`, `in:muted` and `in:snoozed`. They can be combined with other search terms or saved as private searches. Selecting an inbox folder still hides snoozed messages. Opening another conversation member changes the message, while the conversation settings stay attached to the original owned conversation source.

## Time and recovery

Choose **Snooze conversation** or **Reschedule snooze**, then a local date/time. The initial suggestion is one hour ahead. The form shows the browser timezone, offset-bearing local time and exact UTC instant before submission. Nonexistent daylight-saving times are rejected. For an ambiguous repeated hour, the browser chooses its first occurrence and the preview shows the chosen offset/UTC instant. The API also accepts explicit offset-bearing instants. Choose a future time within 366 days. Once saved, the UTC deadline stays the same when the browser timezone or daylight-saving offset changes.

A persisted database timestamp is the durable due-time intent. The existing worker's dispatcher checks it on startup, approximately every five seconds and through its durable minute schedule. No provider connection, new queue or in-memory-only alarm is required. Wakeup rechecks verified ownership/account existence under the existing user/account lock order and conditionally clears only still-due timestamps. A stale scan cannot clear a future reschedule. Multiple workers can recover the same deadline safely.

Inbox visibility also compares the stored deadline with the database clock, so polling/refetch recovers due mail even while the worker is stopped. The worker clears the deadline and emits the usual committed SSE invalidation when it returns. Background delivery, API connectivity and browser polling/coalescing mean this is not a precise alarm service.

Controls submit one explicit change with the last-read version. A stale tab receives a conflict rather than overwriting another tab. **Reload settings** fetches the current state before retrying. Unknown-response failures leave the outcome to subsequent local refresh; repeating a stale request cannot toggle the state again. SSE and polling update other tabs while retaining typed search, draft recovery and reader image consent. Snooze/unsnooze returns to the source list; choose the appropriate sidebar view to find its changed membership.

## State and inheritance

`mail_messages` stores local pin/mute booleans, a snooze timestamp and an independent monotonic version for each field. An explicit change updates the bounded current conversation transactionally. Metadata sync and MIME References upgrades reconcile settings before committing their changed header graph, under existing user/account locks. New replies/copies inherit the latest choice independently for each field. False/unset choices keep their versions so an older pin/mute/snooze cannot return when two components join.

Header corrections or bridge removal can split the graph: existing members keep their last settings, then future changes apply only to the currently connected component. Unpruned mirror copies can carry state through replacement/move synchronization. Once every stored copy of a conversation is removed, its local state is gone; a later disconnected message cannot recover a setting from a deleted conversation. No cross-account rules or permanent conversation merge registry is introduced. Header relationships remain untrusted grouping hints, never authorization.

The existing 1,000-copy conversation cap also bounds these controls. Oversized conversations refuse mutations with 413 rather than partially changing a thread. Metadata reconciliation skips an oversized component so ordinary provider synchronization and individual reads continue; inheritance beyond that limit is not promised. Active Drafts cannot be used as conversation-control sources. Cache eviction does not remove the local settings.

## Upgrade and rollback

Apply `0022_local_conversation_state.sql` and `0023_local_state_lookup.sql` using `npm run db:migrate` before deploying API/worker/web changes. They add defaulted local columns, a monotonic sequence, indexes for ordering/due/choice lookup and a selective `mail` SSE trigger. They preserve existing messages, memberships, bodies, drafts, signatures, credentials, uploads and immutable Outbox records. No dependency or environment changes are needed. Index creation locks the message table; schedule a maintenance window for large hosted databases.

Deploy the compatible API/worker before the new web app. Retain additive columns/indexes during application rollback; old code ignores local choices and resumes its previous list behavior. Reload or choose the newest page if an older API refuses a pin-aware cursor. Old cursor formats remain accepted by the new API as unpinned positions. Do not reset mail, checkpoints, drafts, queues or Outbox snapshots, and never edit applied migrations.

## Verification — 2026-10-29

Disposable API tests cover verified/private ownership and foreign-admin denial, origin/body/date validation, excluded Drafts, pin ordering/cursors/reader neighbors, unchanged provider flags/counts/actions, stale-tab conflicts, snooze views/counts/search, independent-field merge/split behavior, actual synthetic IMAP reply/copy inheritance, worker startup recovery without mail keys, verification removal, oversized graphs and wake/reschedule races. Chromium exercises two-tab propagation, typed-search/focus retention, reload persistence, pin/unpin, mute, snooze/unsnooze, nonexistent local times and due-time SSE recovery. Existing conversation/search/SSE browser journeys remain regression proof.

Implementation proof: `npm run check` passed lint/typechecks, 39 unit tests and both builds. All 186 integration tests passed, followed by all ten focused conversation-state API tests including the added size-limit and stale-wakeup race checks. Four focused Chromium journeys passed all 25 checks across conversation controls, existing conversation navigation/image consent, search/keyboard triage and SSE. Local health/readiness returned 200. No real-recipient messages or live-mail actions were used for tests.

Full-browser, real-provider/manual accessibility, large-mailbox and multi-worker/load acceptance remain pending. Scheduled sending (the rest of K04), notifications (K06) and their acceptance are separate work.
