-- List previews (D048): NULL means not read yet, '' means checked and empty.
-- Gmail/Microsoft store their provider preview at sync and backfill older mail
-- in the worker; every provider fills a missing preview from the body cache.
ALTER TABLE mail_messages ADD COLUMN snippet text CHECK (char_length(snippet)<=200);
--> statement-breakpoint
-- Mail already in the body cache gets its preview now (plain text bodies; HTML-only
-- bodies fill the next time they are fetched).
UPDATE mail_messages m SET snippet=left(btrim(regexp_replace(regexp_replace(c.plain_text,'^[ \t]*>.*$','','gn'),'[[:space:]]+',' ','g')),200)
FROM mail_content c WHERE c.user_id=m.user_id AND c.account_id=m.account_id AND c.message_id=m.id
AND c.state='ready' AND btrim(coalesce(c.plain_text,''))<>'';
--> statement-breakpoint
CREATE INDEX mail_messages_unchecked_snippet_idx ON mail_messages(user_id,account_id,received_at DESC) WHERE snippet IS NULL;
--> statement-breakpoint
-- Open lists refresh when a preview first appears.
CREATE TRIGGER mail_messages_notify_snippet AFTER UPDATE OF snippet ON mail_messages FOR EACH ROW
WHEN (coalesce(OLD.snippet,'')='' AND NEW.snippet<>'')
EXECUTE FUNCTION mail_notify_change('mail');
