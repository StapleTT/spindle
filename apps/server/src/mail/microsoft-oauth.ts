import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AuthConfig } from '../auth/config.js';
import { encryptCredential, type MailKeys } from './credentials.js';
import {
  hasMicrosoftScopes,
  MICROSOFT_SCOPES,
  type MicrosoftConfig,
  microsoftJson,
} from './microsoft.js';
import { transaction } from './store.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();
const tokenString = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x21-\x7e]+$/.test(value);
const mailAddress = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 320 &&
  /^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+$/u.test(value);

export function registerMicrosoftOAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AuthConfig,
  keys: MailKeys,
  microsoft: MicrosoftConfig | null,
) {
  const redirectUri = `${config.appUrl}/api/mail/oauth/microsoft/callback`;
  app.post<{ Body: { history: '90d' | 'all'; accountId?: string } }>(
    '/api/mail/oauth/microsoft',
    {
      bodyLimit: 1024,
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['history'],
          properties: {
            history: { type: 'string', enum: ['90d', 'all'] },
            accountId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!microsoft || !keys.keys.has(keys.active))
        return reply.code(503).send({
          message:
            'Microsoft connections need to be configured by the operator.',
        });
      const owner = request.mailUser ?? '';
      const { history, accountId } = request.body;
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const result = await transaction(pool, async (db) => {
        const user = await db.query(
          'SELECT id FROM users WHERE id=$1 AND email_verified AND NOT suspended FOR UPDATE',
          [owner],
        );
        if (!user.rowCount) return 'unavailable';
        await db.query(
          'DELETE FROM mail_oauth_states WHERE expires_at<clock_timestamp()',
        );
        let hint: string | undefined;
        if (accountId) {
          const target = (
            await db.query(
              "SELECT username FROM mail_accounts WHERE user_id=$1 AND id=$2 AND provider='microsoft'",
              [owner, accountId],
            )
          ).rows[0];
          if (!target) return 'missing';
          hint = target.username;
        } else if (
          (
            await db.query(
              'SELECT count(*)::int AS count FROM mail_accounts WHERE user_id=$1',
              [owner],
            )
          ).rows[0].count >= 5
        )
          return 'limit';
        await db.query(
          `INSERT INTO mail_oauth_states(state_hash,user_id,session_id,account_id,history,code_verifier,expires_at,provider)
           VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes','microsoft')`,
          [
            sha256(state).toString('hex'),
            owner,
            request.mailSession,
            accountId ?? null,
            history,
            verifier,
          ],
        );
        return { hint };
      });
      if (result === 'unavailable')
        return reply.code(403).send({ message: 'Account is unavailable.' });
      if (result === 'missing')
        return reply.code(404).send({ message: 'Mail account not found.' });
      if (result === 'limit')
        return reply
          .code(409)
          .send({ message: 'You can connect up to five mail accounts.' });
      const url = new URL(microsoft.authUrl);
      url.search = new URLSearchParams({
        client_id: microsoft.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        response_mode: 'query',
        scope: MICROSOFT_SCOPES,
        state,
        code_challenge: sha256(verifier).toString('base64url'),
        code_challenge_method: 'S256',
        prompt: 'select_account',
        ...(result.hint ? { login_hint: result.hint } : {}),
      }).toString();
      return { url: url.href };
    },
  );

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/api/mail/oauth/microsoft/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            state: { type: 'string', maxLength: 128 },
            code: { type: 'string', maxLength: 8192 },
            error: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const done = (result: string) =>
        reply.redirect(
          `${config.appUrl}/inbox#view=settings&microsoft=${result}`,
          303,
        );
      const owner = request.mailUser ?? '';
      const { state, code, error } = request.query;
      if (!state) return done('expired');
      const saved = (
        await pool.query(
          `DELETE FROM mail_oauth_states WHERE state_hash=$1 AND user_id=$2 AND session_id=$3
           AND provider='microsoft' AND expires_at>clock_timestamp() RETURNING account_id,history,code_verifier`,
          [sha256(state).toString('hex'), owner, request.mailSession],
        )
      ).rows[0] as
        | { account_id: string | null; history: string; code_verifier: string }
        | undefined;
      if (!saved) return done('expired');
      if (error || !code) return done('denied');
      if (!microsoft || !keys.keys.has(keys.active)) return done('failed');
      let identity: { sub: string; email: string; name: string | null };
      let refresh: string | undefined;
      try {
        const granted = await microsoftJson<{
          access_token?: unknown;
          refresh_token?: unknown;
          scope?: unknown;
        }>(microsoft.tokenUrl, {
          form: {
            grant_type: 'authorization_code',
            code,
            code_verifier: saved.code_verifier,
            client_id: microsoft.clientId,
            client_secret: microsoft.clientSecret,
            redirect_uri: redirectUri,
            scope: MICROSOFT_SCOPES,
          },
        });
        if (!tokenString(granted.access_token, 32768)) return done('failed');
        if (!hasMicrosoftScopes(granted.scope)) return done('scope');
        if (granted.refresh_token !== undefined) {
          if (!tokenString(granted.refresh_token, 16384)) return done('failed');
          refresh = granted.refresh_token;
        }
        const info = await microsoftJson<{ sub?: unknown }>(
          microsoft.userinfoUrl,
          { token: granted.access_token },
        );
        if (
          typeof info.sub !== 'string' ||
          !/^[\x21-\x7e]{1,255}$/.test(info.sub)
        )
          return done('failed');
        const url = new URL(microsoft.graphUrl);
        url.searchParams.set(
          '$select',
          'id,mail,userPrincipalName,displayName',
        );
        const profile = await microsoftJson<{
          id?: unknown;
          mail?: unknown;
          userPrincipalName?: unknown;
          displayName?: unknown;
        }>(url.href, { token: granted.access_token });
        const email = mailAddress(profile.mail)
          ? profile.mail
          : profile.userPrincipalName;
        if (
          !tokenString(profile.id, 255) ||
          !mailAddress(email) ||
          (profile.displayName !== undefined &&
            profile.displayName !== null &&
            (typeof profile.displayName !== 'string' ||
              profile.displayName.length > 1000 ||
              /\p{Cc}/u.test(profile.displayName)))
        )
          return done('failed');
        const name =
          typeof profile.displayName === 'string'
            ? profile.displayName.trim().replace(/\s+/g, ' ').slice(0, 100)
            : '';
        identity = { sub: info.sub, email, name: name || null };
      } catch {
        request.log.warn('Microsoft authorization exchange failed');
        return done('failed');
      }
      // Microsoft has no per-refresh-token revocation endpoint. Never revoke
      // the user's unrelated Microsoft sessions or grants on a refused connect.
      const result = await transaction(pool, async (db) => {
        const user = await db.query(
          'SELECT id FROM users WHERE id=$1 AND email_verified AND NOT suspended FOR UPDATE',
          [owner],
        );
        if (!user.rowCount) return 'failed';
        const session = await db.query(
          'SELECT id FROM auth_sessions WHERE id=$1 AND user_id=$2 AND expires_at>clock_timestamp() FOR SHARE',
          [request.mailSession, owner],
        );
        if (!session.rowCount) return 'expired';
        const existing = (
          await db.query(
            "SELECT id FROM mail_accounts WHERE user_id=$1 AND provider='microsoft' AND provider_account=$2 FOR UPDATE",
            [owner, identity.sub],
          )
        ).rows[0] as { id: string } | undefined;
        if (saved.account_id && existing?.id !== saved.account_id)
          return 'mismatch';
        if (existing) {
          await db.query(
            `UPDATE mail_accounts SET username=$3,provider_name=$4,credential=COALESCE($5,credential),status='pending',
             error_code=NULL,failures=0,next_sync_at=clock_timestamp(),sync_request=gen_random_uuid(),
             lease_token=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2`,
            [
              owner,
              existing.id,
              identity.email,
              identity.name,
              refresh
                ? encryptCredential(refresh, owner, existing.id, keys)
                : null,
            ],
          );
          return 'connected';
        }
        if (!refresh) return 'failed';
        if (
          (
            await db.query(
              'SELECT count(*)::int AS count FROM mail_accounts WHERE user_id=$1',
              [owner],
            )
          ).rows[0].count >= 5
        )
          return 'limit';
        const id = randomUUID();
        await db.query(
          `INSERT INTO mail_accounts(id,user_id,provider,provider_account,name,username,provider_name,credential,history_since)
           VALUES($1,$2,'microsoft',$3,$4,$4,$5,$6,$7)`,
          [
            id,
            owner,
            identity.sub,
            identity.email,
            identity.name,
            encryptCredential(refresh, owner, id, keys),
            saved.history === '90d'
              ? new Date(Date.now() - 90 * 86400000)
              : null,
          ],
        );
        return 'connected';
      });
      return done(result);
    },
  );
}
