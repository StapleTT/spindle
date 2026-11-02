import type { Transporter } from 'nodemailer';
import type { Pool, PoolClient } from 'pg';
import type { AuthConfig } from './config.js';
import { invitationEmail, sendAuthEmail } from './email.js';

export async function saveInvitation(
  client: PoolClient,
  email: string,
  role: 'user' | 'admin',
) {
  const result = await client.query(
    `INSERT INTO invites(email,role,expires_at) VALUES($1,$2,clock_timestamp()+interval '7 days')
     ON CONFLICT(email) DO UPDATE SET id=gen_random_uuid()::text,role=$2,expires_at=excluded.expires_at,
     revoked_at=NULL,accepted_at=NULL,accepted_user_id=NULL,delivery_state='unknown',created_at=clock_timestamp()
     RETURNING id,email,expires_at`,
    [email, role],
  );
  return result.rows[0] as { id: string; email: string; expires_at: Date };
}

export async function deliverInvitation(
  pool: Pool,
  mailer: Transporter,
  config: AuthConfig,
  invite: { id: string; email: string; expires_at: Date },
) {
  const link = new URL('/login', config.appUrl);
  link.search = new URLSearchParams({
    view: 'signup',
    email: invite.email,
  }).toString();
  let state: 'sent' | 'failed' = 'sent';
  try {
    await sendAuthEmail(
      mailer,
      config,
      invite.email,
      invitationEmail(config, invite.email, link.href, invite.expires_at),
    );
  } catch {
    state = 'failed';
  }
  // A slow delivery cannot change a replacement invitation's status.
  await pool.query('UPDATE invites SET delivery_state=$2 WHERE id=$1', [
    invite.id,
    state,
  ]);
  return state;
}
