import { and, eq, gt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { readAuthConfig } from '../src/auth/config.js';
import {
  createMailer,
  invitationEmail,
  sendAuthEmail,
} from '../src/auth/email.js';
import { readConfig } from '../src/config.js';
import { invites, user } from '../src/db/schema.js';

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
const db = drizzle(pool);
const mailer = createMailer(config);
const expiresAt = new Date(Date.now() + 7 * 24 * 3600000);
try {
  await db.transaction(async (tx) => {
    // Serializes explicit admin designation; it is never granted by registration order.
    await tx.execute('SELECT pg_advisory_xact_lock(728491603)');
    if ((await tx.select().from(user).where(eq(user.email, email))).length)
      throw new Error('This email already has an account.');
    if (flag === '--admin') {
      const admins = await tx.select().from(user).where(eq(user.role, 'admin'));
      const pending = await tx
        .select()
        .from(invites)
        .where(
          and(eq(invites.role, 'admin'), gt(invites.expiresAt, new Date())),
        );
      if (admins.length || pending.some((invite) => invite.email !== email))
        throw new Error('An admin already exists or has an active invitation.');
    }
    const values = {
      email,
      role: flag === '--admin' ? ('admin' as const) : ('user' as const),
      expiresAt,
    };
    await tx
      .insert(invites)
      .values(values)
      .onConflictDoUpdate({ target: invites.email, set: values });
  });
  const link = new URL(config.appUrl);
  link.searchParams.set('view', 'signup');
  link.searchParams.set('email', email);
  await sendAuthEmail(
    mailer,
    config,
    email,
    invitationEmail(config, email, link.href, expiresAt),
  );
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
