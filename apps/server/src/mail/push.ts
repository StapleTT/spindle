// D049: live push for Gmail and Outlook. A notification is only a wake
// signal: it makes the account's ordinary sync run now, which stays the
// authority. Watches and subscriptions are created and renewed by the
// worker at the end of a successful sync; the API only receives callbacks.
import {
  createHash,
  createPublicKey,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
  verify,
} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { logger } from '../logger.js';
import type { GmailApi } from './gmail.js';
import { type GoogleConfig, GoogleError } from './google.js';
import {
  type MicrosoftApi,
  type MicrosoftConfig,
  MicrosoftError,
} from './microsoft.js';
import { type MailAccount, withLease } from './store.js';

const DAY_MS = 86400000;
// Under both Graph limits documented for Outlook messages (4,230 and 10,080 minutes).
const GRAPH_LIFETIME_MS = 4200 * 60000;

// Sync now for these accounts: a running pass reruns after a second because
// sync_request changed. Accounts waiting for reconnect stay asleep.
async function wake(pool: Pool, accounts: string[]) {
  if (!accounts.length) return;
  await pool.query(
    `WITH woke AS (UPDATE mail_accounts SET next_sync_at=LEAST(next_sync_at,clock_timestamp()),sync_request=gen_random_uuid()
      WHERE id=ANY($1::uuid[]) AND status IN ('ready','syncing') RETURNING 1)
    SELECT pg_notify('spindle_mail_work','') FROM woke LIMIT 1`,
    [accounts],
  );
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

type TokenClaims = {
  audience: string;
  serviceAccount: string;
};

// Verifies a Pub/Sub push OIDC token: RS256 signed by a current Google key,
// issued for this webhook to the configured push service account.
export function verifyGoogleToken(
  token: string,
  keyFor: (kid: string) => KeyObject | undefined,
  expected: TokenClaims,
  now = Date.now() / 1000,
) {
  if (token.length > 8192) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [head, body, signature] = parts as [string, string, string];
  const json = (part: string) => {
    try {
      const value = JSON.parse(Buffer.from(part, 'base64url').toString());
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  };
  const header = json(head);
  const claims = json(body);
  if (!header || !claims || header.alg !== 'RS256') return false;
  const key = typeof header.kid === 'string' ? keyFor(header.kid) : undefined;
  if (
    !key ||
    !verify(
      'RSA-SHA256',
      Buffer.from(`${head}.${body}`),
      key,
      Buffer.from(signature, 'base64url'),
    )
  )
    return false;
  return (
    (claims.iss === 'accounts.google.com' ||
      claims.iss === 'https://accounts.google.com') &&
    claims.aud === expected.audience &&
    typeof claims.email === 'string' &&
    claims.email.toLowerCase() === expected.serviceAccount &&
    claims.email_verified === true &&
    typeof claims.exp === 'number' &&
    claims.exp > now - 60 &&
    (typeof claims.iat !== 'number' || claims.iat < now + 60)
  );
}

// Google's signing keys, cached for their max-age. An unknown key ID
// refetches at most once a minute, so forged tokens cannot cause a storm.
function googleKeys(url: string) {
  let keys = new Map<string, KeyObject>();
  let until = 0;
  let fetched = 0;
  return async (kid: string) => {
    const now = Date.now();
    if ((now < until && keys.has(kid)) || now - fetched < 60000) return keys;
    fetched = now;
    try {
      const response = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      const text = await response.text();
      if (!response.ok || text.length > 65536) return keys;
      const list = (JSON.parse(text) as { keys?: unknown }).keys;
      const next = new Map<string, KeyObject>();
      for (const jwk of Array.isArray(list) ? list.slice(0, 20) : []) {
        if (jwk?.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      }
      const age = Number(
        response.headers.get('cache-control')?.match(/max-age=(\d+)/)?.[1],
      );
      keys = next;
      until = now + Math.min(DAY_MS, Math.max(60000, (age || 3600) * 1000));
    } catch {
      // Keep the previous keys; Pub/Sub retries rejected deliveries.
    }
    return keys;
  };
}

export function registerPushRoutes(
  app: FastifyInstance,
  pool: Pool,
  google: GoogleConfig | null,
  microsoft: MicrosoftConfig | null,
) {
  const push = google?.push;
  if (push) {
    const keys = googleKeys(push.certsUrl);
    app.post<{ Body: { message: { data: string } } }>(
      '/api/push/google',
      {
        schema: {
          body: {
            type: 'object',
            required: ['message'],
            properties: {
              message: {
                type: 'object',
                required: ['data'],
                properties: { data: { type: 'string', maxLength: 4096 } },
              },
            },
          },
        },
      },
      async (request, reply) => {
        const token = /^Bearer (\S+)$/.exec(
          request.headers.authorization ?? '',
        )?.[1];
        const kid = (() => {
          try {
            return JSON.parse(
              Buffer.from(token?.split('.')[0] ?? '', 'base64url').toString(),
            ).kid;
          } catch {
            return undefined;
          }
        })();
        const current =
          typeof kid === 'string' && kid.length <= 128
            ? await keys(kid)
            : new Map<string, KeyObject>();
        if (!token || !verifyGoogleToken(token, (id) => current.get(id), push))
          return reply.code(401).send();
        let address: unknown;
        try {
          address = JSON.parse(
            Buffer.from(request.body.message.data, 'base64').toString(),
          ).emailAddress;
        } catch {
          address = undefined;
        }
        // Several Spindle users may connect one Gmail address; each watched
        // account syncs its own mailbox with its own grant.
        if (typeof address === 'string' && address.length <= 320)
          await wake(
            pool,
            (
              await pool.query<{ id: string }>(
                `SELECT a.id FROM mail_accounts a JOIN mail_push p ON p.account_id=a.id AND p.user_id=a.user_id
                WHERE a.provider='gmail' AND p.provider='gmail' AND lower(a.username)=lower($1)`,
                [address],
              )
            ).rows.map((row) => row.id),
          );
        return reply.code(204).send();
      },
    );
  }
  if (microsoft?.pushUrl)
    app.post<{ Querystring: { validationToken?: string } }>(
      '/api/push/microsoft',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              validationToken: { type: 'string', maxLength: 1024 },
            },
          },
        },
      },
      async (request, reply) => {
        // Graph validates the URL when a subscription is created or renewed.
        if (request.query.validationToken !== undefined)
          return reply
            .code(200)
            .type('text/plain; charset=utf-8')
            .send(request.query.validationToken);
        // Checked by hand: the validation request has an empty text body.
        const value = (request.body as { value?: unknown } | null)?.value;
        const items = (Array.isArray(value) ? value.slice(0, 100) : []).filter(
          (
            item,
          ): item is {
            subscriptionId: string;
            clientState: string;
            lifecycleEvent?: string;
          } =>
            typeof item?.subscriptionId === 'string' &&
            item.subscriptionId.length <= 256 &&
            typeof item.clientState === 'string' &&
            item.clientState.length <= 256,
        );
        const rows = (
          await pool.query<{
            account_id: string;
            subscription_id: string;
            client_state_hash: Buffer;
          }>(
            `SELECT account_id,subscription_id,client_state_hash FROM mail_push
            WHERE provider='microsoft' AND subscription_id=ANY($1::text[])`,
            [items.map((item) => item.subscriptionId)],
          )
        ).rows;
        const woken = new Set<string>();
        const renew = new Set<string>();
        for (const item of items) {
          const row = rows.find(
            (candidate) => candidate.subscription_id === item.subscriptionId,
          );
          if (
            !row?.client_state_hash ||
            !timingSafeEqual(sha256(item.clientState), row.client_state_hash)
          )
            continue;
          woken.add(row.account_id);
          if (
            item.lifecycleEvent === 'subscriptionRemoved' ||
            item.lifecycleEvent === 'reauthorizationRequired'
          )
            renew.add(row.account_id);
        }
        if (renew.size)
          await pool.query(
            "UPDATE mail_push SET renew_at=clock_timestamp() WHERE provider='microsoft' AND account_id=ANY($1::uuid[])",
            [[...renew]],
          );
        await wake(pool, [...woken]);
        // Unknown or mismatched notifications are acknowledged and ignored.
        return reply.code(202).send();
      },
    );
}

const due = async (pool: Pool, account: MailAccount) =>
  (
    await pool.query<{ due: boolean; subscription_id: string | null }>(
      'SELECT renew_at<=clock_timestamp() AS due,subscription_id FROM mail_push WHERE account_id=$1',
      [account.id],
    )
  ).rows[0] ?? { due: true, subscription_id: null };

// Push setup never fails a sync: polling still covers the account, and a
// failed renewal is retried in 15 minutes.
async function failed(
  pool: Pool,
  account: MailAccount,
  provider: 'gmail' | 'microsoft',
  error: unknown,
) {
  const code =
    error instanceof GoogleError || error instanceof MicrosoftError
      ? `${error.status}`
      : 'failed';
  logger.warn({ account: account.id, status: code }, 'Push renewal failed');
  try {
    await withLease(pool, account, (db) =>
      db.query(
        `INSERT INTO mail_push(user_id,account_id,provider,renew_at,error_code)
        VALUES($1,$2,$3,clock_timestamp()+interval '15 minutes',$4)
        ON CONFLICT (account_id) DO UPDATE SET renew_at=EXCLUDED.renew_at,error_code=EXCLUDED.error_code`,
        [account.user_id, account.id, provider, code],
      ),
    );
  } catch {
    // Lost lease: the next sync retries.
  }
}

// Gmail watch: all label changes, renewed daily (Google's recommendation;
// a watch lasts seven days).
export async function renewGmailWatch(
  pool: Pool,
  google: GoogleConfig | null,
  account: MailAccount,
  api: GmailApi,
) {
  if (!google?.push || !(await due(pool, account)).due) return;
  try {
    const watch = await api<{ expiration?: unknown }>(
      '/watch',
      {},
      { json: { topicName: google.push.topic } },
    );
    const expires = Number(watch.expiration);
    if (!Number.isSafeInteger(expires) || expires <= Date.now())
      throw new GoogleError(502, 'invalid_response');
    await withLease(pool, account, (db) =>
      db.query(
        `INSERT INTO mail_push(user_id,account_id,provider,expires_at,renew_at)
        VALUES($1,$2,'gmail',to_timestamp($3::double precision/1000),clock_timestamp()+interval '1 day')
        ON CONFLICT (account_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,renew_at=EXCLUDED.renew_at,error_code=NULL`,
        [account.user_id, account.id, expires],
      ),
    );
  } catch (error) {
    await failed(pool, account, 'gmail', error);
  }
}

// Graph subscription on /me/messages, renewed daily. A missing subscription
// (404 on renewal) is recreated with a new client state.
export async function renewGraphSubscription(
  pool: Pool,
  microsoft: MicrosoftConfig | null,
  account: MailAccount,
  api: MicrosoftApi,
) {
  if (!microsoft?.pushUrl) return;
  const current = await due(pool, account);
  if (!current.due) return;
  const collection = new URL('subscriptions', microsoft.graphUrl).href;
  const expirationDateTime = new Date(
    Date.now() + GRAPH_LIFETIME_MS,
  ).toISOString();
  try {
    let id = current.subscription_id;
    let clientState: string | null = null;
    if (id)
      try {
        await api(
          `${collection}/${encodeURIComponent(id)}`,
          {},
          { method: 'PATCH', json: { expirationDateTime } },
        );
      } catch (error) {
        if (!(error instanceof MicrosoftError && error.status === 404))
          throw error;
        id = null;
      }
    if (!id) {
      clientState = randomBytes(48).toString('base64url');
      const created = await api<{ id?: unknown }>(
        collection,
        {},
        {
          json: {
            changeType: 'created,updated,deleted',
            notificationUrl: microsoft.pushUrl,
            lifecycleNotificationUrl: microsoft.pushUrl,
            resource: 'me/messages',
            expirationDateTime,
            clientState,
          },
        },
      );
      if (
        typeof created.id !== 'string' ||
        !/^[\x21-\x7e]{1,256}$/.test(created.id)
      )
        throw new MicrosoftError(502, 'invalid_response');
      id = created.id;
    }
    await withLease(pool, account, (db) =>
      db.query(
        `INSERT INTO mail_push(user_id,account_id,provider,subscription_id,client_state_hash,expires_at,renew_at)
        VALUES($1,$2,'microsoft',$3,$4,$5,clock_timestamp()+interval '1 day')
        ON CONFLICT (account_id) DO UPDATE SET subscription_id=EXCLUDED.subscription_id,
          client_state_hash=COALESCE(EXCLUDED.client_state_hash,mail_push.client_state_hash),
          expires_at=EXCLUDED.expires_at,renew_at=EXCLUDED.renew_at,error_code=NULL`,
        [
          account.user_id,
          account.id,
          id,
          clientState ? sha256(clientState) : null,
          expirationDateTime,
        ],
      ),
    );
  } catch (error) {
    await failed(pool, account, 'microsoft', error);
  }
}
