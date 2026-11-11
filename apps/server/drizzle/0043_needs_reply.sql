-- Needs reply (D046): the heuristic is computed at query time; this column
-- only holds the user's manual correction. NULL = follow the heuristic.
ALTER TABLE mail_messages ADD COLUMN local_needs_reply boolean;
--> statement-breakpoint
CREATE TRIGGER mail_messages_notify_needs_reply AFTER UPDATE OF local_needs_reply ON mail_messages FOR EACH ROW
WHEN (OLD.local_needs_reply IS DISTINCT FROM NEW.local_needs_reply)
EXECUTE FUNCTION mail_notify_change('mail');
