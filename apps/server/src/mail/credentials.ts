import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function readMailKeys(env: NodeJS.ProcessEnv = process.env) {
  const keys = new Map<string, Buffer>();
  const active = env.MAIL_ENCRYPTION_KEY_ID ?? 'v1';
  if (env.MAIL_ENCRYPTION_KEYS) {
    let values: unknown;
    try {
      values = JSON.parse(env.MAIL_ENCRYPTION_KEYS);
    } catch {
      throw new Error('MAIL_ENCRYPTION_KEYS must be a JSON key ring');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new Error('MAIL_ENCRYPTION_KEYS must be a JSON key ring');
    for (const [id, value] of Object.entries(values)) {
      if (!/^[a-zA-Z0-9_-]{1,40}$/.test(id) || typeof value !== 'string')
        throw new Error('Invalid mail encryption key');
      const key = Buffer.from(value, 'base64');
      if (key.length !== 32 || key.toString('base64') !== value)
        throw new Error('Mail encryption keys must be 32 bytes in base64');
      keys.set(id, key);
    }
    if (!keys.has(active))
      throw new Error('Active mail encryption key is missing');
  }
  return { active, keys };
}

export type MailKeys = ReturnType<typeof readMailKeys>;

export function encryptCredential(
  password: string,
  owner: string,
  account: string,
  ring: MailKeys,
) {
  const key = ring.keys.get(ring.active);
  if (!key) throw new Error('Mail encryption is not configured');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${owner}:${account}`));
  const encrypted = Buffer.concat([
    cipher.update(password, 'utf8'),
    cipher.final(),
  ]);
  return [
    ring.active,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    encrypted.toString('base64'),
  ].join('.');
}

export function decryptCredential(
  value: string,
  owner: string,
  account: string,
  ring: MailKeys,
) {
  const [id, iv, tag, data, extra] = value.split('.');
  const key = id ? ring.keys.get(id) : undefined;
  if (!key || !iv || !tag || !data || extra !== undefined)
    throw new Error('Mail credential unavailable');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(`${owner}:${account}`));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
