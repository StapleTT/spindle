import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { readConfig } from '../src/config.js';

const databaseUrl = readConfig().databaseUrl;
const admin = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 5000,
});
const name = `spindle_test_${randomBytes(8).toString('hex')}`;
const testUrl = new URL(databaseUrl);
testUrl.pathname = `/${name}`;
let created = false;
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      ...(process.argv.includes('--browser')
        ? [
            'apps/web/test/auth.browser.ts',
            'apps/web/test/mail.browser.ts',
            'apps/web/test/idle.browser.ts',
            'apps/web/test/events.browser.ts',
            'apps/web/test/search.browser.ts',
            'apps/web/test/conversations.browser.ts',
            'apps/web/test/conversation-state.browser.ts',
            'apps/web/test/reader.browser.ts',
            'apps/web/test/composer.browser.ts',
            'apps/web/test/signatures.browser.ts',
            'apps/web/test/provider-drafts.browser.ts',
            'apps/web/test/smtp.browser.ts',
            'apps/web/test/replies.browser.ts',
            'apps/web/test/attachments.browser.ts',
          ]
        : [
            'apps/server/test/auth.integration.ts',
            'apps/server/test/mail.integration.ts',
            'apps/server/test/idle.integration.ts',
            'apps/server/test/events.integration.ts',
            'apps/server/test/search.integration.ts',
            'apps/server/test/conversations.integration.ts',
            'apps/server/test/conversation-state.integration.ts',
            'apps/server/test/reader.integration.ts',
            'apps/server/test/mail-actions.integration.ts',
            'apps/server/test/drafts.integration.ts',
            'apps/server/test/signatures.integration.ts',
            'apps/server/test/provider-drafts.integration.ts',
            'apps/server/test/smtp.integration.ts',
            'apps/server/test/replies.integration.ts',
            'apps/server/test/outgoing-attachments.integration.ts',
          ]),
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: testUrl.href },
    },
  );
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('exit', (code) => resolve(code ?? 1));
    child.once('error', reject);
  });
} catch {
  console.error(
    'Auth integration tests failed to run. The development database role needs CREATEDB permission.',
  );
  process.exitCode = 1;
} finally {
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
