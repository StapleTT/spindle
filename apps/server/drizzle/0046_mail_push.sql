-- D049: provider push (Gmail watch, Graph subscription) per account. A push
-- notification only wakes the account's ordinary sync. Rows go with the account;
-- the provider side expires on its own (at most seven days).
CREATE TABLE mail_push (
  user_id text NOT NULL,
  account_id uuid PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('gmail','microsoft')),
  subscription_id text UNIQUE CHECK (length(subscription_id) BETWEEN 1 AND 256),
  client_state_hash bytea CHECK (length(client_state_hash)=32),
  expires_at timestamptz,
  renew_at timestamptz NOT NULL,
  error_code text CHECK (length(error_code)<=64),
  FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
