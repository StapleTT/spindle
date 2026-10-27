import { getCurrentAdapter } from '@better-auth/core/context';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Transporter } from 'nodemailer';
import type { Pool } from 'pg';
import * as schema from '../db/schema.js';
import { logger } from '../logger.js';
import type { AuthConfig } from './config.js';
import { createMailer, sendAuthEmail } from './email.js';

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
            },
          },
        },
      },
    ],
    logger: { disabled: true },
    user: {
      additionalFields: {
        role: { type: ['user', 'admin'], input: false, defaultValue: 'user' },
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
      sendResetPassword: async ({ user, url }) => {
        try {
          await sendAuthEmail(
            mailer,
            config,
            user.email,
            'Reset your Spindle password',
            `Reset your password within one hour:\n\n${url}\n\nIf you did not request this, ignore this email.`,
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
          'Verify your Spindle email',
          `Verify your email within one hour:\n\n${url}\n\nOnly continue if you created this Spindle account. If you did not, ignore this email.`,
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
    databaseHooks: {
      user: {
        create: {
          before: async (newUser, context) => {
            if (!context)
              throw new APIError('FORBIDDEN', {
                message: 'Registration requires a request.',
              });
            const adapter = await getCurrentAdapter(context.context.adapter);
            const invite = await adapter.findOne<{ role: 'user' | 'admin' }>({
              model: 'invite',
              where: [
                { field: 'email', value: newUser.email },
                { field: 'expiresAt', value: new Date(), operator: 'gt' },
              ],
            });
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
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
