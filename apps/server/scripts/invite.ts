import { Pool } from 'pg';
import { readAuthConfig } from '../src/auth/config.js';
import { createMailer } from '../src/auth/email.js';
import { deliverInvitation, saveInvitation } from '../src/auth/invitations.js';
import { readConfig } from '../src/config.js';
import { transaction } from '../src/mail/store.js';

const [input, flag, ...extra] = process.argv.slice(2);
const email = input?.trim().toLowerCase();
if (
  !email ||
  email.length > 254 ||
  !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
  (flag && flag !== '--admin') ||
  extra.length
) {
  throw new Error('Usage: npm run auth:invite -- email@example.com [--admin]');
}
const config = readAuthConfig();
const pool = new Pool({
  connectionString: readConfig().databaseUrl,
  connectionTimeoutMillis: 5000,
});
const mailer = createMailer(config);
try {
  const invitation = await transaction(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(728491603)');
    if (
      (await client.query('SELECT 1 FROM users WHERE email=$1', [email]))
        .rowCount
    )
      throw new Error('Account exists');
    if (
      flag === '--admin' &&
      (
        await client.query(
          `SELECT 1 FROM users WHERE role='admin'
      UNION ALL SELECT 1 FROM invites WHERE role='admin' AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at>clock_timestamp() AND email<>$1`,
          [email],
        )
      ).rowCount
    )
      throw new Error('An administrator is designated');
    return saveInvitation(client, email, flag === '--admin' ? 'admin' : 'user');
  });
  if ((await deliverInvitation(pool, mailer, config, invitation)) !== 'sent')
    throw new Error('Delivery unavailable');
  console.log(
    'Invitation issued. Check the recipient inbox (Mailpit during local development).',
  );
} catch {
  console.error(
    'Unable to issue invitation. Check migrations, existing accounts/admin invites and SMTP availability. An invitation saved before an email failure can be reissued.',
  );
  process.exitCode = 1;
} finally {
  mailer.close();
  await pool.end();
}
