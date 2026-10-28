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
