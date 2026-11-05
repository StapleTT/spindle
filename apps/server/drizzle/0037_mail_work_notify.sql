-- D041: wake the worker when a reader requests a body or attachment, instead
-- of waiting for the 5-second dispatch timer. Delivered at commit; workers
-- LISTEN on spindle_mail_work and dispatch. Only transitions into pending fire,
-- so worker claims and completions never loop. The payload is empty.
CREATE FUNCTION mail_work_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('spindle_mail_work', '');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER mail_content_requested AFTER INSERT ON mail_content FOR EACH ROW
WHEN (NEW.state='pending' OR NEW.reply_headers_pending) EXECUTE FUNCTION mail_work_notify();
CREATE TRIGGER mail_content_rerequested AFTER UPDATE OF state,reply_headers_pending ON mail_content FOR EACH ROW
WHEN ((NEW.state='pending' AND OLD.state IS DISTINCT FROM 'pending')
  OR (NEW.reply_headers_pending AND NOT OLD.reply_headers_pending)) EXECUTE FUNCTION mail_work_notify();
CREATE TRIGGER mail_content_attachment_requested AFTER INSERT ON mail_content_attachments FOR EACH ROW
WHEN (NEW.state='pending') EXECUTE FUNCTION mail_work_notify();
CREATE TRIGGER mail_content_attachment_rerequested AFTER UPDATE OF state ON mail_content_attachments FOR EACH ROW
WHEN (NEW.state='pending' AND OLD.state IS DISTINCT FROM 'pending') EXECUTE FUNCTION mail_work_notify();
