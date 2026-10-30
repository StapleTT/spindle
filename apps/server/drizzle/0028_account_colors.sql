ALTER TABLE mail_accounts ADD COLUMN color text CHECK (color ~ '^#[0-9a-f]{6}$');
--> statement-breakpoint
CREATE TRIGGER mail_accounts_color_notify AFTER UPDATE OF color ON mail_accounts FOR EACH ROW
WHEN (OLD.color IS DISTINCT FROM NEW.color) EXECUTE FUNCTION mail_notify_change('accounts');
