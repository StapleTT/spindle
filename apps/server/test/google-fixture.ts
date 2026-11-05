import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { GoogleConfig } from '../src/mail/google.js';
import { testConfig } from './auth-fixture.js';

export type FakeMessage = {
  labels: Set<string>;
  internalDate: number;
  headers: Record<string, string>;
  // Full RFC 5322 source for format=raw; defaults to the headers plus a body.
  raw?: string;
};
export type Identity = { sub: string; email: string };

// Synthetic Google: OAuth, userinfo, revocation and the Gmail endpoints the
// worker uses. No real accounts, tokens or mail.
export async function fakeGoogle(appUrl = testConfig.appUrl) {
  const codes = new Map<
    string,
    { identity: Identity; scope: string; refresh?: string; challenge: string }
  >();
  const refreshTokens = new Map<string, Identity>();
  // Access token -> identity and the refresh token it came from. As at
  // Google, revoking that refresh token invalidates its access tokens.
  const accessTokens = new Map<
    string,
    { identity: Identity; refresh?: string | undefined }
  >();
  let refreshes = 0;
  const revoked: string[] = [];
  const listCalls: { pageToken?: string; q?: string }[] = [];
  const messages = new Map<string, FakeMessage>();
  const history: Record<string, unknown>[] = [];
  const state = {
    historyId: 1000,
    minHistoryId: 0,
    failPageToken: false,
    send: 'ok' as 'ok' | 'reject' | 'rate' | 'lost',
    modifies: [] as { id: string; add: string[]; remove: string[] }[],
    // Gmail's per-user quota: 250 units/s, messages.get costs 5 units.
    getsPerSecond: 50,
    exhausted: false,
    gets: 0,
    peakPerSecond: 0,
  };
  // Browser consent: approves as `state.consent` and returns to Spindle.
  const consent: { identity: Identity | null } = { identity: null };
  const window = { second: 0, count: 0 };
  const sent: string[] = [];
  const app = Fastify();
  app.get<{ Querystring: Record<string, string> }>(
    '/auth',
    async (request, reply) => {
      const query = request.query;
      if (
        !consent.identity ||
        query.redirect_uri !== `${appUrl}/api/mail/oauth/google/callback`
      )
        return reply.code(400).send('Unexpected authorization request');
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        identity: consent.identity,
        scope: query.scope ?? '',
        refresh: `refresh-${randomUUID()}`,
        challenge: query.code_challenge ?? '',
      });
      return reply.redirect(
        `${query.redirect_uri}?${new URLSearchParams({ state: query.state ?? '', code })}`,
        302,
      );
    },
  );
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.post<{ Body: Record<string, string> }>(
    '/token',
    async (request, reply) => {
      const body = request.body;
      if (
        body.client_id !== 'fake-client' ||
        body.client_secret !== 'fake-secret'
      )
        return reply.code(401).send({ error: 'invalid_client' });
      if (body.grant_type === 'authorization_code') {
        const code = codes.get(body.code ?? '');
        codes.delete(body.code ?? '');
        if (
          !code ||
          body.redirect_uri !== `${appUrl}/api/mail/oauth/google/callback` ||
          createHash('sha256')
            .update(body.code_verifier ?? '')
            .digest('base64url') !== code.challenge
        )
          return reply.code(400).send({ error: 'invalid_grant' });
        const access = `access-${randomUUID()}`;
        accessTokens.set(access, {
          identity: code.identity,
          refresh: code.refresh,
        });
        if (code.refresh) refreshTokens.set(code.refresh, code.identity);
        return {
          access_token: access,
          scope: code.scope,
          ...(code.refresh ? { refresh_token: code.refresh } : {}),
        };
      }
      const identity = refreshTokens.get(body.refresh_token ?? '');
      if (body.grant_type !== 'refresh_token' || !identity)
        return reply.code(400).send({ error: 'invalid_grant' });
      const access = `access-${randomUUID()}`;
      accessTokens.set(access, { identity, refresh: body.refresh_token });
      refreshes++;
      return { access_token: access, expires_in: 3599 };
    },
  );
  app.post<{ Body: Record<string, string> }>('/revoke', async (request) => {
    revoked.push(request.body.token ?? '');
    refreshTokens.delete(request.body.token ?? '');
    return {};
  });
  const identity = (authorization?: string) => {
    const entry = accessTokens.get(
      (authorization ?? '').replace(/^Bearer /, ''),
    );
    return entry && (!entry.refresh || refreshTokens.has(entry.refresh))
      ? entry.identity
      : undefined;
  };
  app.get('/userinfo', async (request, reply) => {
    const user = identity(request.headers.authorization);
    if (!user) return reply.code(401).send({ error: 'invalid_token' });
    return { sub: user.sub, email: user.email, email_verified: true };
  });
  app.addHook('onRequest', async (request, reply) => {
    if (
      request.url.startsWith('/gmail/') &&
      !identity(request.headers.authorization)
    )
      return reply.code(401).send({ error: { code: 401 } });
  });
  const resource = (id: string, message: FakeMessage) => ({
    id,
    threadId: id,
    labelIds: [...message.labels],
    internalDate: String(message.internalDate),
    sizeEstimate: 1234,
    payload: {
      headers: Object.entries(message.headers).map(([name, value]) => ({
        name,
        value,
      })),
    },
  });
  app.get('/gmail/profile', async () => ({
    emailAddress: 'owner@gmail.test',
    historyId: String(state.historyId),
  }));
  app.get('/gmail/labels', async () => ({
    labels: [
      ...[
        'INBOX',
        'SENT',
        'DRAFT',
        'SPAM',
        'TRASH',
        'UNREAD',
        'STARRED',
        'IMPORTANT',
        'CATEGORY_PERSONAL',
      ].map((id) => ({ id, name: id, type: 'system' })),
      { id: 'Label_1', name: 'Receipts 日本', type: 'user' },
    ],
  }));
  app.get<{
    Querystring: { pageToken?: string; q?: string; maxResults?: string };
  }>('/gmail/messages', async (request) => {
    const { pageToken, q } = request.query;
    listCalls.push({
      ...(pageToken ? { pageToken } : {}),
      ...(q ? { q } : {}),
    });
    if (pageToken && state.failPageToken) {
      // A non-retryable failure mid-listing stands in for a worker crash.
      state.failPageToken = false;
      return { messages: 'malformed' };
    }
    const after = Number(q?.match(/^after:(\d+)$/)?.[1] ?? 0) * 1000;
    const rfc822 = q?.match(/^rfc822msgid:(.+)$/)?.[1];
    const ids = [...messages.entries()]
      .filter(([, message]) =>
        rfc822
          ? message.headers['Message-Id'] === `<${rfc822}>`
          : message.internalDate > after,
      )
      .sort((a, b) => b[1].internalDate - a[1].internalDate)
      .map(([id]) => id);
    const offset = Number(pageToken ?? 0);
    const size = Number(request.query.maxResults ?? 100);
    const page = ids.slice(offset, offset + size);
    return {
      messages: page.map((id) => ({ id, threadId: id })),
      ...(offset + size < ids.length
        ? { nextPageToken: String(offset + size) }
        : {}),
    };
  });
  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/gmail/messages/:id',
    async (request, reply) => {
      assert.ok(['metadata', 'raw'].includes(request.query.format ?? ''));
      const second = Math.floor(Date.now() / 1000);
      if (second !== window.second) Object.assign(window, { second, count: 0 });
      window.count++;
      state.peakPerSecond = Math.max(state.peakPerSecond, window.count);
      if (state.exhausted || window.count > state.getsPerSecond)
        return reply
          .code(429)
          .header('retry-after', '1')
          .send({
            error: {
              code: 429,
              status: 'RESOURCE_EXHAUSTED',
              message: 'User-rate limit exceeded. Synthetic detail text.',
              errors: [{ reason: 'rateLimitExceeded' }],
            },
          });
      state.gets++;
      const message = messages.get(request.params.id);
      if (!message) return reply.code(404).send({ error: { code: 404 } });
      if (request.query.format === 'raw')
        return {
          id: request.params.id,
          raw: Buffer.from(
            message.raw ??
              `${Object.entries(message.headers)
                .map(([name, value]) => `${name}: ${value}`)
                .join(
                  '\r\n',
                )}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSynthetic body for ${request.params.id}\r\n`,
          ).toString('base64url'),
        };
      return resource(request.params.id, message);
    },
  );
  const known = new Set([
    'INBOX',
    'SENT',
    'DRAFT',
    'SPAM',
    'TRASH',
    'UNREAD',
    'STARRED',
    'IMPORTANT',
    'CATEGORY_PERSONAL',
    'Label_1',
  ]);
  const modified = (id: string, add: string[], remove: string[]) => {
    const message = messages.get(id);
    if (!message) return null;
    for (const label of remove) message.labels.delete(label);
    for (const label of add) message.labels.add(label);
    const entry = { message: { id } };
    record({
      ...(add.length ? { labelsAdded: [{ ...entry, labelIds: add }] } : {}),
      ...(remove.length
        ? { labelsRemoved: [{ ...entry, labelIds: remove }] }
        : {}),
    });
    state.modifies.push({ id, add, remove });
    return resource(id, message);
  };
  app.post<{
    Params: { id: string };
    Body: { addLabelIds?: string[]; removeLabelIds?: string[] };
  }>('/gmail/messages/:id/modify', async (request, reply) => {
    if (state.exhausted)
      return reply
        .code(429)
        .header('retry-after', '1')
        .send({
          error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] },
        });
    const add = request.body.addLabelIds ?? [];
    const remove = request.body.removeLabelIds ?? [];
    if (!add.length && !remove.length)
      return reply.code(400).send({ error: { code: 400 } });
    if ([...add, ...remove].some((label) => !known.has(label)))
      return reply.code(400).send({ error: { code: 400 } });
    return (
      modified(request.params.id, add, remove) ??
      reply.code(404).send({ error: { code: 404 } })
    );
  });
  app.post<{ Params: { id: string } }>(
    '/gmail/messages/:id/trash',
    async (request, reply) =>
      modified(request.params.id, ['TRASH'], ['INBOX']) ??
      reply.code(404).send({ error: { code: 404 } }),
  );
  app.post<{ Params: { id: string } }>(
    '/gmail/messages/:id/untrash',
    async (request, reply) =>
      modified(request.params.id, [], ['TRASH']) ??
      reply.code(404).send({ error: { code: 404 } }),
  );
  app.get('/gmail/settings/sendAs', async () => ({
    sendAs: [
      {
        sendAsEmail: 'owner@gmail.test',
        displayName: 'Synthetic Owner',
        isDefault: true,
        isPrimary: true,
      },
    ],
  }));
  // Media upload of the exact MIME snapshot. `send` chooses the outcome.
  app.addContentTypeParser(
    'message/rfc822',
    { parseAs: 'buffer', bodyLimit: 40 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.post<{ Body: Buffer; Querystring: { uploadType?: string } }>(
    '/upload/gmail/messages/send',
    async (request, reply) => {
      assert.equal(request.query.uploadType, 'media');
      const mode = state.send;
      if (mode === 'reject')
        return reply.code(400).send({ error: { code: 400 } });
      if (mode === 'rate')
        return reply.code(429).send({ error: { code: 429 } });
      const id = `sent${sent.length}`;
      sent.push(request.body.toString());
      const messageId =
        request.body.toString().match(/^Message-ID: (<[^>]+>)/im)?.[1] ?? '';
      messages.set(id, {
        labels: new Set(['SENT']),
        internalDate: Date.now(),
        headers: { 'Message-Id': messageId, Subject: 'sent' },
      });
      // Sent, but the response is lost: delivery must stay unknown.
      if (mode === 'lost')
        return reply.code(503).send({ error: { code: 503 } });
      return { id, threadId: id, labelIds: ['SENT'] };
    },
  );
  app.get<{ Querystring: { startHistoryId: string } }>(
    '/gmail/history',
    async (request, reply) => {
      const start = Number(request.query.startHistoryId);
      if (start < state.minHistoryId)
        return reply.code(404).send({ error: { code: 404 } });
      return {
        history: history.filter((record) => Number(record.id) > start),
        historyId: String(state.historyId),
      };
    },
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const config: GoogleConfig = {
    clientId: 'fake-client',
    clientSecret: 'fake-secret',
    authUrl: `${base}/auth`,
    tokenUrl: `${base}/token`,
    revokeUrl: `${base}/revoke`,
    userinfoUrl: `${base}/userinfo`,
    gmailUrl: `${base}/gmail`,
    uploadUrl: `${base}/upload/gmail`,
  };
  const record = (entry: Record<string, unknown>) => {
    state.historyId += 1;
    history.push({ id: String(state.historyId), ...entry });
  };
  return {
    app,
    config,
    consent,
    sent,
    refreshCount: () => refreshes,
    codes,
    refreshTokens,
    revoked,
    listCalls,
    messages,
    state,
    record,
  };
}
