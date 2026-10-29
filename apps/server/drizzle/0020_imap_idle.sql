ALTER TABLE mail_accounts ADD COLUMN next_idle_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE mail_accounts ADD COLUMN idle_failures integer NOT NULL DEFAULT 0 CHECK(idle_failures BETWEEN 0 AND 10);
CREATE INDEX mail_accounts_idle_due_idx ON mail_accounts(next_idle_at) WHERE status='ready';
