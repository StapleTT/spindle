import { simpleParser } from 'mailparser';
import { MAX_IMAGE_BYTES, rasterType } from './media.js';
import { sanitizeMessage } from './sanitize.js';

export const MAX_RAW_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

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
  const safe = sanitizeMessage(rawHtml);
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
  return {
    plain,
    html: safe.html,
    resources: safe.resources,
    images,
    bytes: Buffer.byteLength(plain) + Buffer.byteLength(safe.html) + imageBytes,
  };
}
