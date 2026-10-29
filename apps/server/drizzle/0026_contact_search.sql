ALTER TABLE mail_messages ADD COLUMN contact_vector tsvector GENERATED ALWAYS AS (
  to_tsvector('simple',left(mail_search_people(sender)||' '||mail_search_people(recipients->'to')||' '||mail_search_people(recipients->'cc')||' '||translate(mail_search_people(sender)||' '||mail_search_people(recipients->'to')||' '||mail_search_people(recipients->'cc'),'@._+-','     '),100000))
) STORED;
CREATE INDEX mail_messages_contacts_idx ON mail_messages USING gin(contact_vector);
