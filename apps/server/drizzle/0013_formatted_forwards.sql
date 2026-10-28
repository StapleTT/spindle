ALTER TABLE mail_drafts ADD COLUMN forward_content jsonb;
ALTER TABLE mail_drafts ADD CONSTRAINT mail_drafts_forward_content_check CHECK (
  forward_content IS NULL OR (jsonb_typeof(forward_content)='object' AND octet_length(forward_content::text)<=550000)
);
