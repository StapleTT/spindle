CREATE TABLE mail_content (
  message_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  version uuid NOT NULL DEFAULT gen_random_uuid(),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','failed')),
  plain_text text,
  html text,
  resources jsonb NOT NULL DEFAULT '[]',
  byte_size integer NOT NULL DEFAULT 0 CHECK (byte_size>=0),
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days',
  accessed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id,account_id,message_id),
  FOREIGN KEY (user_id,account_id,message_id) REFERENCES mail_messages(user_id,account_id,id) ON DELETE CASCADE
);
CREATE INDEX mail_content_pending_idx ON mail_content(next_attempt_at) WHERE state='pending';
CREATE INDEX mail_content_user_cache_idx ON mail_content(user_id,accessed_at);
--> statement-breakpoint
CREATE TABLE mail_content_images (
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  message_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 0 AND 19),
  content_type text NOT NULL CHECK (content_type IN ('image/png','image/jpeg','image/gif','image/webp')),
  data bytea NOT NULL CHECK (octet_length(data)<=5242880),
  PRIMARY KEY (message_id,position),
  FOREIGN KEY (user_id,account_id,message_id) REFERENCES mail_content(user_id,account_id,message_id) ON DELETE CASCADE
);
