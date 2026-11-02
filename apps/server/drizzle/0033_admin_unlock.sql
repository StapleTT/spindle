ALTER TABLE auth_sessions ADD COLUMN admin_unlocked_at timestamptz;
--> statement-breakpoint
CREATE FUNCTION reset_admin_unlock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE auth_sessions SET admin_unlocked_at=NULL WHERE user_id=NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_admin_unlock_reset AFTER UPDATE OF role,email_verified ON users
FOR EACH ROW WHEN (OLD.role IS DISTINCT FROM NEW.role OR OLD.email_verified IS DISTINCT FROM NEW.email_verified)
EXECUTE FUNCTION reset_admin_unlock();
