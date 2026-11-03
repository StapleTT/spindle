import helmet from '@fastify/helmet';
import Fastify, { type FastifyError } from 'fastify';
import type { Transporter } from 'nodemailer';
import type { Pool } from 'pg';
import { registerAdminRoutes } from './admin/routes.js';
import type { Auth } from './auth/auth.js';
import type { AuthConfig } from './auth/config.js';
import { registerDataExport } from './auth/data-export.js';
import { createMailer } from './auth/email.js';
import { registerAuthRoutes } from './auth/routes.js';
import { loggerOptions } from './logger.js';
import { readContentConfig } from './mail/content-config.js';
import { type MailKeys, readMailKeys } from './mail/credentials.js';
import { registerMailRoutes } from './mail/routes.js';

export function buildApp(
  database: Pool,
  auth: Auth,
  config: AuthConfig,
  mailKeys: MailKeys = readMailKeys(),
  content = readContentConfig(config),
  mailer: Transporter = createMailer(config),
) {
  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: 64 * 1024,
    ajv: { customOptions: { coerceTypes: false } },
    trustProxy: config.trustProxy,
  });
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: { frameSrc: content ? [content.origin] : ["'none'"] },
    },
  });
  registerAuthRoutes(app, auth, config);
  registerDataExport(app, database, auth, config);
  app.register(async (admin) =>
    registerAdminRoutes(admin, database, auth, config, mailer),
  );
  app.register(async (mail) =>
    registerMailRoutes(mail, database, auth, config, mailKeys, content),
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
    mailer.close();
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
