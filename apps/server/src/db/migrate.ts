import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

export async function migrateDatabase(pool: Pool) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(728491602)');
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(
        new URL('../../drizzle', import.meta.url),
      ),
    });
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(728491602)');
    } finally {
      client.release();
    }
  }
}
