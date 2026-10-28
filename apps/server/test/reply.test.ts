import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { outgoingMessage } from '../src/mail/outgoing-message.js';
import {
  messageId,
  referenceIds,
  replyMetadata,
  responseDraft,
} from '../src/mail/reply.js';
import { replyMail } from './reply-fixture.js';

const self = [
  'writer@example.test',
  'alias@example.test',
  'login@example.test',
];
async function source(raw = replyMail()) {
  const parsed = await simpleParser(raw, { skipHtmlToText: true });
  return {
    id: 'source-id',
    accountId: 'account-id',
    date: '2026-10-28T12:00:00Z',
    plain: parsed.text ?? '',
    html: typeof parsed.html === 'string' ? parsed.html : '',
    metadata: replyMetadata(parsed),
    attachments: 0,
  };
}

test('reply recipients honor Reply-To, exclude known identities and deduplicate To/Cc', async () => {
  const original = await source();
  const reply = responseDraft('reply', original, self),
    all = responseDraft('replyAll', original, self);
  assert.match(reply.content.to, /support@example.test/);
  assert.equal(reply.content.cc, '');
  assert.match(all.content.to, /support@example.test/);
  assert.match(all.content.to, /other@example.test/);
  assert.equal(all.content.cc, 'copy@example.test');
  assert.doesNotMatch(
    JSON.stringify(all.content),
    /never-copy|login@example|alias@example|writer@example.*To:/,
  );
  assert.equal(all.accountId, original.accountId);
  const sent = await source(
    replyMail({
      from: 'Writer <writer@example.test>',
      to: 'friend@example.test, alias@example.test',
      cc: 'copy@example.test',
      replyTo: null,
    }),
  );
  assert.equal(
    responseDraft('reply', sent, self).content.to,
    'friend@example.test',
  );
  assert.equal(
    responseDraft('replyAll', sent, self).content.cc,
    'copy@example.test',
  );
  const invalid = await source(replyMail({ replyTo: 'not-an-address' }));
  assert.equal(responseDraft('reply', invalid, self).content.to, '');
  assert.ok(responseDraft('reply', invalid, self).replyContext.warnings.length);
});

test('reply chains keep a valid parent last and bound references without header injection', async () => {
  assert.equal(
    messageId('<parent@example.test>\r\nBcc: injected@example.test'),
    null,
  );
  assert.equal(messageId('<invalid id@example.test>'), null);
  const original = await source();
  original.metadata.references = Array.from(
    { length: 150 },
    (_, index) => `<ancestor-${index}@example.test>`,
  );
  original.metadata.references.splice(20, 0, '<parent@example.test>');
  const context = responseDraft('reply', original, self).replyContext;
  assert.equal(context.references[0], '<ancestor-0@example.test>');
  assert.equal(context.references.at(-1), '<parent@example.test>');
  assert.ok(context.references.length <= 30);
  assert.ok(context.references.join(' ').length <= 8000);
  assert.deepEqual(
    referenceIds('<bad id> <ok@example.test> <ok@example.test>'),
    ['<ok@example.test>'],
  );
  original.metadata.subject = '😀'.repeat(1000);
  original.metadata.references = Array.from(
    { length: 40 },
    (_, index) => `<${'\\'.repeat(440)}${index}@example.test>`,
  );
  const escaped = responseDraft('reply', original, self).replyContext;
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) <= 14000);
  assert.equal(escaped.references[0], original.metadata.references[0]);
  assert.equal(escaped.references.at(-1), '<parent@example.test>');
});

test('forwards start blank with a separate HTML original; reply quotes remain safe and bounded', async () => {
  const original = await source(replyMail({ htmlOnly: true }));
  const forward = responseDraft('forward', original, self);
  assert.equal(forward.content.to, '');
  assert.equal(forward.content.cc, '');
  assert.equal(forward.content.bcc, '');
  assert.equal(forward.content.subject, 'Fwd: Project question');
  assert.equal(forward.replyContext.inReplyTo, null);
  assert.deepEqual(forward.replyContext.references, []);
  assert.equal(forward.content.text, '');
  assert.match(forward.forwarded?.text ?? '', /Business newsletter/);
  assert.match(forward.forwarded?.text ?? '', /Second paragraph/);
  assert.doesNotMatch(forward.content.html, /<style|<script|<img|never-copy/);
  original.plain = `<script>literal text</script>\n${'😀'.repeat(15000)}`;
  original.attachments = 1;
  const reply = responseDraft('reply', original, self);
  assert.match(reply.content.html, /&lt;script&gt;/);
  assert.doesNotMatch(reply.content.html, /<script/);
  assert.ok(
    reply.replyContext.warnings.some((value) => value.includes('shortened')),
  );
  assert.ok(
    reply.replyContext.warnings.some((value) => value.includes('attachments')),
  );
  assert.ok(Buffer.byteLength(JSON.stringify(reply.content)) < 120000);
});

test('outgoing MIME emits reply headers, preserves new IDs, and keeps forwards outside the thread', async () => {
  const original = await source();
  const reply = responseDraft('reply', original, self);
  const raw = await outgoingMessage(
    'new-operation',
    'writer@example.test',
    reply.content,
    reply.replyContext,
  );
  const parsed = await simpleParser(raw.raw);
  assert.equal(parsed.inReplyTo, '<parent@example.test>');
  assert.deepEqual(parsed.references, [
    '<root@example.test>',
    '<previous@example.test>',
    '<parent@example.test>',
  ]);
  assert.equal(parsed.messageId, '<new-operation@example.test>');
  assert.equal(parsed.bcc, undefined);
  const forward = responseDraft('forward', original, self);
  forward.content.to = 'friend@example.test';
  const forwarded = await simpleParser(
    (
      await outgoingMessage(
        'forward-operation',
        'writer@example.test',
        forward.content,
        forward.replyContext,
      )
    ).raw,
  );
  assert.equal(forwarded.inReplyTo, undefined);
  assert.equal(forwarded.references, undefined);
});
