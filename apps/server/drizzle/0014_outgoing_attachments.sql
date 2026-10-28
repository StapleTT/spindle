CREATE TABLE mail_uploads (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 0 AND 10485760),
  reserved_bytes integer NOT NULL CHECK(reserved_bytes BETWEEN 0 AND 10485760),
  state text NOT NULL CHECK(state IN ('uploading','pending_fetch','fetching','pending_scan','scanning','ready','failed','quarantined')),
  source jsonb,
  token uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,id)
);
CREATE INDEX mail_uploads_pending ON mail_uploads(state,lease_until);
CREATE TABLE mail_upload_chunks (
  user_id text NOT NULL,
  file_id uuid NOT NULL,
  position integer NOT NULL CHECK(position>=0),
  data bytea NOT NULL CHECK(octet_length(data)<=262144),
  PRIMARY KEY(file_id,position),
  FOREIGN KEY(user_id,file_id) REFERENCES mail_uploads(user_id,id) ON DELETE CASCADE
);
CREATE TABLE mail_draft_attachments (
  user_id text NOT NULL,
  draft_id uuid NOT NULL,
  file_id uuid NOT NULL,
  position smallint NOT NULL CHECK(position BETWEEN 0 AND 9),
  PRIMARY KEY(draft_id,file_id),
  UNIQUE(draft_id,position),
  FOREIGN KEY(user_id,draft_id) REFERENCES mail_drafts(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,file_id) REFERENCES mail_uploads(user_id,id)
);
--> statement-breakpoint
ALTER TABLE mail_outbox ALTER COLUMN raw DROP NOT NULL;
ALTER TABLE mail_outbox ADD COLUMN mime_size integer CHECK(mime_size BETWEEN 1 AND 31457280);
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_mime_storage CHECK((raw IS NOT NULL AND mime_size IS NULL) OR (raw IS NULL AND mime_size IS NOT NULL));
CREATE UNIQUE INDEX mail_outbox_owner_id ON mail_outbox(user_id,id);
CREATE TABLE mail_outbox_chunks (
  user_id text NOT NULL,
  outbox_id uuid NOT NULL,
  position integer NOT NULL CHECK(position>=0),
  data bytea NOT NULL CHECK(octet_length(data)<=262144),
  PRIMARY KEY(outbox_id,position),
  FOREIGN KEY(user_id,outbox_id) REFERENCES mail_outbox(user_id,id) ON DELETE CASCADE
);
