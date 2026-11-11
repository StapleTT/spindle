-- Needs reply was removed (D046). Drop 0043's correction column and trigger.
DROP TRIGGER mail_messages_notify_needs_reply ON mail_messages;
ALTER TABLE mail_messages DROP COLUMN local_needs_reply;
