import dns from 'node:dns/promises';
import net from 'node:net';
import type { TestContext } from 'node:test';
import tls from 'node:tls';
import imapkit from 'imapkit';

export const imapPassword = 'synthetic-imap-password';

export async function imapFixture(
  t: TestContext,
  secure = true,
  starttls = true,
) {
  const server = imapkit({
    secureConnection: secure,
    plugins: ['SPECIAL-USE', ...(starttls ? ['STARTTLS'] : [])],
    users: { testuser: { password: imapPassword } },
    storage: {
      INBOX: { uidvalidity: 1, messages: [] },
      '': {
        separator: '/',
        folders: { Archive: { specialUse: '\\Archive' }, Receipts: {} },
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Test server unavailable');
  t.after(async () => {
    for (const session of server.control.sessions())
      server.control.disconnect(session.session, { reset: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  let trusted = true;
  const actualTls = tls.connect;
  const actualNet = net.connect;
  // Only the test transport redirects the already-validated public address to
  // our loopback fixture and trusts its localhost certificate. Production has no bypass.
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(
    tls,
    'connect',
    (options: tls.ConnectionOptions, callback?: () => void) => {
      assertTls(options);
      return actualTls(
        {
          ...options,
          host: options.socket ? options.host : '127.0.0.1',
          ca: trusted ? server.getCredentials().cert : undefined,
        },
        callback,
      );
    },
  );
  t.mock.method(net, 'connect', (...args: unknown[]) => {
    const options = args[0];
    if (
      options &&
      typeof options === 'object' &&
      'host' in options &&
      options.host === '8.8.8.8'
    )
      args[0] = { ...options, host: '127.0.0.1' };
    return Reflect.apply(actualNet, net, args);
  });
  return {
    server,
    port: address.port,
    trustCertificate: (value: boolean) => {
      trusted = value;
    },
  };
}

function assertTls(options: tls.ConnectionOptions) {
  if (options.rejectUnauthorized !== true || options.servername !== 'localhost')
    throw new Error('Production TLS settings were weakened');
}

export function rawMail(subject: string, id = 'same-id@example.test') {
  return `From: Test Sender <sender@example.test>\r\nTo: Test Recipient <recipient@example.test>\r\nSubject: ${subject}\r\nDate: Tue, 27 Oct 2026 12:00:00 +0000\r\nMessage-ID: <${id}>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic mail fixture.\r\n`;
}
