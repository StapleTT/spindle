import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import { createAuth } from '../src/auth/auth.js';
import { type AuthConfig, readAuthConfig } from '../src/auth/config.js';
import { readContentConfig } from '../src/mail/content-config.js';
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
  content = readContentConfig(config, {}),
) {
  const app = buildApp(
    pool,
    createAuth(pool, config, mailer),
    config,
    mailKeys,
    content,
  );
  app.log.level = 'silent';
  return app;
}

export async function createTestUser(
  app: ReturnType<typeof testApp>,
  pool: Pool,
  config: AuthConfig,
  email: string,
  remoteAddress = '203.0.113.212',
) {
  const password = 'synthetic reader password 123!';
  await pool.query(
    "INSERT INTO invites(email,expires_at) VALUES($1,now()+interval '1 day') ON CONFLICT(email) DO NOTHING",
    [email],
  );
  const signed = await app.inject({
    remoteAddress,
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: config.appUrl },
    payload: { email, name: 'Reader Test', password },
  });
  assert.equal(signed.statusCode, 200, signed.body);
  const id = (
    await pool.query(
      'UPDATE users SET email_verified=true WHERE email=$1 RETURNING id',
      [email],
    )
  ).rows[0].id;
  const login = await app.inject({
    remoteAddress,
    method: 'POST',
    url: '/api/auth/sign-in/email',
    headers: { origin: config.appUrl },
    payload: { email, password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const headers = login.headers['set-cookie'];
  const cookie = (Array.isArray(headers) ? headers : [String(headers)])
    .map((value) => value.split(';')[0])
    .join('; ');
  const session = (
    await pool.query(
      'SELECT id FROM auth_sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',
      [id],
    )
  ).rows[0].id;
  return { id, email, password, cookie, session };
}
