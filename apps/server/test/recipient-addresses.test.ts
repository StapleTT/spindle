import assert from 'node:assert/strict';
import { test } from 'node:test';
import addressparser from 'nodemailer/lib/addressparser';
import {
  enteredRecipients,
  insertRecipient,
  recipientPart,
} from '../../web/src/recipient-addresses.js';

test('recipient completion respects quoted commas, escaped quotes, comments and caret boundaries', () => {
  const value = 'first@example.test, "Doe, Jane" <ja>, tail@example.test';
  const part = recipientPart(value, value.indexOf('<ja') + 3);
  assert.ok(part);
  assert.equal(part.query, 'ja');
  const next = insertRecipient(value, part, {
    name: 'Jane "Support" \\ Team',
    address: 'jane+work@example.test',
  });
  assert.match(next.value, /^first@example\.test, /);
  assert.match(next.value, /, tail@example\.test$/);
  const parsed = addressparser(next.value, { flatten: true });
  assert.equal(parsed.length, 3);
  assert.equal(parsed[1]?.address, 'jane+work@example.test');
  assert.equal(parsed[1]?.name, 'Jane "Support" \\ Team');
  const comment = 'Jane (Sales, East) <ja';
  assert.equal(recipientPart(comment, comment.length)?.start, 0);
  const escaped = '"Jane \\"Doe, Team\\"" <ja';
  assert.equal(recipientPart(escaped, escaped.length)?.start, 0);
  assert.equal(recipientPart('jane', 0), null);
  assert.equal(recipientPart('ja', 0, 2), null);
  assert.equal(recipientPart('j', 1), null);
});

test('last-token completion adds a separator and duplicate filtering preserves explicit plus aliases', () => {
  const text = 'one@example.test, ja',
    part = recipientPart(text, text.length);
  assert.ok(part);
  const next = insertRecipient(text, part, {
    name: 'Doe, Jane\r\n',
    address: 'jane@example.test',
  });
  assert.equal(
    next.value,
    'one@example.test, "Doe, Jane" <jane@example.test>, ',
  );
  assert.equal(next.caret, next.value.length);
  assert.equal(recipientPart(next.value, next.caret), null);
  const values = [
    'one@example.test, ja',
    '"Other, Name" <JANE@example.test>',
    'jane+private@example.test',
  ];
  const selected = enteredRecipients(values, 0, part);
  assert.deepEqual([...selected].sort(), [
    'jane+private@example.test',
    'jane@example.test',
    'one@example.test',
  ]);
  assert.equal(selected.has('jane+work@example.test'), false);
});
