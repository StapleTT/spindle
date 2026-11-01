CREATE TABLE auth_email_changes (
  id text PRIMARY KEY,
  user_id text NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  verification_id text NOT NULL UNIQUE REFERENCES auth_verifications(id) ON DELETE CASCADE,
  old_email text NOT NULL,
  new_email text NOT NULL CHECK (new_email = lower(new_email)),
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE FUNCTION revoke_credentials_on_email_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM auth_sessions WHERE user_id = NEW.id;
  DELETE FROM auth_verifications WHERE value = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_email_changed AFTER UPDATE OF email ON users
FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email)
EXECUTE FUNCTION revoke_credentials_on_email_change();
