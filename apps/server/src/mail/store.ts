import type { Pool, PoolClient } from 'pg';
import type { ImapSettings } from './imap.js';

export type MailAccount = ImapSettings & {
  id: string;
  user_id: string;
  credential: string;
  history_since: Date | null;
  lease_token: string;
  failures: number;
  sync_request: string;
  sync_completed: string | null;
};

export type Mailbox = {
  id: string;
  path: string;
  uid_validity: string | null;
  high_uid: string;
  scan_uid: string | null;
  initial_complete: boolean;
};

export async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await operation(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function claimAccount(
  pool: Pool,
  userId: string,
  id: string,
  syncing = true,
) {
  const result = await pool.query<MailAccount>(
    `UPDATE mail_accounts a SET lease_token=gen_random_uuid(),
       lease_until=clock_timestamp()+interval '90 seconds', status=CASE WHEN $3 THEN 'syncing' ELSE status END
     WHERE a.id=$1 AND a.user_id=$2
       AND (lease_until IS NULL OR lease_until<clock_timestamp())
       AND EXISTS (SELECT 1 FROM users u WHERE u.id=a.user_id AND u.email_verified)
     RETURNING a.*`,
    [id, userId, syncing],
  );
  return result.rows[0];
}

export async function withLease<T>(
  pool: Pool,
  account: MailAccount,
  operation: (client: PoolClient) => Promise<T>,
) {
  return transaction(pool, async (client) => {
    const owner = await client.query(
      'SELECT id FROM users WHERE id=$1 AND email_verified FOR UPDATE',
      [account.user_id],
    );
    if (!owner.rowCount) throw new Error('Mail owner is unavailable');
    const valid = await client.query(
      `SELECT a.id FROM mail_accounts a JOIN users u ON u.id=a.user_id
       WHERE a.id=$1 AND a.user_id=$2 AND a.lease_token=$3
       AND a.lease_until>clock_timestamp() AND u.email_verified FOR UPDATE OF a`,
      [account.id, account.user_id, account.lease_token],
    );
    if (!valid.rowCount) throw new Error('Sync lease no longer valid');
    return operation(client);
  });
}

export async function releaseLease(pool: Pool, account: MailAccount) {
  await pool.query(
    'UPDATE mail_accounts SET lease_token=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2 AND lease_token=$3',
    [account.user_id, account.id, account.lease_token],
  );
}

export async function consumeLimit(
  pool: Pick<Pool, 'query'>,
  user: string,
  action: string,
  max: number,
) {
  const result = await pool.query(
    `INSERT INTO mail_request_limits(user_id, action, window_start, count)
     VALUES ($1,$2,clock_timestamp(),1)
     ON CONFLICT (user_id,action) DO UPDATE SET
       count=CASE WHEN mail_request_limits.window_start < clock_timestamp()-interval '1 minute'
         THEN 1 ELSE mail_request_limits.count+1 END,
       window_start=CASE WHEN mail_request_limits.window_start < clock_timestamp()-interval '1 minute'
         THEN clock_timestamp() ELSE mail_request_limits.window_start END RETURNING count`,
    [user, action],
  );
  return result.rows[0].count <= max;
}
