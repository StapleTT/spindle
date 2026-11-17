// D049: only Pub/Sub's signed token for this webhook and push service
// account may wake Gmail accounts.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';
import { verifyGoogleToken } from '../src/mail/push.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const expected = {
  audience: 'https://mail.example.test/api/push/google',
  serviceAccount: 'push@project.iam.gserviceaccount.com',
};
const now = 1_800_000_000;
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = privateKey,
) {
  const head = encode({ alg: 'RS256', kid: 'k1', typ: 'JWT', ...header });
  const body = encode({
    iss: 'https://accounts.google.com',
    aud: expected.audience,
    email: 'Push@project.iam.gserviceaccount.com',
    email_verified: true,
    iat: now - 10,
    exp: now + 3600,
    ...claims,
  });
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${head}.${body}`),
    key,
  ).toString('base64url');
  return `${head}.${body}.${signature}`;
}
const keyFor = (kid: string) => (kid === 'k1' ? publicKey : undefined);
const check = (value: string) =>
  verifyGoogleToken(value, keyFor, expected, now);

test('Pub/Sub push tokens are verified before any wake', () => {
  assert.equal(check(token()), true);
  assert.equal(check(token({ iss: 'accounts.google.com' })), true);
  assert.equal(
    check(token({ aud: 'https://other.test/api/push/google' })),
    false,
  );
  assert.equal(check(token({ email: 'someone@else.test' })), false);
  assert.equal(check(token({ email_verified: false })), false);
  assert.equal(check(token({ iss: 'https://evil.test' })), false);
  assert.equal(check(token({ exp: now - 120 })), false);
  assert.equal(check(token({ iat: now + 600 })), false);
  assert.equal(check(token({}, { kid: 'unknown' })), false);
  assert.equal(check(token({}, { alg: 'none' })), false);
  assert.equal(check(token({}, {}, other.privateKey)), false);
  // A valid signature does not carry over to altered claims.
  const [head, , signature] = token().split('.');
  assert.equal(
    check(`${head}.${encode({ aud: expected.audience })}.${signature}`),
    false,
  );
  assert.equal(check('not-a-token'), false);
  assert.equal(check(`${'a'.repeat(9000)}.b.c`), false);
});
