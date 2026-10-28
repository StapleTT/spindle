CREATE TABLE mail_actions (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  message_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('read','unread')),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (user_id,account_id,message_id) REFERENCES mail_messages(user_id,account_id,id) ON DELETE CASCADE
);
CREATE INDEX mail_actions_pending_idx ON mail_actions(next_attempt_at) WHERE state='pending';
CREATE INDEX mail_actions_message_idx ON mail_actions(user_id,message_id,seq);
CREATE INDEX mail_actions_completed_idx ON mail_actions(completed_at) WHERE state<>'pending';
