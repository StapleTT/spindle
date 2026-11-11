-- Drafts are Spindle-only (D044). Stop queueing provider Drafts work on save/delete.
DROP TRIGGER mail_draft_provider_save ON mail_drafts;
DROP TRIGGER mail_draft_provider_delete ON mail_drafts;
DROP FUNCTION queue_provider_draft();
--> statement-breakpoint
-- One-time cleanup of copies earlier sync wrote. Copies the user chose to keep stay 'kept'.
-- draft_id is cleared so no worker version can treat a local draft as something to re-upload;
-- source_draft_id and copy history are retained.
UPDATE mail_draft_copies SET state='obsolete' WHERE state='active';
UPDATE mail_draft_links l SET draft_id=NULL,active_copy_id=NULL,candidate=NULL,error_code=NULL,attempts=0,
  state=CASE WHEN EXISTS(SELECT 1 FROM mail_draft_copies c WHERE c.user_id=l.user_id AND c.link_id=l.id
    AND c.state IN ('obsolete','appending','unknown')) THEN 'pending' ELSE 'removed' END,
  next_attempt_at=clock_timestamp();
-- Conflict review no longer exists, so its files no longer need to be retained.
DELETE FROM mail_draft_conflict_files;
-- Native draft imports stop; failed/pending intents stay as history and are never processed.
