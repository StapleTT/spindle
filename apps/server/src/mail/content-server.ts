import Fastify from 'fastify';
import type { Pool } from 'pg';
import { loggerOptions } from '../logger.js';
import { trimContentCache } from './content-cache.js';
import type { ContentConfig } from './content-config.js';
import type { ForwardContent } from './forward.js';
import {
  type ContentGrant,
  signContentGrant,
  verifyContentGrant,
} from './grants.js';
import { fetchRemoteImage } from './image-proxy.js';
import {
  type AttachmentInfo,
  attachmentDisposition,
  MAX_IMAGE_BYTES,
  rasterType,
} from './media.js';
import {
  type ImageResource,
  renderMessage,
  SANITIZER_VERSION,
} from './sanitize.js';
import { consumeLimit, transaction } from './store.js';

export type CachedContent = {
  user_id: string;
  account_id: string;
  message_id: string;
  version: string;
  html: string;
  resources: ImageResource[];
  attachments: AttachmentInfo[];
};

async function grantedContent(pool: Pool, grant: ContentGrant) {
  return (
    await pool.query<CachedContent>(
      `SELECT c.* FROM mail_content c JOIN users u ON u.id=c.user_id
    JOIN auth_sessions s ON s.user_id=c.user_id AND s.id=$4
    WHERE c.user_id=$1 AND c.message_id=$2 AND c.version=$3 AND c.state='ready'
    AND c.sanitizer_version=${SANITIZER_VERSION} AND c.expires_at>clock_timestamp() AND s.expires_at>clock_timestamp() AND u.email_verified
    AND EXISTS(SELECT 1 FROM mail_memberships mm WHERE mm.user_id=c.user_id AND mm.account_id=c.account_id AND mm.message_id=c.message_id)`,
      [grant.owner, grant.message, grant.version, grant.session],
    )
  ).rows[0];
}

async function grantedForward(
  pool: Pool,
  grant: ContentGrant,
): Promise<ForwardContent | null> {
  return (
    (
      await pool.query(
        `SELECT d.forward_content FROM mail_drafts d JOIN users u ON u.id=d.user_id
    JOIN auth_sessions s ON s.user_id=d.user_id AND s.id=$4
    WHERE d.user_id=$1 AND d.id::text=$2 AND d.id::text=$3
    AND d.forward_content IS NOT NULL AND s.expires_at>clock_timestamp() AND u.email_verified`,
        [grant.owner, grant.message, grant.version, grant.session],
      )
    ).rows[0]?.forward_content ?? null
  );
}

export function forwardBodyUrl(
  config: ContentConfig,
  owner: string,
  session: string,
  draft: string,
  images = false,
) {
  const token = signContentGrant(
    {
      owner,
      session,
      message: draft,
      version: draft,
      images,
      kind: 'forward-body',
    },
    config.secret,
  );
  return `${config.origin}/forward?token=${token}`;
}

function htmlDocument(html: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px/1.55 system-ui,sans-serif;margin:0;color:#202124;background:#fff;overflow-wrap:anywhere}img{max-width:100%}pre{white-space:pre-wrap}</style></head><body>${html}</body></html>`;
}

export function bodyUrl(
  config: ContentConfig,
  owner: string,
  session: string,
  message: string,
  version: string,
  images = false,
) {
  const token = signContentGrant(
    { owner, session, message, version, images, kind: 'body' },
    config.secret,
  );
  return `${config.origin}/body?token=${token}`;
}

export function attachmentUrl(
  config: ContentConfig,
  owner: string,
  session: string,
  message: string,
  version: string,
  attachment: number,
) {
  const token = signContentGrant(
    {
      owner,
      session,
      message,
      version,
      images: false,
      kind: 'attachment',
      attachment,
    },
    config.secret,
  );
  return `${config.origin}/attachment?token=${token}`;
}

export function buildContentApp(
  pool: Pool,
  config: ContentConfig,
  fetchImage = fetchRemoteImage,
) {
  const app = Fastify({
    logger: loggerOptions,
    bodyLimit: 1024,
    ajv: { customOptions: { coerceTypes: false } },
  });
  const inFlight = new Map<string, Promise<{ type: string; data: Buffer }>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  function queueImage(load: () => Promise<{ type: string; data: Buffer }>) {
    return new Promise<{ type: string; data: Buffer }>((resolve, reject) => {
      const release = () => {
        active--;
        waiting.shift()?.();
      };
      const start = () => {
        active++;
        void load().then(
          (image) => {
            release();
            resolve(image);
          },
          (error: unknown) => {
            release();
            reject(error);
          },
        );
      };
      if (active < 8) start();
      else waiting.push(start);
    });
  }
  app.addHook('onRequest', async (_request, reply) => {
    reply.headers({
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'cross-origin',
      'x-dns-prefetch-control': 'off',
      'permissions-policy':
        'camera=(), microphone=(), geolocation=(), payment=()',
      'content-security-policy': `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src ${config.origin}; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${config.appOrigin}; sandbox allow-popups allow-popups-to-escape-sandbox`,
    });
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(500).type('text/plain').send('Content unavailable.'),
  );
  const query = {
    type: 'object',
    additionalProperties: false,
    required: ['token'],
    properties: {
      token: { type: 'string', minLength: 1, maxLength: 2048 },
      index: { type: 'string', pattern: '^(?:[0-9]|1[0-9])$' },
    },
  };
  app.get<{ Querystring: { token: string } }>(
    '/body',
    { schema: { querystring: query } },
    async (request, reply) => {
      const grant = verifyContentGrant(request.query.token, config.secret);
      if (grant?.kind !== 'body')
        return reply
          .code(403)
          .type('text/plain')
          .send('Content permission expired. Reopen the message.');
      const content = await grantedContent(pool, grant);
      if (!content)
        return reply
          .code(404)
          .type('text/plain')
          .send('Content is no longer available.');
      if (!(await consumeLimit(pool, grant.owner, 'content-body', 120)))
        return reply.code(429).send('Too many requests.');
      const imageToken = grant.images
        ? signContentGrant({ ...grant, kind: 'image' }, config.secret)
        : null;
      const html = renderMessage(
        content.html,
        imageToken
          ? (index) =>
              `${config.origin}/image?token=${imageToken}&index=${index}`
          : null,
        content.resources.length,
      );
      return reply.type('text/html; charset=utf-8').send(htmlDocument(html));
    },
  );
  app.get<{ Querystring: { token: string } }>(
    '/forward',
    { schema: { querystring: query } },
    async (request, reply) => {
      const grant = verifyContentGrant(request.query.token, config.secret);
      if (grant?.kind !== 'forward-body')
        return reply
          .code(403)
          .send('Forward preview permission expired. Reopen the draft.');
      const content = await grantedForward(pool, grant);
      if (!content)
        return reply
          .code(404)
          .send('Forwarded original is no longer available.');
      if (!(await consumeLimit(pool, grant.owner, 'content-body', 120)))
        return reply.code(429).send('Too many requests.');
      const imageToken = grant.images
        ? signContentGrant({ ...grant, kind: 'forward-image' }, config.secret)
        : null;
      const html = renderMessage(
        content.html,
        imageToken
          ? (index) =>
              `${config.origin}/forward-image?token=${imageToken}&index=${index}`
          : null,
        content.resources.length,
      );
      return reply.type('text/html; charset=utf-8').send(htmlDocument(html));
    },
  );
  app.get<{ Querystring: { token: string; index?: string } }>(
    '/forward-image',
    { schema: { querystring: query } },
    async (request, reply) => {
      const grant = verifyContentGrant(request.query.token, config.secret);
      if (
        grant?.kind !== 'forward-image' ||
        !grant.images ||
        request.query.index === undefined
      )
        return reply.code(403).send('Image permission required.');
      const content = await grantedForward(pool, grant);
      const index = Number(request.query.index),
        resource = content?.resources[index];
      if (!content || !resource)
        return reply.code(404).send('Image unavailable.');
      if (!(await consumeLimit(pool, grant.owner, 'content-image', 120)))
        return reply.code(429).send('Too many image requests.');
      const key = `forward:${grant.owner}:${grant.message}:${index}`;
      let pending: Promise<{ type: string; data: Buffer }>;
      if (resource.kind === 'inline') {
        const image = content.images.find((image) => image.position === index);
        if (!image) return reply.code(404).send('Image unavailable.');
        pending = Promise.resolve({
          type: image.type,
          data: Buffer.from(image.data, 'base64'),
        });
      } else {
        if (!inFlight.has(key) && inFlight.size >= 32)
          return reply.code(429).send('Image proxy is busy. Try again.');
        pending =
          inFlight.get(key) ??
          queueImage(async () => {
            if (!(await grantedForward(pool, grant)))
              throw new Error('Image permission expired');
            return fetchImage(resource.url);
          });
        inFlight.set(key, pending);
      }
      try {
        const image = await pending;
        if (!(await grantedForward(pool, grant)))
          return reply.code(404).send('Image unavailable.');
        if (
          image.data.length > MAX_IMAGE_BYTES ||
          rasterType(image.data) !== image.type
        )
          throw new Error('Invalid image');
        return reply.type(image.type).send(image.data);
      } catch {
        return reply.code(404).send('Image unavailable.');
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    },
  );
  app.get<{ Querystring: { token: string } }>(
    '/attachment',
    { schema: { querystring: query } },
    async (request, reply) => {
      const grant = verifyContentGrant(request.query.token, config.secret);
      if (grant?.kind !== 'attachment' || grant.attachment === undefined)
        return reply
          .code(403)
          .type('text/plain')
          .send('Download permission expired. Reopen the message.');
      const content = await grantedContent(pool, grant);
      const info = content?.attachments[grant.attachment];
      if (!info)
        return reply
          .code(404)
          .type('text/plain')
          .send('Attachment is no longer available.');
      if (!(await consumeLimit(pool, grant.owner, 'content-attachment', 60)))
        return reply.code(429).type('text/plain').send('Too many downloads.');
      const file = (
        await pool.query<{ data: Buffer }>(
          `SELECT data FROM mail_content_attachments WHERE user_id=$1 AND message_id=$2 AND position=$3 AND state='ready'`,
          [grant.owner, grant.message, grant.attachment],
        )
      ).rows[0];
      if (!file)
        return reply
          .code(404)
          .type('text/plain')
          .send('Attachment is no longer available.');
      // Never let the browser render or sniff hostile files: always a download.
      return reply
        .type('application/octet-stream')
        .header('content-disposition', attachmentDisposition(info.filename))
        .send(file.data);
    },
  );
  app.get<{ Querystring: { token: string; index?: string } }>(
    '/image',
    { schema: { querystring: query } },
    async (request, reply) => {
      const grant = verifyContentGrant(request.query.token, config.secret);
      if (
        grant?.kind !== 'image' ||
        !grant.images ||
        request.query.index === undefined
      )
        return reply.code(403).send('Image permission required.');
      const content = await grantedContent(pool, grant);
      if (!content) return reply.code(404).send('Image unavailable.');
      if (!(await consumeLimit(pool, grant.owner, 'content-image', 120)))
        return reply.code(429).send('Too many image requests.');
      const index = Number(request.query.index);
      const resource = content.resources[index];
      if (!resource) return reply.code(404).send('Image unavailable.');
      const cached = (
        await pool.query(
          `SELECT i.content_type,i.data FROM mail_content_images i JOIN mail_content c
            ON c.user_id=i.user_id AND c.message_id=i.message_id
            WHERE i.user_id=$1 AND i.message_id=$2 AND i.position=$3 AND c.version=$4 AND c.sanitizer_version=${SANITIZER_VERSION} AND c.state='ready' AND c.expires_at>clock_timestamp()`,
          [grant.owner, grant.message, index, grant.version],
        )
      ).rows[0];
      if (cached) return reply.type(cached.content_type).send(cached.data);
      if (resource.kind !== 'remote')
        return reply.code(404).send('Image unavailable.');
      const key = `${grant.owner}:${grant.message}:${grant.version}:${index}`;
      if (!inFlight.has(key) && inFlight.size >= 32)
        return reply.code(429).send('Image proxy is busy. Try again.');
      const pending =
        inFlight.get(key) ??
        queueImage(async () => {
          if (!(await grantedContent(pool, grant)))
            throw new Error('Image permission expired');
          return fetchImage(resource.url);
        });
      inFlight.set(key, pending);
      try {
        const image = await pending;
        if (
          image.data.length > MAX_IMAGE_BYTES ||
          rasterType(image.data) !== image.type
        )
          throw new Error('Invalid image');
        const stored = await transaction(pool, async (db) => {
          await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
            grant.owner,
          ]);
          const valid = await db.query(
            `SELECT c.message_id FROM mail_content c JOIN auth_sessions s ON s.user_id=c.user_id
          JOIN users u ON u.id=c.user_id WHERE c.user_id=$1 AND c.message_id=$2 AND c.version=$3 AND c.state='ready'
          AND c.sanitizer_version=${SANITIZER_VERSION} AND c.expires_at>clock_timestamp() AND s.id=$4 AND s.expires_at>clock_timestamp() AND u.email_verified FOR UPDATE OF c`,
            [grant.owner, grant.message, grant.version, grant.session],
          );
          if (!valid.rowCount) return false;
          const inserted = await db.query(
            `INSERT INTO mail_content_images(user_id,account_id,message_id,position,content_type,data)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING position`,
            [
              grant.owner,
              content.account_id,
              grant.message,
              index,
              image.type,
              image.data,
            ],
          );
          if (inserted.rowCount) {
            await db.query(
              'UPDATE mail_content SET byte_size=byte_size+$3 WHERE user_id=$1 AND message_id=$2',
              [grant.owner, grant.message, image.data.length],
            );
            await trimContentCache(db, grant.owner, grant.message);
          }
          return true;
        });
        if (!stored) return reply.code(404).send('Image unavailable.');
        return reply.type(image.type).send(image.data);
      } catch {
        return reply.code(502).send('Image could not be loaded.');
      } finally {
        if (inFlight.get(key) === pending) inFlight.delete(key);
      }
    },
  );
  return app;
}
