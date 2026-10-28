import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import {
  composeOutgoing,
  outgoingMessage,
} from '../src/mail/outgoing-message.js';
import { defaultSenderName, senderDisplayName } from '../src/mail/smtp.js';

const content = {
  to: 'friend@example.test',
  cc: '',
  bcc: 'hidden@example.test',
  subject: 'Name check',
  format: 'rich' as const,
  html: '<p>Hello</p>',
  text: 'Hello',
};
test('sender display names round-trip through normal and streamed MIME without changing the mailbox or private envelope', async () => {
  const name = 'Zoë "Support", Inbox';
  const message = await outgoingMessage(
    'name-check',
    'writer@example.test',
    content,
    null,
    null,
    name,
  );
  const parsed = await simpleParser(message.raw);
  assert.equal(parsed.from?.value[0]?.name, name);
  assert.equal(parsed.from?.value[0]?.address, 'writer@example.test');
  assert.equal(parsed.bcc, undefined);
  assert.ok(message.recipients.includes('hidden@example.test'));
  const streamed = composeOutgoing(
    'stream-name-check',
    'writer@example.test',
    content,
    null,
    null,
    [
      {
        filename: 'test.txt',
        contentType: 'application/octet-stream',
        content: Readable.from([Buffer.from('attachment')]),
      },
    ],
    name,
  );
  const received = await simpleParser(await streamed.compiled.build());
  assert.equal(received.from?.value[0]?.name, name);
  assert.equal(received.from?.value[0]?.address, 'writer@example.test');
  assert.equal(received.attachments[0]?.content.toString(), 'attachment');
  const blank = await simpleParser(
    (await outgoingMessage('blank-name', 'writer@example.test', content)).raw,
  );
  assert.equal(blank.from?.value[0]?.name, '');
});
test('sender names reject header controls and oversized values; profile defaults are bounded and normalized', async () => {
  assert.equal(senderDisplayName('  Support  '), 'Support');
  for (const name of [
    'Name\r\nBcc: hidden@example.test',
    'Name\0',
    'Name\t',
    'Name\u0085',
    'x'.repeat(201),
  ]) {
    assert.throws(() => senderDisplayName(name));
    await assert.rejects(
      outgoingMessage(
        'invalid',
        'writer@example.test',
        content,
        null,
        null,
        name,
      ),
    );
  }
  const profile = defaultSenderName(`Name\r\n${'😀'.repeat(220)}`);
  assert.doesNotMatch(profile, /\p{Cc}/u);
  assert.ok(Array.from(profile).length <= 200);
  assert.doesNotThrow(() => senderDisplayName(profile));
});
