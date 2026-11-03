import { getCurrentAdapter } from '@better-auth/core/context';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from 'better-auth/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Transporter } from 'nodemailer';
import type { Pool } from 'pg';
import * as schema from '../db/schema.js';
import { logger } from '../logger.js';
import {
  insertSecurityEvent,
  recordSecurityEvent,
} from './account-lifecycle.js';
import { accountSettings } from './account-settings.js';
import type { AuthConfig } from './config.js';
import {
  createMailer,
  passwordResetEmail,
  sendAuthEmail,
  verificationEmail,
} from './email.js';

export function createAuth(
  pool: Pool,
  config: AuthConfig,
  mailer: Transporter = createMailer(config),
) {
  const db = drizzle(pool);
  const cookieName = (name: string) =>
    `${config.secureCookies ? '__Host-' : ''}spindle.${name}`;
  return betterAuth({
    appName: 'Spindle',
    baseURL: config.appUrl,
    basePath: '/api/auth',
    secret: config.secret,
    trustedOrigins: [config.appUrl],
    database: drizzleAdapter(db, { provider: 'pg', schema, transaction: true }),
    plugins: [
      accountSettings(pool, config, mailer),
      {
        id: 'spindle-invites',
        schema: {
          invite: {
            modelName: 'invites',
            fields: {
              email: { type: 'string', required: true, unique: true },
              role: { type: ['user', 'admin'], required: true },
              expiresAt: { type: 'date', required: true },
              createdAt: { type: 'date', required: true },
              revokedAt: { type: 'date', required: false },
              acceptedAt: { type: 'date', required: false },
              acceptedUserId: { type: 'string', required: false },
            },
          },
        },
      },
    ],
    logger: { disabled: true },
    user: {
      additionalFields: {
        role: { type: ['user', 'admin'], input: false, defaultValue: 'user' },
        suspended: { type: 'boolean', input: false, defaultValue: false },
        deletionDueAt: { type: 'date', input: false, required: false },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      freshAge: 900,
      cookieCache: { enabled: false },
    },
    verification: { storeIdentifier: 'hashed' },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 15,
      maxPasswordLength: 128,
      requireEmailVerification: true,
      autoSignIn: false,
      resetPasswordTokenExpiresIn: 3600,
      revokeSessionsOnPasswordReset: true,
      onPasswordReset: async ({ user }, request) => {
        await insertSecurityEvent(
          pool,
          user.id,
          'password.reset',
          request?.headers,
        );
      },
      sendResetPassword: async ({ user, url }) => {
        try {
          await sendAuthEmail(
            mailer,
            config,
            user.email,
            passwordResetEmail(config, user.email, url),
          );
        } catch {
          // Recovery responses must not reveal whether an account exists during a relay outage.
          logger.error('Password recovery email delivery failed');
        }
      },
    },
    emailVerification: {
      expiresIn: 3600,
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => {
        await sendAuthEmail(
          mailer,
          config,
          user.email,
          verificationEmail(config, user.email, url),
        );
      },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 60, max: 5 },
        '/request-password-reset': { window: 60, max: 3 },
        '/send-verification-email': { window: 60, max: 3 },
        '/account/*': { window: 60, max: 30 },
        '/account/email/confirm': { window: 60, max: 10 },
        '/account/deletion/cancel': { window: 60, max: 5 },
      },
    },
    advanced: {
      // Supply exact __Host- names and secure attributes instead of Better Auth's __Secure- prefix.
      useSecureCookies: false,
      defaultCookieAttributes: {
        secure: config.secureCookies,
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
      },
      cookies: {
        session_token: { name: cookieName('session') },
        session_data: { name: cookieName('session_data') },
        dont_remember: { name: cookieName('dont_remember') },
      },
      ipAddress: { ipAddressHeaders: ['x-spindle-client-ip'] },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-out') return;
        const current = await getSessionFromCtx(ctx);
        if (current)
          await recordSecurityEvent(
            ctx.context.adapter,
            current.user.id,
            'sign_out',
            ctx.headers,
          );
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== '/sign-in/email') return;
        const created = ctx.context.newSession;
        if (created) {
          await recordSecurityEvent(
            ctx.context.adapter,
            created.user.id,
            'sign_in.succeeded',
            ctx.headers,
          );
          return;
        }
        const email: unknown = ctx.body?.email;
        if (
          !(ctx.context.returned instanceof APIError) ||
          typeof email !== 'string'
        )
          return;
        // Only known accounts are recorded; unknown addresses leave no trace.
        const found = await ctx.context.internalAdapter.findUserByEmail(
          email.trim().toLowerCase(),
        );
        if (found)
          await recordSecurityEvent(
            ctx.context.adapter,
            found.user.id,
            'sign_in.failed',
            ctx.headers,
          );
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, context) => {
            if (!context) return;
            const adapter = await getCurrentAdapter(context.context.adapter);
            const owner = await adapter.findOne<{
              suspended: boolean;
              deletionDueAt: Date | null;
            }>({
              model: 'user',
              where: [{ field: 'id', value: session.userId }],
            });
            if (owner?.deletionDueAt)
              throw new APIError('FORBIDDEN', {
                code: 'ACCOUNT_DELETION_PENDING',
                message:
                  'This account is scheduled for deletion. Cancel the deletion to sign in.',
                deletionDueAt: owner.deletionDueAt.toISOString(),
              });
            if (!owner || owner.suspended)
              throw new APIError('FORBIDDEN', {
                message: 'This account is suspended. Contact the operator.',
              });
          },
        },
      },
      user: {
        create: {
          before: async (newUser, context) => {
            if (!context)
              throw new APIError('FORBIDDEN', {
                message: 'Registration requires a request.',
              });
            const adapter = await getCurrentAdapter(context.context.adapter);
            const candidate = await adapter.findOne<{
              id: string;
              expiresAt: Date;
            }>({
              model: 'invite',
              where: [
                { field: 'email', value: newUser.email },
                { field: 'expiresAt', value: new Date(), operator: 'gt' },
                { field: 'revokedAt', value: null },
                { field: 'acceptedAt', value: null },
              ],
            });
            const invite = candidate
              ? await adapter.update<{ role: 'user' | 'admin' }>({
                  model: 'invite',
                  where: [
                    { field: 'id', value: candidate.id },
                    { field: 'revokedAt', value: null },
                    { field: 'acceptedAt', value: null },
                    { field: 'expiresAt', value: new Date(), operator: 'gt' },
                  ],
                  update: { expiresAt: candidate.expiresAt },
                })
              : null;
            if (config.registrationMode === 'invite' && !invite) {
              throw new APIError('FORBIDDEN', {
                message:
                  'Unable to register. Check your invitation or contact the operator.',
              });
            }
            return {
              data: {
                ...newUser,
                name: newUser.name.slice(0, 100),
                role: invite?.role ?? 'user',
              },
            };
          },
          after: async (newUser, context) => {
            if (!context) return;
            const adapter = await getCurrentAdapter(context.context.adapter);
            await recordSecurityEvent(
              adapter,
              newUser.id,
              'account.created',
              context.headers,
            );
            await adapter.update({
              model: 'invite',
              where: [
                { field: 'email', value: newUser.email },
                { field: 'revokedAt', value: null },
                { field: 'acceptedAt', value: null },
              ],
              update: { acceptedAt: new Date(), acceptedUserId: newUser.id },
            });
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
