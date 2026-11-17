export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    !parsed.hostname
  ) {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }

  return { databaseUrl, port, host: env.HOST ?? '127.0.0.1' };
}

// D049: public HTTPS origin that providers call for push notifications.
// Unset means no push; polling continues either way.
export function readPushUrl(env: NodeJS.ProcessEnv = process.env) {
  const value = env.PUSH_URL;
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('PUSH_URL must be an https origin');
  }
  if (url.protocol !== 'https:' || url.origin !== value.replace(/\/$/, ''))
    throw new Error('PUSH_URL must be an https origin');
  return url.origin;
}
