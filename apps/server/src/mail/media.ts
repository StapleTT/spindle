import type { MessageStructureObject } from 'imapflow';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function rasterType(data: Buffer) {
  if (
    data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (data[0] === 255 && data[1] === 216 && data[2] === 255)
    return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(data.subarray(0, 6).toString('ascii')))
    return 'image/gif';
  if (
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export function remoteImageUrl(value: string) {
  try {
    if (value.length > 2048) return null;
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 100;

export type AttachmentInfo = {
  part: string;
  filename: string;
  contentType: string;
  size: number;
};

export function safeFilename(value: string | undefined, fallback: string) {
  const name = Array.from(
    (value ?? '')
      .normalize('NFC')
      // Controls, bidi overrides (extension spoofing) and path/shell-hostile characters.
      .replace(/[\p{Cc}\p{Cf}/\\:*?"<>|]/gu, '_')
      .replace(/^[\s.]+|[\s.]+$/g, ''),
  )
    .slice(0, 200)
    .join('');
  return name || fallback;
}

export function listAttachments(root: MessageStructureObject | undefined) {
  const found: AttachmentInfo[] = [];
  const visit = (node: MessageStructureObject, depth: number) => {
    if (found.length >= MAX_ATTACHMENTS || depth > 20) return;
    const type = node.type.toLowerCase();
    if (node.childNodes?.length && type !== 'message/rfc822') {
      for (const child of node.childNodes) visit(child, depth + 1);
      return;
    }
    const name = node.dispositionParameters?.filename ?? node.parameters?.name;
    // Content-ID parts are embedded body resources unless explicitly attached.
    if (
      node.disposition?.toLowerCase() !== 'attachment' &&
      type !== 'message/rfc822' &&
      (!name || node.id)
    )
      return;
    const size = Math.max(0, Math.floor(node.size ?? 0));
    found.push({
      // A single-part message has no part number; IMAP addresses its body as part 1.
      part: node.part ?? '1',
      filename: safeFilename(
        name,
        type === 'message/rfc822' ? 'message.eml' : 'attachment',
      ),
      contentType: /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(
        type,
      )
        ? type
        : 'application/octet-stream',
      // Base64 is normally wrapped as 76 characters plus CRLF per 57 decoded bytes.
      size:
        node.encoding?.toLowerCase() === 'base64'
          ? Math.floor((size * 57) / 78)
          : size,
    });
  };
  if (root) visit(root, 0);
  return found;
}

export function attachmentDisposition(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
