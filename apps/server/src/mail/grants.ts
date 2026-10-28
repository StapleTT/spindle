import { createHmac, timingSafeEqual } from 'node:crypto';

export type ContentGrant = {
  owner: string;
  session: string;
  message: string;
  version: string;
  kind: 'body' | 'image' | 'attachment';
  images: boolean;
  attachment?: number;
  expires: number;
};

export function signContentGrant(
  grant: Omit<ContentGrant, 'expires'>,
  secret: string,
) {
  const payload = Buffer.from(
    JSON.stringify({ ...grant, expires: Date.now() + 5 * 60000 }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`spindle-content-v1:${payload}`)
    .digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyContentGrant(
  token: string,
  secret: string,
): ContentGrant | null {
  try {
    if (token.length > 2048) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const actual = Buffer.from(signature, 'base64url');
    const expected = createHmac('sha256', secret)
      .update(`spindle-content-v1:${payload}`)
      .digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return null;
    const value = JSON.parse(
      Buffer.from(payload, 'base64url').toString(),
    ) as ContentGrant;
    if (
      !value ||
      typeof value.owner !== 'string' ||
      typeof value.session !== 'string' ||
      typeof value.message !== 'string' ||
      typeof value.version !== 'string' ||
      ![value.owner, value.session, value.message, value.version].every(
        (field) => field.length > 0 && field.length <= 128,
      ) ||
      !['body', 'image', 'attachment'].includes(value.kind) ||
      (value.kind === 'attachment') !==
        (Number.isInteger(value.attachment) &&
          Number(value.attachment) >= 0 &&
          Number(value.attachment) < 100) ||
      typeof value.images !== 'boolean' ||
      typeof value.expires !== 'number' ||
      !Number.isSafeInteger(value.expires) ||
      value.expires <= Date.now() ||
      value.expires > Date.now() + 5 * 60000
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
