import type { TestContext } from 'node:test';
import { SMTPServer } from 'smtp-server';
import type { imapFixture } from './imap-fixture.js';

export const smtpPassword = 'synthetic-smtp-password';
export async function smtpFixture(
  t: TestContext,
  imap: Awaited<ReturnType<typeof imapFixture>>['server'],
  secure = true,
  starttls = true,
) {
  const received: { raw: Buffer; recipients: string[] }[] = [];
  const controls = {
    rejectData: false,
    rejectRecipient: false,
    dropAfterData: false,
    autoSaveSent: false,
    authFail: false,
  };
  let authAttempts = 0;
  const server = new SMTPServer({
    ...imap.getCredentials(),
    secure,
    disabledCommands: starttls ? [] : ['STARTTLS'],
    logger: false,
    disableReverseLookup: true,
    closeTimeout: 1000,
    size: 30 * 1024 * 1024,
    onAuth(auth, _session, done) {
      authAttempts++;
      if (
        controls.authFail ||
        auth.username !== 'writer@example.test' ||
        auth.password !== smtpPassword
      )
        return done(new Error('Synthetic authentication failure'));
      done(null, { user: 'writer' });
    },
    onRcptTo(address, _session, done) {
      if (controls.rejectRecipient && address.address.startsWith('reject@'))
        return done(
          Object.assign(new Error('Synthetic recipient rejection'), {
            responseCode: 550,
          }),
        );
      done();
    },
    onData(stream, session, done) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        if (controls.rejectData)
          return done(
            Object.assign(new Error('Synthetic DATA rejection'), {
              responseCode: 550,
            }),
          );
        const raw = Buffer.concat(chunks);
        received.push({
          raw,
          recipients: session.envelope.rcptTo.map((item) => item.address),
        });
        if (controls.autoSaveSent)
          imap.control.addMessage('Sent', {
            raw,
            flags: ['\\Seen'],
            internaldate: new Date(),
          });
        if (controls.dropAfterData) {
          for (const connection of server.connections)
            if (connection.id === session.id) connection.close();
          return;
        }
        done(null, 'Synthetic acceptance');
      });
    },
  });
  server.on('error', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.server.address();
  if (!address || typeof address === 'string')
    throw new Error('SMTP fixture unavailable');
  t.after(async () => {
    for (const connection of server.connections) connection.close();
    await new Promise<void>((resolve) => server.close(resolve));
  });
  return {
    server,
    port: address.port,
    received,
    controls,
    authAttempts: () => authAttempts,
  };
}
