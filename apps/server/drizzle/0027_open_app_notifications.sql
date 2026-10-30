ALTER TABLE mail_messages ADD COLUMN notification_at timestamptz;
CREATE INDEX mail_messages_notifications_idx ON mail_messages(user_id,notification_at DESC,id DESC) WHERE notification_at IS NOT NULL;
--> statement-breakpoint
-- Muting/snoozing consumes any pending arrival, so undoing it never replays old alerts.
CREATE FUNCTION suppress_local_notification() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.local_muted OR NEW.local_snoozed_until>clock_timestamp() THEN NEW.notification_at:=NULL; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_messages_notification_suppression BEFORE INSERT OR UPDATE OF local_muted,local_snoozed_until ON mail_messages
FOR EACH ROW EXECUTE FUNCTION suppress_local_notification();
--> statement-breakpoint
CREATE FUNCTION suppress_read_notification() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; source_id uuid; read_or_deleted boolean:=false;
BEGIN
  IF TG_OP='DELETE' THEN owner_id:=OLD.user_id; source_id:=OLD.message_id;
  ELSE owner_id:=NEW.user_id; source_id:=NEW.message_id;
    read_or_deleted:='\Seen'=ANY(NEW.flags) OR '\Deleted'=ANY(NEW.flags);
  END IF;
  IF read_or_deleted OR NOT EXISTS(
    SELECT 1 FROM mail_memberships mm JOIN mailboxes b ON b.user_id=mm.user_id AND b.id=coalesce(mm.pending_mailbox_id,mm.mailbox_id)
    WHERE mm.user_id=owner_id AND mm.message_id=source_id AND b.role='inbox'
  ) THEN
    UPDATE mail_messages SET notification_at=NULL WHERE user_id=owner_id AND id=source_id AND notification_at IS NOT NULL;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER mail_memberships_notification_read AFTER INSERT OR DELETE OR UPDATE OF flags,pending_mailbox_id,mailbox_id ON mail_memberships
FOR EACH ROW EXECUTE FUNCTION suppress_read_notification();
