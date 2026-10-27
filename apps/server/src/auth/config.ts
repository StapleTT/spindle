export function readAuthConfig(env: NodeJS.ProcessEnv = process.env) {
  let url: URL;
  try {
    url = new URL(env.APP_URL ?? '');
  } catch {
    throw new Error('APP_URL must be the application origin');
  }
  if (
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error(
      'APP_URL must be the application origin without a path or credentials',
    );
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'];
  const localDevelopment =
    env.ALLOW_INSECURE_LOCALHOST === 'true' &&
    env.NODE_ENV !== 'production' &&
    local.includes(url.hostname) &&
    local.includes(env.HOST ?? '127.0.0.1');
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && localDevelopment)
  ) {
    throw new Error(
      'APP_URL requires HTTPS; insecure development is restricted to explicit loopback use',
    );
  }
  const secret = env.AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('AUTH_SECRET must contain at least 32 random characters');
  const registrationMode = env.REGISTRATION_MODE ?? 'invite';
  if (!['invite', 'public'].includes(registrationMode))
    throw new Error('REGISTRATION_MODE must be invite or public');
  if (!env.SMTP_HOST || !env.MAIL_FROM || /[\r\n]/.test(env.MAIL_FROM)) {
    throw new Error('SMTP_HOST and a valid MAIL_FROM are required');
  }
  const smtpPort = Number(env.SMTP_PORT);
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535)
    throw new Error('SMTP_PORT must be from 1 to 65535');
  if (!['true', 'false'].includes(env.SMTP_SECURE ?? ''))
    throw new Error('SMTP_SECURE must be true or false');
  if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASSWORD))
    throw new Error('SMTP_USER and SMTP_PASSWORD must be set together');
  return {
    appUrl: url.origin,
    trustProxy: env.TRUST_PROXY
      ? env.TRUST_PROXY.split(',').map((proxy) => proxy.trim())
      : (false as const),
    secret,
    registrationMode,
    secureCookies: url.protocol === 'https:',
    smtpHost: env.SMTP_HOST,
    smtpPort,
    smtpSecure: env.SMTP_SECURE === 'true',
    smtpRequireTLS: !(localDevelopment && local.includes(env.SMTP_HOST)),
    smtpUser: env.SMTP_USER,
    smtpPassword: env.SMTP_PASSWORD,
    mailFrom: env.MAIL_FROM,
  };
}

export type AuthConfig = ReturnType<typeof readAuthConfig>;
