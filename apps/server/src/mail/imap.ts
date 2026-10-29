import { ImapFlow } from 'imapflow';
import { resolveMailHost } from './network.js';

export type ImapSettings = {
  host: string;
  port: number;
  transport: 'tls' | 'starttls';
  username: string;
};

export async function connectImap(
  settings: ImapSettings,
  password: string,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const address = await resolveMailHost(settings.host);
  signal?.throwIfAborted();
  const client = new ImapFlow({
    host: address,
    port: settings.port,
    servername: settings.host,
    secure: settings.transport === 'tls',
    doSTARTTLS: settings.transport === 'starttls',
    auth: { user: settings.username, pass: password },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    maxLiteralSize: 256 * 1024,
    maxLineLength: 256 * 1024,
    maxResponseSize: 512 * 1024,
    maxResponseTokens: 10000,
  });
  // An error event must never leak provider diagnostics or crash the worker.
  client.on('error', () => {});
  const abort = () => client.close();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => client.close(), 30000);
  try {
    await client.connect();
    return client;
  } catch {
    client.close();
    throw new Error('IMAP connection failed');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
