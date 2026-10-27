import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readAuthConfig } from '../src/auth/config.js';

const env = {
  APP_URL: 'https://mail.example.test',
  AUTH_SECRET: 'test-only-not-a-production-secret-123456789',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '587',
  SMTP_SECURE: 'false',
  MAIL_FROM: 'noreply@example.test',
};

test('hosted auth requires HTTPS and a persistent strong secret', () => {
  assert.equal(readAuthConfig(env).secureCookies, true);
  assert.equal(readAuthConfig(env).smtpRequireTLS, true);
  assert.throws(
    () =>
      readAuthConfig({
        ...env,
        APP_URL: 'http://mail.example.test',
        ALLOW_INSECURE_LOCALHOST: 'true',
      }),
    /HTTPS/,
  );
  assert.throws(
    () => readAuthConfig({ ...env, AUTH_SECRET: '' }),
    /AUTH_SECRET/,
  );
  assert.throws(
    () =>
      readAuthConfig({ ...env, APP_URL: 'https://user:password@example.test' }),
    /without a path or credentials/,
  );
  assert.throws(
    () => readAuthConfig({ ...env, APP_URL: 'https://example.test/some-path' }),
    /without a path/,
  );
});

test('insecure development is explicit, loopback-only and unavailable in production', () => {
  const local = {
    ...env,
    APP_URL: 'http://127.0.0.1:5173',
    ALLOW_INSECURE_LOCALHOST: 'true',
    SMTP_HOST: '127.0.0.1',
  };
  assert.equal(readAuthConfig(local).secureCookies, false);
  assert.equal(readAuthConfig(local).smtpRequireTLS, false);
  assert.throws(
    () => readAuthConfig({ ...local, ALLOW_INSECURE_LOCALHOST: 'false' }),
    /HTTPS/,
  );
  assert.throws(() => readAuthConfig({ ...local, HOST: '0.0.0.0' }), /HTTPS/);
  assert.throws(
    () => readAuthConfig({ ...local, NODE_ENV: 'production' }),
    /HTTPS/,
  );
});

test('invalid registration and relay settings fail closed', () => {
  assert.throws(
    () => readAuthConfig({ ...env, REGISTRATION_MODE: 'anything' }),
    /REGISTRATION_MODE/,
  );
  assert.throws(
    () => readAuthConfig({ ...env, SMTP_PORT: 'abc' }),
    /SMTP_PORT/,
  );
  assert.throws(
    () => readAuthConfig({ ...env, SMTP_SECURE: '' }),
    /SMTP_SECURE/,
  );
  assert.throws(
    () => readAuthConfig({ ...env, SMTP_USER: 'user' }),
    /set together/,
  );
  assert.throws(
    () =>
      readAuthConfig({
        ...env,
        MAIL_FROM: 'from@example.test\r\nBcc: someone@example.test',
      }),
    /MAIL_FROM/,
  );
});
