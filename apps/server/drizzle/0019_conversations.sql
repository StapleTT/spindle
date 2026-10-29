ALTER TABLE mail_messages ADD COLUMN reference_ids text[] CHECK(cardinality(reference_ids)<=100);
--> statement-breakpoint
CREATE FUNCTION mail_thread_ids(value text) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(id ORDER BY n),'{}'::text[]) FROM (
    SELECT (part)[1] AS id,n FROM regexp_matches(left(coalesce(value,''),65536),'<[^<>]*>','g') WITH ORDINALITY AS x(part,n)
    WHERE length((part)[1])<=512 AND (part)[1] ~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$' AND (part)[1] !~ '[^!-~]'
    ORDER BY n LIMIT 100
  ) ids
$$;
CREATE FUNCTION mail_thread_tokens(own_id text,parent_id text,refs text[]) RETURNS text[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(array_agg(DISTINCT id ORDER BY id),'{}'::text[]) FROM unnest(
    CASE WHEN length(own_id)<=512 AND own_id ~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$' AND own_id !~ '[^!-~]' THEN ARRAY[own_id] ELSE '{}'::text[] END
    || mail_thread_ids(parent_id) || coalesce(refs,'{}'::text[])
  ) ids(id) WHERE length(id)<=512 AND id ~ '^<[^<>[:space:]@]+@[^<>[:space:]@]+>$' AND id !~ '[^!-~]'
$$;
ALTER TABLE mail_messages ADD COLUMN thread_tokens text[] GENERATED ALWAYS AS (mail_thread_tokens(message_id,in_reply_to,reference_ids)) STORED;
CREATE INDEX mail_messages_thread_tokens_idx ON mail_messages USING gin(thread_tokens);
--> statement-breakpoint
-- Reuse already parsed headers without changing the cache or fetching mail during upgrade.
UPDATE mail_messages m SET reference_ids=ARRAY(
  SELECT value FROM jsonb_array_elements_text(c.reply_metadata->'references') WITH ORDINALITY AS refs(value,n) ORDER BY n LIMIT 100
) FROM mail_content c WHERE c.user_id=m.user_id AND c.account_id=m.account_id AND c.message_id=m.id
  AND jsonb_typeof(c.reply_metadata->'references')='array';
