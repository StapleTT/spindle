import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import {
  MICROSOFT_SCOPES,
  type MicrosoftConfig,
} from '../src/mail/microsoft.js';
import { testConfig } from './auth-fixture.js';

export type MicrosoftIdentity = {
  sub: string;
  email: string;
  name?: string;
};
export type GraphMessage = {
  folder: string;
  subject: string;
  received: number;
  read: boolean;
  flagged?: boolean;
  draft?: boolean;
  messageId?: string;
  raw?: string;
  headers?: { name: string; value: string }[];
};

// Synthetic OAuth and Graph only; tokens and mail never leave loopback.
export async function fakeMicrosoft(appUrl = testConfig.appUrl) {
  const app = Fastify();
  let base = '';
  const codes = new Map<
    string,
    {
      identity: MicrosoftIdentity;
      scope: string;
      challenge: string;
      refresh?: string;
    }
  >();
  const refreshTokens = new Map<string, MicrosoftIdentity>();
  const accessTokens = new Map<string, MicrosoftIdentity>();
  const consent: { identity: MicrosoftIdentity | null } = { identity: null };
  const messages = new Map<string, GraphMessage>();
  const folders = new Map(
    [
      ['inbox', 'Inbox'],
      ['sentitems', 'Sent Items'],
      ['drafts', 'Drafts'],
      ['junkemail', 'Junk Email'],
      ['deleteditems', 'Deleted Items'],
      ['archive', 'Archive'],
      ['receipts', 'Receipts 日本'],
    ].map(([id, name]) => [id as string, name as string]),
  );
  const folderAliases = new Map<string, string>();
  const sent: string[] = [];
  const requests: { method: string; url: string }[] = [];
  const changes: {
    version: number;
    folder: string;
    id: string;
    removed: boolean;
  }[] = [];
  const state = {
    version: 1,
    minVersion: 0,
    pageSize: 2,
    failPage: false,
    externalNextLink: false,
    expireFolders: false,
    loseMoveResponse: false,
    exhausted: false,
    send: 'ok' as 'ok' | 'reject' | 'rate' | 'lost',
    sendRetryAfter: 120,
    refreshes: 0,
    modifies: 0,
    moves: 0,
    gets: 0,
  };
  const record = (folder: string, id: string, removed = false) => {
    changes.push({ version: ++state.version, folder, id, removed });
  };
  const resource = (id: string, message: GraphMessage) => ({
    id,
    parentFolderId: message.folder,
    subject: message.subject,
    receivedDateTime: new Date(message.received).toISOString(),
    sentDateTime: new Date(message.received).toISOString(),
    isRead: message.read,
    isDraft: message.draft ?? false,
    flag: { flagStatus: message.flagged ? 'flagged' : 'notFlagged' },
    from: {
      emailAddress: {
        name: 'Synthetic Sender',
        address: 'sender@example.test',
      },
    },
    toRecipients: [
      { emailAddress: { address: 'owner@outlook.test', name: '' } },
    ],
    ccRecipients: [],
    internetMessageId: message.messageId ?? `<${id}@example.test>`,
    internetMessageHeaders: message.headers ?? [
      {
        name: 'Message-ID',
        value: message.messageId ?? `<${id}@example.test>`,
      },
      { name: 'From', value: 'Synthetic Sender <sender@example.test>' },
      { name: 'To', value: 'owner@outlook.test' },
      { name: 'Subject', value: message.subject },
      { name: 'Date', value: new Date(message.received).toUTCString() },
      { name: 'References', value: '<parent@example.test>' },
      { name: 'In-Reply-To', value: '<parent@example.test>' },
    ],
  });
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) =>
      done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );
  app.get<{ Querystring: Record<string, string> }>(
    '/auth',
    async (request, reply) => {
      const query = request.query;
      if (
        !consent.identity ||
        query.redirect_uri !== `${appUrl}/api/mail/oauth/microsoft/callback`
      )
        return reply.code(400).send('Unexpected authorization request');
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        identity: consent.identity,
        scope: query.scope ?? '',
        challenge: query.code_challenge ?? '',
        refresh: `refresh-${randomUUID()}`,
      });
      return reply.redirect(
        `${query.redirect_uri}?${new URLSearchParams({ state: query.state ?? '', code })}`,
        302,
      );
    },
  );
  app.post<{ Body: Record<string, string> }>(
    '/token',
    async (request, reply) => {
      const body = request.body;
      if (
        body.client_id !== 'fake-microsoft-client' ||
        body.client_secret !== 'fake-microsoft-secret'
      )
        return reply.code(401).send({ error: 'invalid_client' });
      let identity: MicrosoftIdentity | undefined;
      let refresh: string | undefined;
      let scope = MICROSOFT_SCOPES;
      if (body.grant_type === 'authorization_code') {
        const code = codes.get(body.code ?? '');
        codes.delete(body.code ?? '');
        if (
          !code ||
          body.redirect_uri !== `${appUrl}/api/mail/oauth/microsoft/callback` ||
          createHash('sha256')
            .update(body.code_verifier ?? '')
            .digest('base64url') !== code.challenge
        )
          return reply.code(400).send({ error: 'invalid_grant' });
        identity = code.identity;
        refresh = code.refresh;
        scope = code.scope;
      } else if (body.grant_type === 'refresh_token') {
        identity = refreshTokens.get(body.refresh_token ?? '');
        if (!identity) return reply.code(400).send({ error: 'invalid_grant' });
        refreshTokens.delete(body.refresh_token ?? '');
        refresh = `rotated-${randomUUID()}`;
        state.refreshes++;
      }
      if (!identity) return reply.code(400).send({ error: 'invalid_grant' });
      const access = `access-${randomUUID()}`;
      accessTokens.set(access, identity);
      if (refresh) refreshTokens.set(refresh, identity);
      return {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3599,
        scope,
        ...(refresh ? { refresh_token: refresh } : {}),
      };
    },
  );
  const identity = (authorization?: string) =>
    accessTokens.get((authorization ?? '').replace(/^Bearer /, ''));
  app.get('/userinfo', async (request, reply) => {
    const user = identity(request.headers.authorization);
    return user
      ? { sub: user.sub, email: user.email }
      : reply.code(401).send({ error: 'invalid_token' });
  });
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/v1.0/me')) return;
    if (!identity(request.headers.authorization))
      return reply
        .code(401)
        .send({ error: { code: 'InvalidAuthenticationToken' } });
    assert.match(
      String(request.headers.prefer ?? ''),
      /(?:^|,\s*)IdType="ImmutableId"(?:,|$)/,
    );
    requests.push({ method: request.method, url: request.url });
    if (state.exhausted)
      return reply
        .code(429)
        .header('retry-after', '120')
        .send({ error: { code: 'TooManyRequests' } });
  });
  app.get('/v1.0/me', async (request) => {
    const user = identity(request.headers.authorization);
    assert.ok(user);
    return {
      id: `id-${user.sub}`,
      mail: user.email,
      userPrincipalName: user.email,
      displayName: user.name ?? 'Synthetic Microsoft Owner',
    };
  });
  app.get<{ Querystring: Record<string, string> }>(
    '/v1.0/me/mailFolders/delta',
    async (request, reply) => {
      if (request.query.delta !== undefined && state.expireFolders) {
        state.expireFolders = false;
        return reply.code(410).send({ error: { code: 'SyncStateNotFound' } });
      }
      const offset = Number(request.query.offset ?? 0);
      const rows = [...folders].map(([id, displayName]) => ({
        id,
        displayName,
        parentFolderId: 'root',
        childFolderCount: 0,
      }));
      const value = rows.slice(offset, offset + state.pageSize);
      const next = offset + state.pageSize < rows.length;
      return {
        value,
        [next ? '@odata.nextLink' : '@odata.deltaLink']:
          `${base}/v1.0/me/mailFolders/delta?${next ? `offset=${offset + state.pageSize}` : 'delta=1'}`,
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1.0/me/mailFolders/:id',
    async (request, reply) => {
      const id = folderAliases.get(request.params.id) ?? request.params.id;
      const displayName = folders.get(id);
      return displayName
        ? { id, displayName, childFolderCount: 0 }
        : reply.code(404).send({ error: { code: 'ErrorItemNotFound' } });
    },
  );
  app.get<{ Params: { id: string }; Querystring: Record<string, string> }>(
    '/v1.0/me/mailFolders/:id/messages/delta',
    async (request, reply) => {
      const { id } = request.params;
      const cursor =
        request.query.delta === undefined ? -1 : Number(request.query.delta);
      const offset = Number(request.query.offset ?? 0);
      if (cursor >= 0 && cursor < state.minVersion)
        return reply.code(410).send({ error: { code: 'SyncStateNotFound' } });
      if (offset && state.failPage) {
        state.failPage = false;
        return { value: 'malformed' };
      }
      const rows =
        cursor < 0
          ? [...messages]
              .filter(([, message]) => message.folder === id)
              .map(([remote]) => ({ id: remote }))
          : changes
              .filter(
                (change) => change.folder === id && change.version > cursor,
              )
              .map((change) => ({
                id: change.id,
                ...(change.removed
                  ? { '@removed': { reason: 'deleted' } }
                  : {}),
              }));
      const next = offset + state.pageSize < rows.length;
      const path = `${base}/v1.0/me/mailFolders/${encodeURIComponent(id)}/messages/delta`;
      return {
        value: rows.slice(offset, offset + state.pageSize),
        [next ? '@odata.nextLink' : '@odata.deltaLink']: state.externalNextLink
          ? 'https://attacker.example/v1.0/me/messages/delta?token=secret'
          : `${path}?${next ? `${cursor < 0 ? '' : `delta=${cursor}&`}offset=${offset + state.pageSize}` : `delta=${state.version}`}`,
      };
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1.0/me/messages/:id',
    async (request, reply) => {
      const message = messages.get(request.params.id);
      state.gets++;
      return message
        ? resource(request.params.id, message)
        : reply.code(404).send({ error: { code: 'ErrorItemNotFound' } });
    },
  );
  app.get<{ Params: { id: string } }>(
    '/v1.0/me/messages/:id/$value',
    async (request, reply) => {
      const message = messages.get(request.params.id);
      if (!message)
        return reply.code(404).send({ error: { code: 'ErrorItemNotFound' } });
      return reply
        .type('message/rfc822')
        .send(
          message.raw ??
            [
              'From: Synthetic Sender <sender@example.test>',
              'To: owner@outlook.test',
              `Subject: ${message.subject}`,
              `Message-ID: <${request.params.id}@example.test>`,
              'Content-Type: text/plain; charset=utf-8',
              '',
              `Synthetic Microsoft body for ${request.params.id}`,
              '',
            ].join('\r\n'),
        );
    },
  );
  app.patch<{ Params: { id: string }; Body: { isRead: boolean } }>(
    '/v1.0/me/messages/:id',
    async (request, reply) => {
      const message = messages.get(request.params.id);
      if (!message)
        return reply.code(404).send({ error: { code: 'ErrorItemNotFound' } });
      message.read = request.body.isRead;
      state.modifies++;
      record(message.folder, request.params.id);
      return resource(request.params.id, message);
    },
  );
  app.post<{ Params: { id: string }; Body: { destinationId: string } }>(
    '/v1.0/me/messages/:id/move',
    async (request, reply) => {
      const message = messages.get(request.params.id);
      if (!message)
        return reply.code(404).send({ error: { code: 'ErrorItemNotFound' } });
      if (!folders.has(request.body.destinationId))
        return reply.code(404).send({ error: { code: 'ErrorFolderNotFound' } });
      record(message.folder, request.params.id, true);
      message.folder = request.body.destinationId;
      record(message.folder, request.params.id);
      state.moves++;
      if (state.loseMoveResponse)
        return reply.code(503).send({ error: { code: 'ServiceUnavailable' } });
      return reply.code(201).send(resource(request.params.id, message));
    },
  );
  app.post<{ Body: string }>('/v1.0/me/sendMail', async (request, reply) => {
    if (state.send === 'reject')
      return reply
        .code(400)
        .send({ error: { code: 'ErrorInvalidRecipients' } });
    if (state.send === 'rate')
      return reply
        .code(429)
        .header('retry-after', String(state.sendRetryAfter))
        .send({ error: { code: 'TooManyRequests' } });
    const raw = Buffer.from(request.body, 'base64').toString();
    sent.push(raw);
    const remote = `sent-${sent.length}`;
    const sentFolder = folderAliases.get('sentitems') ?? 'sentitems';
    messages.set(remote, {
      folder: sentFolder,
      subject: 'sent',
      received: Date.now(),
      read: true,
      messageId: raw.match(/^Message-ID: (<[^>]+>)/im)?.[1] ?? '',
      raw,
    });
    record(sentFolder, remote);
    if (state.send === 'lost')
      return reply.code(503).send({ error: { code: 'ServiceUnavailable' } });
    return reply.code(202).send();
  });
  app.get<{ Querystring: { $filter?: string } }>(
    '/v1.0/me/mailFolders/sentitems/messages',
    async (request) => {
      const expected = request.query.$filter
        ?.match(/internetMessageId eq '((?:''|[^'])*)'/)?.[1]
        ?.replace(/''/g, "'");
      return {
        value: [...messages]
          .filter(
            ([, message]) =>
              message.folder ===
                (folderAliases.get('sentitems') ?? 'sentitems') &&
              message.messageId === expected,
          )
          .map(([id, message]) => resource(id, message)),
      };
    },
  );
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  const config: MicrosoftConfig = {
    clientId: 'fake-microsoft-client',
    clientSecret: 'fake-microsoft-secret',
    authUrl: `${base}/auth`,
    tokenUrl: `${base}/token`,
    userinfoUrl: `${base}/userinfo`,
    graphUrl: `${base}/v1.0/me`,
  };
  return {
    app,
    config,
    consent,
    codes,
    refreshTokens,
    accessTokens,
    messages,
    folders,
    folderAliases,
    state,
    sent,
    requests,
    record,
  };
}
