ALTER TABLE mail_actions DROP CONSTRAINT mail_actions_state_check;
ALTER TABLE mail_actions ADD CONSTRAINT mail_actions_state_check CHECK (state IN ('pending','applied','failed','cancelled'));
ALTER TABLE mail_actions ADD COLUMN undo_until timestamptz NOT NULL DEFAULT now();
CREATE INDEX mail_actions_undo_idx ON mail_actions(user_id,undo_until) WHERE state='pending';
