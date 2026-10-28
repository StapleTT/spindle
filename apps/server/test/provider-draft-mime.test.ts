import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import MailComposer from 'nodemailer/lib/mail-composer';
import {
  composeProviderDraft,
  parseProviderDraft,
} from '../src/mail/provider-draft-mime.js';

const content = {
  to: '',
  cc: '',
  bcc: 'Secret <hidden@example.test>',
  subject: 'Draft café',
  format: 'rich' as const,
  html: '<p>Hello <strong>world</strong></p>',
  text: 'Hello world',
};

test('Draft MIME permits unfinished recipients and retains private Bcc, identity, threading and file bytes', async () => {
  const context = {
    kind: 'reply' as const,
    sourceMessageId: '',
    originalSubject: '',
    inReplyTo: '<parent@example.test>',
    references: ['<root@example.test>', '<parent@example.test>'],
    warnings: [],
  };
  const compiled = composeProviderDraft(
    randomUUID(),
    randomUUID(),
    { address: 'writer@example.test', name: 'Writer café' },
    { ...content, to: 'Unfinished <' },
    context,
    null,
    [
      {
        filename: 'data.txt',
        content: Readable.from([Buffer.from('Exact attachment bytes')]),
        contentType: 'application/octet-stream',
      },
    ],
  );
  const raw = await compiled.build();
  const parsed = await simpleParser(raw);
  assert.equal(parsed.from?.value[0]?.name, 'Writer café');
  assert.equal(parsed.inReplyTo, '<parent@example.test>');
  assert.ok(parsed.bcc);
  const value = await parseProviderDraft(raw);
  assert.match(value.content.bcc, /hidden@example.test/);
  assert.equal(value.content.subject, 'Draft café');
  assert.equal(value.content.html, content.html);
  assert.equal(value.files[0]?.data.toString(), 'Exact attachment bytes');
  assert.equal(value.replyContext?.inReplyTo, '<parent@example.test>');
  const empty = await composeProviderDraft(
    randomUUID(),
    randomUUID(),
    null,
    { ...content, bcc: '', html: '<p></p>' },
    null,
    null,
    [],
  ).build();
  assert.equal((await parseProviderDraft(empty)).content.to, '');
});

test('complex native HTML keeps styling in the isolated original with images while removing executable content', async () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  );
  const raw = await new MailComposer({
    subject: 'Styled draft',
    html: '<style>.layout{color:red}</style><table class="layout"><tr><td>Original body<img src="cid:tiny"></td></tr></table><script>alert(1)</script>',
    attachments: [{ filename: 'tiny.png', cid: 'tiny', content: png }],
  })
    .compile()
    .build();
  const value = await parseProviderDraft(raw);
  assert.equal(value.forward?.origin, 'provider');
  assert.match(value.forward?.html ?? '', /<style>|<table/);
  assert.doesNotMatch(value.forward?.html ?? '', /<script|alert\(1\)/);
  assert.equal(value.forward?.images.length, 1);
  assert.equal(value.files.length, 0);
  assert.equal(value.content.text, '');
  const output = await composeProviderDraft(
    randomUUID(),
    randomUUID(),
    null,
    value.content,
    null,
    value.forward,
    [],
  ).build();
  assert.match((await simpleParser(output)).html || '', /<table/);
});

test('provider draft import refuses excess content and attachments instead of silently truncating', async () => {
  const long = await new MailComposer({ text: 'x'.repeat(100001) })
    .compile()
    .build();
  await assert.rejects(parseProviderDraft(long), /draft_too_large/);
  const files = await new MailComposer({
    attachments: Array.from({ length: 11 }, (_, i) => ({
      filename: `${i}.txt`,
      content: Buffer.from('file'),
    })),
  })
    .compile()
    .build();
  await assert.rejects(parseProviderDraft(files), /draft_files_too_large/);
});
