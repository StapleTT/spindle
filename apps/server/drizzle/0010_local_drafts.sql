CREATE TABLE mail_drafts (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id uuid,
  content jsonb NOT NULL CHECK (jsonb_typeof(content)='object' AND octet_length(content::text)<=160000),
  revision integer NOT NULL DEFAULT 1 CHECK (revision>0),
  last_save_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE SET NULL (account_id)
);
CREATE INDEX mail_drafts_user_idx ON mail_drafts(user_id,updated_at DESC,id);
--> statement-breakpoint
-- Account removal preserves the text and invalidates open editors' old revisions.
CREATE FUNCTION mail_draft_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.revision := OLD.revision+1;
  NEW.updated_at := clock_timestamp();
  IF NEW.last_save_id IS NOT DISTINCT FROM OLD.last_save_id THEN
    NEW.last_save_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_draft_revision BEFORE UPDATE ON mail_drafts
FOR EACH ROW EXECUTE FUNCTION mail_draft_revision();
