import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import type { AuthConfig } from '../auth/config.js';

export const mailTopics = [
  'mail',
  'accounts',
  'actions',
  'outbox',
  'drafts',
  'files',
  'searches',
] as const;
type Topic = (typeof mailTopics)[number];
type Stream = { close: () => void; poke: (topic: Topic) => void };
const channel = 'spindle_mail_changed';

export function registerMailEvents(
  app: FastifyInstance,
  pool: Pool,
  config: AuthConfig,
) {
  const streams = new Map<string, Set<Stream>>();
  let listener: PoolClient | undefined,
    opening: Promise<void> | undefined,
    stopping = false,
    total = 0;
  function closeStreams() {
    for (const group of streams.values())
      for (const stream of [...group]) stream.close();
  }
  async function listen() {
    if (listener) return;
    if (opening) return opening;
    opening = (async () => {
      const client = await pool.connect();
      const lost = () => {
        if (listener !== client) return;
        listener = undefined;
        closeStreams();
        client.release(true);
      };
      client.on('error', lost);
      client.on('end', lost);
      client.on('notification', (message) => {
        if (message.channel !== channel || !message.payload) return;
        try {
          const data: unknown = JSON.parse(message.payload);
          if (
            !Array.isArray(data) ||
            data.length !== 2 ||
            typeof data[0] !== 'string' ||
            !mailTopics.includes(data[1])
          )
            return;
          for (const stream of streams.get(data[0]) ?? []) stream.poke(data[1]);
        } catch {
          /* Malformed notifications never become client data. */
        }
      });
      try {
        await client.query(`LISTEN ${channel}`);
        if (stopping) {
          client.release(true);
          return;
        }
        listener = client;
      } catch (error) {
        client.release(true);
        throw error;
      }
    })().finally(() => {
      opening = undefined;
    });
    return opening;
  }
  app.addHook('preClose', async () => {
    stopping = true;
    closeStreams();
    if (opening) await opening.catch(() => {});
    const client = listener;
    listener = undefined;
    client?.release(true);
  });
  app.get(
    '/api/mail/events',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {},
        },
      },
    },
    async (request, reply) => {
      const owner = request.mailUser ?? '',
        session = request.mailSession ?? '';
      if (request.raw.url?.includes('?'))
        return reply
          .code(400)
          .send({ message: 'Event streams do not accept query parameters.' });
      if (
        (request.headers.origin && request.headers.origin !== config.appUrl) ||
        (request.headers['sec-fetch-site'] &&
          !['same-origin', 'none'].includes(
            String(request.headers['sec-fetch-site']),
          ))
      )
        return reply
          .code(403)
          .send({ message: 'Request origin is not allowed.' });
      const last = request.headers['last-event-id'];
      if (
        last !== undefined &&
        (typeof last !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d{0,14}$/.test(
            last,
          ))
      )
        return reply.code(400).send({ message: 'Invalid event cursor.' });
      try {
        await listen();
      } catch {
        return reply
          .code(503)
          .send({ message: 'Live updates are temporarily unavailable.' });
      }
      if (stopping || !listener)
        return reply
          .code(503)
          .send({ message: 'Live updates are restarting.' });
      if (total >= 100 || (streams.get(owner)?.size ?? 0) >= 4)
        return reply
          .header('retry-after', '5')
          .code(429)
          .send({ message: 'Live update connection limit reached.' });
      const response = reply.raw;
      if (response.destroyed) return reply;
      let closed = false,
        busy = false,
        first = true,
        sequence = 0,
        lastHeartbeat = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined,
        nextTickAt = 0;
      const id = randomUUID(),
        pending = new Set<Topic>(mailTopics);
      const group = streams.get(owner) ?? new Set<Stream>();
      streams.set(owner, group);
      function close() {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        group.delete(stream);
        total--;
        if (!group.size) streams.delete(owner);
        response.end();
      }
      function write(frame: string) {
        if (closed || response.destroyed) return false;
        if (!response.write(frame)) {
          close();
          response.destroy();
          return false;
        }
        return true;
      }
      function schedule(delay = 2000) {
        if (!closed && !busy) {
          const at = Date.now() + delay;
          if (timer && nextTickAt <= at) return;
          clearTimeout(timer);
          nextTickAt = at;
          timer = setTimeout(() => {
            timer = undefined;
            nextTickAt = 0;
            void tick();
          }, delay);
          timer.unref();
        }
      }
      const stream: Stream = {
        close,
        poke: (topic) => {
          pending.add(topic);
          schedule(100);
        },
      };
      group.add(stream);
      total++;
      response.on('close', close);
      response.on('error', close);
      async function tick() {
        if (closed || busy) return;
        busy = true;
        try {
          const valid = (
            await pool.query(
              `SELECT 1 FROM auth_sessions s JOIN users u ON u.id=s.user_id
          WHERE s.id=$1 AND s.user_id=$2 AND s.expires_at>clock_timestamp() AND u.email_verified`,
              [session, owner],
            )
          ).rowCount;
          if (closed) return;
          if (!valid) {
            write('event: session-ended\ndata: {}\n\n');
            close();
            return;
          }
          if (first || pending.size) {
            const topics = [...pending];
            pending.clear();
            if (
              !write(
                `id: ${id}:${++sequence}\nevent: ${first ? 'reset' : 'change'}\ndata: ${JSON.stringify({ topics })}\n\n`,
              )
            )
              return;
            first = false;
            lastHeartbeat = Date.now();
          } else if (Date.now() - lastHeartbeat >= 15000) {
            if (!write(': keepalive\n\n')) return;
            lastHeartbeat = Date.now();
          }
        } catch {
          close();
        } finally {
          busy = false;
          schedule(pending.size ? 100 : 2000);
        }
      }
      // Headers/cookies are authorized above; the stream never accepts owner or bearer query parameters.
      reply.hijack();
      for (const [name, value] of Object.entries(reply.getHeaders()))
        if (value !== undefined) response.setHeader(name, value);
      response.setHeader('content-type', 'text/event-stream; charset=utf-8');
      response.setHeader('cache-control', 'private, no-store, no-transform');
      response.setHeader('x-accel-buffering', 'no');
      response.setHeader('connection', 'keep-alive');
      response.writeHead(200);
      write('retry: 5000\n\n');
      const lifetime = setTimeout(close, 300000);
      lifetime.unref();
      response.once('close', () => clearTimeout(lifetime));
      schedule(0);
    },
  );
}
