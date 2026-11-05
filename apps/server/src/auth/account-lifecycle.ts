import type { Pool, PoolClient } from 'pg';
import type { GmailGrant } from '../mail/google.js';

export type SecurityEventType =
  | 'account.created'
  | 'sign_in.succeeded'
  | 'sign_in.failed'
  | 'sign_out'
  | 'password.changed'
  | 'password.reset'
  | 'email.change_requested'
  | 'email.change_cancelled'
  | 'email.changed'
  | 'session.revoked'
  | 'sessions.revoked_others'
  | 'export.created'
  | 'deletion.scheduled'
  | 'deletion.cancelled'
  | 'account.deleted';

export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
export const SECURITY_EVENT_RETENTION = '180 days';

/** Network metadata only; never bodies, tokens or credentials. */
export function clientMeta(headers?: Headers | null) {
  return {
    ipAddress: headers?.get('x-spindle-client-ip')?.slice(0, 64) ?? null,
    userAgent: headers?.get('user-agent')?.slice(0, 512) ?? null,
  };
}

type EventAdapter = {
  create: (input: {
    model: string;
    data: Record<string, unknown>;
  }) => Promise<unknown>;
};

/** Records inside the caller's Better Auth adapter context (transactional when it is). */
export function recordSecurityEvent(
  adapter: EventAdapter,
  userId: string,
  type: SecurityEventType,
  headers?: Headers | null,
) {
  return adapter.create({
    model: 'securityEvent',
    data: { userId, type, ...clientMeta(headers), createdAt: new Date() },
  });
}

export function insertSecurityEvent(
  db: Pick<Pool, 'query'>,
  userId: string,
  type: SecurityEventType,
  headers?: Headers | null,
) {
  const meta = clientMeta(headers);
  return db.query(
    'INSERT INTO security_events(user_id,type,ip_address,user_agent) VALUES($1,$2,$3,$4)',
    [userId, type, meta.ipAddress, meta.userAgent],
  );
}

/**
 * Permanently removes a user. Owned mail, credentials, drafts, uploads, outbox,
 * search data and sessions cascade from `users`. Retains only an `account.deleted`
 * event keyed by the stable user ID, and scrubs the address from admin records.
 * `due` restricts deletion to an expired self-service grace period.
 */
export async function deleteUserData(
  client: PoolClient,
  userId: string,
  due: boolean,
) {
  const user = (
    await client.query(
      `SELECT email FROM users WHERE id=$1 AND (NOT $2 OR (suspended AND deletion_due_at<=clock_timestamp())) FOR UPDATE`,
      [userId, due],
    )
  ).rows[0] as { email: string } | undefined;
  if (!user) return false;
  await client.query(
    `UPDATE admin_audit SET details=details-'email',
     target_id=CASE WHEN target_id=$2 THEN 'deleted-user' ELSE target_id END
     WHERE target_id IN ($1,$2) OR details->>'email'=$2`,
    [userId, user.email],
  );
  await client.query(
    'DELETE FROM invites WHERE email=$1 OR accepted_user_id=$2',
    [user.email, userId],
  );
  await client.query('DELETE FROM auth_verifications WHERE value=$1', [userId]);
  await client.query('DELETE FROM security_events WHERE user_id=$1', [userId]);
  // Gmail grants are returned so the caller can revoke them after commit.
  const grants = (
    await client.query<GmailGrant>(
      "SELECT user_id,id,credential,provider_account FROM mail_accounts WHERE user_id=$1 AND provider='gmail'",
      [userId],
    )
  ).rows;
  await client.query('DELETE FROM users WHERE id=$1', [userId]);
  await insertSecurityEvent(client, userId, 'account.deleted');
  return grants;
}
