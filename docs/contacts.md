# Recipient autocomplete

In the composer, type at least two characters in **To**, **Cc** or **Bcc** to see matching names and email addresses from your synchronized mail. Suggestions are optional: typing, pasting, autosave, sending and Send later continue to work without them.

Use Up/Down and Enter to select, or click an option. Escape dismisses the list; Tab leaves the field without choosing a recipient. IME composition waits until composition ends. Every option shows the actual address alongside its display name. Selection replaces only the recipient containing the cursor, preserving the preceding/following recipients. Names with commas, quotes and backslashes are quoted safely. Completing the last recipient adds a comma/space for the next one. Completing a selection spanning multiple recipients is disabled. A suggestion cannot push a field beyond its existing 4,000-character limit.

Addresses already entered in another recipient or field are filtered case-insensitively. Editing the current recipient still permits replacing its display name. Plus-tag and dotted addresses stay distinct; no provider-specific alias folding or send-as identity management is introduced. Connected IMAP login and SMTP sender addresses are excluded from suggestions; you can still type a self-address manually.

## Sources, ranking and coverage

Sources are the signed-in user's synchronized From/To/Cc header participants. There are no provider/network lookups on this path and no separate address book or retained contact history. Bcc, cached body/header data, local drafts and Outbox recipient envelopes never seed suggestions. Active Drafts, deleted memberships, Trash and Junk are excluded. A message with another eligible synchronized membership can still contribute its public participants. Pin/mute/snooze do not erase contact history.

Match names and addresses by word/address-part prefix, with up to eight search words. Exact address and address-prefix matches rank first, followed by name-prefix/other word matches. Within match quality, the selected sending account is preferred, then frequency and recency. Case variants of an address deduplicate; the preferred account's most recent matching nonempty name is selected. Names come from mail headers, not a verified directory. Unsupported/incomplete SMTP addresses and header-control addresses are not suggested.

Migration `0026_contact_search.sql` adds a generated participant-only full-text vector and GIN index. It reuses the existing participant-text function and caps its index input at 100,000 characters per message. It excludes subject/body/Bcc, so unrelated subject matches cannot crowd the contact candidates. Suggestions examine at most the latest 2,000 eligible matching messages, return up to eight addresses and show a coverage note when the matching history exceeds that bound. Frequency counts synchronized physical message copies; this is a bounded recipient aid, not a promise to enumerate every historical contact. Full export uses the eligible source headers rather than this suggestion sample/index prefix.

Requests debounce for 300 ms and are cancelled when input, account, focus or session changes. Results are scoped to the current query/account; a late prior response cannot replace the current list. Suggestions filter current To/Cc/Bcc choices locally without sending those fields to the lookup endpoint. Mail/account SSE invalidations refresh a focused list, with normal new requests on refocus. Lookup failures show a small notice and retain manual entry and draft recovery. Requests have a separate owner-scoped 120/minute budget so autocomplete does not consume the normal mail-list read budget. Typed query strings are omitted from existing request logs.

## Ownership, deletion and export

Every request requires the existing verified session and private owner boundary. A preferred account must belong to that user; an admin role does not grant foreign contacts. Only names/addresses are returned, with no subjects, bodies, source message IDs, frequency or Bcc metadata. Responses are `no-store` and the browser retains no persistent suggestion cache.

Deletion follows the source mail: deleting its final eligible local source, moving it to Trash/Junk, or disconnecting its account removes that observation from subsequent suggestions/export. Other eligible sources can keep the same address available. User deletion cascades the source mail and generated index data. There is no independent contact record requiring a second deletion. Manual address-book editing/hiding and external contact imports are outside this autocomplete slice.

The same private contact set can be exported through `GET /api/mail/contacts/export`. It returns up to 100 unique names/addresses with `nextCursor`; request subsequent pages using `?after=<URL-encoded nextCursor>` until it is null. Cursor order is normalized address, duplicates are removed across accounts and pagination never authorizes foreign mail. Pages reflect current local data; concurrent sync/deletion can change subsequent pages. This is a paginated JSON API, not a complete user-data export UI; broader user export/deletion remains L07. Suggestions use `GET /api/mail/contacts?q=<prefix>&account=<optional owned sending account>`.

## Upgrade and rollback

Apply 0026 with `npm run db:migrate` before deploying API/web changes. Existing sync writers automatically maintain the generated vector as participant metadata changes. No dependency, environment value, worker queue, credential or provider budget changes. The stored generated column/index require a mail-table rewrite/index build; use a maintenance window for a large hosted database.

Application rollback retains the additive column/index and existing source mail. Older API/web code ignores them. Do not reset mail, drafts, provider mappings, queues or immutable Outbox snapshots. Local application/replay preserved 3,784 messages/memberships, eleven cached bodies, three drafts, provider mappings, credentials, stored chunks and seven immutable Outbox records.

## Verification — 2026-10-29

Disposable API tests cover private/verified ownership and foreign-admin denial, Bcc/Drafts/Junk/Trash exclusion, account validation, selected-account/frequency ranking, casing/plus aliases, malformed addresses/names, self exclusion, parameterized hostile prefixes, pending moves, source/account deletion, bounded history and paginated private export. Pure recipient tests verify quoted commas/escapes/comments, caret boundaries, safe address formatting and duplicate handling with the actual SMTP address parser.

Chromium covers keyboard/pointer completion, replacement in the middle of a quoted list, independent To/Cc/Bcc, autosave/reload, stale responses, IME, literal hostile names, offline lookup/manual entry, live source deletion and field-size refusal. Existing composer, provider-Drafts, reply and Send later journeys are regression checks. No real provider connections, messages or recipient sends are needed for these tests.

Implementation proof: `npm run check` passed lint/typechecks, 42 unit tests and both builds. All 206 integration tests passed. Five focused Chromium journeys passed all ten checks across autocomplete, composer autosave, provider Drafts, replies and Send later. Migration application/replay preserved existing rows and protected content; local health/readiness returned 200. Tests used synthetic mail and sent nothing to real recipients.

Manual screen-reader/mobile acceptance, large-mailbox performance and supported-provider release acceptance remain separate gates. Claude Design visual integration remains pending.
