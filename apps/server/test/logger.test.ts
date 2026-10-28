import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loggerOptions } from '../src/logger.js';

test('authentication links and content grants do not leak bearer credentials into request logs', () => {
  for (const url of [
    '/api/auth/verify-email?token=secret&callbackURL=private',
    '/api/auth/reset-password/secret?callbackURL=private',
    '/body?token=secret&private=1',
    '/image?token=secret&index=0&private=1',
  ]) {
    const serialized = JSON.stringify(
      loggerOptions.serializers.req({ method: 'GET', url }),
    );
    assert.ok(!serialized.includes('secret'));
    assert.ok(!serialized.includes('private'));
  }
});
