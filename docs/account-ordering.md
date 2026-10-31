# Account ordering

In Settings → Accounts, drag the three-line handle on the right of an account to reorder it with a mouse, pen or touch. A drop marker shows the destination; holding near the scrolling area's edge scrolls the list. Release to save. Escape, pointer cancellation and dropping outside the list cancel the gesture. Clicking the handle without dragging does not save.

Keyboard users can focus the same handle and press Up/Down to move one position. Focus stays with the handle. There is no visible success or position message. Pending saves prevent another ordering action; failures stay visible and the current saved list is refetched before retrying.

Order belongs to the signed-in user and is saved in Postgres across browsers/devices. Settings, the sidebar, account filter chips, search account selectors, signatures and composer selectors share the ordered account list. Reordering an open composer leaves its selected sending account and saved draft unchanged. It does not reorder messages or change provider folders, credentials, sync requests or mail state.

Existing accounts retain their creation-time/ID order until moved. New accounts append after saved positions. Reconnecting preserves position; disconnecting removes that account without changing the relative order of the others. Existing automatic account colors remain positional; explicitly saved custom colors stay with their accounts.

## API and concurrency

`GET /api/mail/accounts` sorts by nullable `sort_order`, then creation time and ID, with unsorted accounts last. `PATCH /api/mail/accounts/order` accepts:

```json
{
  "accountIds": [
    "22222222-2222-4222-8222-222222222222",
    "11111111-1111-4111-8111-111111111111"
  ],
  "expectedAccountIds": [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222"
  ]
}
```

Both arrays contain one to five unique UUIDs. The desired array must contain exactly the current user's connected accounts. The server derives ownership from a verified session, requires the exact write origin, bounds bodies and applies existing persistent write limits. Admin roles provide no override. The response returns `accountIds` only.

The transaction locks the user and owned accounts in the existing owner-first order. Stale ordering or account membership returns a generic 409 without partial writes or information about foreign accounts. Replaying an already-current desired order succeeds without rewriting data. Only changed positions are updated. The existing commit-only accounts-topic SSE notification updates other open clients; reset/refetch and polling retain their existing recovery behavior. Pending reads from before the save cannot overwrite the saving tab's acknowledged order.

## Upgrade and rollback

Apply additive migration `0030_account_order.sql` before deploying the new API, then deploy web code. It adds a nullable checked integer and accounts-topic notification trigger, with no backfill or mail rewrite. No dependency, configuration, provider call or background job is added. On rollback, retain the column/trigger; older API code uses creation order and ignores saved positions. Re-upgrading restores saved ordering. Do not reset the database.

## Verification — 2026-10-31

Seven focused API checks passed across ordering and existing account colors: default order, persistence through another API instance and migration replay, unchanged non-order account fields, ownership/verification/origin boundaries, bounded malformed/duplicate/incomplete input, concurrent stale saves, safe replay, append/reconnect and account removal. Eight Settings Chromium checks passed, including keyboard focus, failed-save retry, sidebar/filter/composer consistency, touch layout, cross-tab invalidation and reload/device persistence. The new browser slice starts with fresh read/write budgets after the preceding settings journeys.

`npm run check` passed lint, workspace typechecks, 46 unit tests and both builds. The local migration and replay preserved private row hashes/counts for users/sessions/accounts, eight mailboxes, 3,924 messages/memberships, 31 cached bodies, four drafts, seven immutable Outbox entries and saved preferences. A phone screenshot was inspected. Manual screen-reader and cross-browser acceptance remain part of F09/K09.

Follow-up: replaced the visible arrows with a three-line drag handle and removed position/success feedback at the user's request. The eight Settings Chromium checks now exercise mouse dragging, Escape cancellation without writes, keyboard movement and focus, real touch dragging with edge scrolling, absent position feedback, failures/retry and the existing cross-tab/device/composer checks. The persistence API, schema and provider behavior are unchanged.
