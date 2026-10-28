CREATE FUNCTION mail_search_people(data jsonb) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(coalesce(p->>'name','')||' '||coalesce(p->>'address',''),' ' ORDER BY n),'')
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(data)='array' THEN data ELSE '[]'::jsonb END) WITH ORDINALITY AS people(p,n)
$$;
--> statement-breakpoint
ALTER TABLE mail_messages ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('simple',left(subject||' '||mail_search_people(sender)||' '||mail_search_people(recipients->'to')||' '||mail_search_people(recipients->'cc')||' '||translate(mail_search_people(sender)||' '||mail_search_people(recipients->'to')||' '||mail_search_people(recipients->'cc'),'@._+-','     '),100000))
) STORED;
CREATE INDEX mail_messages_search_idx ON mail_messages USING gin(search_vector);
ALTER TABLE mail_content ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple',left(coalesce(plain_text,''),100000))) STORED;
CREATE INDEX mail_content_search_idx ON mail_content USING gin(search_vector) WHERE state='ready';
CREATE UNIQUE INDEX mailboxes_user_id_idx ON mailboxes(user_id,id);
CREATE TABLE mail_saved_searches (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  query text NOT NULL CHECK(length(query) BETWEEN 1 AND 500),
  account_id uuid,
  mailbox_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(user_id,name),
  FOREIGN KEY(user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,mailbox_id) REFERENCES mailboxes(user_id,id) ON DELETE CASCADE
);
