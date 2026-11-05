import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { GoogleConfig } from '../src/mail/google.js';
import { testConfig } from './auth-fixture.js';

export type FakeMessage = {
  labels: Set<string>;
  internalDate: number;
  headers: Record<string, string>;
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
  const accessTokens = new Map<string, Identity>();
  const revoked: string[] = [];
  const listCalls: { pageToken?: string; q?: string }[] = [];
  const messages = new Map<string, FakeMessage>();
  const history: Record<string, unknown>[] = [];
  const state = {
    historyId: 1000,
    minHistoryId: 0,
    failPageToken: false,
    // Gmail's per-user quota: 250 units/s, messages.get costs 5 units.
    getsPerSecond: 50,
    exhausted: false,
    gets: 0,
    peakPerSecond: 0,
  };
  // Browser consent: approves as `state.consent` and returns to Spindle.
  const consent: { identity: Identity | null } = { identity: null };
  const window = { second: 0, count: 0 };
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
        accessTokens.set(access, code.identity);
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
      accessTokens.set(access, identity);
      return { access_token: access };
    },
  );
  app.post<{ Body: Record<string, string> }>('/revoke', async (request) => {
    revoked.push(request.body.token ?? '');
    refreshTokens.delete(request.body.token ?? '');
    return {};
  });
  const identity = (authorization?: string) =>
    accessTokens.get((authorization ?? '').replace(/^Bearer /, ''));
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
    const ids = [...messages.entries()]
      .filter(([, message]) => message.internalDate > after)
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
      assert.equal(request.query.format, 'metadata');
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
      return resource(request.params.id, message);
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
  };
  const record = (entry: Record<string, unknown>) => {
    state.historyId += 1;
    history.push({ id: String(state.historyId), ...entry });
  };
  return {
    app,
    config,
    consent,
    codes,
    refreshTokens,
    revoked,
    listCalls,
    messages,
    state,
    record,
  };
}
