# Outgoing attachments

Use **Add files** in the composer, reply or forward. Upload progress and each file's status appear below the note. **Remove** removes a file from this draft. Completed uploads persist with autosave, reopen/reload and **Save my edits as a new draft** recovery copies. Keep the draft open until uploads finish; unfinished uploads cannot survive closing the browser and require selecting the file again. File bytes are never stored in browser recovery storage.

New forwards include ordinary original files within the limits below. The worker retrieves them under the existing account lease and read-only IMAP identity checks, then scans them. Each can be removed before sending. Original files that exceed count, size or storage limits are omitted with a visible warning. Already-fetched files survive deletion of the original message, cache expiry and account removal. Files not yet retrieved can fail if the original disappears; retry fetching or remove them. Replies do not automatically include original files.

## Checks and outcomes

New file attachments, including ordinary files copied into forwards, must receive a clean ClamAV result before Send is allowed. States distinguish uploading, fetching, waiting for a check, checking, ready, failed and blocked. Scanner outages and malformed/unfinished responses fail closed; **Retry check** retries the existing bytes after the scanner becomes available. Files detected as malware are blocked and their bytes discarded. Interrupted local uploads require selecting the file again. The server independently enforces these rules when sending; disabling a button is not the security boundary.

ClamAV is a private operator-configured service, never a public file-submission API. The supplied configuration also blocks encrypted archives and scan-limit overruns rather than treating uninspected contents as clean. A clean result is a scanner outcome, not a guarantee that a file is harmless. Existing received-file downloads and the formatted-forward pipeline's bounded embedded raster images retain their existing policies; this slice does not claim full received-mail scanning or replace the release security review.

Once Send succeeds, the Outbox holds an independent immutable MIME snapshot, including attachments. Draft revisions protect membership edits and recovery copies. Queued/uncertain sends retain their existing freeze, cancel, retry and no-blind-resend rules. Acceptance removes the draft; uncertain delivery keeps its files and text. A provider-advertised size rejection before submission is a definite failure, preserving an editable draft. A lost SMTP acknowledgement remains unknown. See [sending](sending.md).

## Limits and storage

- Up to 10 files, 10 MiB per file and 20 MiB total per draft.
- Up to 30 MiB encoded MIME for messages with file attachments, including Base64 overhead, note and forwarded content. Provider limits may be lower. The existing 512 KiB limit still applies to messages without ordinary file attachments.
- 256 MiB of reserved/stored outgoing files and Outbox MIME per user, including retained outcomes; up to 1,000 file records.
- Two unfinished local uploads per user across API instances and four active binary uploads per API process. Upload writes have a separate persistent 60/minute budget; status reads use the existing read budget.
- Local upload requests have a two-minute deadline. Unstarted uploads expire after ten minutes; interrupted/expired streams discard partial bytes. Unreferenced files are cleaned after 24 hours. Referenced drafts retain their files. Settled Outbox retention remains seven days; unresolved failures and unknown outcomes remain available and count toward storage.

Uploads, scanner reads, MIME persistence and SMTP reads use Postgres chunks of at most 256 KiB with bounded read batches. The queue transaction freezes MIME and starts the five-second undo window after construction completes. No attachment file paths, URLs or declared MIME types grant server file/network access; filenames are normalized and ordinary files are sent as `application/octet-stream` with encoded filenames. Both file references and chunk rows enforce the owner boundary in APIs, worker queries and composite foreign keys. Platform admins have no implicit file access.

Provider Drafts synchronization also imports native files through quarantine and retains conflict-file references; see [provider drafts](provider-drafts.md). Provider Drafts and optional Spindle-managed Sent copying use ImapFlow's byte-buffer APPEND API, so that one operation buffers at most the bounded 30 MiB snapshot. SMTP transmission stays streamed. Provider-managed Sent mode avoids that APPEND. Streamed APPEND and broader M3/release acceptance remain open.

## Start the scanner locally

Run from the repository root:

```sh
docker compose up -d clamav
docker compose logs --tail=30 clamav
docker compose ps clamav
```

Use `sudo docker ...` if your local Docker permissions require it. The first start downloads virus signatures and may take several minutes. The service binds to loopback port 3310 and keeps signature updates in `clamav_data`; allow sufficient RAM for the signature database. The worker defaults to `CLAMAV_HOST=127.0.0.1`, `CLAMAV_PORT=3310`. Hosted deployments should use a protected private endpoint; ClamAV's TCP protocol has no application authentication or TLS here, so never expose it publicly. Restart the worker if changing endpoint environment variables.

If files show **Security check unavailable**, confirm the container is healthy, then choose **Retry check**. Ordinary messages without file attachments keep their existing sending path. Preserve existing `.env` values; the defaults need no secret changes.

## Upgrade, rollback and proof

Apply additive migration `0014_outgoing_attachments.sql`, then deploy API, web and worker together. Existing outbox rows retain their bounded `raw` bytes. New messages with file attachments use owned immutable MIME chunks and a recorded byte count. The migration does not rewrite existing mail, drafts, settings or send states. Replaying it is safe; no cache reset or data deletion is required.

Drain/stop old workers before enabling new attachment queues. For rollback, retain the migration, file/chunk tables and outcomes. An older worker cannot read chunked MIME: keep those queued jobs stopped until the current worker is restored. Never convert sending/unknown rows to queued, and never restore a database with sending enabled. File data lives in Postgres and follows its backup, restore and private-volume requirements; signature data is a separate scanner cache. Removing a draft detaches references; user deletion cascades stored files and outgoing snapshots.

Synthetic integration/browser tests cover verified ownership and foreign-admin denial, origin checks, safe Unicode filenames, upload replay, partial/oversized streams, cancellation races, persistent quotas, scan failures/retries and malware blocking, revisions and copies, immutable streamed MIME, exact recipient/Sent bytes, provider size rejection, cancellation/unknown outcomes, forward retrieval and source deletion, cleanup and durable dispatch. No real-recipient test email is sent. Real-account file delivery remains operational acceptance until confirmed.

Live scanner verification after the user started ClamAV: the configured service accepted harmless bytes and detected the standard EICAR antivirus test. A disposable-database check through the real upload API, Postgres chunks and pg-boss worker produced Ready for the clean file and Quarantined for EICAR, with detected test bytes removed. No private files or real recipients were used. The existing development database had no attachment rows needing retry.
