CREATE TABLE mail_draft_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  draft_id uuid,
  source_draft_id uuid NOT NULL,
  subject text NOT NULL DEFAULT '',
  desired_revision integer NOT NULL,
  synced_revision integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','synced','waiting','failed','conflict','unknown','removed')),
  active_copy_id uuid,
  candidate jsonb CHECK(candidate IS NULL OR octet_length(candidate::text)<=800000),
  error_code text,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '3 seconds',
  UNIQUE(user_id,id),
  UNIQUE(user_id,account_id,source_draft_id),
  FOREIGN KEY(user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,draft_id) REFERENCES mail_drafts(user_id,id) ON DELETE SET NULL(draft_id)
);
CREATE INDEX mail_draft_links_due ON mail_draft_links(next_attempt_at) WHERE state NOT IN ('conflict','removed');
CREATE TABLE mail_draft_copies (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  link_id uuid NOT NULL,
  state text NOT NULL CHECK(state IN ('appending','active','obsolete','removed','unknown','kept')),
  path text NOT NULL CHECK(length(path)<=1000),
  uid_validity text NOT NULL,
  uid text,
  message_id text,
  marker uuid,
  hash text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 31457280),
  revision integer NOT NULL,
  modseq text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id),
  FOREIGN KEY(user_id,link_id) REFERENCES mail_draft_links(user_id,id) ON DELETE CASCADE
);
ALTER TABLE mail_draft_links ADD FOREIGN KEY(user_id,active_copy_id) REFERENCES mail_draft_copies(user_id,id) ON DELETE SET NULL(active_copy_id);
CREATE INDEX mail_draft_copies_link_state ON mail_draft_copies(user_id,link_id,state);
CREATE INDEX mail_draft_copies_marker ON mail_draft_copies(user_id,marker) WHERE marker IS NOT NULL;
CREATE TABLE mail_draft_conflict_files (
  user_id text NOT NULL,
  link_id uuid NOT NULL,
  file_id uuid NOT NULL,
  PRIMARY KEY(link_id,file_id),
  FOREIGN KEY(user_id,link_id) REFERENCES mail_draft_links(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,file_id) REFERENCES mail_uploads(user_id,id)
);
CREATE TABLE mail_draft_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  account_id uuid NOT NULL,
  path text NOT NULL,
  uid_validity text NOT NULL,
  uid text NOT NULL,
  subject text NOT NULL DEFAULT '',
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','imported','failed')),
  error_code text,
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,account_id,path,uid_validity,uid),
  FOREIGN KEY(user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
CREATE INDEX mail_draft_imports_due ON mail_draft_imports(next_attempt_at) WHERE state='pending';
--> statement-breakpoint
CREATE FUNCTION queue_provider_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    UPDATE mail_draft_links SET state=CASE WHEN state IN ('conflict','unknown') THEN state ELSE 'pending' END,
      next_attempt_at=clock_timestamp() WHERE user_id=OLD.user_id AND source_draft_id=OLD.id;
    RETURN OLD;
  END IF;
  UPDATE mail_draft_links SET state=CASE WHEN state IN ('conflict','unknown') THEN state ELSE 'pending' END,
    next_attempt_at=clock_timestamp() WHERE user_id=NEW.user_id AND source_draft_id=NEW.id AND account_id IS DISTINCT FROM NEW.account_id;
  IF NEW.account_id IS NOT NULL THEN
    INSERT INTO mail_draft_links(user_id,account_id,draft_id,source_draft_id,subject,desired_revision)
      VALUES(NEW.user_id,NEW.account_id,NEW.id,NEW.id,left(NEW.content->>'subject',1000),NEW.revision)
    ON CONFLICT(user_id,account_id,source_draft_id) DO UPDATE SET draft_id=NEW.id,subject=EXCLUDED.subject,
      desired_revision=NEW.revision,attempts=0,next_attempt_at=clock_timestamp()+interval '3 seconds',
      state=CASE WHEN mail_draft_links.state IN ('conflict','unknown') THEN mail_draft_links.state ELSE 'pending' END;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_draft_provider_save AFTER INSERT OR UPDATE ON mail_drafts FOR EACH ROW EXECUTE FUNCTION queue_provider_draft();
CREATE TRIGGER mail_draft_provider_delete AFTER DELETE ON mail_drafts FOR EACH ROW EXECUTE FUNCTION queue_provider_draft();
INSERT INTO mail_draft_links(user_id,account_id,draft_id,source_draft_id,subject,desired_revision)
  SELECT user_id,account_id,id,id,left(content->>'subject',1000),revision FROM mail_drafts WHERE account_id IS NOT NULL;
