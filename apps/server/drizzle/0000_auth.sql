CREATE TABLE users (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  email_verified boolean NOT NULL DEFAULT false,
  image text,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE auth_sessions (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_user_id_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions(expires_at);
--> statement-breakpoint
CREATE TABLE auth_accounts (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  provider_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password text,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_accounts_user_id_idx ON auth_accounts(user_id);
CREATE UNIQUE INDEX auth_accounts_provider_account_idx ON auth_accounts(provider_id, account_id);
--> statement-breakpoint
CREATE TABLE auth_verifications (
  id text PRIMARY KEY,
  identifier text NOT NULL UNIQUE,
  value text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verifications_expires_at_idx ON auth_verifications(expires_at);
--> statement-breakpoint
CREATE TABLE auth_rate_limits (
  id text PRIMARY KEY,
  key text NOT NULL UNIQUE,
  count integer NOT NULL,
  last_request bigint NOT NULL
);
CREATE TABLE invites (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Credential changes invalidate all existing sessions and recovery links in the same transaction.
CREATE FUNCTION revoke_credentials_on_password_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM auth_sessions WHERE user_id = NEW.user_id;
  DELETE FROM auth_verifications WHERE value = NEW.user_id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_password_changed AFTER UPDATE OF password ON auth_accounts
FOR EACH ROW WHEN (OLD.password IS DISTINCT FROM NEW.password)
EXECUTE FUNCTION revoke_credentials_on_password_change();
