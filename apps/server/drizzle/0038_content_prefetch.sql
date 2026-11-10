-- D042: bodies are prefetched and no longer expire by age; the per-user cache
-- budget (least recently used first) is the bound. Existing ready bodies keep
-- their place instead of being fetched again when their seven days end.
-- expires_at is outside every mail_content trigger's column list, so this
-- neither wakes the worker nor notifies readers.
UPDATE mail_content SET expires_at='infinity' WHERE state='ready';
--> statement-breakpoint
-- Body-cache changes get their own topic. Prefetch commits them continuously,
-- and under 'mail' every one made each open list refetch. Lists, counts and
-- conversations do not depend on cached bodies; the reader and body search do.
DROP TRIGGER mail_content_notify_row ON mail_content;
DROP TRIGGER mail_content_notify_update ON mail_content;
DROP TRIGGER mail_content_attachments_notify_row ON mail_content_attachments;
DROP TRIGGER mail_content_attachments_notify_update ON mail_content_attachments;
CREATE TRIGGER mail_content_notify_row AFTER INSERT OR DELETE ON mail_content FOR EACH ROW EXECUTE FUNCTION mail_notify_change('content');
CREATE TRIGGER mail_content_notify_update AFTER UPDATE OF user_id,state,version,sanitizer_version,plain_text,html,resources,attachments,reply_metadata,reply_headers_pending,error_code ON mail_content FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state,OLD.version,OLD.sanitizer_version,OLD.plain_text,OLD.html,OLD.resources,OLD.attachments,OLD.reply_metadata,OLD.reply_headers_pending,OLD.error_code) IS DISTINCT FROM ROW(NEW.user_id,NEW.state,NEW.version,NEW.sanitizer_version,NEW.plain_text,NEW.html,NEW.resources,NEW.attachments,NEW.reply_metadata,NEW.reply_headers_pending,NEW.error_code))
EXECUTE FUNCTION mail_notify_change('content');
CREATE TRIGGER mail_content_attachments_notify_row AFTER INSERT OR DELETE ON mail_content_attachments FOR EACH ROW EXECUTE FUNCTION mail_notify_change('content');
CREATE TRIGGER mail_content_attachments_notify_update AFTER UPDATE OF user_id,state ON mail_content_attachments FOR EACH ROW
WHEN (ROW(OLD.user_id,OLD.state) IS DISTINCT FROM ROW(NEW.user_id,NEW.state))
EXECUTE FUNCTION mail_notify_change('content');
