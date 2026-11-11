import type { Pool } from 'pg';
import {
  decryptCredential,
  encryptCredential,
  type MailKeys,
} from './credentials.js';
import { type MailAccount, withLease } from './store.js';

export const MICROSOFT_SCOPES =
  'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';

export function readMicrosoftConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.MICROSOFT_CLIENT_ID;
  const clientSecret = env.MICROSOFT_CLIENT_SECRET;
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret)
    throw new Error(
      'MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set together',
    );
  return {
    clientId,
    clientSecret,
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userinfoUrl: 'https://graph.microsoft.com/oidc/userinfo',
    graphUrl: 'https://graph.microsoft.com/v1.0/me',
  };
}

export type MicrosoftConfig = NonNullable<
  ReturnType<typeof readMicrosoftConfig>
>;

export class MicrosoftError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryAfter: number | null = null,
  ) {
    super('Microsoft request failed');
  }
}

export class MicrosoftPause extends Error {
  constructor(readonly delaySeconds: number) {
    super('Microsoft sync paused');
  }
}

export type MicrosoftRequest = Omit<RequestInit, 'body'> & {
  token?: string;
  form?: Record<string, string>;
  json?: unknown;
  upload?: { type: string; data: Buffer };
  raw?: boolean;
  maxBytes?: number;
  timeout?: number;
};

const enumLike = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value)
    ? value
    : '';

// Read under the byte limit, including non-JSON error pages and raw MIME.
export async function microsoftJson<T>(
  url: string,
  init: MicrosoftRequest = {},
): Promise<T> {
  const {
    token,
    form,
    json,
    upload,
    raw,
    maxBytes = 4 * 1024 * 1024,
    timeout = 10000,
    ...rest
  } = init;
  const headers = new Headers(rest.headers);
  headers.set('accept', raw ? 'message/rfc822' : 'application/json');
  headers.set(
    'prefer',
    [
      ...(headers.get('prefer') ?? '')
        .split(',')
        .map((preference) => preference.trim())
        .filter((preference) => preference && !/^idtype\s*=/i.test(preference)),
      'IdType="ImmutableId"',
    ].join(', '),
  );
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (form) headers.set('content-type', 'application/x-www-form-urlencoded');
  if (json !== undefined) headers.set('content-type', 'application/json');
  if (upload) headers.set('content-type', upload.type);
  const timed = AbortSignal.timeout(Math.max(1, Math.floor(timeout)));
  const response = await fetch(url, {
    ...rest,
    redirect: 'error',
    signal: rest.signal ? AbortSignal.any([rest.signal, timed]) : timed,
    headers,
    ...(form ? { method: 'POST', body: new URLSearchParams(form) } : {}),
    ...(json !== undefined
      ? { method: 'POST', body: JSON.stringify(json) }
      : {}),
    ...(upload ? { method: 'POST', body: new Uint8Array(upload.data) } : {}),
    ...(rest.method ? { method: rest.method } : {}),
  });
  const reader = response.body?.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (reader)
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new MicrosoftError(502, 'too_large');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  const source = Buffer.concat(chunks, bytes);
  let body: unknown;
  if (!raw || !response.ok)
    try {
      body = JSON.parse(source.toString('utf8'));
    } catch {
      // Report non-JSON failures by status, without provider message text.
    }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    const retryHeader = response.headers.get('retry-after');
    const retry = retryHeader
      ? /^\d+$/.test(retryHeader)
        ? Number(retryHeader)
        : (Date.parse(retryHeader) - Date.now()) / 1000
      : Number.NaN;
    throw new MicrosoftError(
      response.status,
      enumLike(
        error && typeof error === 'object'
          ? (error as { code?: unknown }).code
          : error,
      ),
      Number.isFinite(retry) ? Math.max(0, Math.ceil(retry)) : null,
    );
  }
  if (raw) return source as T;
  if (response.status === 202 || response.status === 204) return null as T;
  if (!body || typeof body !== 'object')
    throw new MicrosoftError(502, 'invalid_response');
  return body as T;
}

export function hasMicrosoftScopes(value: unknown) {
  if (typeof value !== 'string') return false;
  const scopes = new Set(
    value
      .split(/\s+/)
      .map((scope) =>
        scope.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase(),
      ),
  );
  return ['user.read', 'mail.readwrite', 'mail.send'].every((scope) =>
    scopes.has(scope),
  );
}

export type MicrosoftApi = <T>(
  path: string,
  query?: Record<string, string> | URLSearchParams,
  request?: MicrosoftRequest & { once?: boolean },
) => Promise<T>;

export async function openMicrosoft(
  pool: Pool,
  microsoft: MicrosoftConfig | null,
  keys: MailKeys,
  account: MailAccount,
  hardDeadline: number,
): Promise<MicrosoftApi> {
  if (!microsoft) throw new Error('Microsoft is not configured');
  const remaining = () => {
    const ms = hardDeadline - Date.now();
    if (ms <= 0) throw new MicrosoftPause(1);
    return ms;
  };
  const granted = await microsoftJson<{
    access_token?: unknown;
    refresh_token?: unknown;
    scope?: unknown;
  }>(microsoft.tokenUrl, {
    form: {
      grant_type: 'refresh_token',
      refresh_token: decryptCredential(
        account.credential,
        account.user_id,
        account.id,
        keys,
      ),
      client_id: microsoft.clientId,
      client_secret: microsoft.clientSecret,
      scope: MICROSOFT_SCOPES,
    },
    timeout: Math.min(10000, remaining()),
  });
  if (
    typeof granted.access_token !== 'string' ||
    !granted.access_token ||
    granted.access_token.length > 32768 ||
    !/^[\x21-\x7e]+$/.test(granted.access_token)
  )
    throw new MicrosoftError(502, 'invalid_response');
  if (granted.scope !== undefined && !hasMicrosoftScopes(granted.scope))
    throw new MicrosoftError(403, 'insufficient_scope');
  if (granted.refresh_token !== undefined) {
    if (
      typeof granted.refresh_token !== 'string' ||
      !granted.refresh_token ||
      granted.refresh_token.length > 16384 ||
      !/^[\x21-\x7e]+$/.test(granted.refresh_token)
    )
      throw new MicrosoftError(502, 'invalid_response');
    const credential = encryptCredential(
      granted.refresh_token,
      account.user_id,
      account.id,
      keys,
    );
    await withLease(pool, account, (db) =>
      db.query(
        'UPDATE mail_accounts SET credential=$3 WHERE user_id=$1 AND id=$2',
        [account.user_id, account.id, credential],
      ),
    );
    account.credential = credential;
  }
  const token = granted.access_token;
  const base = new URL(microsoft.graphUrl);
  let slot = 0;
  return async (path, query = {}, request = {}) => {
    const { once, ...init } = request;
    const url = new URL(
      /^https?:\/\//.test(path)
        ? path
        : `${base.href}${!path || path.startsWith('/') ? path : `/${path}`}`,
    );
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      url.hash ||
      !(
        url.pathname === base.pathname ||
        url.pathname.startsWith(`${base.pathname}/`)
      )
    )
      throw new MicrosoftError(502, 'invalid_link');
    for (const [name, value] of new URLSearchParams(query))
      url.searchParams.set(name, value);
    const method = (
      init.method ?? (init.json !== undefined || init.upload ? 'POST' : 'GET')
    ).toUpperCase();
    const retryable = !once && (method === 'GET' || method === 'PATCH');
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(0, slot - Date.now());
      if (Date.now() + wait >= hardDeadline)
        throw new MicrosoftPause(Math.max(1, Math.ceil(wait / 1000)));
      slot = Math.max(slot, Date.now()) + 100;
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      try {
        return await microsoftJson(url.href, {
          ...init,
          token,
          timeout: Math.min(init.timeout ?? 10000, remaining()),
        });
      } catch (error) {
        if (retryable && Date.now() >= hardDeadline)
          throw new MicrosoftPause(1);
        if (
          !retryable ||
          !(error instanceof MicrosoftError) ||
          ['too_large', 'invalid_response', 'invalid_link'].includes(
            error.code,
          ) ||
          !(error.status === 429 || error.status >= 500)
        )
          throw error;
        const delay = (error.retryAfter ?? 2 ** attempt) * 1000;
        if (attempt >= 3 || delay >= remaining())
          throw new MicrosoftPause(
            Math.max(error.retryAfter ?? 0, error.status === 429 ? 60 : 30),
          );
        slot = Math.max(slot, Date.now() + delay);
      }
    }
  };
}
