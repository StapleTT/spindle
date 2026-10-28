import type { Readable } from 'node:stream';
import addressparser from 'nodemailer/lib/addressparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { cleanDraft } from './drafts.js';
import { type ForwardContent, outgoingForward } from './forward.js';
import {
  type ReplyContext,
  referenceIds,
  messageId as validMessageId,
} from './reply.js';
import { emailAddress, senderDisplayName } from './smtp.js';

export type OutgoingContent = Parameters<typeof cleanDraft>[0];

export function composeOutgoing(
  id: string,
  sender: string,
  content: OutgoingContent,
  context?: ReplyContext | null,
  forward?: ForwardContent | null,
  files: { filename: string; content: Readable; contentType: string }[] = [],
  displayName = '',
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
  const forwarded =
    forward && safe.format === 'rich' ? outgoingForward(forward, id) : null;
  const messageId = `<${id}@${sender.split('@')[1]}>`;
  const parent =
    context && ['reply', 'replyAll'].includes(context.kind)
      ? validMessageId(context.inReplyTo)
      : null;
  const compiled = new MailComposer({
    from: { address: sender, name: senderDisplayName(displayName) },
    to,
    cc,
    bcc,
    subject: safe.subject,
    text: [safe.text, forward?.text].filter(Boolean).join('\n\n'),
    ...(safe.format === 'rich'
      ? { html: safe.html + (forwarded?.html ?? '') }
      : {}),
    attachments: [...(forwarded?.attachments ?? []), ...files],
    messageId,
    ...(parent
      ? { inReplyTo: parent, references: referenceIds(context?.references) }
      : {}),
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  return { compiled, messageId, recipients };
}

export async function outgoingMessage(
  id: string,
  sender: string,
  content: OutgoingContent,
  context?: ReplyContext | null,
  forward?: ForwardContent | null,
  displayName = '',
) {
  const { compiled, messageId, recipients } = composeOutgoing(
    id,
    sender,
    content,
    context,
    forward,
    [],
    displayName,
  );
  const raw = await compiled.build();
  if (raw.length > 512 * 1024)
    throw new Error('The encoded message exceeds the 512 KiB send limit.');
  return { raw, messageId, recipients };
}
