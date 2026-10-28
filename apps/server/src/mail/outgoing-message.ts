import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { cleanDraft } from './drafts.js';
import { emailAddress } from './smtp.js';

export type OutgoingContent = Parameters<typeof cleanDraft>[0];

export async function outgoingMessage(
  id: string,
  sender: string,
  content: OutgoingContent,
) {
  if (!emailAddress(sender))
    throw new Error('Configure an SMTP login email before sending.');
  if (/[\r\n\0]/.test(content.subject))
    throw new Error('Subject contains invalid header characters.');
  const used = new Set<string>();
  const field = (value: string) => {
    if (/[\r\n\0]/.test(value))
      throw new Error('Recipients contain invalid header characters.');
    if (!value.trim()) return [];
    const parsed = addressparser(value, { flatten: false });
    if (
      !parsed.length ||
      parsed.some(
        (item) => !('address' in item) || !emailAddress(item.address ?? ''),
      )
    )
      throw new Error(
        'Complete every recipient address before sending. Groups are not supported yet.',
      );
    return parsed.flatMap((item) => {
      if (
        !('address' in item) ||
        typeof item.address !== 'string' ||
        used.has(item.address)
      )
        return [];
      used.add(item.address);
      return [{ address: item.address, name: item.name ?? '' }];
    });
  };
  const to = field(content.to),
    cc = field(content.cc),
    bcc = field(content.bcc);
  const recipients = [...to, ...cc, ...bcc].map((item) => item.address);
  if (recipients.length < 1 || recipients.length > 50)
    throw new Error('Choose between 1 and 50 recipients.');
  const safe = cleanDraft(content);
  const messageId = `<${id}@${sender.split('@')[1]}>`;
  const raw = await new MailComposer({
    from: { address: sender, name: '' },
    to,
    cc,
    bcc,
    subject: safe.subject,
    text: safe.text,
    ...(safe.format === 'rich' ? { html: safe.html } : {}),
    messageId,
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  })
    .compile()
    .build();
  if (raw.length > 512 * 1024)
    throw new Error('The encoded message exceeds the 512 KiB send limit.');
  return { raw, messageId, recipients };
}
