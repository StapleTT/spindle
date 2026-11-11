import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type ConversationItem,
  relatedConversationItems,
} from '../src/conversation-items.js';

function item(id: string, copyKey = id, folder = 'INBOX'): ConversationItem {
  return {
    id,
    copyKey,
    subject: 'Same subject',
    sender: [],
    receivedAt: '2026-11-01T12:00:00Z',
    unread: true,
    matchesView: folder === 'INBOX',
    headersPending: false,
    folders: [
      {
        name: folder,
        path: folder,
        role: folder === 'All Mail' ? '\\All' : null,
      },
    ],
  };
}

test('a standalone selected message and its matching virtual-folder copies have no redundant timeline entries', () => {
  const inbox = item('inbox', 'envelope'),
    allMail = item('all', 'envelope', 'All Mail');
  assert.deepEqual(relatedConversationItems([inbox], 'inbox'), []);
  assert.deepEqual(relatedConversationItems([allMail, inbox], 'inbox'), []);
  assert.deepEqual(relatedConversationItems([inbox, allMail], 'all'), []);
});

test('real replies remain distinct and matching folder copies appear once with a physical representative', () => {
  const root = item('root'),
    reply = item('reply'),
    copy = item('reply-copy', 'reply', 'All Mail');
  const entries = relatedConversationItems([copy, reply, root], 'root');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, 'reply');
  assert.deepEqual(
    entries[0]?.folders.map((folder) => folder.path),
    ['All Mail', 'INBOX'],
  );
  assert.equal(entries[0]?.matchesView, true);
  assert.deepEqual(
    relatedConversationItems([copy, reply, root], 'reply').map(
      (entry) => entry.id,
    ),
    ['root'],
  );
  const sent = {
    ...reply,
    matchesView: false,
    folders: [{ name: 'Sent', path: 'Sent', role: '\\Sent' }],
  };
  assert.equal(
    relatedConversationItems([copy, sent, root], 'root')[0]?.id,
    'reply',
  );
});

test('same-folder redeliveries, different metadata, missing fingerprints and subject matches are not hidden', () => {
  const first = item('first', 'envelope'),
    redelivery = item('redelivery', 'envelope');
  assert.deepEqual(
    relatedConversationItems([first, redelivery], 'first').map(
      (entry) => entry.id,
    ),
    ['redelivery'],
  );
  const changed = item('changed', 'different-envelope', 'All Mail');
  const unknown = item('unknown', 'envelope', 'All Mail');
  delete unknown.copyKey;
  assert.deepEqual(
    relatedConversationItems([first, changed, unknown], 'first').map(
      (entry) => entry.id,
    ),
    ['changed', 'unknown'],
  );
});

test('matching folder display names do not replace folder identity', () => {
  const root = item('root');
  const first = item('first', 'copy', 'AQMkFolderOne=');
  const second = item('second', 'copy', 'AQMkFolderTwo=');
  for (const message of [first, second])
    message.folders = message.folders.map((folder) => ({
      ...folder,
      name: 'Receipts',
    }));
  const [related] = relatedConversationItems([root, first, second], root.id);
  assert.deepEqual(
    related?.folders.map((folder) => folder.path),
    ['AQMkFolderOne=', 'AQMkFolderTwo='],
  );
  assert.deepEqual(
    related?.folders.map((folder) => folder.name),
    ['Receipts', 'Receipts'],
  );
});
