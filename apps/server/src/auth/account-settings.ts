import { randomBytes } from 'node:crypto';
import type { GenericEndpointContext } from '@better-auth/core';
import {
  getCurrentAdapter,
  runWithTransaction,
} from '@better-auth/core/context';
import type { BetterAuthPlugin, Session, User } from 'better-auth';
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sensitiveSessionMiddleware,
} from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import type { Transporter } from 'nodemailer';
import type { Pool } from 'pg';
import { z } from 'zod';
import { consumeLimit } from '../mail/store.js';
import type { AuthConfig } from './config.js';
import { emailChangeEmail, sendAuthEmail } from './email.js';

const password = z.string().min(1).max(128);
const confirmed = z.object({ currentPassword: password });
const tokenBody = z
  .object({ token: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
const invalidLink = () =>
  new APIError('BAD_REQUEST', {
    message:
      'This email-change link is invalid, expired or replaced. Request a new one in Settings.',
  });
type PendingEmail = {
  id: string;
  userId: string;
  verificationId: string;
  oldEmail: string;
  newEmail: string;
  expiresAt: Date;
};
type Adapter = Awaited<ReturnType<typeof getCurrentAdapter>>;

// Serialize account changes through the existing transactional auth adapter.
async function lockOwner(ctx: GenericEndpointContext, userId: string) {
  const adapter = await getCurrentAdapter(ctx.context.adapter);
  const user = await adapter.update<User>({
    model: 'user',
    where: [
      { field: 'id', value: userId },
      { field: 'emailVerified', value: true },
      { field: 'suspended', value: false },
    ],
    update: { updatedAt: new Date() },
  });
  if (!user)
    throw new APIError('UNAUTHORIZED', { message: 'Sign in to continue.' });
  return { adapter, user };
}

async function withConfirmedSession<T>(
  ctx: GenericEndpointContext,
  currentPassword: string | undefined,
  operation: (adapter: Adapter, user: User) => Promise<T>,
) {
  const session = ctx.context.session;
  if (!session?.user.emailVerified || session.user.suspended)
    throw new APIError('UNAUTHORIZED');
  const credential =
    currentPassword === undefined
      ? null
      : await ctx.context.internalAdapter.findCredentialAccount(
          session.user.id,
        );
  const confirmedHash = credential?.password;
  if (
    currentPassword !== undefined &&
    (!confirmedHash ||
      !(await ctx.context.password.verify({
        hash: confirmedHash,
        password: currentPassword,
      })))
  )
    throw new APIError('BAD_REQUEST', {
      message: 'Your current password is incorrect.',
    });
  return runWithTransaction(ctx.context.adapter, async () => {
    const { adapter, user } = await lockOwner(ctx, session.user.id);
    // A no-op conditional update locks the confirmed credential without revoking it.
    if (
      credential &&
      confirmedHash &&
      !(await adapter.update({
        model: 'account',
        where: [
          { field: 'id', value: credential.id },
          { field: 'userId', value: user.id },
          { field: 'password', value: confirmedHash },
        ],
        update: { password: confirmedHash },
      }))
    )
      throw new APIError('UNAUTHORIZED', {
        message: 'Your account changed. Sign in again.',
      });
    const active = await adapter.findOne<Session>({
      model: 'session',
      where: [
        { field: 'id', value: session.session.id },
        { field: 'userId', value: user.id },
        { field: 'expiresAt', value: new Date(), operator: 'gt' },
      ],
    });
    const latestCredential = credential
      ? await ctx.context.internalAdapter.findCredentialAccount(user.id)
      : null;
    if (
      !active ||
      user.email !== session.user.email ||
      (credential && latestCredential?.password !== credential.password)
    )
      throw new APIError('UNAUTHORIZED', {
        message: 'Your account changed. Sign in again.',
      });
    return operation(adapter, user);
  });
}

async function clearEmailChange(adapter: Adapter, userId: string) {
  const pending = await adapter.findOne<PendingEmail>({
    model: 'emailChange',
    where: [{ field: 'userId', value: userId }],
  });
  if (pending)
    await adapter.delete({
      model: 'verification',
      where: [{ field: 'id', value: pending.verificationId }],
    });
}

export function accountSettings(
  pool: Pool,
  config: AuthConfig,
  mailer: Transporter,
) {
  const accountAccess = createAuthMiddleware(async (ctx) => {
    const session = ctx.context.session;
    if (!session?.user.emailVerified || session.user.suspended)
      throw new APIError('FORBIDDEN', {
        message: 'Verify your email to continue.',
      });
    if (
      !(await consumeLimit(
        pool,
        session.user.id,
        ctx.method === 'GET'
          ? 'account-settings-read'
          : 'account-settings-write',
        ctx.method === 'GET' ? 60 : 10,
      ))
    )
      throw new APIError('TOO_MANY_REQUESTS', {
        message: 'Too many account requests. Try again in a minute.',
      });
  });
  const sensitive = createAuthMiddleware(async (ctx) => {
    const userId = ctx.context.session?.user.id;
    if (
      !userId ||
      !(await consumeLimit(pool, userId, 'account-settings-confirm', 5))
    )
      throw new APIError('TOO_MANY_REQUESTS', {
        message: 'Too many password confirmations. Try again in a minute.',
      });
  });
  const access = [sensitiveSessionMiddleware, accountAccess];
  const confirmAccess = [...access, sensitive];
  return {
    id: 'spindle-account-settings',
    schema: {
      emailChange: {
        modelName: 'emailChange',
        fields: {
          userId: { type: 'string', required: true, unique: true },
          verificationId: { type: 'string', required: true, unique: true },
          oldEmail: { type: 'string', required: true },
          newEmail: { type: 'string', required: true },
          expiresAt: { type: 'date', required: true },
        },
      },
    },
    endpoints: {
      accountDetails: createAuthEndpoint(
        '/account',
        { method: 'GET', use: access },
        async (ctx) => {
          const current = ctx.context.session;
          if (!current) throw new APIError('UNAUTHORIZED');
          const pending = await ctx.context.adapter.findOne<PendingEmail>({
            model: 'emailChange',
            where: [
              { field: 'userId', value: current.user.id },
              { field: 'expiresAt', value: new Date(), operator: 'gt' },
            ],
          });
          return ctx.json({
            user: {
              id: current.user.id,
              name: current.user.name,
              email: current.user.email,
            },
            pendingEmail: pending
              ? { email: pending.newEmail, expiresAt: pending.expiresAt }
              : null,
          });
        },
      ),
      accountProfile: createAuthEndpoint(
        '/account/profile',
        {
          method: 'POST',
          use: access,
          body: z
            .object({
              name: z
                .string()
                .trim()
                .min(1)
                .max(100)
                .refine((value) =>
                  [...value].every(
                    (character) =>
                      character.charCodeAt(0) >= 32 &&
                      character.charCodeAt(0) !== 127,
                  ),
                ),
            })
            .strict(),
        },
        async (ctx) => {
          await withConfirmedSession(ctx, undefined, async (_adapter, user) =>
            ctx.context.internalAdapter.updateUser(user.id, {
              name: ctx.body.name,
            }),
          );
          return ctx.json({ status: true });
        },
      ),
      accountPassword: createAuthEndpoint(
        '/account/password',
        {
          method: 'POST',
          use: confirmAccess,
          body: confirmed
            .extend({ newPassword: z.string().min(15).max(128) })
            .strict(),
        },
        async (ctx) => {
          const hash = await ctx.context.password.hash(ctx.body.newPassword);
          await withConfirmedSession(
            ctx,
            ctx.body.currentPassword,
            async (_adapter, user) => {
              const credential =
                await ctx.context.internalAdapter.findCredentialAccount(
                  user.id,
                );
              if (!credential) throw new APIError('BAD_REQUEST');
              await ctx.context.internalAdapter.updateAccount(credential.id, {
                password: hash,
              });
            },
          );
          deleteSessionCookie(ctx);
          return ctx.json({ status: true, signInRequired: true });
        },
      ),
      accountEmail: createAuthEndpoint(
        '/account/email',
        {
          method: 'POST',
          use: confirmAccess,
          body: confirmed
            .extend({
              newEmail: z.string().trim().toLowerCase().email().max(254),
            })
            .strict(),
        },
        async (ctx) => {
          const token = randomBytes(32).toString('hex');
          const target = await withConfirmedSession(
            ctx,
            ctx.body.currentPassword,
            async (adapter, user) => {
              if (ctx.body.newEmail === user.email)
                throw new APIError('BAD_REQUEST', {
                  message: 'Enter a different email address.',
                });
              await clearEmailChange(adapter, user.id);
              if (
                await ctx.context.internalAdapter.findUserByEmail(
                  ctx.body.newEmail,
                )
              )
                return null;
              const expiresAt = new Date(Date.now() + 3600000);
              const verification =
                await ctx.context.internalAdapter.createVerificationValue({
                  identifier: `account-email:${token}`,
                  value: user.id,
                  expiresAt,
                });
              await adapter.create({
                model: 'emailChange',
                data: {
                  userId: user.id,
                  verificationId: verification.id,
                  oldEmail: user.email,
                  newEmail: ctx.body.newEmail,
                  expiresAt,
                },
              });
              return ctx.body.newEmail;
            },
          );
          if (target) {
            const link = new URL('/login', config.appUrl);
            link.search = new URLSearchParams({
              view: 'email-change',
              token,
            }).toString();
            try {
              await sendAuthEmail(
                mailer,
                config,
                target,
                emailChangeEmail(config, target, link.href),
              );
            } catch {
              throw new APIError('SERVICE_UNAVAILABLE', {
                message: 'Unable to send the verification email. Try again.',
              });
            }
          }
          return ctx.json({
            status: true,
            message:
              'If that address is available, a verification link has been sent. Your current sign-in email stays active until you confirm it.',
          });
        },
      ),
      accountCancelEmail: createAuthEndpoint(
        '/account/email/cancel',
        { method: 'POST', use: confirmAccess, body: confirmed.strict() },
        async (ctx) => {
          await withConfirmedSession(
            ctx,
            ctx.body.currentPassword,
            async (adapter, user) => clearEmailChange(adapter, user.id),
          );
          return ctx.json({ status: true });
        },
      ),
      accountConfirmEmail: createAuthEndpoint(
        '/account/email/confirm',
        { method: 'POST', body: tokenBody },
        async (ctx) => {
          const identifier = `account-email:${ctx.body.token}`;
          const verification =
            await ctx.context.internalAdapter.findVerificationValue(identifier);
          if (!verification) throw invalidLink();
          const session = await getSessionFromCtx(ctx);
          if (session && session.user.id !== verification.value)
            throw invalidLink();
          try {
            await runWithTransaction(ctx.context.adapter, async () => {
              const { adapter, user } = await lockOwner(
                ctx,
                verification.value,
              );
              const pending = await adapter.findOne<PendingEmail>({
                model: 'emailChange',
                where: [
                  { field: 'userId', value: user.id },
                  { field: 'verificationId', value: verification.id },
                ],
              });
              if (
                !pending ||
                pending.oldEmail !== user.email ||
                pending.expiresAt <= new Date()
              )
                throw invalidLink();
              if (
                await ctx.context.internalAdapter.findUserByEmail(
                  pending.newEmail,
                )
              )
                throw invalidLink();
              const consumed =
                await ctx.context.internalAdapter.consumeVerificationValue(
                  identifier,
                );
              if (
                !consumed ||
                consumed.id !== pending.verificationId ||
                consumed.value !== user.id
              )
                throw invalidLink();
              await ctx.context.internalAdapter.updateUser(user.id, {
                email: pending.newEmail,
                emailVerified: true,
              });
            });
          } catch (error) {
            if (error instanceof APIError && error.status === 'UNAUTHORIZED')
              throw invalidLink();
            if (
              error instanceof Error &&
              'cause' in error &&
              typeof error.cause === 'object' &&
              error.cause &&
              'code' in error.cause &&
              error.cause.code === '23505'
            )
              throw invalidLink();
            throw error;
          }
          deleteSessionCookie(ctx);
          return ctx.json({ status: true, signInRequired: true });
        },
      ),
      accountSessions: createAuthEndpoint(
        '/account/sessions',
        {
          method: 'GET',
          use: access,
          query: z
            .object({ cursor: z.string().min(1).max(128).optional() })
            .strict(),
        },
        async (ctx) => {
          const current = ctx.context.session;
          if (!current) throw new APIError('UNAUTHORIZED');
          const cursor = ctx.query?.cursor ?? null;
          if (
            cursor &&
            !(
              await pool.query(
                'SELECT 1 FROM auth_sessions WHERE user_id=$1 AND id=$2',
                [current.user.id, cursor],
              )
            ).rowCount
          )
            throw new APIError('BAD_REQUEST', {
              message: 'The session list changed. Refresh and try again.',
            });
          const rows = (
            await pool.query(
              `SELECT id, id=$2 AS current, left(user_agent,512) AS "userAgent",ip_address AS "ipAddress",created_at AS "createdAt",updated_at AS "updatedAt",expires_at AS "expiresAt"
           FROM auth_sessions WHERE user_id=$1 AND expires_at>clock_timestamp()
           AND ($3::text IS NULL OR ((id=$2),created_at,id)<(SELECT (id=$2),created_at,id FROM auth_sessions WHERE user_id=$1 AND id=$3))
           ORDER BY (id=$2) DESC,created_at DESC,id DESC LIMIT 26`,
              [current.user.id, current.session.id, cursor],
            )
          ).rows;
          return ctx.json({
            sessions: rows.slice(0, 25),
            nextCursor: rows.length > 25 ? rows[24]?.id : null,
          });
        },
      ),
      accountRevokeSession: createAuthEndpoint(
        '/account/sessions/revoke',
        {
          method: 'POST',
          use: confirmAccess,
          body: confirmed
            .extend({ sessionId: z.string().min(1).max(128) })
            .strict(),
        },
        async (ctx) => {
          await withConfirmedSession(
            ctx,
            ctx.body.currentPassword,
            async (adapter, user) => {
              const session = await adapter.findOne<Session>({
                model: 'session',
                where: [
                  { field: 'id', value: ctx.body.sessionId },
                  { field: 'userId', value: user.id },
                ],
              });
              if (!session)
                throw new APIError('NOT_FOUND', {
                  message: 'Session not found.',
                });
              if (session.id === ctx.context.session?.session.id)
                throw new APIError('BAD_REQUEST', {
                  message: 'Use Sign out to leave this device.',
                });
              await ctx.context.internalAdapter.deleteSession(session.token);
            },
          );
          return ctx.json({ status: true });
        },
      ),
      accountRevokeOthers: createAuthEndpoint(
        '/account/sessions/revoke-others',
        { method: 'POST', use: confirmAccess, body: confirmed.strict() },
        async (ctx) => {
          const currentId = ctx.context.session?.session.id;
          if (!currentId) throw new APIError('UNAUTHORIZED');
          await withConfirmedSession(
            ctx,
            ctx.body.currentPassword,
            async (adapter, user) => {
              // Database-backed sessions have no cookie/secondary cache to invalidate.
              await adapter.deleteMany({
                model: 'session',
                where: [
                  { field: 'userId', value: user.id },
                  {
                    field: 'id',
                    value: currentId,
                    operator: 'ne',
                  },
                ],
              });
            },
          );
          return ctx.json({ status: true });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
}
