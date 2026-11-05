-- D038: Gmail API accounts. IMAP rows keep their server settings; Gmail rows are
-- identified by the Google subject and hold an encrypted refresh token.
ALTER TABLE mail_accounts ADD COLUMN provider text NOT NULL DEFAULT 'imap' CHECK (provider IN ('imap','gmail'));
ALTER TABLE mail_accounts ADD COLUMN provider_account text CHECK (length(provider_account) BETWEEN 1 AND 255);
ALTER TABLE mail_accounts ALTER COLUMN host DROP NOT NULL;
ALTER TABLE mail_accounts ALTER COLUMN port DROP NOT NULL;
ALTER TABLE mail_accounts ALTER COLUMN transport DROP NOT NULL;
ALTER TABLE mail_accounts ADD CONSTRAINT mail_accounts_provider_settings CHECK (
  (provider='imap' AND host IS NOT NULL AND port IS NOT NULL AND transport IS NOT NULL AND provider_account IS NULL)
  OR (provider='gmail' AND host IS NULL AND port IS NULL AND transport IS NULL AND provider_account IS NOT NULL));
CREATE UNIQUE INDEX mail_accounts_gmail_identity ON mail_accounts(user_id,provider_account) WHERE provider='gmail';
--> statement-breakpoint
-- Gmail memberships have no IMAP UID. The message pair was already unique; the
-- UID triple stays unique (NULLs are distinct) for the IMAP ON CONFLICT target.
ALTER TABLE mail_memberships DROP CONSTRAINT mail_memberships_pkey;
ALTER TABLE mail_memberships DROP CONSTRAINT mail_memberships_mailbox_id_message_id_key;
ALTER TABLE mail_memberships ADD PRIMARY KEY (mailbox_id,message_id);
ALTER TABLE mail_memberships ADD CONSTRAINT mail_memberships_imap_uid UNIQUE (mailbox_id,uid_validity,uid);
ALTER TABLE mail_memberships ALTER COLUMN uid_validity DROP NOT NULL;
ALTER TABLE mail_memberships ALTER COLUMN uid DROP NOT NULL;
ALTER TABLE mail_memberships ADD CONSTRAINT mail_memberships_uid_pair CHECK ((uid IS NULL)=(uid_validity IS NULL));
--> statement-breakpoint
-- Durable Gmail checkpoint: page_token belongs to the listing (initial) or to
-- history.list from history_id (incremental), so progress survives restarts.
CREATE TABLE mail_gmail_sync (
  user_id text NOT NULL,
  account_id uuid PRIMARY KEY,
  history_id text CHECK (history_id ~ '^[0-9]{1,20}$'),
  page_token text CHECK (length(page_token) <= 1000),
  initial_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
-- Message IDs seen by the current full listing; after it completes, unlisted
-- local messages (deleted while history had expired) are removed.
CREATE TABLE mail_gmail_listed (
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  remote_key text NOT NULL,
  PRIMARY KEY (account_id,remote_key),
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE mail_oauth_states (
  state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  account_id uuid,
  history text NOT NULL CHECK (history IN ('90d','all')),
  code_verifier text NOT NULL CHECK (length(code_verifier) BETWEEN 43 AND 128),
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
CREATE INDEX mail_oauth_states_expiry ON mail_oauth_states(expires_at);
