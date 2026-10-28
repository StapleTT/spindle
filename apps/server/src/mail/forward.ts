import { rasterType, remoteImageUrl } from './media.js';
import { type ImageResource, renderMessage } from './sanitize.js';

export type ForwardContent = {
  html: string;
  text: string;
  resources: ImageResource[];
  images: { position: number; type: string; data: string }[];
};

export function forwardContent(
  original: { html: string; text: string },
  resources: ImageResource[],
  images: { position: number; content_type: string; data: Buffer }[],
): ForwardContent {
  const snapshot: ForwardContent = {
    ...original,
    resources,
    images: images
      .filter((image) => resources[image.position]?.kind === 'inline')
      .map((image) => {
        if (rasterType(image.data) !== image.content_type)
          throw new Error(
            'An embedded image is unavailable. Reload the original before forwarding.',
          );
        return {
          position: image.position,
          type: image.content_type,
          data: image.data.toString('base64'),
        };
      }),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 512 * 1024)
    throw new Error(
      'The formatted original exceeds the forwarding size limit. It has not been shortened.',
    );
  return snapshot;
}

export function outgoingForward(original: ForwardContent, operation: string) {
  const attachments = original.images.map((image) => {
    const content = Buffer.from(image.data, 'base64');
    if (rasterType(content) !== image.type)
      throw new Error('An embedded image is invalid. Recreate this forward.');
    return {
      cid: `forward-${operation}-${image.position}@spindle`,
      filename: `image-${image.position}.${image.type.split('/')[1]}`,
      content,
      contentType: image.type,
      contentDisposition: 'inline' as const,
    };
  });
  return {
    html: renderMessage(
      original.html,
      (index) => {
        const resource = original.resources[index];
        if (resource?.kind === 'remote') return remoteImageUrl(resource.url);
        const image =
          attachments[
            original.images.findIndex((image) => image.position === index)
          ];
        return image ? `cid:${image.cid}` : null;
      },
      original.resources.length,
    ),
    attachments,
  };
}
