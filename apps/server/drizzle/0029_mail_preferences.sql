CREATE TABLE mail_preferences (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  image_proxy boolean NOT NULL DEFAULT true,
  block_remote_images boolean NOT NULL DEFAULT true,
  undo_send boolean NOT NULL DEFAULT true
);
CREATE TRIGGER mail_preferences_notify AFTER INSERT OR UPDATE OR DELETE ON mail_preferences
FOR EACH ROW EXECUTE FUNCTION mail_notify_change('accounts');
