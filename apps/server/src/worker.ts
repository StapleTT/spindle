import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { readConfig } from './config.js';
import { logger } from './logger.js';
import { readMailKeys } from './mail/credentials.js';
import { startMailWorker } from './mail/worker.js';

const { databaseUrl } = readConfig();
const boss = new PgBoss({ connectionString: databaseUrl });
const keys = readMailKeys();
const pool = new Pool({
  connectionString: databaseUrl,
  max: 5,
  connectionTimeoutMillis: 5000,
  query_timeout: 15000,
});
pool.on('error', () => logger.error('Mail database connection failed'));
boss.on('error', () => logger.error('Worker database operation failed'));
let stopMail: (() => void) | undefined;

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopMail?.();
    void boss
      .stop({ graceful: true, timeout: 60000 })
      .then(() => pool.end())
      .catch(() => {
        process.exitCode = 1;
      });
  });
}

try {
  await pool.query('SELECT id FROM mail_accounts LIMIT 0');
  await pool.query('SELECT message_id FROM mail_content LIMIT 0');
  await boss.start();
  stopMail = await startMailWorker(boss, pool, keys);
  logger.info('Worker ready for private IMAP synchronization');
  if (!keys.keys.size)
    logger.warn('Mailbox connections require mail encryption configuration');
} catch {
  logger.error(
    'Worker startup failed; check database availability and permissions',
  );
  await boss.stop();
  await pool.end();
  process.exitCode = 1;
}
