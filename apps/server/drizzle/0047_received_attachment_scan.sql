-- Received attachments are now scanned before download (D050). 'blocked' means
-- malware was detected and the bytes were discarded; 'unchecked' means the
-- scanner was unavailable, so the bytes were discarded and a retry refetches.
ALTER TABLE mail_content_attachments DROP CONSTRAINT mail_content_attachments_state_check;
--> statement-breakpoint
ALTER TABLE mail_content_attachments ADD CONSTRAINT mail_content_attachments_state_check
  CHECK (state IN ('pending','ready','failed','unchecked','blocked'));
--> statement-breakpoint
-- Earlier downloads were never scanned. Drop those cached copies (provider mail
-- is untouched) so the next download fetches and scans them.
UPDATE mail_content c SET byte_size=greatest(c.byte_size-t.bytes,0)
FROM (SELECT message_id,sum(octet_length(data))::integer AS bytes FROM mail_content_attachments
  WHERE state='ready' GROUP BY message_id) t
WHERE c.message_id=t.message_id;
--> statement-breakpoint
DELETE FROM mail_content_attachments WHERE state='ready';
