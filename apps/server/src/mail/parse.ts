import { simpleParser } from 'mailparser';
import {
  type AttachmentInfo,
  MAX_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  rasterType,
  safeContentType,
  safeFilename,
} from './media.js';
import { replyMetadata } from './reply.js';
import { sanitizeMessage } from './sanitize.js';

export const MAX_RAW_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

// Provider JSON headers use the same bounded parser as MIME headers.
export function headerBlock(headers: unknown, names: string[]) {
  const values = new Map<string, string>();
  for (const header of Array.isArray(headers) ? headers.slice(0, 500) : []) {
    const name =
      typeof header?.name === 'string' ? header.name.toLowerCase() : '';
    if (
      typeof header?.value === 'string' &&
      names.some((wanted) => wanted.toLowerCase() === name) &&
      !values.has(name)
    )
      values.set(name, header.value);
  }
  const block = Buffer.from(
    names
      .flatMap((name) => {
        const value = values.get(name.toLowerCase());
        return value === undefined
          ? []
          : [`${name}: ${value.replace(/[\r\n\0]+/g, ' ').slice(0, 8192)}`];
      })
      .join('\r\n'),
  );
  return { values, block };
}

// Newsletter rule: senders of bulk mail declare RFC 2369 List-Unsubscribe.
export function hasListUnsubscribe(headers: Buffer) {
  return /^list-unsubscribe[ \t]*:/im.test(headers.toString('latin1'));
}

export async function parseReplyHeaders(headers: Buffer) {
  if (headers.length > 64 * 1024) throw new Error('Header size limit');
  return replyMetadata(
    await simpleParser(Buffer.concat([headers, Buffer.from('\r\n\r\n')]), {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipTextLinks: true,
      maxHeadSize: 64 * 1024,
      maxChildNodes: 1,
    }),
  );
}

export async function parseMessage(source: Buffer) {
  if (source.length > MAX_RAW_BYTES) throw new Error('Message size limit');
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: MAX_BODY_BYTES,
    maxHeadSize: 64 * 1024,
    maxChildNodes: 100,
  });
  const plain = (parsed.text ?? '').replace(/\0/g, '');
  const rawHtml =
    typeof parsed.html === 'string' ? parsed.html.replace(/\0/g, '') : '';
  if (Buffer.byteLength(plain) + Buffer.byteLength(rawHtml) > MAX_BODY_BYTES)
    throw new Error('Message body limit');
  const safe = rawHtml ? sanitizeMessage(rawHtml) : { html: '', resources: [] };
  if (Buffer.byteLength(plain) + Buffer.byteLength(safe.html) > MAX_BODY_BYTES)
    throw new Error('Sanitized body size limit');
  const images: { position: number; type: string; data: Buffer }[] = [];
  let imageBytes = 0;
  safe.resources.forEach((resource, position) => {
    if (resource.kind !== 'inline') return;
    const attachment = parsed.attachments.find(
      (part) => part.contentId?.replace(/^<|>$/g, '') === resource.cid,
    );
    if (!attachment || attachment.content.length > MAX_IMAGE_BYTES) return;
    const type = rasterType(attachment.content);
    if (!type || imageBytes + attachment.content.length > 8 * 1024 * 1024)
      return;
    imageBytes += attachment.content.length;
    images.push({ position, type, data: attachment.content });
  });
  const reply = replyMetadata(parsed);
  return {
    reply,
    plain,
    html: safe.html,
    resources: safe.resources,
    images,
    listUnsubscribe: parsed.headers.has('list-unsubscribe'),
    bytes:
      Buffer.byteLength(plain) +
      Buffer.byteLength(safe.html) +
      imageBytes +
      Buffer.byteLength(JSON.stringify(reply)),
  };
}

// Attachments of a raw message, with the selection rules listAttachments
// applies to IMAP body structures: Content-ID parts are embedded resources
// unless explicitly attached. Providers without part addressing (Gmail)
// store the position as `part` and re-read the same raw message to download.
export async function rawAttachments(source: Buffer) {
  if (source.length > MAX_RAW_BYTES) throw new Error('Message size limit');
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipTextLinks: true,
    maxHeadSize: 64 * 1024,
    maxChildNodes: 100,
  });
  return parsed.attachments
    .filter(
      (file) =>
        file.contentDisposition === 'attachment' ||
        file.contentType === 'message/rfc822' ||
        (file.filename && !file.contentId),
    )
    .slice(0, MAX_ATTACHMENTS)
    .map((file, index) => ({
      info: {
        part: String(index),
        filename: safeFilename(
          file.filename,
          file.contentType === 'message/rfc822' ? 'message.eml' : 'attachment',
        ),
        contentType: safeContentType(file.contentType.toLowerCase()),
        size: file.content.length,
      } satisfies AttachmentInfo,
      content: file.content,
    }));
}
