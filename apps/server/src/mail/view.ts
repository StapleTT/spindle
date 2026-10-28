// Every list and reader navigation query uses this same owned membership boundary.
// Parameters: $1 user, $2 optional account, $3 optional mailbox.
export const mailViewCondition = `m.user_id=$1 AND ($2::uuid IS NULL OR m.account_id=$2)
  AND EXISTS(SELECT 1 FROM mail_memberships mm JOIN mailboxes b
    ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=mm.mailbox_id
    WHERE mm.user_id=$1 AND mm.message_id=m.id AND
    CASE WHEN $3::uuid IS NOT NULL THEN b.id=$3 ELSE b.role='inbox' END)`;
