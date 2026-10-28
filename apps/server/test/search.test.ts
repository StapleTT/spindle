import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSearch, searchCondition, searchKey } from '../src/mail/search.js';

test('bounded search syntax keeps field values and hostile text in parameters', () => {
  const query =
    '"project launch" from:alice to:"Bob Example" -subject:cancelled body:minutes is:unread has:attachment after:2026-01-01 before:2027-01-01 in:anywhere';
  const terms = parseSearch(query);
  assert.equal(terms.length, 10);
  assert.equal(terms[0]?.phrase, true);
  assert.equal(terms[3]?.exclude, true);
  const values: unknown[] = ['owner', null, null];
  const sql = searchCondition(
    'subject:"x\'); DROP TABLE users; --"',
    values,
  ).condition;
  assert.doesNotMatch(sql, /DROP TABLE/);
  assert.match(String(values[3]), /DROP TABLE/);
  for (const value of [
    '"unfinished',
    'from:',
    'is:starred',
    'has:unknown',
    'after:2026-02-30',
    'before:0000-01-01',
    'in:unknown',
    '-in:trash',
    'x'.repeat(501),
    'x '.repeat(33),
    'bad\0value',
  ])
    assert.throws(() => parseSearch(value), Error, value);
  assert.notEqual(
    searchKey('a', undefined, undefined, 'hello'),
    searchKey('b', undefined, undefined, 'hello'),
  );
  assert.notEqual(
    searchKey('a', undefined, undefined, 'hello'),
    searchKey('a', undefined, undefined, 'other'),
  );
});
