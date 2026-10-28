import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Auth } from './auth.js';
import type { AuthConfig } from './config.js';

export function authHeaders(request: FastifyRequest) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('x-spindle-client-ip', request.ip);
  return headers;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: Auth,
  config: AuthConfig,
) {
  app.get('/api/auth-config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { registrationMode: config.registrationMode };
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    bodyLimit: 8192,
    handler: async (request, reply) => {
      const path = new URL(request.url, config.appUrl).pathname.slice(
        '/api/auth'.length,
      );
      const allowed =
        request.method === 'POST'
          ? [
              '/sign-up/email',
              '/sign-in/email',
              '/sign-out',
              '/send-verification-email',
              '/request-password-reset',
              '/reset-password',
            ].includes(path)
          : ['/get-session', '/verify-email'].includes(path) ||
            /^\/reset-password\/[^/]+$/.test(path);
      if (!allowed) return reply.code(404).send({ message: 'Not found.' });
      if (
        request.method === 'POST' &&
        request.headers.origin !== config.appUrl
      ) {
        return reply
          .code(403)
          .send({ message: 'Request origin is not allowed.' });
      }
      const headers = authHeaders(request);
      const response = await auth.handler(
        new Request(new URL(request.url, config.appUrl), {
          method: request.method,
          headers,
          ...(request.method === 'POST'
            ? { body: JSON.stringify(request.body ?? {}) }
            : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, name) => {
        if (name !== 'set-cookie') reply.header(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      if (response.status >= 500) {
        request.log.error('Authentication request failed');
        return reply.send({
          message:
            'Authentication is temporarily unavailable. Please try again.',
        });
      }
      return reply.send(await response.text());
    },
  });

  app.get('/api/me', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const current = await auth.api.getSession({
      headers: authHeaders(request),
    });
    if (!current)
      return reply.code(401).send({ message: 'Sign in to continue.' });
    if (!current.user.emailVerified)
      return reply
        .code(403)
        .send({ message: 'Verify your email to continue.' });
    return {
      user: {
        id: current.user.id,
        email: current.user.email,
        role: current.user.role,
      },
    };
  });
}
