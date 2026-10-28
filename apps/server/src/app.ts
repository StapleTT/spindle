import helmet from '@fastify/helmet';
import Fastify, { type FastifyError } from 'fastify';
import type { Pool } from 'pg';
import type { Auth } from './auth/auth.js';
import type { AuthConfig } from './auth/config.js';
import { registerAuthRoutes } from './auth/routes.js';
import { loggerOptions } from './logger.js';
import { type MailKeys, readMailKeys } from './mail/credentials.js';
import { registerMailRoutes } from './mail/routes.js';

export function buildApp(
  database: Pool,
  auth: Auth,
  config: AuthConfig,
  mailKeys: MailKeys = readMailKeys(),
) {
  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { coerceTypes: false } },
    trustProxy: config.trustProxy,
  });
  app.register(helmet);
  registerAuthRoutes(app, auth, config);
  app.register(async (mail) =>
    registerMailRoutes(mail, database, auth, config, mailKeys),
  );
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (status === 500) request.log.error('Request failed');
    reply.code(status).send({
      message:
        status === 500
          ? 'Request failed. Please try again.'
          : 'Invalid request.',
    });
  });
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
