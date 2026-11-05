-- D040: Gmail reader, actions and sending. The default "Send mail as" display
-- name is read from Gmail (users.settings.sendAs) for the From header; NULL
-- until the first sync, when the Spindle profile name is the fallback.
ALTER TABLE mail_gmail_sync ADD COLUMN display_name text
  CHECK (length(display_name) <= 800 AND display_name !~ '[[:cntrl:]]');
