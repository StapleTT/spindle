import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loggerOptions } from '../src/logger.js';

test('authentication links do not leak bearer credentials into request logs', () => {
  for (const url of [
    '/api/auth/verify-email?token=secret&callbackURL=private',
    '/api/auth/reset-password/secret?callbackURL=private',
  ]) {
    const serialized = JSON.stringify(
      loggerOptions.serializers.req({ method: 'GET', url }),
    );
    assert.ok(!serialized.includes('secret'));
    assert.ok(!serialized.includes('private'));
  }
});
