ALTER TABLE mail_content ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]';
--> statement-breakpoint
CREATE TABLE mail_content_attachments (
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  message_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 99),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','failed')),
  data bytea CHECK (octet_length(data)<=10485760),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id,position),
  CHECK ((state='ready')=(data IS NOT NULL)),
  FOREIGN KEY (user_id,account_id,message_id) REFERENCES mail_content(user_id,account_id,message_id) ON DELETE CASCADE
);
CREATE INDEX mail_content_attachments_pending_idx ON mail_content_attachments(next_attempt_at) WHERE state='pending';
