-- Avoid scanning accounts with no local choices on each metadata batch.
CREATE INDEX mail_messages_local_choices_idx ON mail_messages(user_id,account_id)
WHERE greatest(local_pin_version,local_mute_version,local_snooze_version)>0;
