import type { Readable } from 'node:stream';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { resolveMailHost } from './network.js';

export type SmtpSettings = {
  host: string;
  port: number;
  transport: 'tls' | 'starttls';
  username: string;
};

export function senderDisplayName(value: string) {
  if (/\p{Cc}/u.test(value) || Array.from(value).length > 200)
    throw new Error(
      'Sender display name must be at most 200 characters and contain no control characters.',
    );
  return value.trim();
}

export function defaultSenderName(profileName: string) {
  return Array.from(profileName.replace(/\p{Cc}/gu, ' ').trim())
    .slice(0, 200)
    .join('');
}
export const smtpErrors: Record<string, string> = {
  provider_draft_changed:
    'This draft changed or was removed in another mail client. Open the draft and review the provider version before sending.',
  draft_check_failed:
    'The provider draft could not be checked before sending. Your draft and attachments are safe; retry when the provider is reachable.',
  smtp_unavailable:
    'The SMTP server could not be reached securely. Check the server, encryption and credentials.',
  smtp_rejected:
    'The SMTP server rejected this message. Review its recipients and outgoing settings before retrying.',
  settings_changed:
    'Outgoing settings changed. Review the draft and queue a new send.',
  account_removed:
    'The connected account was removed. The draft has been preserved.',
  delivery_unknown:
    'Delivery status is unknown. The server may have accepted this message. Check Sent and the recipient before sending again; Spindle will not resend it automatically.',
};

export function emailAddress(value: string) {
  // A single bare mailbox, never a display name, quoted local part or header.
  if (
    value.length > 254 ||
    !/^[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+(?:\.[a-zA-Z0-9!#$%&'*+\-/=?^_`{|}~]+)*@[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(
      value,
    )
  )
    return false;
  const [local, domain] = value.split('@');
  return Boolean(
    local &&
      local.length <= 64 &&
      domain?.includes('.') &&
      domain
        .split('.')
        .every(
          (label) =>
            label.length > 0 &&
            label.length <= 63 &&
            !label.startsWith('-') &&
            !label.endsWith('-'),
        ),
  );
}

function operation<T>(
  client: SMTPConnection,
  run: (
    done: (
      error: SMTPConnection.SMTPError | null | undefined,
      value?: T,
    ) => void,
  ) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => finish(error);
    const end = () => finish(new Error('SMTP ended'));
    const finish = (error?: Error | null, value?: T) => {
      client.off('error', fail);
      client.off('end', end);
      if (error) reject(error);
      else resolve(value as T);
    };
    client.once('error', fail);
    client.once('end', end);
    run(finish);
  });
}

export async function connectSmtp(settings: SmtpSettings, password: string) {
  const address = await resolveMailHost(settings.host);
  const client = new SMTPConnection({
    host: address,
    port: settings.port,
    secure: settings.transport === 'tls',
    requireTLS: settings.transport === 'starttls',
    opportunisticTLS: false,
    tls: {
      servername: settings.host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    logger: false,
    debug: false,
  });
  client.on('error', () => {});
  const timer = setTimeout(() => client.close(), 40000);
  const close = () => {
    clearTimeout(timer);
    client.close();
  };
  try {
    await operation<void>(client, (done) => client.connect(done));
    if (!client.secure) throw new Error('TLS is required');
    await operation<boolean>(client, (done) =>
      client.login({ user: settings.username, pass: password }, done),
    );
    return {
      close,
      send: (
        sender: string,
        recipients: string[],
        raw: Buffer | Readable,
        size?: number,
      ) =>
        operation<SMTPConnection.SentMessageInfo>(client, (done) =>
          client.send(
            {
              from: sender,
              to: recipients,
              size: Buffer.isBuffer(raw) ? raw.length : size,
            },
            raw,
            done,
          ),
        ),
    };
  } catch (error) {
    close();
    throw error;
  }
}
