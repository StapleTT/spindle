ALTER TABLE mail_smtp ADD COLUMN display_name text NOT NULL DEFAULT '';
UPDATE mail_smtp s SET display_name=btrim(left(regexp_replace(u.name,'[[:cntrl:]]',' ','g'),200))
  FROM users u WHERE u.id=s.user_id;
ALTER TABLE mail_smtp ADD CONSTRAINT mail_smtp_display_name_check
  CHECK(char_length(display_name)<=200 AND display_name !~ '[[:cntrl:]]');
