CREATE SEQUENCE mail_local_state_version;
ALTER TABLE mail_messages
  ADD COLUMN local_pinned boolean NOT NULL DEFAULT false,
  ADD COLUMN local_muted boolean NOT NULL DEFAULT false,
  ADD COLUMN local_snoozed_until timestamptz,
  ADD COLUMN local_pin_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN local_mute_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN local_snooze_version bigint NOT NULL DEFAULT 0;
CREATE INDEX mail_messages_local_order_idx ON mail_messages(user_id,local_pinned DESC,received_at DESC,id DESC);
CREATE INDEX mail_messages_snooze_due_idx ON mail_messages(local_snoozed_until) WHERE local_snoozed_until IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER mail_messages_local_notify AFTER UPDATE OF local_pinned,local_muted,local_snoozed_until,local_pin_version,local_mute_version,local_snooze_version ON mail_messages FOR EACH ROW
WHEN (ROW(OLD.local_pinned,OLD.local_muted,OLD.local_snoozed_until,OLD.local_pin_version,OLD.local_mute_version,OLD.local_snooze_version) IS DISTINCT FROM ROW(NEW.local_pinned,NEW.local_muted,NEW.local_snoozed_until,NEW.local_pin_version,NEW.local_mute_version,NEW.local_snooze_version))
EXECUTE FUNCTION mail_notify_change('mail');
