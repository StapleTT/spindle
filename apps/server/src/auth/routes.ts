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

function containsNul(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (value && typeof value === 'object')
    return Object.entries(value).some(
      ([key, item]) => key.includes('\u0000') || containsNul(item),
    );
  return false;
}

// Better Auth endpoints reachable through /api/auth/*; everything else is 404.
export const authProxyPaths = {
  POST: [
    '/sign-up/email',
    '/sign-in/email',
    '/sign-out',
    '/send-verification-email',
    '/request-password-reset',
    '/reset-password',
    '/account/profile',
    '/account/password',
    '/account/email',
    '/account/email/cancel',
    '/account/email/confirm',
    '/account/sessions/revoke',
    '/account/sessions/revoke-others',
    '/account/deletion',
    '/account/deletion/cancel',
  ],
  GET: [
    '/get-session',
    '/verify-email',
    '/account',
    '/account/sessions',
    '/account/activity',
  ],
};

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
          ? authProxyPaths.POST.includes(path)
          : authProxyPaths.GET.includes(path) ||
            /^\/reset-password\/[^/]+$/.test(path);
      if (!allowed) return reply.code(404).send({ message: 'Not found.' });
      // Postgres text cannot hold NUL; refuse it before Better Auth queries.
      if (/%00/.test(request.url) || containsNul(request.body))
        return reply.code(400).send({ message: 'Invalid request.' });
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
    if (!current.user.emailVerified || current.user.suspended)
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
