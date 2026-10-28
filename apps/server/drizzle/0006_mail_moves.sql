ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_kind_check;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_kind_check CHECK (kind IN ('read','unread','archive','trash'));
ALTER TABLE mail_actions ADD COLUMN target_mailbox_id uuid;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_target_check CHECK ((kind IN ('archive','trash'))=(target_mailbox_id IS NOT NULL));
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_target_fk FOREIGN KEY (user_id,account_id,target_mailbox_id) REFERENCES mailboxes(user_id,account_id,id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE mail_memberships ADD COLUMN pending_mailbox_id uuid;
ALTER TABLE mail_memberships ADD CONSTRAINT mail_memberships_pending_fk FOREIGN KEY (user_id,account_id,pending_mailbox_id) REFERENCES mailboxes(user_id,account_id,id) ON DELETE SET NULL (pending_mailbox_id);
CREATE INDEX mail_memberships_pending_idx ON mail_memberships(pending_mailbox_id) WHERE pending_mailbox_id IS NOT NULL;
