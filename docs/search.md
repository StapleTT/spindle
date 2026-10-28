# Local search and keyboard triage

Search reads the signed-in user's synchronized Postgres data. It never connects to a provider, fetches bodies or starts remote searches. Platform administrators have the same ownership restrictions as other users. Opening a result uses the existing isolated reader and may request missing content through the worker.

## Search and coverage

Use **Search mail**, optionally choose an account/folder, and submit. Query, scope and pagination live in the URL fragment, so reload, browser Back and reader navigation preserve them. Results sort by received date descending, then local UUID descending. Keyset cursors are bound to the user, query, account and folder. Previous/Next uses the same filters and order; opening mail does not mark it read.

| Syntax                                      | Meaning                                                |
| ------------------------------------------- | ------------------------------------------------------ |
| `project launch`                            | Both words, in indexed headers or available body text  |
| `"project launch"`                          | Adjacent full-text tokens; punctuation is normalized   |
| `-subject:cancelled`                        | Exclude a word/phrase or supported filter              |
| `from:alice`, `to:"Bob Example"`            | Sender or To display names/addresses; To excludes Cc   |
| `subject:project`, `body:minutes`           | Restrict the full-text term to that field              |
| `is:read`, `is:unread`                      | Current local read state, including pending actions    |
| `has:attachment`                            | Attachment metadata in a current cached body           |
| `after:2026-10-01`, `before:2026-11-01`     | Received date, inclusive after / exclusive before, UTC |
| `in:inbox/archive/sent/trash/spam/anywhere` | Choose one role scope, without a minus                 |

Search combines terms with AND; there is no OR, wildcard, fuzzy matching or stemming. Text matching uses Postgres's `simple` configuration, including normalized address tokens. Unknown operators, malformed quotes/dates, control characters, over 500 characters or over 32 terms are rejected. A selected folder takes precedence over `in:`. Without a folder or `in:`, searches cover synchronized received folders including Sent and Archive, excluding Trash/Junk. Empty search restores the ordinary inbox/folder view. Active Drafts remain in the composer workspace. **Clear search** retains the current account/folder; **Unified inbox** clears both scope and query.

Indexed header text includes subject, sender and To/Cc names/addresses, capped at its first 100,000 characters. Bcc is excluded. Body indexing covers the first 100,000 characters of ready, unexpired content using the current sanitizer version. Search shows cached-body count versus total messages in the selected base scope, before term filters. Account cards expose sync history and initial-sync progress; synchronized history limits still apply. Opening mail fills the existing seven-day, bounded cache; expiry, eviction or sanitizer upgrades remove body/attachment matches until content is cached again. A negative body term cannot prove an uncached message lacks that term. Attachment filenames and file contents are not searched. Remote search/ingestion remains J02.

Folder copies retain distinct local message IDs. If a provider exposes the same mail through multiple physical IMAP folders, all-folder results may contain multiple copies. Spindle does not merge identities based on untrusted Message-ID headers.

## Saved and split views

Apply a search, enter a name and choose **Save current search**. Up to 50 private named searches store query, optional account and folder. Names are unique per user; delete/recreate to change a saved search. Removing its account/folder deletes the saved view instead of broadening its scope. The **Split reader** preference is stored per user in this browser; desktop shows list and reader together, narrow screens stack them. Automatic “Needs reply” and “Newsletters” heuristics remain separate J03 work.

## Keyboard controls

The **Commands and keyboard shortcuts** button, `?`, or Ctrl/Cmd+K opens the native modal command palette. Filter commands, use arrow keys and Enter, or Escape to return focus. Available commands invoke the same enabled controls as mouse/touch actions.

| Key             | Action                                                       |
| --------------- | ------------------------------------------------------------ |
| `/`             | Focus search                                                 |
| `j` / `k`       | Focus next/previous row on this page, or navigate the reader |
| `o` / `u`       | Open focused row / return to list and restore focus          |
| `c`             | Compose                                                      |
| `m`             | Toggle read/unread                                           |
| `e` / `#`       | Archive / move to Trash                                      |
| `r` / `a` / `f` | Reply / reply all / forward in the reader                    |
| `x`             | Toggle selection of the remembered row                       |
| `z`             | Undo the latest currently available action                   |
| `n` / `p`       | Older / newest list page, focusing the first result          |

Shortcuts pause in inputs, selects, textareas, contenteditable editors, textbox/combobox roles, dialogs, IME composition and outside the mail workspace. Handled events and other Ctrl/Meta/Alt combinations are ignored. Mutation-key repeats are ignored. In split view, row focus targets that row; reader focus targets the open message. Reply shortcuts from a list row cannot reply to a different open message. Mutations require an explicit row or reader context. Read-state filters advance the reader when an action removes its current result. There is no send shortcut or permanent-delete shortcut.

## Selected message actions and recovery

Checkboxes select only visible rows on the current page, up to 50; the page checkbox never means all matching results. Changing query, account, folder or page clears selection. Polling removes vanished rows from selection. **Mark selected read/unread**, **Archive selected** and **Trash selected** queue the existing durable per-message intents. Missing messages or unsupported destinations are refused individually, including mixed-account batches. Each newly attempted item consumes the existing 60-per-minute action budget. The batch endpoint also uses the ordinary write budget.

Batch results distinguish recorded intentions from refusals. Provider completion/failure/conflict and individual five-second Undo remain in **Recent actions**. Undo is per message, never an atomic whole-batch rollback. The worker owns provider I/O, lease fencing, retry policy and conflict reconciliation, unchanged from [mail actions](actions.md).

Before submission, user-scoped session storage retains each client operation ID. An unconfirmed response offers **Retry same batch request**, including after reload; it reuses those IDs and cannot create duplicate accepted intents. New batches wait until the outstanding response is resolved. Browser storage must be available before submission. Closing a tab can remove this recovery record; durable accepted actions remain on the server and in Recent actions. Refused items can be selected again as new explicit intentions.

## Upgrade, rollback and proof

`0018_local_search.sql` adds generated search vectors/GIN indexes, an immutable participant-text function and the owned saved-search table. Apply with `npm run db:migrate` before deploying the search API/web. It does not rewrite original headers, bodies, drafts, credentials or immutable Outbox snapshots. Application rollback keeps this additive migration; older code ignores the derived columns and saved views. Do not drop user-created saved searches as an application rollback step. Initial index creation locks the mail tables; schedule a maintenance window for large hosted datasets. Reindex/performance work is required if the existing bounded local approach stops meeting measured targets.

Automated proof uses disposable databases and synthetic mail: parser limits/parameterization; foreign-user/admin denial; full-text filters and cache expiry/revision/prefix coverage; stable cursors/reader neighbors; saved-view quota concurrency and scope removal; partial batches, operation replay, quotas and undo. Chromium exercises search reload/saved views, filtered navigation, split-context targeting, input/IME guards, lost batch response recovery, read/Trash/Undo, command palette, pagination/focus, narrow reflow and stale-response isolation, including late reader actions after a new search. Existing action/provider/browser suites remain the provider-side regression proof. Large-mailbox keyboard/screen-reader acceptance and performance benchmarks remain J06–J08/K09.

Implementation verification on 2026-10-28: `npm run check` passed with 39 unit tests; all 149 integration tests passed; six focused Chromium journeys passed, including eight search/triage subchecks. Local migration/replay preserved existing counts and protected content, and health/readiness returned 200. The full browser suite and manual large-mailbox/screen-reader acceptance were not run for this slice.
