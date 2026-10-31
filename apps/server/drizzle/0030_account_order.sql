ALTER TABLE mail_accounts ADD COLUMN sort_order integer CHECK (sort_order >= 0);
--> statement-breakpoint
CREATE TRIGGER mail_accounts_order_notify AFTER UPDATE OF sort_order ON mail_accounts FOR EACH ROW
WHEN (OLD.sort_order IS DISTINCT FROM NEW.sort_order) EXECUTE FUNCTION mail_notify_change('accounts');
