CREATE TABLE mail_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  transport text NOT NULL CHECK (transport IN ('tls', 'starttls')),
  username text NOT NULL,
  credential text NOT NULL,
  history_since timestamptz,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'ready', 'error')),
  error_code text,
  failures integer NOT NULL DEFAULT 0,
  next_sync_at timestamptz NOT NULL DEFAULT now(),
  last_synced_at timestamptz,
  sync_request uuid NOT NULL DEFAULT gen_random_uuid(),
  sync_completed uuid,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, id),
  UNIQUE (user_id, host, port, username)
);
CREATE INDEX mail_accounts_due_idx ON mail_accounts(next_sync_at);
--> statement-breakpoint
CREATE TABLE mailboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  path text NOT NULL,
  name text NOT NULL,
  role text,
  uid_validity text,
  high_uid bigint NOT NULL DEFAULT 0 CHECK (high_uid BETWEEN 0 AND 4294967295),
  scan_uid bigint,
  initial_complete boolean NOT NULL DEFAULT false,
  last_synced_at timestamptz,
  UNIQUE (user_id, account_id, id),
  UNIQUE (account_id, path),
  FOREIGN KEY (user_id, account_id) REFERENCES mail_accounts(user_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE mail_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  remote_key text NOT NULL,
  message_id text,
  subject text NOT NULL,
  sender jsonb NOT NULL,
  recipients jsonb NOT NULL,
  sent_at timestamptz,
  received_at timestamptz NOT NULL,
  in_reply_to text,
  size_bytes bigint NOT NULL DEFAULT 0,
  UNIQUE (user_id, account_id, id),
  UNIQUE (account_id, remote_key),
  FOREIGN KEY (user_id, account_id) REFERENCES mail_accounts(user_id, id) ON DELETE CASCADE
);
CREATE INDEX mail_messages_stream_idx ON mail_messages(user_id, received_at DESC, id DESC);
CREATE INDEX mail_messages_account_stream_idx ON mail_messages(user_id, account_id, received_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE mail_memberships (
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  mailbox_id uuid NOT NULL,
  message_id uuid NOT NULL,
  uid_validity text NOT NULL,
  uid bigint NOT NULL CHECK (uid BETWEEN 1 AND 4294967295),
  flags text[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (mailbox_id, uid_validity, uid),
  UNIQUE (mailbox_id, message_id),
  FOREIGN KEY (user_id, account_id, mailbox_id) REFERENCES mailboxes(user_id, account_id, id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, account_id, message_id) REFERENCES mail_messages(user_id, account_id, id) ON DELETE CASCADE
);
CREATE INDEX mail_memberships_message_idx ON mail_memberships(user_id, message_id);
--> statement-breakpoint
CREATE TABLE mail_request_limits (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL,
  PRIMARY KEY (user_id, action)
);
