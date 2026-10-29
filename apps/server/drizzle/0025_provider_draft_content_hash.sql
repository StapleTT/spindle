ALTER TABLE mail_draft_copies ADD COLUMN content_hash text CHECK(content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE mail_draft_copies ADD COLUMN content_hash_source text CHECK(content_hash_source IS NULL OR content_hash_source ~ '^[0-9a-f]{64}$');
