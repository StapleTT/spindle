-- Native Microsoft mail; existing IMAP/Gmail identities and credentials stay intact.
ALTER TABLE mail_accounts DROP CONSTRAINT mail_accounts_provider_check;
ALTER TABLE mail_accounts ADD CONSTRAINT mail_accounts_provider_check CHECK (provider IN ('imap','gmail','microsoft'));
ALTER TABLE mail_accounts DROP CONSTRAINT mail_accounts_provider_settings;
ALTER TABLE mail_accounts ADD CONSTRAINT mail_accounts_provider_settings CHECK (
  (provider='imap' AND host IS NOT NULL AND port IS NOT NULL AND transport IS NOT NULL AND provider_account IS NULL)
  OR (provider IN ('gmail','microsoft') AND host IS NULL AND port IS NULL AND transport IS NULL AND provider_account IS NOT NULL));
ALTER TABLE mail_accounts ADD COLUMN provider_name text CHECK (length(provider_name)<=200);
CREATE UNIQUE INDEX mail_accounts_microsoft_identity ON mail_accounts(user_id,provider_account) WHERE provider='microsoft';
--> statement-breakpoint
-- Provider-bound states prevent a Google callback consuming a Microsoft flow.
ALTER TABLE mail_oauth_states ADD COLUMN provider text NOT NULL DEFAULT 'gmail' CHECK (provider IN ('gmail','microsoft'));
--> statement-breakpoint
-- Empty scope tracks the folder hierarchy; other scopes are Graph folder IDs.
-- Unfiltered delta avoids Graph's 5,000-message limit for date-filtered delta.
CREATE TABLE mail_graph_sync (
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  scope text NOT NULL CHECK (length(scope)<=2048),
  next_link text CHECK (length(next_link)<=16384),
  delta_link text CHECK (length(delta_link)<=16384),
  initial_complete boolean NOT NULL DEFAULT false,
  checked_at timestamptz,
  PRIMARY KEY (account_id,scope),
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
CREATE TABLE mail_graph_listed (
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  scope text NOT NULL,
  remote_key text NOT NULL CHECK (length(remote_key) BETWEEN 1 AND 2048),
  PRIMARY KEY (account_id,scope,remote_key),
  FOREIGN KEY (account_id,scope) REFERENCES mail_graph_sync(account_id,scope) ON DELETE CASCADE,
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
