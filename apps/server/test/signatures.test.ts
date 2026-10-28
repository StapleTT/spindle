import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { simpleParser } from 'mailparser';
import { cleanDraft } from '../src/mail/drafts.js';
import { outgoingMessage } from '../src/mail/outgoing-message.js';
import {
  composeProviderDraft,
  parseProviderDraft,
} from '../src/mail/provider-draft-mime.js';
import { responseDraft } from '../src/mail/reply.js';
import { signatureContent } from '../src/mail/signatures.js';

const signature = {
  html: '<p>Regards,<br /><strong>Writer café</strong></p>',
  text: 'Regards,\nWriter café',
};
const content = {
  to: 'recipient@example.test',
  cc: '',
  bcc: '',
  subject: 'Signed message',
  format: 'rich' as const,
  html: '<p>My note</p>',
  text: 'My note',
};
test('signature snapshot becomes editable rich/plain content and appears once in provider and outgoing MIME', async () => {
  const signed = signatureContent(content, signature);
  assert.match(signed.html, /<strong>Writer café<\/strong>/);
  assert.equal(signed.text, 'My note\nRegards,\nWriter café');
  assert.equal(
    signatureContent({ ...content, format: 'plain' }, signature).text,
    'My note\n\nRegards,\nWriter café',
  );
  const raw = await composeProviderDraft(
    randomUUID(),
    randomUUID(),
    null,
    signed,
    null,
    null,
    [],
  ).build();
  const imported = await parseProviderDraft(raw);
  assert.equal(imported.content.text, signed.text);
  const sent = await outgoingMessage(
    randomUUID(),
    'writer@example.test',
    imported.content,
  );
  const mime = await simpleParser(sent.raw);
  assert.equal((mime.text?.match(/Writer café/g) ?? []).length, 1);
  assert.equal(((mime.html || '').match(/Writer café/g) ?? []).length, 1);
  const edited = cleanDraft({
    ...signed,
    html: signed.html.replace('Writer café', 'Edited name'),
  });
  assert.match(edited.text, /Edited name/);
  assert.equal(signatureContent(content, null), content);
});
test('response signatures precede quoted and formatted original content', () => {
  const source = {
    id: randomUUID(),
    accountId: randomUUID(),
    date: new Date(),
    plain: 'Original body',
    html: '<table><tr><td>Original body</td></tr></table>',
    metadata: {
      from: [{ name: 'Sender', address: 'sender@example.test' }],
      to: [{ name: 'Writer', address: 'writer@example.test' }],
      cc: [],
      replyTo: null,
      subject: 'Question',
      messageId: '<source@example.test>',
      inReplyTo: null,
      references: [],
      truncatedRecipients: false,
    },
    attachments: 0,
  };
  for (const kind of ['reply', 'replyAll', 'forward'] as const) {
    const response = responseDraft(kind, source, ['writer@example.test']);
    const signed = signatureContent(response.content, signature, true);
    assert.equal((signed.html.match(/Writer café/g) ?? []).length, 1);
    if (kind === 'forward') assert.ok(response.forwarded);
    else
      assert.ok(
        signed.html.indexOf('Writer café') <
          signed.html.indexOf('<blockquote>'),
      );
  }
  const plain = signatureContent(
    { ...content, format: 'plain', text: 'Quoted original' },
    signature,
    true,
  );
  assert.ok(
    plain.text.indexOf('Writer café') < plain.text.indexOf('Quoted original'),
  );
});
