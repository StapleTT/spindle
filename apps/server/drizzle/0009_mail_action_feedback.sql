ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_state_check;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_state_check CHECK (state IN ('pending','applied','failed','cancelled','conflict'));
ALTER TABLE mail_actions ADD COLUMN subject text NOT NULL DEFAULT '';
ALTER TABLE mail_actions ADD COLUMN dismissed_at timestamptz;
UPDATE mail_actions a SET subject=m.subject FROM mail_messages m WHERE m.user_id=a.user_id AND m.id=a.message_id;
--> statement-breakpoint
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_account_fk FOREIGN KEY (user_id,account_id) REFERENCES mail_accounts(user_id,id) ON DELETE CASCADE;
ALTER TABLE mail_actions ALTER COLUMN message_id DROP NOT NULL;
ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_user_id_account_id_message_id_fkey;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_message_fk FOREIGN KEY (user_id,account_id,message_id) REFERENCES mail_messages(user_id,account_id,id) ON DELETE SET NULL (message_id);
ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_target_fk;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_target_fk FOREIGN KEY (user_id,account_id,target_mailbox_id) REFERENCES mailboxes(user_id,account_id,id) ON DELETE SET NULL (target_mailbox_id);
ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_target_check;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_target_check CHECK (kind NOT IN ('read','unread') OR target_mailbox_id IS NULL);
CREATE INDEX mail_actions_recent_idx ON mail_actions(user_id,seq DESC);
