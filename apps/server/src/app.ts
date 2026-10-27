import helmet from '@fastify/helmet';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { logger } from './logger.js';

export function buildApp(database: Pool) {
  const app = Fastify({ loggerInstance: logger, bodyLimit: 64 * 1024 });
  app.register(helmet);
  app.addHook('onClose', async () => {
    await database.end();
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_request, reply) => {
    try {
      await database.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
