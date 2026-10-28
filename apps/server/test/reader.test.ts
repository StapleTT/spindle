import assert from 'node:assert/strict';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { readContentConfig } from '../src/mail/content-config.js';
import { signContentGrant, verifyContentGrant } from '../src/mail/grants.js';
import { fetchRemoteImage } from '../src/mail/image-proxy.js';
import {
  attachmentDisposition,
  listAttachments,
  rasterType,
  remoteImageUrl,
  safeFilename,
} from '../src/mail/media.js';
import { MAX_RAW_BYTES, parseMessage } from '../src/mail/parse.js';
import { renderMessage, sanitizeMessage } from '../src/mail/sanitize.js';
import { testConfig } from './auth-fixture.js';
import { imapFixture } from './imap-fixture.js';
import { tinyPng } from './reader-fixture.js';

test('hostile mail becomes inert HTML and images have no source until explicitly enabled', () => {
  const dirty = `<base href="https://evil.example"><meta http-equiv="refresh" content="0;url=https://evil.example">
    <script>parent.document.body.innerHTML='stolen'</script><style>@import 'https://evil.example/font';</style>
    <form action="https://evil.example"><input autofocus onfocus="alert(1)"></form>
    <svg onload="alert(1)"><image href="https://evil.example/svg"></image></svg>
    <math><mi xlink:href="javascript:alert(1)">bad</mi></math><iframe srcdoc="<script>alert(1)</script>"></iframe>
    <p style="background:url(https://evil.example/css)" onclick="alert(1)">Safe words</p>
    <a href="javascript:alert(1)" target="_top">Unsafe link</a><a href="https://example.test/">Good link</a>
    <img src="https://images.example.test/a.png" srcset="https://evil.example/a 2x" onerror="alert(1)" alt="Photo">
    <img src="cid:inline@example.test" alt="Inline"><img src="data:image/svg+xml,evil"><img data-spindle-image="0">`;
  const safe = sanitizeMessage(dirty);
  assert.equal(safe.resources.length, 3);
  assert.ok(safe.html.includes('Safe words'));
  assert.doesNotMatch(
    safe.html,
    /<(?:script|style|svg|math|iframe|form|input|base|meta)\b|onerror|onclick|srcset|javascript:|https:\/\/evil\.example/i,
  );
  assert.doesNotMatch(safe.html, /\ssrc=/);
  const blocked = renderMessage(safe.html, null, safe.resources.length);
  assert.doesNotMatch(blocked, /<img|\ssrc=/);
  assert.doesNotMatch(blocked, /url\(/);
  const shown = renderMessage(
    safe.html,
    (index) => `https://content.example.test/image?token=owned&index=${index}`,
    safe.resources.length,
  );
  assert.equal((shown.match(/<img/g) ?? []).length, 2);
  assert.ok(shown.includes('content.example.test/image'));
  assert.ok(!shown.includes('images.example.test'));
  assert.match(shown, /rel="noopener noreferrer"/);
});

test('image sources are constrained and SVG cannot masquerade as a supported raster', () => {
  for (const value of [
    'javascript:alert(1)',
    'data:image/png;base64,x',
    'file:///etc/passwd',
    '//host/image',
    'https://user:pass@example.test/x',
    'https://example.test:8443/a',
  ])
    assert.equal(remoteImageUrl(value), null, value);
  assert.equal(
    remoteImageUrl('https://example.test/a#fragment'),
    'https://example.test/a',
  );
  assert.equal(rasterType(tinyPng), 'image/png');
  assert.equal(
    rasterType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    null,
  );
});

test('content origin must use a separate hostname with secure hosted transport', () => {
  assert.equal(
    readContentConfig(testConfig, {})?.origin,
    'http://localhost:3001',
  );
  assert.throws(() =>
    readContentConfig(testConfig, { CONTENT_URL: 'http://127.0.0.1:3001' }),
  );
  assert.throws(() =>
    readContentConfig(testConfig, { CONTENT_HOST: '0.0.0.0' }),
  );
  assert.equal(
    readContentConfig(testConfig, { CONTENT_PORT: '3002' })?.origin,
    'http://localhost:3002',
  );
  const hosted = { ...testConfig, appUrl: 'https://app.example.test' };
  assert.equal(readContentConfig(hosted, {}), null);
  assert.throws(() =>
    readContentConfig(hosted, { CONTENT_URL: 'http://content.example.test' }),
  );
  assert.equal(
    readContentConfig(hosted, { CONTENT_URL: 'https://content.example.test' })
      ?.origin,
    'https://content.example.test',
  );
});

test('content grants are scoped, short-lived, tamper resistant and expire', () => {
  const grant = {
    owner: 'owner',
    session: 'session',
    message: 'message',
    version: 'version',
    kind: 'body' as const,
    images: false,
  };
  const token = signContentGrant(grant, 'test-only-secret');
  assert.equal(verifyContentGrant(token, 'test-only-secret')?.images, false);
  assert.equal(verifyContentGrant(`${token}x`, 'test-only-secret'), null);
  assert.equal(verifyContentGrant(token, 'wrong-secret'), null);
  assert.equal(verifyContentGrant('invalid', 'test-only-secret'), null);
  const real = Date.now;
  try {
    Date.now = () => real() + 6 * 60000;
    assert.equal(verifyContentGrant(token, 'test-only-secret'), null);
  } finally {
    Date.now = real;
  }
});

test('MIME parser decodes charsets, alternatives and inline CIDs without retaining arbitrary attachments', async () => {
  const raw = `From: sender@example.test\r\nTo: recipient@example.test\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=outer\r\n\r\n--outer\r\nContent-Type: multipart/alternative; boundary=inner\r\n\r\n--inner\r\nContent-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nCaf=E9 plain text\r\n--inner\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello HTML</p><img src="cid:picture@example.test"><script>alert(1)</script>\r\n--inner--\r\n--outer\r\nContent-Type: image/png\r\nContent-ID: <picture@example.test>\r\nContent-Transfer-Encoding: base64\r\n\r\n${tinyPng.toString('base64')}\r\n--outer\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename=secret.bin\r\n\r\nNot retained\r\n--outer--\r\n`;
  const parsed = await parseMessage(Buffer.from(raw));
  assert.match(parsed.plain, /Café plain text/);
  assert.match(parsed.html, /Hello HTML/);
  assert.doesNotMatch(parsed.html, /<script/);
  assert.equal(parsed.images.length, 1);
  assert.ok(parsed.images[0]?.data.equals(tinyPng));
  assert.equal(parsed.resources[0]?.kind, 'inline');
  await assert.rejects(parseMessage(Buffer.alloc(MAX_RAW_BYTES + 1)));
  const tooMany = `Content-Type: multipart/mixed; boundary=b\r\n\r\n${Array.from({ length: 102 }, () => `--b\r\nContent-Type: text/plain\r\n\r\nPart\r\n`).join('')}--b--\r\n`;
  await assert.rejects(parseMessage(Buffer.from(tooMany)));
});

test('image proxy pins public addresses, drops ambient headers and revalidates redirects', async (t) => {
  await imapFixture(t);
  const optionsSeen: https.RequestOptions[] = [];
  t.mock.method(
    https,
    'request',
    (options: https.RequestOptions, callback: (response: unknown) => void) => {
      optionsSeen.push(options);
      const request = new PassThrough();
      request.end = () => {
        const response = Object.assign(new PassThrough(), {
          statusCode: 200,
          headers: { 'content-type': 'image/png' },
        });
        queueMicrotask(() => {
          callback(response);
          response.end(tinyPng);
        });
        return request;
      };
      return request;
    },
  );
  const result = await fetchRemoteImage(
    'https://images.example.test/pixel.png',
  );
  assert.equal(result.type, 'image/png');
  assert.equal(optionsSeen[0]?.hostname, '8.8.8.8');
  assert.equal(optionsSeen[0]?.servername, 'images.example.test');
  assert.equal(optionsSeen[0]?.rejectUnauthorized, true);
  const headers = optionsSeen[0]?.headers as Record<string, string>;
  assert.equal(headers.cookie, undefined);
  assert.equal(headers.authorization, undefined);
  assert.equal(headers.referer, undefined);
  t.mock.method(
    https,
    'request',
    (_options: https.RequestOptions, callback: (response: unknown) => void) => {
      const request = new PassThrough();
      request.end = () => {
        queueMicrotask(() =>
          callback(
            Object.assign(new PassThrough(), {
              statusCode: 302,
              headers: { location: 'http://169.254.169.254/latest/meta-data' },
            }),
          ),
        );
        return request;
      };
      return request;
    },
  );
  await assert.rejects(
    fetchRemoteImage('https://images.example.test/redirect'),
  );
});

test('attachment metadata and download names are bounded and inert', () => {
  assert.equal(
    safeFilename('../../etc/passwd', 'attachment'),
    '_.._etc_passwd',
  );
  assert.equal(
    safeFilename('invoice\u202Efdp.exe', 'attachment'),
    'invoice_fdp.exe',
  );
  assert.equal(safeFilename(' .. ', 'attachment'), 'attachment');
  assert.equal(Array.from(safeFilename('😀'.repeat(300), 'x')).length, 200);
  assert.equal(
    attachmentDisposition('a"b\\\r\né (1).txt'),
    `attachment; filename="a_b____ (1).txt"; filename*=UTF-8''a%22b%5C%0D%0A%C3%A9%20%281%29.txt`,
  );
  const listed = listAttachments({
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain' },
      {
        part: '2',
        type: 'image/png',
        id: '<cid>',
        parameters: { name: 'logo.png' },
      },
      {
        part: '3',
        type: 'application/pdf',
        disposition: 'inline',
        dispositionParameters: { filename: 'apple.pdf' },
      },
      {
        part: '4',
        type: 'Bad Type',
        disposition: 'attachment',
        encoding: 'base64',
        size: 78,
      },
    ],
  });
  assert.deepEqual(listed, [
    {
      part: '3',
      filename: 'apple.pdf',
      contentType: 'application/pdf',
      size: 0,
    },
    {
      part: '4',
      filename: 'attachment',
      contentType: 'application/octet-stream',
      size: 57,
    },
  ]);
  assert.equal(
    listAttachments({
      type: 'application/pdf',
      parameters: { name: 'only.pdf' },
    })[0]?.part,
    '1',
  );
  const grant = {
    owner: 'u',
    session: 's',
    message: 'm',
    version: 'v',
    images: false,
  };
  for (const [value, valid] of [
    [{ ...grant, kind: 'attachment', attachment: 0 }, true],
    [{ ...grant, kind: 'attachment' }, false],
    [{ ...grant, kind: 'attachment', attachment: 100 }, false],
    [{ ...grant, kind: 'body', attachment: 0 }, false],
  ] as const)
    assert.equal(
      Boolean(verifyContentGrant(signContentGrant(value, 'secret'), 'secret')),
      valid,
    );
});
