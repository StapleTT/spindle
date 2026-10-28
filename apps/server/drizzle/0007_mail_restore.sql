ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_kind_check;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_kind_check CHECK (kind IN ('read','unread','archive','trash','move','restore'));
ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_target_check;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_target_check CHECK ((kind IN ('archive','trash','move','restore'))=(target_mailbox_id IS NOT NULL));
ALTER TABLE mail_actions ADD COLUMN source_mailbox_id uuid;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_source_fk FOREIGN KEY (user_id,account_id,source_mailbox_id) REFERENCES mailboxes(user_id,account_id,id) ON DELETE SET NULL (source_mailbox_id);
