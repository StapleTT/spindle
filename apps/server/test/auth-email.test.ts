import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AuthConfig } from '../src/auth/config.js';
import {
  invitationEmail,
  passwordResetEmail,
  verificationEmail,
} from '../src/auth/email.js';

const config = { appUrl: 'https://app.example.test' } as AuthConfig;
const url = 'https://app.example.test/api/auth/verify?token=a"b<c>&d=1';

test('auth emails escape user values and keep the action link first in plain text', () => {
  const email = '"><img src=x onerror=alert(1)>@example.test';
  for (const message of [
    verificationEmail(config, email, url),
    passwordResetEmail(config, email, url),
    invitationEmail(config, email, url, new Date('2026-11-05T12:00:00Z')),
  ]) {
    assert.doesNotMatch(message.html, /<img src=x/);
    assert.match(message.html, /&quot;&gt;&lt;img src=x/);
    assert.match(
      message.html,
      /href="https:\/\/app\.example\.test\/api\/auth\/verify\?token=a&quot;b&lt;c&gt;&amp;d=1"/,
    );
    assert.match(
      message.html,
      /src="https:\/\/app\.example\.test\/spindle-mark\.png"/,
    );
    assert.equal(message.text.match(/https?:\/\/\S+/)?.[0], url);
  }
});

test('auth email subjects stay stable and invitation states its UTC expiry', () => {
  assert.equal(
    verificationEmail(config, 'a@example.test', url).subject,
    'Verify your Spindle email',
  );
  assert.equal(
    passwordResetEmail(config, 'a@example.test', url).subject,
    'Reset your Spindle password',
  );
  const invite = invitationEmail(
    config,
    'a@example.test',
    url,
    new Date('2026-11-05T23:30:00Z'),
  );
  assert.match(invite.html, /expires on November 5, 2026 \(UTC\)/);
});
