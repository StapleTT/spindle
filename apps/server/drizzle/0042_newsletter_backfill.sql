-- One-time newsletter check (D045): NULL means the List-Unsubscribe header has
-- not been read yet. Rows already flagged stay flagged; every other row is
-- checked again by the worker (Gmail/Microsoft) or the IMAP metadata scan.
ALTER TABLE mail_messages ALTER COLUMN list_unsubscribe DROP NOT NULL, ALTER COLUMN list_unsubscribe DROP DEFAULT;
--> statement-breakpoint
UPDATE mail_messages SET list_unsubscribe=NULL WHERE NOT list_unsubscribe;
--> statement-breakpoint
CREATE INDEX mail_messages_unchecked_newsletter_idx ON mail_messages(user_id,account_id,received_at DESC) WHERE list_unsubscribe IS NULL;
--> statement-breakpoint
-- Open Newsletters views refresh as the check fills them.
CREATE TRIGGER mail_messages_notify_newsletter AFTER UPDATE OF list_unsubscribe ON mail_messages FOR EACH ROW
WHEN (OLD.list_unsubscribe IS DISTINCT FROM NEW.list_unsubscribe AND NEW.list_unsubscribe)
EXECUTE FUNCTION mail_notify_change('mail');
