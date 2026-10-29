-- Notifications are delivered only on commit and coalesced by user/topic within a transaction.
-- Reconnecting clients invalidate/refetch durable local state, rather than replaying deltas.
CREATE FUNCTION mail_notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    PERFORM pg_notify('spindle_mail_changed',json_build_array(OLD.user_id,TG_ARGV[0])::text);
  ELSE
    PERFORM pg_notify('spindle_mail_changed',json_build_array(NEW.user_id,TG_ARGV[0])::text);
    IF TG_OP='UPDATE' AND OLD.user_id IS DISTINCT FROM NEW.user_id THEN
      PERFORM pg_notify('spindle_mail_changed',json_build_array(OLD.user_id,TG_ARGV[0])::text);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mail_accounts_notify_row AFTER INSERT OR DELETE ON mail_accounts FOR EACH ROW EXECUTE FUNCTION mail_notify_change('accounts');
CREATE TRIGGER mail_accounts_notify_update AFTER UPDATE OF user_id,name,host,port,transport,username,status,error_code,last_synced_at,history_since ON mail_accounts FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.name,OLD.host,OLD.port,OLD.transport,OLD.username,OLD.status,OLD.error_code,OLD.last_synced_at,OLD.history_since) IS DISTINCT FROM ROW(NEW.user_id,NEW.name,NEW.host,NEW.port,NEW.transport,NEW.username,NEW.status,NEW.error_code,NEW.last_synced_at,NEW.history_since))
EXECUTE FUNCTION mail_notify_change('accounts');
CREATE TRIGGER mailboxes_notify_row AFTER INSERT OR DELETE ON mailboxes FOR EACH ROW EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mailboxes_notify_update AFTER UPDATE OF user_id,name,path,role,initial_complete,uid_validity ON mailboxes FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.name,OLD.path,OLD.role,OLD.initial_complete,OLD.uid_validity) IS DISTINCT FROM ROW(NEW.user_id,NEW.name,NEW.path,NEW.role,NEW.initial_complete,NEW.uid_validity))
EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_messages_notify_row AFTER INSERT OR DELETE ON mail_messages FOR EACH ROW EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_messages_notify_update AFTER UPDATE OF user_id,subject,sender,recipients,sent_at,received_at,message_id,in_reply_to,reference_ids,size_bytes ON mail_messages FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.subject,OLD.sender,OLD.recipients,OLD.sent_at,OLD.received_at,OLD.message_id,OLD.in_reply_to,OLD.reference_ids,OLD.size_bytes) IS DISTINCT FROM ROW(NEW.user_id,NEW.subject,NEW.sender,NEW.recipients,NEW.sent_at,NEW.received_at,NEW.message_id,NEW.in_reply_to,NEW.reference_ids,NEW.size_bytes))
EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_memberships_notify_row AFTER INSERT OR DELETE ON mail_memberships FOR EACH ROW EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_memberships_notify_update AFTER UPDATE OF user_id,mailbox_id,message_id,uid_validity,uid,flags,pending_mailbox_id ON mail_memberships FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.mailbox_id,OLD.message_id,OLD.uid_validity,OLD.uid,OLD.flags,OLD.pending_mailbox_id) IS DISTINCT FROM ROW(NEW.user_id,NEW.mailbox_id,NEW.message_id,NEW.uid_validity,NEW.uid,NEW.flags,NEW.pending_mailbox_id))
EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_content_notify_row AFTER INSERT OR DELETE ON mail_content FOR EACH ROW EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_content_notify_update AFTER UPDATE OF user_id,state,version,sanitizer_version,plain_text,html,resources,attachments,reply_metadata,reply_headers_pending,error_code ON mail_content FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.version,OLD.sanitizer_version,OLD.plain_text,OLD.html,OLD.resources,OLD.attachments,OLD.reply_metadata,OLD.reply_headers_pending,OLD.error_code) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.version,NEW.sanitizer_version,NEW.plain_text,NEW.html,NEW.resources,NEW.attachments,NEW.reply_metadata,NEW.reply_headers_pending,NEW.error_code))
EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_content_attachments_notify_row AFTER INSERT OR DELETE ON mail_content_attachments FOR EACH ROW EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_content_attachments_notify_update AFTER UPDATE OF user_id,state ON mail_content_attachments FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state) IS DISTINCT FROM ROW(NEW.user_id,NEW.state))
EXECUTE FUNCTION mail_notify_change('mail');
CREATE TRIGGER mail_actions_notify_row AFTER INSERT OR DELETE ON mail_actions FOR EACH ROW EXECUTE FUNCTION mail_notify_change('actions');
CREATE TRIGGER mail_actions_notify_update AFTER UPDATE OF user_id,state,error_code,dismissed_at,subject,message_id,target_mailbox_id,undo_until ON mail_actions FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.error_code,OLD.dismissed_at,OLD.subject,OLD.message_id,OLD.target_mailbox_id,OLD.undo_until) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.error_code,NEW.dismissed_at,NEW.subject,NEW.message_id,NEW.target_mailbox_id,NEW.undo_until))
EXECUTE FUNCTION mail_notify_change('actions');
CREATE TRIGGER mail_drafts_notify_row AFTER INSERT OR DELETE ON mail_drafts FOR EACH ROW EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_drafts_notify_update AFTER UPDATE OF user_id,revision,content,account_id,reply_context ON mail_drafts FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.revision,OLD.content,OLD.account_id,OLD.reply_context) IS DISTINCT FROM ROW(NEW.user_id,NEW.revision,NEW.content,NEW.account_id,NEW.reply_context))
EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_smtp_notify_row AFTER INSERT OR DELETE ON mail_smtp FOR EACH ROW EXECUTE FUNCTION mail_notify_change('accounts');
CREATE TRIGGER mail_smtp_notify_update AFTER UPDATE OF user_id,version,state,error_code,display_name,username ON mail_smtp FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.version,OLD.state,OLD.error_code,OLD.display_name,OLD.username) IS DISTINCT FROM ROW(NEW.user_id,NEW.version,NEW.state,NEW.error_code,NEW.display_name,NEW.username))
EXECUTE FUNCTION mail_notify_change('accounts');
CREATE TRIGGER mail_outbox_notify_row AFTER INSERT OR DELETE ON mail_outbox FOR EACH ROW EXECUTE FUNCTION mail_notify_change('outbox');
CREATE TRIGGER mail_outbox_notify_update AFTER UPDATE OF user_id,state,sent_copy,error_code,accepted,rejected,draft_id,account_id ON mail_outbox FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.sent_copy,OLD.error_code,OLD.accepted,OLD.rejected,OLD.draft_id,OLD.account_id) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.sent_copy,NEW.error_code,NEW.accepted,NEW.rejected,NEW.draft_id,NEW.account_id))
EXECUTE FUNCTION mail_notify_change('outbox');
CREATE TRIGGER mail_uploads_notify_row AFTER INSERT OR DELETE ON mail_uploads FOR EACH ROW EXECUTE FUNCTION mail_notify_change('files');
CREATE TRIGGER mail_uploads_notify_update AFTER UPDATE OF user_id,state,error_code,filename,size_bytes ON mail_uploads FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.error_code,OLD.filename,OLD.size_bytes) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.error_code,NEW.filename,NEW.size_bytes))
EXECUTE FUNCTION mail_notify_change('files');
CREATE TRIGGER mail_draft_attachments_notify_row AFTER INSERT OR DELETE ON mail_draft_attachments FOR EACH ROW EXECUTE FUNCTION mail_notify_change('files');
CREATE TRIGGER mail_draft_attachments_notify_update AFTER UPDATE OF user_id,draft_id,file_id,position ON mail_draft_attachments FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.draft_id,OLD.file_id,OLD.position) IS DISTINCT FROM ROW(NEW.user_id,NEW.draft_id,NEW.file_id,NEW.position))
EXECUTE FUNCTION mail_notify_change('files');
CREATE TRIGGER mail_draft_links_notify_row AFTER INSERT OR DELETE ON mail_draft_links FOR EACH ROW EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_draft_links_notify_update AFTER UPDATE OF user_id,state,error_code,synced_revision,desired_revision,candidate,active_copy_id,account_id,draft_id ON mail_draft_links FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.error_code,OLD.synced_revision,OLD.desired_revision,OLD.candidate,OLD.active_copy_id,OLD.account_id,OLD.draft_id) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.error_code,NEW.synced_revision,NEW.desired_revision,NEW.candidate,NEW.active_copy_id,NEW.account_id,NEW.draft_id))
EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_draft_copies_notify_row AFTER INSERT OR DELETE ON mail_draft_copies FOR EACH ROW EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_draft_copies_notify_update AFTER UPDATE OF user_id,state,uid,path ON mail_draft_copies FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.uid,OLD.path) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.uid,NEW.path))
EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_draft_imports_notify_row AFTER INSERT OR DELETE ON mail_draft_imports FOR EACH ROW EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_draft_imports_notify_update AFTER UPDATE OF user_id,state,error_code ON mail_draft_imports FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.error_code) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.error_code))
EXECUTE FUNCTION mail_notify_change('drafts');
CREATE TRIGGER mail_signatures_notify_row AFTER INSERT OR DELETE ON mail_signatures FOR EACH ROW EXECUTE FUNCTION mail_notify_change('accounts');
CREATE TRIGGER mail_signatures_notify_update AFTER UPDATE OF user_id,revision ON mail_signatures FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.revision) IS DISTINCT FROM ROW(NEW.user_id,NEW.revision))
EXECUTE FUNCTION mail_notify_change('accounts');
CREATE TRIGGER mail_saved_searches_notify_row AFTER INSERT OR DELETE ON mail_saved_searches FOR EACH ROW EXECUTE FUNCTION mail_notify_change('searches');
CREATE TRIGGER mail_saved_searches_notify_update AFTER UPDATE OF user_id,name,query,account_id,mailbox_id ON mail_saved_searches FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.name,OLD.query,OLD.account_id,OLD.mailbox_id) IS DISTINCT FROM ROW(NEW.user_id,NEW.name,NEW.query,NEW.account_id,NEW.mailbox_id))
EXECUTE FUNCTION mail_notify_change('searches');
