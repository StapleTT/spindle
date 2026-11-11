import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { AuthConfig } from '../auth/config.js';
import { encryptCredential, type MailKeys } from './credentials.js';
import {
  GMAIL_SCOPE,
  GOOGLE_SCOPES,
  type GoogleConfig,
  googleJson,
  revokeIfUnused,
} from './google.js';
import { transaction } from './store.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest();

// D038: the API performs only the code exchange, userinfo and revocation; the
// worker owns all mailbox I/O.
export function registerGmailOAuthRoutes(
  app: FastifyInstance,
  pool: Pool,
  config: AuthConfig,
  keys: MailKeys,
  google: GoogleConfig | null,
) {
  const redirectUri = `${config.appUrl}/api/mail/oauth/google/callback`;

  app.post<{ Body: { history: '90d' | 'all'; accountId?: string } }>(
    '/api/mail/oauth/google',
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
      if (!google || !keys.keys.has(keys.active))
        return reply.code(503).send({
          message: 'Gmail connections need to be configured by the operator.',
        });
      const owner = request.mailUser ?? '';
      const { history, accountId } = request.body;
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const result = await transaction(pool, async (db) => {
        // Same owner-first lock as IMAP connect and account ordering.
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        await db.query(
          'DELETE FROM mail_oauth_states WHERE expires_at<clock_timestamp()',
        );
        let hint: string | undefined;
        if (accountId) {
          const target = (
            await db.query(
              "SELECT username FROM mail_accounts WHERE user_id=$1 AND id=$2 AND provider='gmail'",
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
          `INSERT INTO mail_oauth_states(state_hash,user_id,session_id,account_id,history,code_verifier,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '10 minutes')`,
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
      if (result === 'missing')
        return reply.code(404).send({ message: 'Mail account not found.' });
      if (result === 'limit')
        return reply
          .code(409)
          .send({ message: 'You can connect up to five mail accounts.' });
      const url = new URL(google.authUrl);
      url.search = new URLSearchParams({
        client_id: google.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: GOOGLE_SCOPES,
        state,
        code_challenge: sha256(verifier).toString('base64url'),
        code_challenge_method: 'S256',
        access_type: 'offline',
        prompt: 'consent',
        ...(result.hint ? { login_hint: result.hint } : {}),
      }).toString();
      return { url: url.href };
    },
  );

  app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
    '/api/mail/oauth/google/callback',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            state: { type: 'string', maxLength: 128 },
            code: { type: 'string', maxLength: 2048 },
            error: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      // Generic result codes only: no provider text, codes or tokens in URLs.
      const done = (result: string) =>
        reply.redirect(
          `${config.appUrl}/inbox#view=settings&gmail=${result}`,
          303,
        );
      const owner = request.mailUser ?? '';
      const { state, code, error } = request.query;
      if (!state) return done('expired');
      // Single use, bound to this user and sign-in session, and expiring.
      const saved = (
        await pool.query(
          `DELETE FROM mail_oauth_states WHERE provider='gmail' AND state_hash=$1 AND user_id=$2 AND session_id=$3
           AND expires_at>clock_timestamp() RETURNING account_id,history,code_verifier`,
          [sha256(state).toString('hex'), owner, request.mailSession],
        )
      ).rows[0] as
        | { account_id: string | null; history: string; code_verifier: string }
        | undefined;
      if (!saved) return done('expired');
      if (error || !code) return done('denied');
      if (!google || !keys.keys.has(keys.active)) return done('failed');
      let token: { refresh_token?: string; access_token: string };
      let identity: { sub: string; email: string };
      let scopes: string[];
      try {
        const granted = await googleJson<{
          access_token?: unknown;
          refresh_token?: unknown;
          scope?: unknown;
        }>(google.tokenUrl, {
          form: {
            grant_type: 'authorization_code',
            code,
            code_verifier: saved.code_verifier,
            client_id: google.clientId,
            client_secret: google.clientSecret,
            redirect_uri: redirectUri,
          },
        });
        if (typeof granted.access_token !== 'string' || !granted.access_token)
          return done('failed');
        token = {
          access_token: granted.access_token,
          ...(typeof granted.refresh_token === 'string' &&
          granted.refresh_token &&
          granted.refresh_token.length <= 2048
            ? { refresh_token: granted.refresh_token }
            : {}),
        };
        scopes =
          typeof granted.scope === 'string' ? granted.scope.split(' ') : [];
        const info = await googleJson<{
          sub?: unknown;
          email?: unknown;
          email_verified?: unknown;
        }>(google.userinfoUrl, { token: token.access_token });
        if (
          typeof info.sub !== 'string' ||
          !/^[\x21-\x7e]{1,255}$/.test(info.sub) ||
          typeof info.email !== 'string' ||
          info.email.length > 320 ||
          !/^[^\s@\0]+@[^\s@\0]+$/.test(info.email) ||
          info.email_verified !== true
        )
          // Without a trustworthy identity, sharing cannot be checked, so the
          // grant is left alone rather than revoked.
          return done('failed');
        identity = { sub: info.sub, email: info.email };
      } catch {
        request.log.warn('Gmail authorization exchange failed');
        return done('failed');
      }
      // A refused grant is revoked unless another connection shares it.
      const revoke = () =>
        revokeIfUnused(
          pool,
          google,
          identity.sub,
          token.refresh_token ?? token.access_token,
        );
      // Granular consent can leave Gmail access unchecked.
      if (!scopes.includes(GMAIL_SCOPE)) {
        await revoke();
        return done('scope');
      }
      const result = await transaction(pool, async (db) => {
        await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [owner]);
        const existing = (
          await db.query(
            "SELECT id FROM mail_accounts WHERE user_id=$1 AND provider='gmail' AND provider_account=$2 FOR UPDATE",
            [owner, identity.sub],
          )
        ).rows[0] as { id: string } | undefined;
        // A reconnect must return the same Google account (no substitution).
        if (saved.account_id && existing?.id !== saved.account_id)
          return 'mismatch';
        if (existing) {
          // Google may omit a refresh token on re-consent; keep the stored one.
          await db.query(
            `UPDATE mail_accounts SET username=$3,credential=COALESCE($4,credential),status='pending',
             error_code=NULL,failures=0,next_sync_at=clock_timestamp(),sync_request=gen_random_uuid(),
             lease_token=NULL,lease_until=NULL WHERE user_id=$1 AND id=$2`,
            [
              owner,
              existing.id,
              identity.email,
              token.refresh_token
                ? encryptCredential(
                    token.refresh_token,
                    owner,
                    existing.id,
                    keys,
                  )
                : null,
            ],
          );
          return 'connected';
        }
        if (!token.refresh_token) return 'failed';
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
          `INSERT INTO mail_accounts(id,user_id,provider,provider_account,name,username,credential,history_since)
           VALUES($1,$2,'gmail',$3,$4,$4,$5,$6)`,
          [
            id,
            owner,
            identity.sub,
            identity.email,
            encryptCredential(token.refresh_token, owner, id, keys),
            saved.history === '90d'
              ? new Date(Date.now() - 90 * 86400000)
              : null,
          ],
        );
        return 'connected';
      });
      if (result !== 'connected') await revoke();
      return done(result);
    },
  );
}
