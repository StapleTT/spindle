ALTER TABLE mail_content ADD COLUMN reply_metadata jsonb;
ALTER TABLE mail_content ADD COLUMN reply_headers_pending boolean NOT NULL DEFAULT false;
ALTER TABLE mail_drafts ADD COLUMN reply_context jsonb;
ALTER TABLE mail_drafts ADD CONSTRAINT mail_drafts_reply_context_check CHECK (
  reply_context IS NULL OR (jsonb_typeof(reply_context)='object' AND octet_length(reply_context::text)<=16000)
);
