import pino from 'pino';

export const loggerOptions = {
  serializers: {
    req: (request: {
      method: string;
      url: string;
      ip?: string;
      remoteAddress?: string;
    }) => ({
      method: request.method,
      url: (request.url.split('?')[0] ?? '').replace(
        /(\/api\/auth\/reset-password\/)[^/?]+/,
        '$1[REDACTED]',
      ),
      remoteAddress: request.ip ?? request.remoteAddress ?? 'unknown',
    }),
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'token',
      'databaseUrl',
    ],
    censor: '[REDACTED]',
  },
};

export const logger = pino(loggerOptions);
