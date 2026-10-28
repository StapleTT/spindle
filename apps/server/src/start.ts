import { Pool } from 'pg';
import { buildApp } from './app.js';
import { createAuth } from './auth/auth.js';
import { readAuthConfig } from './auth/config.js';
import { readConfig } from './config.js';
import { logger } from './logger.js';
import { readContentConfig } from './mail/content-config.js';
import { buildContentApp } from './mail/content-server.js';

const config = readConfig();
const authConfig = readAuthConfig();
const database = new Pool({
  connectionString: config.databaseUrl,
  connectionTimeoutMillis: 5000,
  query_timeout: 5000,
  max: 10,
});
database.on('error', () =>
  logger.error('Unexpected database connection error'),
);
const app = buildApp(database, createAuth(database, authConfig), authConfig);
const contentConfig = readContentConfig(authConfig);
const contentApp = contentConfig
  ? buildContentApp(database, contentConfig)
  : null;
app.addHook('preClose', async () => {
  await contentApp?.close();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().catch(() => {
      process.exitCode = 1;
    });
  });
}

try {
  await database.query('SELECT id FROM users LIMIT 0');
  await database.query('SELECT id FROM mail_accounts LIMIT 0');
  await database.query('SELECT message_id FROM mail_content LIMIT 0');
  if (contentConfig && contentApp)
    await contentApp.listen({
      host: contentConfig.host,
      port: contentConfig.port,
    });
  await app.listen({ host: config.host, port: config.port });
} catch {
  logger.error(
    'API startup failed; check database migrations, host, port and auth configuration',
  );
  await app.close();
  process.exitCode = 1;
}
