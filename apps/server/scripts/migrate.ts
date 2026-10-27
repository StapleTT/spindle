import { Pool } from 'pg';
import { readConfig } from '../src/config.js';
import { migrateDatabase } from '../src/db/migrate.js';

const pool = new Pool({
  connectionString: readConfig().databaseUrl,
  connectionTimeoutMillis: 5000,
});
try {
  await migrateDatabase(pool);
  console.log('Database migrations applied.');
} catch {
  console.error(
    'Migration failed. Check database access and migration compatibility.',
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
