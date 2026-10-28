import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { test } from 'node:test';
import {
  decryptCredential,
  encryptCredential,
  readMailKeys,
} from '../src/mail/credentials.js';
import { isPublicAddress, resolveMailHost } from '../src/mail/network.js';

test('credentials use authenticated owner/account binding and a rotatable key ring', () => {
  const old = Buffer.alloc(32, 1).toString('base64');
  const next = Buffer.alloc(32, 2).toString('base64');
  const ring = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({ v1: old }),
  });
  const sealed = encryptCredential(
    'synthetic-app-password',
    'owner',
    'account',
    ring,
  );
  assert.ok(!sealed.includes('synthetic-app-password'));
  assert.notEqual(
    sealed,
    encryptCredential('synthetic-app-password', 'owner', 'account', ring),
  );
  assert.equal(
    decryptCredential(sealed, 'owner', 'account', ring),
    'synthetic-app-password',
  );
  assert.throws(() => decryptCredential(sealed, 'other', 'account', ring));
  assert.throws(() => decryptCredential(sealed, 'owner', 'other', ring));
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() =>
    decryptCredential(parts.join('.'), 'owner', 'account', ring),
  );
  const rotated = readMailKeys({
    MAIL_ENCRYPTION_KEY_ID: 'v2',
    MAIL_ENCRYPTION_KEYS: JSON.stringify({ v1: old, v2: next }),
  });
  assert.equal(
    decryptCredential(sealed, 'owner', 'account', rotated),
    'synthetic-app-password',
  );
  const replacement = encryptCredential(
    decryptCredential(sealed, 'owner', 'account', rotated),
    'owner',
    'account',
    rotated,
  );
  assert.match(replacement, /^v2\./);
  assert.equal(
    decryptCredential(replacement, 'owner', 'account', rotated),
    'synthetic-app-password',
  );
  assert.throws(() =>
    decryptCredential(sealed, 'owner', 'account', readMailKeys({})),
  );
  assert.throws(() => readMailKeys({ MAIL_ENCRYPTION_KEYS: '{"v1":"short"}' }));
  assert.throws(() => readMailKeys({ MAIL_ENCRYPTION_KEYS: '[]' }));
  assert.throws(() =>
    readMailKeys({
      MAIL_ENCRYPTION_KEY_ID: 'missing',
      MAIL_ENCRYPTION_KEYS: JSON.stringify({ v1: old }),
    }),
  );
});

test('mail egress rejects private, reserved, mapped and transition ranges', () => {
  for (const value of [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.1.2',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '192.0.2.1',
    '198.51.100.2',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    'fc00::1',
    'fe80::1',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'not-an-ip',
  ]) {
    assert.equal(isPublicAddress(value), false, value);
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('DNS validates every answer and returns a pinned address', async (t) => {
  const lookup = t.mock.method(dns, 'lookup', async () => [
    { address: '8.8.8.8', family: 4 },
    { address: '127.0.0.1', family: 4 },
  ]);
  await assert.rejects(resolveMailHost('mail.example.test'));
  lookup.mock.mockImplementation(async () => [
    { address: '8.8.8.8', family: 4 },
  ]);
  assert.equal(await resolveMailHost('mail.example.test'), '8.8.8.8');
  await assert.rejects(resolveMailHost('127.0.0.1'));
  assert.equal(await resolveMailHost('8.8.8.8'), '8.8.8.8');
});
