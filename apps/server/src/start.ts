import { Pool } from 'pg';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { logger } from './logger.js';

const config = readConfig();
const database = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  max: 10,
});
database.on('error', () =>
  logger.error('Unexpected database connection error'),
);
const app = buildApp(database);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}

try {
  await app.listen({ host: config.host, port: config.port });
} catch {
  logger.error('API startup failed; check the host, port and configuration');
  await app.close();
  process.exitCode = 1;
}
