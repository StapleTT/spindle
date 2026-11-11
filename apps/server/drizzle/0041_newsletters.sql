-- Newsletters view (J03): messages whose headers declare List-Unsubscribe.
-- Constant default: metadata-only on Postgres 11+, no table rewrite. Existing
-- mail fills as background metadata scans revisit it.
ALTER TABLE mail_messages ADD COLUMN list_unsubscribe boolean NOT NULL DEFAULT false;
