ALTER TABLE users ADD COLUMN deletion_due_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_deletion_suspended CHECK (deletion_due_at IS NULL OR suspended);
CREATE INDEX users_deletion_due_idx ON users(deletion_due_at) WHERE deletion_due_at IS NOT NULL;
--> statement-breakpoint
CREATE FUNCTION bump_deletion_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.admin_revision=OLD.admin_revision THEN NEW.admin_revision:=OLD.admin_revision+1; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_deletion_revision BEFORE UPDATE OF deletion_due_at ON users
FOR EACH ROW WHEN (OLD.deletion_due_at IS DISTINCT FROM NEW.deletion_due_at)
EXECUTE FUNCTION bump_deletion_revision();
--> statement-breakpoint
CREATE TABLE security_events (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('account.created','sign_in.succeeded','sign_in.failed','sign_out',
    'password.changed','password.reset','email.change_requested','email.change_cancelled','email.changed',
    'session.revoked','sessions.revoked_others','export.created','deletion.scheduled','deletion.cancelled','account.deleted')),
  ip_address text,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX security_events_user_idx ON security_events(user_id,created_at DESC,id DESC);
CREATE INDEX security_events_created_idx ON security_events(created_at DESC,id DESC);
--> statement-breakpoint
ALTER TABLE admin_audit DROP CONSTRAINT admin_audit_action_check;
ALTER TABLE admin_audit ADD CONSTRAINT admin_audit_action_check
  CHECK (action IN ('user.suspend','user.resume','user.role','user.sessions','user.delete','invite.send','invite.revoke'));
