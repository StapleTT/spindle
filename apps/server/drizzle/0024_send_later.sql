ALTER TABLE mail_outbox ADD COLUMN scheduled_at timestamptz;
ALTER TABLE mail_outbox ADD COLUMN schedule_revision integer NOT NULL DEFAULT 1 CHECK(schedule_revision>0);
--> statement-breakpoint
-- Older queue/retry writers must also preserve the scheduled lower bound.
CREATE FUNCTION guard_scheduled_send() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.scheduled_at IS NOT NULL AND NEW.state='queued' THEN
    NEW.next_attempt_at:=GREATEST(NEW.next_attempt_at,NEW.scheduled_at);
  END IF;
  IF NEW.state='sending' AND NEW.scheduled_at>clock_timestamp() THEN
    RAISE EXCEPTION 'Scheduled send is not due' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_outbox_schedule_guard BEFORE INSERT OR UPDATE OF scheduled_at,next_attempt_at,state ON mail_outbox
FOR EACH ROW EXECUTE FUNCTION guard_scheduled_send();
--> statement-breakpoint
CREATE TRIGGER mail_outbox_schedule_notify AFTER UPDATE OF scheduled_at,schedule_revision ON mail_outbox FOR EACH ROW
WHEN (ROW(OLD.scheduled_at,OLD.schedule_revision) IS DISTINCT FROM ROW(NEW.scheduled_at,NEW.schedule_revision))
EXECUTE FUNCTION mail_notify_change('outbox');
