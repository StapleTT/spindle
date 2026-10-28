CREATE TABLE mail_smtp (
  user_id text NOT NULL,
  account_id uuid PRIMARY KEY,
  version uuid NOT NULL DEFAULT gen_random_uuid(),
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  transport text NOT NULL CHECK (transport IN ('tls','starttls')),
  username text NOT NULL,
  credential text NOT NULL,
  save_sent_copy boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','ready','failed')),
  error_code text,
  checked_at timestamptz,
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX mail_drafts_owner_id ON mail_drafts(user_id,id);
--> statement-breakpoint
CREATE TABLE mail_outbox (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid,
  draft_id uuid,
  source_draft_id uuid NOT NULL,
  draft_revision integer NOT NULL,
  smtp_version uuid NOT NULL,
  save_sent_copy boolean NOT NULL DEFAULT false,
  sender text NOT NULL,
  recipients jsonb NOT NULL CHECK (jsonb_typeof(recipients)='array'),
  subject text NOT NULL,
  message_id text NOT NULL UNIQUE,
  raw bytea NOT NULL CHECK (octet_length(raw)<=524288),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','accepted','partial','failed','unknown','cancelled')),
  accepted jsonb NOT NULL DEFAULT '[]',
  rejected jsonb NOT NULL DEFAULT '[]',
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 seconds',
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  sent_copy text NOT NULL DEFAULT 'pending' CHECK (sent_copy IN ('pending','appending','saved','unknown','failed','unavailable')),
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE SET NULL (account_id),
  FOREIGN KEY (user_id,draft_id) REFERENCES mail_drafts(user_id,id) ON DELETE SET NULL (draft_id)
);
CREATE INDEX mail_outbox_owner ON mail_outbox(user_id,created_at DESC,id);
CREATE INDEX mail_outbox_due ON mail_outbox(next_attempt_at) WHERE state IN ('queued','sending','accepted','partial');
CREATE UNIQUE INDEX mail_outbox_one_intent ON mail_outbox(user_id,source_draft_id,draft_revision) WHERE state NOT IN ('failed','cancelled');
--> statement-breakpoint
-- Draft text remains available for cancellation, failure and unknown outcomes.
CREATE FUNCTION guard_queued_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) THEN
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM mail_outbox WHERE user_id=OLD.user_id AND draft_id=OLD.id AND state IN ('queued','sending','unknown','partial')) THEN
    -- Account removal must still preserve text and clear the stale association.
    IF TG_OP='UPDATE' AND NEW.account_id IS NULL AND OLD.account_id IS NOT NULL AND NEW.content=OLD.content THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'Draft is in outbox' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_draft_outbox_guard BEFORE UPDATE OR DELETE ON mail_drafts
FOR EACH ROW EXECUTE FUNCTION guard_queued_draft();
CREATE FUNCTION disconnect_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.account_id IS NOT NULL AND NEW.account_id IS NULL THEN
    IF NEW.state='queued' THEN NEW.state:='failed'; NEW.error_code:='account_removed'; NEW.completed_at:=clock_timestamp(); END IF;
    IF NEW.state='sending' THEN NEW.state:='unknown'; NEW.error_code:='delivery_unknown'; NEW.completed_at:=clock_timestamp(); END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_outbox_disconnect BEFORE UPDATE ON mail_outbox
FOR EACH ROW EXECUTE FUNCTION disconnect_outbox();
