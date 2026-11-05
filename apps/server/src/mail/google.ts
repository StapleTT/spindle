import type { Pool } from 'pg';
import { decryptCredential, type MailKeys } from './credentials.js';

// D038: one restricted scope covers read, labels, drafts and send for later slices.
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
export const GOOGLE_SCOPES = `openid email ${GMAIL_SCOPE}`;

export function readGoogleConfig(env: NodeJS.ProcessEnv = process.env) {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret)
    throw new Error(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together',
    );
  // Fixed Google endpoints; tests replace them with a local fake.
  return {
    clientId,
    clientSecret,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revokeUrl: 'https://oauth2.googleapis.com/revoke',
    userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    gmailUrl: 'https://gmail.googleapis.com/gmail/v1/users/me',
  };
}

export type GoogleConfig = NonNullable<ReturnType<typeof readGoogleConfig>>;

// Status and OAuth error code only; provider text never reaches logs or clients.
export class GoogleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super('Google request failed');
  }
}

export async function googleJson<T>(
  url: string,
  init: RequestInit & { token?: string; form?: Record<string, string> } = {},
  timeout = 10000,
): Promise<T> {
  const { token, form, ...rest } = init;
  const response = await fetch(url, {
    ...rest,
    redirect: 'error',
    signal: AbortSignal.timeout(timeout),
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    ...(form ? { method: 'POST', body: new URLSearchParams(form) } : {}),
  });
  const text = await response.text();
  if (text.length > 4 * 1024 * 1024) throw new GoogleError(502, 'too_large');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON error pages are reported by status only.
  }
  if (!response.ok) {
    const error = (body as { error?: unknown } | null)?.error;
    throw new GoogleError(
      response.status,
      typeof error === 'string' ? error.slice(0, 64) : '',
    );
  }
  if (!body || typeof body !== 'object')
    throw new GoogleError(502, 'invalid_response');
  return body as T;
}

export function refreshAccessToken(google: GoogleConfig, refresh: string) {
  return googleJson<{ access_token?: unknown }>(google.tokenUrl, {
    form: {
      grant_type: 'refresh_token',
      refresh_token: refresh,
      client_id: google.clientId,
      client_secret: google.clientSecret,
    },
  }).then(({ access_token }) => {
    if (typeof access_token !== 'string' || !access_token)
      throw new GoogleError(502, 'invalid_response');
    return access_token;
  });
}

// Google grants are per Google account and client, so revoking one would also
// end another Spindle connection to the same Google account. Revoke only once
// no connection uses it; failure never blocks disconnect or deletion.
export async function revokeIfUnused(
  pool: Pool,
  google: GoogleConfig,
  subject: string,
  token: string,
) {
  if (
    (
      await pool.query(
        "SELECT 1 FROM mail_accounts WHERE provider='gmail' AND provider_account=$1 LIMIT 1",
        [subject],
      )
    ).rowCount
  )
    return;
  await fetch(google.revokeUrl, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }),
  }).catch(() => undefined);
}

export type GmailGrant = {
  user_id: string;
  id: string;
  credential: string;
  provider_account: string;
};

// Call after the rows are deleted and committed.
export async function revokeUnusedGrants(
  pool: Pool,
  google: GoogleConfig | null,
  keys: MailKeys,
  grants: GmailGrant[],
) {
  if (!google) return;
  for (const grant of grants) {
    try {
      await revokeIfUnused(
        pool,
        google,
        grant.provider_account,
        decryptCredential(grant.credential, grant.user_id, grant.id, keys),
      );
    } catch {
      // Best effort: the local token is already gone.
    }
  }
}
