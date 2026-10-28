import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createAuth } from '../src/auth/auth.js';
import { type AuthConfig, readAuthConfig } from '../src/auth/config.js';
import type { MailKeys } from '../src/mail/credentials.js';

export const testConfig = readAuthConfig({
  APP_URL: 'http://127.0.0.1:5173',
  ALLOW_INSECURE_LOCALHOST: 'true',
  AUTH_SECRET: 'unit-test-only-secret-which-is-not-used-outside-tests',
  SMTP_HOST: '127.0.0.1',
  SMTP_PORT: '1025',
  SMTP_SECURE: 'false',
  MAIL_FROM: 'noreply@example.test',
});

export function testApp(
  pool: Pool,
  config: AuthConfig = testConfig,
  mailer = nodemailer.createTransport({ jsonTransport: true }),
  mailKeys?: MailKeys,
) {
  const app = buildApp(
    pool,
    createAuth(pool, config, mailer),
    config,
    mailKeys,
  );
  app.log.level = 'silent';
  return app;
}
