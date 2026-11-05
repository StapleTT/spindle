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
