import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { Parser } from 'htmlparser2';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import { cleanDraft } from './drafts.js';
import { DRAFT_FILE_BYTES, FILE_BYTES, MIME_BYTES } from './file-storage.js';
import {
  type ForwardContent,
  forwardContent,
  outgoingForward,
} from './forward.js';
import { rasterType, safeFilename } from './media.js';
import {
  htmlText,
  messageId,
  type ReplyContext,
  referenceIds,
} from './reply.js';
import { sanitizeMessage } from './sanitize.js';
import { emailAddress, senderDisplayName } from './smtp.js';

export const draftHash = (raw: Buffer) =>
  createHash('sha256').update(raw).digest('hex');
type Content = Parameters<typeof cleanDraft>[0];
export type DraftValue = {
  content: Content;
  replyContext: ReplyContext | null;
  forward: ForwardContent | null;
  files: { filename: string; data: Buffer }[];
};
export function composeProviderDraft(
  id: string,
  link: string,
  sender: { address: string; name: string } | null,
  content: Content,
  context: ReplyContext | null,
  forward: ForwardContent | null,
  files: { filename: string; content: Readable; contentType: string }[],
) {
  const safe = cleanDraft(content),
    original =
      forward && safe.format === 'rich' ? outgoingForward(forward, id) : null;
  const identity =
    sender && emailAddress(sender.address)
      ? { address: sender.address, name: senderDisplayName(sender.name) }
      : undefined;
  const compiled = new MailComposer({
    from: identity,
    to: safe.to,
    cc: safe.cc,
    bcc: safe.bcc,
    subject: safe.subject,
    text: [safe.text, forward?.text].filter(Boolean).join('\n\n'),
    ...(safe.format === 'rich'
      ? { html: safe.html + (original?.html ?? '') }
      : {}),
    attachments: [...(original?.attachments ?? []), ...files],
    messageId: `<${id}@spindle-draft.invalid>`,
    ...(context?.inReplyTo && messageId(context.inReplyTo)
      ? {
          inReplyTo: context.inReplyTo,
          references: referenceIds(context.references),
        }
      : {}),
    headers: { 'X-Spindle-Draft': link, 'X-Spindle-Operation': id },
    date: new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  compiled.keepBcc = true;
  return compiled;
}

const field = (value: string) => value.replace(/\p{Cc}/gu, ' ').trim();
export async function parseProviderDraft(raw: Buffer): Promise<DraftValue> {
  if (raw.length > MIME_BYTES) throw new Error('draft_too_large');
  const parsed = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: 2 * 1024 * 1024,
    maxHeadSize: 64 * 1024,
    maxChildNodes: 100,
  });
  const addresses = (input: typeof parsed.to) =>
    field(
      (Array.isArray(input) ? input : input ? [input] : [])
        .map((item) => item.text)
        .join(', '),
    );
  const html =
      typeof parsed.html === 'string' ? parsed.html.replaceAll('\0', '') : '',
    text = (parsed.text ?? '').replaceAll('\0', '');
  if (Buffer.byteLength(html) + Buffer.byteLength(text) > 2 * 1024 * 1024)
    throw new Error('draft_too_large');
  let preserve = false;
  new Parser({
    onopentag: (tag, attrs) => {
      if (
        ![
          'html',
          'head',
          'body',
          'p',
          'br',
          'strong',
          'b',
          'em',
          'i',
          's',
          'strike',
          'ul',
          'ol',
          'li',
          'blockquote',
          'a',
          'div',
        ].includes(tag) ||
        Object.keys(attrs).some(
          (key) => !(tag === 'a' && ['href', 'target', 'rel'].includes(key)),
        )
      )
        preserve = true;
    },
  }).end(html);
  const safe = sanitizeMessage(html);
  const images: { position: number; content_type: string; data: Buffer }[] = [];
  for (const [position, resource] of safe.resources.entries())
    if (resource.kind === 'inline') {
      const file = parsed.attachments.find(
        (file) => file.contentId?.replace(/^<|>$/g, '') === resource.cid,
      );
      if (!file || !rasterType(file.content))
        throw new Error('unsupported_draft_image');
      images.push({
        position,
        content_type: rasterType(file.content) ?? '',
        data: file.content,
      });
    }
  // Complex received HTML stays outside the editor, using the existing isolated preview.
  const original =
    html && preserve
      ? {
          ...forwardContent(
            { html: safe.html, text: text || htmlText(safe.html) },
            safe.resources,
            images,
          ),
          origin: 'provider' as const,
        }
      : null;
  const content = cleanDraft({
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    subject: field(parsed.subject ?? ''),
    format: html ? 'rich' : 'plain',
    html: original ? '<p></p>' : html,
    text: original ? '' : text,
  });
  if (
    [content.to, content.cc, content.bcc].some(
      (value) => value.length > 4000,
    ) ||
    content.subject.length > 1000 ||
    content.html.length > 100000 ||
    content.text.length > 100000 ||
    Buffer.byteLength(JSON.stringify(content)) > 120000
  )
    throw new Error('draft_too_large');
  const files = parsed.attachments
    .filter(
      (file) =>
        file.contentDisposition === 'attachment' ||
        !file.contentId ||
        !safe.resources.some(
          (resource) =>
            resource.kind === 'inline' &&
            resource.cid === file.contentId?.replace(/^<|>$/g, ''),
        ),
    )
    .map((file) => ({
      filename: safeFilename(file.filename, 'attachment'),
      data: file.content,
    }));
  if (
    files.length > 10 ||
    files.some((file) => file.data.length > FILE_BYTES) ||
    files.reduce((sum, file) => sum + file.data.length, 0) > DRAFT_FILE_BYTES
  )
    throw new Error('draft_files_too_large');
  const parent = messageId(parsed.inReplyTo),
    references = referenceIds(parsed.references);
  while (references.length > 30 || references.join(' ').length > 7000)
    references.splice(1, 1);
  const context: ReplyContext | null = parent
    ? {
        kind: 'reply',
        sourceMessageId: '',
        originalSubject: content.subject,
        inReplyTo: parent,
        references,
        warnings: [],
      }
    : null;
  return { content, replyContext: context, forward: original, files };
}
