// Drafts belong in the composer; deleted/sent copies remain readable in their folders.
export const receivedMembershipCondition = `b.role IS DISTINCT FROM '\\Drafts'
  AND (NOT('\\Draft'=ANY(mm.flags)) OR b.role IN ('\\Trash','\\Sent','\\Junk'))`;

export const localStateFields = `m.local_pinned AS pinned,m.local_muted AS muted,
  CASE WHEN m.local_snoozed_until>clock_timestamp() THEN m.local_snoozed_until ELSE NULL END AS "snoozedUntil",
  greatest(m.local_pin_version,m.local_mute_version,m.local_snooze_version)::text AS version`;
const awake = 'coalesce(m.local_snoozed_until<=clock_timestamp(),true)';

// Every list and reader navigation query uses this same owned membership boundary.
// A pending move already shows the message in its destination folder.
// Parameters: $1 user, $2 optional account, $3 optional mailbox.
export function mailView(scope = 'inbox') {
  const roles: Record<string, string> = {
    inbox: 'inbox',
    archive: '\\Archive',
    sent: '\\Sent',
    trash: '\\Trash',
    spam: '\\Junk',
  };
  const folder =
    scope === 'anywhere'
      ? 'true'
      : ['search', 'pinned', 'muted', 'snoozed'].includes(scope)
        ? "b.role IS DISTINCT FROM '\\Trash' AND b.role IS DISTINCT FROM '\\Junk'"
        : `b.role='${roles[scope] ?? 'inbox'}'${scope === 'inbox' ? ` AND ${awake}` : ''}`;
  const state =
    scope === 'pinned'
      ? ' AND m.local_pinned'
      : scope === 'muted'
        ? ' AND m.local_muted'
        : scope === 'snoozed'
          ? ' AND m.local_snoozed_until>clock_timestamp()'
          : '';
  return `m.user_id=$1 AND ($2::uuid IS NULL OR m.account_id=$2)
  AND EXISTS(SELECT 1 FROM mail_memberships mm JOIN mailboxes b
    ON b.user_id=mm.user_id AND b.account_id=mm.account_id AND b.id=COALESCE(mm.pending_mailbox_id,mm.mailbox_id)
    WHERE mm.user_id=$1 AND mm.message_id=m.id AND ${receivedMembershipCondition} AND
    CASE WHEN $3::uuid IS NOT NULL THEN b.id=$3 AND (b.role IS DISTINCT FROM 'inbox' OR ${awake}) ELSE ${folder} END)${state}`;
}
export const mailViewCondition = mailView();
