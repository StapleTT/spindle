import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { forwardContent } from '../src/mail/forward.js';
import { outgoingMessage } from '../src/mail/outgoing-message.js';
import { parseMessage } from '../src/mail/parse.js';
import { responseDraft } from '../src/mail/reply.js';
import { newsletterHtml, readerMail, tinyPng } from './reader-fixture.js';
import { replyMail } from './reply-fixture.js';

async function fixture() {
  const parsed = await parseMessage(
    Buffer.from(
      readerMail(
        'Styled original',
        newsletterHtml(1),
        'Complete plain alternative.',
      ),
    ),
  );
  const draft = responseDraft(
    'forward',
    {
      id: 'source',
      accountId: 'account',
      date: '2026-10-28',
      plain: parsed.plain,
      html: parsed.html,
      metadata: parsed.reply,
      attachments: 0,
    },
    [],
  );
  assert.ok(draft.forwarded);
  const forward = forwardContent(
    draft.forwarded,
    parsed.resources,
    parsed.images.map((image) => ({ ...image, content_type: image.type })),
  );
  const content = {
    ...draft.content,
    to: 'friend@example.test',
    html: '<p>My note.</p>',
    text: 'My note.',
  };
  return { draft, forward, content };
}

test('forwarded SMTP HTML preserves newsletter CSS, layout, remote URLs and CID images without editor filtering', async () => {
  const { draft, forward, content } = await fixture();
  const encoded = await outgoingMessage(
    'styled-forward',
    'writer@example.test',
    content,
    draft.replyContext,
    forward,
  );
  const received = await simpleParser(encoded.raw, { skipImageLinks: true });
  assert.equal(received.inReplyTo, undefined);
  assert.equal(received.references, undefined);
  assert.equal(received.bcc, undefined);
  assert.equal(typeof received.html, 'string');
  const html = String(received.html);
  assert.match(html, /<style>/);
  assert.match(html, /@media/);
  assert.match(html, /color:#123456/);
  assert.match(html, /<table[^>]+width="600"/);
  assert.match(html, /cellpadding="0"/);
  assert.match(html, /background-color:#123456/);
  assert.match(html, /https:\/\/images.example.test\/pixel.png/);
  assert.match(html, /https:\/\/images.example.test\/css/);
  assert.match(html, /cid:forward-styled-forward-/);
  assert.ok(html.indexOf('My note.') < html.indexOf('Forwarded message'));
  assert.doesNotMatch(
    html,
    /<script|readerPwned|spindle-image:|\/image\?token=|\/forward-image\?token=/,
  );
  assert.match(
    received.text ?? '',
    /My note\.[\s\S]*Complete plain alternative/,
  );
  assert.equal(received.attachments.length, 1);
  assert.deepEqual(received.attachments[0]?.content, tinyPng);
  assert.equal(received.attachments[0]?.contentDisposition, 'inline');
  assert.ok(Buffer.byteLength(JSON.stringify(draft.content)) < 120000);
});

test('plain-text selection converts the whole forward while rich formatting remains available', async () => {
  const { draft, forward, content } = await fixture();
  const received = await simpleParser(
    (
      await outgoingMessage(
        'plain-forward',
        'writer@example.test',
        { ...content, format: 'plain' },
        draft.replyContext,
        forward,
      )
    ).raw,
  );
  assert.equal(received.html, false);
  assert.equal(received.attachments.length, 0);
  assert.match(
    received.text ?? '',
    /My note\.[\s\S]*Complete plain alternative/,
  );
  assert.match(forward.html, /<table/);
});

test('formatted forwarding rejects oversized originals and invalid embedded images instead of truncating HTML', () => {
  assert.throws(
    () =>
      forwardContent(
        { html: `<p>${'x'.repeat(600000)}</p>`, text: 'body' },
        [],
        [],
      ),
    /not been shortened/,
  );
  assert.throws(
    () =>
      forwardContent(
        { html: '<p>body</p>', text: 'body' },
        [{ kind: 'inline', cid: 'image' }],
        [
          {
            position: 0,
            content_type: 'image/png',
            data: Buffer.from('not an image'),
          },
        ],
      ),
    /embedded image/,
  );
});

test('plain-only MIME and legacy empty HTML wrappers retain the original text in forwards', async () => {
  const parsed = await parseMessage(Buffer.from(replyMail()));
  assert.equal(parsed.html, '');
  const draft = responseDraft(
    'forward',
    {
      id: 'source',
      accountId: 'account',
      date: '2026-10-28',
      plain: parsed.plain,
      html: '<div class="spindle-email-body"></div>',
      metadata: parsed.reply,
      attachments: 0,
    },
    [],
  );
  assert.equal(draft.forwarded, null);
  assert.match(draft.content.text, /Original response body/);
});
