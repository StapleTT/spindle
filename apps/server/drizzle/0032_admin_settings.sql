ALTER TABLE users ADD COLUMN suspended boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN admin_revision integer NOT NULL DEFAULT 0;
ALTER TABLE invites ADD COLUMN revoked_at timestamptz;
ALTER TABLE invites ADD COLUMN accepted_at timestamptz;
ALTER TABLE invites ADD COLUMN accepted_user_id text REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE invites ADD COLUMN delivery_state text NOT NULL DEFAULT 'unknown' CHECK (delivery_state IN ('unknown','sent','failed'));
UPDATE invites i SET accepted_at=u.created_at,accepted_user_id=u.id FROM users u WHERE u.email=i.email;
--> statement-breakpoint
CREATE TABLE admin_audit (
  id uuid PRIMARY KEY,
  actor_id text REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL CHECK (action IN ('user.suspend','user.resume','user.role','user.sessions','invite.send','invite.revoke')),
  target_id text NOT NULL,
  request_hash text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit(created_at DESC,id DESC);
--> statement-breakpoint
CREATE FUNCTION protect_last_admin() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role='admin' AND NOT OLD.suspended AND
     (TG_OP='DELETE' OR NEW.role<>'admin' OR NEW.suspended) THEN
    PERFORM pg_advisory_xact_lock(728491603);
    IF NOT EXISTS (SELECT 1 FROM users WHERE role='admin' AND NOT suspended AND id<>OLD.id) THEN
      RAISE EXCEPTION 'Cannot remove the last active administrator' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_last_admin BEFORE UPDATE OF role,suspended OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION protect_last_admin();
--> statement-breakpoint
CREATE FUNCTION fence_suspended_user() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.suspended THEN
    DELETE FROM auth_sessions WHERE user_id=NEW.id;
    DELETE FROM auth_verifications WHERE value=NEW.id;
    UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE user_id=NEW.id;
    UPDATE mail_uploads SET token=NULL,lease_until=clock_timestamp()-interval '1 second' WHERE user_id=NEW.id AND state IN ('uploading','scanning');
  END IF;
  PERFORM pg_notify('spindle_mail_changed',json_build_array(NEW.id,'accounts')::text);
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_suspension AFTER UPDATE OF suspended ON users
FOR EACH ROW WHEN (OLD.suspended IS DISTINCT FROM NEW.suspended) EXECUTE FUNCTION fence_suspended_user();
--> statement-breakpoint
CREATE FUNCTION check_session_owner_active() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM users WHERE id=NEW.user_id AND NOT suspended FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER auth_session_active BEFORE INSERT ON auth_sessions
FOR EACH ROW EXECUTE FUNCTION check_session_owner_active();
