import http from 'node:http';
import https from 'node:https';
import { MAX_IMAGE_BYTES, rasterType, remoteImageUrl } from './media.js';
import { resolveMailHost } from './network.js';

export async function fetchRemoteImage(
  input: string,
  redirects = 0,
  signal = AbortSignal.timeout(15000),
): Promise<{ type: string; data: Buffer }> {
  const normalized = remoteImageUrl(input);
  if (!normalized || redirects > 3)
    throw new Error('Image destination rejected');
  const url = new URL(normalized);
  const address = await resolveMailHost(url.hostname.replace(/^\[|\]$/g, ''));
  signal.throwIfAborted();
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: address,
        port: url.protocol === 'https:' ? 443 : 80,
        servername: url.hostname,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        headers: {
          host: url.host,
          accept: 'image/png,image/jpeg,image/gif,image/webp',
          'user-agent': 'Spindle image proxy',
        },
        agent: false,
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        signal,
      },
      (response) => {
        void (async () => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
            const location = response.headers.location;
            response.destroy();
            if (!location) throw new Error('Invalid image redirect');
            return resolve(
              await fetchRemoteImage(
                new URL(location, url).href,
                redirects + 1,
                signal,
              ),
            );
          }
          if (
            response.statusCode !== 200 ||
            Number(response.headers['content-length'] ?? 0) > MAX_IMAGE_BYTES
          ) {
            response.destroy();
            throw new Error('Image unavailable');
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          for await (const chunk of response) {
            const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += value.length;
            if (bytes > MAX_IMAGE_BYTES) {
              response.destroy();
              throw new Error('Image size limit');
            }
            chunks.push(value);
          }
          const data = Buffer.concat(chunks);
          const type = rasterType(data);
          if (!type) throw new Error('Unsupported image');
          resolve({ type, data });
        })().catch(reject);
      },
    );
    request.on('error', () => reject(new Error('Image fetch failed')));
    request.end();
  });
}
