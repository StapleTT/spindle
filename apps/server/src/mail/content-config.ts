import type { AuthConfig } from '../auth/config.js';

export function readContentConfig(
  auth: AuthConfig,
  env: NodeJS.ProcessEnv = process.env,
) {
  const app = new URL(auth.appUrl);
  const local =
    app.protocol === 'http:' &&
    ['127.0.0.1', 'localhost'].includes(app.hostname);
  const port = Number(env.CONTENT_PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('CONTENT_PORT is invalid');
  const host = env.CONTENT_HOST ?? '127.0.0.1';
  const value =
    env.CONTENT_URL ??
    (local
      ? `http://${app.hostname === 'localhost' ? '127.0.0.1' : 'localhost'}:${port}`
      : undefined);
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('CONTENT_URL must be an origin');
  }
  if (
    url.hostname.replace(/\.$/, '') === app.hostname.replace(/\.$/, '') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        local &&
        url.protocol === 'http:' &&
        ['127.0.0.1', 'localhost'].includes(url.hostname)
      ))
  )
    throw new Error(
      'CONTENT_URL requires a separate hostname and HTTPS outside loopback development',
    );
  if (
    url.protocol === 'http:' &&
    !['127.0.0.1', 'localhost', '::1'].includes(host)
  )
    throw new Error('HTTP content development must bind to loopback');
  return {
    origin: url.origin,
    port,
    host,
    appOrigin: app.origin,
    secret: auth.secret,
  };
}

export type ContentConfig = NonNullable<ReturnType<typeof readContentConfig>>;
