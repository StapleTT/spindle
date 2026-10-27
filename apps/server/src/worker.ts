import { PgBoss } from 'pg-boss';
import { readConfig } from './config.js';
import { logger } from './logger.js';

const { databaseUrl } = readConfig();
const boss = new PgBoss({ connectionString: databaseUrl });
boss.on('error', () => logger.error('Worker database operation failed'));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void boss.stop({ graceful: true, timeout: 10000 }).catch(() => {
      process.exitCode = 1;
    });
  });
}

try {
  await boss.start();
  logger.info('Worker queue ready; mail sync handlers are not implemented yet');
} catch {
  logger.error(
    'Worker startup failed; check database availability and permissions',
  );
  await boss.stop();
  process.exitCode = 1;
}
