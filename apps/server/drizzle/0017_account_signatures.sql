CREATE TABLE mail_signatures (
  account_id uuid PRIMARY KEY,
  user_id text NOT NULL,
  html text NOT NULL CHECK(octet_length(html)<=20000),
  text text NOT NULL CHECK(octet_length(text)<=20000),
  new_messages boolean NOT NULL DEFAULT true,
  replies_forwards boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  FOREIGN KEY(user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE
);
