import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';
import { migrateDatabase } from '../src/db/migrate.js';
import { applyMailActions } from '../src/mail/actions.js';
import { readMailKeys } from '../src/mail/credentials.js';
import { connectImap } from '../src/mail/imap.js';
import { syncAccount } from '../src/mail/sync.js';
import { startMailWorker } from '../src/mail/worker.js';
import { createTestUser, testApp, testConfig } from './auth-fixture.js';
import { imapFixture, imapPassword, rawMail } from './imap-fixture.js';

test('read/unread actions are durable, owned and synchronized to IMAP', {
  skip: !process.env.TEST_DATABASE_URL,
  timeout: 90000,
}, async (t) => {
  const connectionString = process.env.TEST_DATABASE_URL;
  assert.ok(connectionString);
  assert.match(
    new URL(connectionString).pathname,
    /^\/spindle_test_[a-z0-9_]+$/,
  );
  const pool = new Pool({ connectionString, max: 8 });
  await migrateDatabase(pool);
  const keys = readMailKeys({
    MAIL_ENCRYPTION_KEYS: JSON.stringify({
      v1: Buffer.alloc(32, 46).toString('base64'),
    }),
  });
  const app = testApp(pool, testConfig, undefined, keys);
  t.after(() => app.close());
  const owner = await createTestUser(
    app,
    pool,
    testConfig,
    'actions-owner@example.test',
  );
  const other = await createTestUser(
    app,
    pool,
    testConfig,
    'actions-other@example.test',
  );
  await pool.query("UPDATE users SET role='admin' WHERE id=$1", [other.id]);
  const { server, port } = await imapFixture(t, true, true, [
    'MOVE',
    'UIDPLUS',
  ]);
  for (const [subject, minute] of [
    ['First action mail', 1],
    ['Second action mail', 2],
  ] as const)
    server.control.addMessage('INBOX', {
      raw: rawMail(subject, `${minute}@example.test`),
      internaldate: new Date(`2026-10-27T12:0${minute}:00Z`),
      flags: [],
    });
  function request(
    path: string,
    method: 'GET' | 'POST' = 'GET',
    payload?: object,
    cookie = owner.cookie,
    origin = testConfig.appUrl,
  ) {
    return app.inject({
      url: `/api/mail/${path}`,
      method,
      headers: { origin, cookie },
      ...(payload ? { payload } : {}),
    });
  }
  const connected = await request('accounts', 'POST', {
    name: 'Actions account',
    host: 'localhost',
    port,
    transport: 'tls',
    username: 'testuser',
    password: imapPassword,
    history: 'all',
  });
  assert.equal(connected.statusCode, 202, connected.body);
  const account = connected.json().account.id;
  await syncAccount(pool, keys, owner.id, account);
  const [second, first] = (await request('messages')).json().messages;
  const providerSeen = (uid: number) =>
    server.control.getMessage('INBOX', uid).flags.includes('\\Seen');
  const inboxUnread = async () =>
    (await request('mailboxes'))
      .json()
      .mailboxes.find((box: { role: string }) => box.role === 'inbox').unread;
  const mark = (id: string, kind: string, action = randomUUID()) =>
    request(`messages/${id}/actions`, 'POST', { id: action, kind });
  // Tests skip the five-second undo window instead of sleeping through it.
  const apply = async (connect?: typeof connectImap) => {
    await pool.query(
      "UPDATE mail_actions SET next_attempt_at=now(),undo_until=LEAST(undo_until,now()) WHERE state='pending'",
    );
    await applyMailActions(pool, keys, owner.id, account, connect);
  };
  t.beforeEach(() =>
    pool.query('DELETE FROM mail_request_limits WHERE user_id=$1', [owner.id]),
  );

  await t.test(
    'actions reject anonymous, foreign, cross-origin and invalid requests',
    async () => {
      const payload = { id: randomUUID(), kind: 'read' };
      const path = `messages/${first.id}/actions`;
      assert.equal((await request(path, 'POST', payload, '')).statusCode, 401);
      assert.equal(
        (await request(path, 'POST', payload, other.cookie)).statusCode,
        404,
      );
      assert.equal(
        (
          await request(
            path,
            'POST',
            payload,
            owner.cookie,
            'https://attacker.test',
          )
        ).statusCode,
        403,
      );
      for (const invalid of [
        { id: 'not-a-uuid', kind: 'read' },
        { id: randomUUID(), kind: 'delete' },
      ])
        assert.equal((await request(path, 'POST', invalid)).statusCode, 400);
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM mail_actions')).rows[0].count,
        ),
        0,
      );
    },
  );

  await t.test(
    'mark read is immediate locally, idempotent and survives a sync before dispatch',
    async () => {
      assert.equal(await inboxUnread(), 2);
      const action = randomUUID();
      const marked = await mark(first.id, 'read', action);
      assert.equal(marked.statusCode, 202, marked.body);
      assert.deepEqual(marked.json().action, {
        id: action,
        kind: 'read',
        state: 'pending',
      });
      assert.equal((await mark(first.id, 'read', action)).statusCode, 202);
      assert.equal((await mark(first.id, 'unread', action)).statusCode, 409);
      assert.equal((await mark(second.id, 'read', action)).statusCode, 409);
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM mail_actions')).rows[0].count,
        ),
        1,
      );
      assert.equal(await inboxUnread(), 1);
      const detail = (await request(`messages/${first.id}`)).json().message;
      assert.equal(detail.unread, false);
      assert.equal(detail.lastAction.state, 'pending');
      assert.equal(
        (await request('messages')).json().messages[1].unread,
        false,
      );
      // A metadata pass that still sees the provider as unread keeps pending intent.
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(providerSeen(1), false);
      assert.equal(await inboxUnread(), 1);
      await apply();
      assert.equal(providerSeen(1), true);
      assert.equal(
        (await request(`messages/${first.id}`)).json().message.lastAction.state,
        'applied',
      );
      assert.equal(await inboxUnread(), 1);
    },
  );

  await t.test(
    'consecutive intents apply in order and external changes reconcile',
    async () => {
      await mark(first.id, 'unread');
      await mark(first.id, 'read');
      await mark(first.id, 'unread');
      await apply();
      assert.equal(providerSeen(1), false);
      assert.equal(
        (await request(`messages/${first.id}`)).json().message.unread,
        true,
      );
      server.control.setFlags('INBOX', [2], ['\\Seen'], 'add');
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(
        (await request(`messages/${second.id}`)).json().message.unread,
        false,
      );
      assert.equal(await inboxUnread(), 1);
    },
  );

  await t.test(
    'provider failures retry, then fail visibly and revert the local change',
    async () => {
      await mark(first.id, 'read');
      assert.equal(await inboxUnread(), 0);
      for (let attempt = 0; attempt < 5; attempt++) {
        await apply(async () => {
          throw new Error('Provider offline');
        });
      }
      const detail = (await request(`messages/${first.id}`)).json().message;
      assert.equal(detail.lastAction.state, 'failed');
      assert.equal(detail.unread, true);
      assert.equal(providerSeen(1), false);
      assert.equal(await inboxUnread(), 1);
      await mark(first.id, 'read');
      await pool.query(
        "UPDATE mail_memberships SET uid_validity='999' WHERE user_id=$1 AND message_id=$2",
        [owner.id, first.id],
      );
      await apply();
      const changed = (
        await pool.query(
          'SELECT state,error_code FROM mail_actions WHERE message_id=$1 ORDER BY seq DESC LIMIT 1',
          [first.id],
        )
      ).rows[0];
      assert.deepEqual(changed, {
        state: 'conflict',
        error_code: 'message_changed',
      });
      assert.equal(providerSeen(1), false);
      assert.equal(await inboxUnread(), 1);
      await pool.query(
        "UPDATE mail_memberships SET uid_validity='1' WHERE user_id=$1 AND message_id=$2",
        [owner.id, first.id],
      );
    },
  );

  await t.test(
    'archive and trash move to designated folders and keep local identity',
    async () => {
      for (const [subject, minute] of [
        ['Third action mail', 3],
        ['Fourth action mail', 4],
        ['Fifth action mail', 5],
      ] as const)
        server.control.addMessage('INBOX', {
          raw: rawMail(subject, `${minute}@example.test`),
          internaldate: new Date(`2026-10-27T12:0${minute}:00Z`),
          flags: [],
        });
      const resync = async () => {
        await pool.query(
          'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
          [owner.id],
        );
        await syncAccount(pool, keys, owner.id, account);
      };
      await resync();
      const folders = (await request('mailboxes')).json().mailboxes as {
        id: string;
        role: string | null;
      }[];
      const folder = (role: string) => {
        const found = folders.find((box) => box.role === role);
        assert.ok(found);
        return found.id;
      };
      const inbox = folder('inbox');
      const archive = folder('\\Archive');
      const trash = folder('\\Trash');
      const subjects = async (box: string): Promise<string[]> =>
        (await request(`messages?mailbox=${box}`))
          .json()
          .messages.map((message: { subject: string }) => message.subject);
      const idOf = async (subject: string) => {
        const id = (
          await pool.query(
            'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
            [owner.id, subject],
          )
        ).rows[0]?.id as string | undefined;
        assert.ok(id);
        return id;
      };
      const provider = (path: string) =>
        server.control
          .listMessages(path, { raw: true })
          .map((message) => /Subject: (.*)\r\n/.exec(String(message.raw))?.[1]);

      const third = await idOf('Third action mail');
      assert.equal((await mark(third, 'archive')).statusCode, 202);
      assert.ok(!(await subjects(inbox)).includes('Third action mail'));
      assert.ok((await subjects(archive)).includes('Third action mail'));
      assert.deepEqual(
        (await request(`messages/${third}?mailbox=${archive}`)).json().message
          .canMove,
        { archive: false, trash: true },
      );
      assert.equal((await mark(third, 'archive')).statusCode, 409);
      // A metadata pass before dispatch keeps the pending destination.
      await resync();
      assert.ok(provider('INBOX').includes('Third action mail'));
      assert.ok((await subjects(archive)).includes('Third action mail'));
      await apply();
      assert.ok(!provider('INBOX').includes('Third action mail'));
      assert.ok(provider('Archive').includes('Third action mail'));
      assert.equal(await idOf('Third action mail'), third);
      await resync();
      assert.equal(await idOf('Third action mail'), third);
      assert.deepEqual(
        (await subjects(archive)).filter(
          (subject) => subject === 'Third action mail',
        ),
        ['Third action mail'],
      );
      // A read queued after a move in the same batch reaches the moved copy.
      await mark(third, 'trash');
      await mark(third, 'read');
      await apply();
      assert.deepEqual(provider('Trash'), ['Third action mail']);
      assert.ok(
        server.control.listMessages('Trash')[0]?.flags.includes('\\Seen'),
      );
      assert.deepEqual(await subjects(trash), ['Third action mail']);
      assert.equal(await idOf('Third action mail'), third);

      const fourth = await idOf('Fourth action mail');
      await pool.query('UPDATE mailboxes SET role=NULL WHERE id=$1', [trash]);
      assert.equal((await mark(fourth, 'trash')).statusCode, 409);
      await pool.query("UPDATE mailboxes SET role='\\Trash' WHERE id=$1", [
        trash,
      ]);

      // Servers without MOVE or UIDPLUS are refused rather than risking a broad EXPUNGE.
      await mark(fourth, 'archive');
      await apply(async (...args) => {
        const client = await connectImap(...args);
        client.capabilities.delete('MOVE');
        client.capabilities.delete('UIDPLUS');
        return client;
      });
      assert.equal(
        (await request(`messages/${fourth}`)).json().message.lastAction.state,
        'failed',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT error_code FROM mail_actions WHERE message_id=$1 ORDER BY seq DESC LIMIT 1',
            [fourth],
          )
        ).rows[0].error_code,
        'move_unsupported',
      );
      assert.ok((await subjects(inbox)).includes('Fourth action mail'));
      assert.ok(provider('INBOX').includes('Fourth action mail'));

      // Without COPYUID the destination is rescanned instead of guessed.
      await mark(fourth, 'archive');
      await apply(async (...args) => {
        const client = await connectImap(...args);
        const move = client.messageMove.bind(client);
        client.messageMove = async (...moveArgs) => {
          const moved = await move(...moveArgs);
          return moved && { ...moved, uidMap: undefined };
        };
        return client;
      });
      assert.ok(provider('Archive').includes('Fourth action mail'));
      assert.ok(!(await subjects(inbox)).includes('Fourth action mail'));
      await syncAccount(pool, keys, owner.id, account);
      assert.ok((await subjects(archive)).includes('Fourth action mail'));
      assert.ok(!(await subjects(inbox)).includes('Fourth action mail'));

      const fifth = await idOf('Fifth action mail');
      await mark(fifth, 'trash');
      assert.ok((await subjects(trash)).includes('Fifth action mail'));
      for (let attempt = 0; attempt < 5; attempt++) {
        await apply(async () => {
          throw new Error('Provider offline');
        });
      }
      assert.ok(!(await subjects(trash)).includes('Fifth action mail'));
      assert.ok((await subjects(inbox)).includes('Fifth action mail'));
      assert.ok(provider('INBOX').includes('Fifth action mail'));
    },
  );

  await t.test(
    'move chooses a folder and restore returns to the recorded origin',
    async () => {
      for (const [subject, minute] of [
        ['Sixth action mail', 6],
        ['Seventh action mail', 7],
      ] as const)
        server.control.addMessage('INBOX', {
          raw: rawMail(subject, `${minute}@example.test`),
          internaldate: new Date(`2026-10-27T12:0${minute}:00Z`),
          flags: [],
        });
      server.control.addMessage('Trash', {
        raw: rawMail('Eighth action mail', '8@example.test'),
        internaldate: new Date('2026-10-27T12:08:00Z'),
        flags: [],
      });
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      const folders = (await request('mailboxes')).json().mailboxes as {
        id: string;
        path: string;
      }[];
      const folder = (path: string) => {
        const found = folders.find((box) => box.path === path);
        assert.ok(found);
        return found.id;
      };
      const idOf = async (subject: string) => {
        const id = (
          await pool.query(
            'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
            [owner.id, subject],
          )
        ).rows[0]?.id as string | undefined;
        assert.ok(id);
        return id;
      };
      const folderOf = async (id: string) =>
        (
          await pool.query(
            `SELECT b.path FROM mail_memberships mm JOIN mailboxes b ON b.id=COALESCE(mm.pending_mailbox_id,mm.mailbox_id)
          WHERE mm.message_id=$1`,
            [id],
          )
        ).rows[0]?.path as string | undefined;
      const origin = async (id: string, box: string) =>
        (await request(`messages/${id}?mailbox=${folder(box)}`)).json().message
          .restoreTo?.path ?? null;
      const action = (id: string, body: object) =>
        request(`messages/${id}/actions`, 'POST', {
          id: randomUUID(),
          ...body,
        });
      const providerHas = (path: string, subject: string) =>
        server.control
          .listMessages(path, { raw: true })
          .some((message) =>
            String(message.raw).includes(`Subject: ${subject}\r\n`),
          );

      const sixth = await idOf('Sixth action mail');
      assert.equal((await action(sixth, { kind: 'move' })).statusCode, 400);
      assert.equal(
        (await action(sixth, { kind: 'archive', mailbox: folder('Receipts') }))
          .statusCode,
        400,
      );
      assert.equal(
        (await action(sixth, { kind: 'move', mailbox: randomUUID() }))
          .statusCode,
        409,
      );
      assert.equal(
        (await action(sixth, { kind: 'move', mailbox: folder('INBOX') }))
          .statusCode,
        409,
      );
      assert.equal((await action(sixth, { kind: 'restore' })).statusCode, 409);
      const operation = randomUUID();
      const moved = await request(`messages/${sixth}/actions`, 'POST', {
        id: operation,
        kind: 'move',
        mailbox: folder('Receipts'),
      });
      assert.equal(moved.statusCode, 202, moved.body);
      assert.equal(moved.json().target, 'Receipts');
      // Replay is answered from the recorded intent even though the message already moved.
      const replay = await request(`messages/${sixth}/actions`, 'POST', {
        id: operation,
        kind: 'move',
        mailbox: folder('Receipts'),
      });
      assert.equal(replay.statusCode, 202, replay.body);
      assert.equal(await folderOf(sixth), 'Receipts');
      assert.equal(await origin(sixth, 'Receipts'), 'INBOX');
      await apply();
      assert.ok(providerHas('Receipts', 'Sixth action mail'));
      assert.equal(await idOf('Sixth action mail'), sixth);
      const restored = await action(sixth, { kind: 'restore' });
      assert.equal(restored.json().target, 'INBOX');
      await apply();
      assert.ok(providerHas('INBOX', 'Sixth action mail'));
      assert.ok(!providerHas('Receipts', 'Sixth action mail'));
      assert.equal(await idOf('Sixth action mail'), sixth);
      assert.equal(await folderOf(sixth), 'INBOX');

      // Restore follows the most recent move, so Receipts -> Trash restores to Receipts.
      const seventh = await idOf('Seventh action mail');
      await action(seventh, { kind: 'move', mailbox: folder('Receipts') });
      await action(seventh, { kind: 'trash' });
      assert.equal(await origin(seventh, 'Trash'), 'Receipts');
      await apply();
      assert.equal(
        (await action(seventh, { kind: 'restore' })).json().target,
        'Receipts',
      );
      await apply();
      assert.ok(providerHas('Receipts', 'Seventh action mail'));
      assert.equal(await folderOf(seventh), 'Receipts');

      // Mail trashed before Spindle knew its origin restores to the inbox.
      const eighth = await idOf('Eighth action mail');
      assert.equal(await origin(eighth, 'Trash'), 'INBOX');
      await action(eighth, { kind: 'restore' });
      await apply();
      assert.ok(providerHas('INBOX', 'Eighth action mail'));
      assert.equal(await folderOf(eighth), 'INBOX');
    },
  );

  await t.test(
    'five-second undo cancels before dispatch and is listed for reloads',
    async () => {
      server.control.addMessage('INBOX', {
        raw: rawMail('Ninth action mail', '9@example.test'),
        internaldate: new Date('2026-10-27T12:09:00Z'),
        flags: [],
      });
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      const ninth = (
        await pool.query(
          'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
          [owner.id, 'Ninth action mail'],
        )
      ).rows[0].id as string;
      const providerHas = (path: string) =>
        server.control
          .listMessages(path, { raw: true })
          .some((message) =>
            String(message.raw).includes('Subject: Ninth action mail\r\n'),
          );
      const inInbox = async () =>
        (await request('messages'))
          .json()
          .messages.some((message: { id: string }) => message.id === ninth);
      const undo = (id: string, cookie = owner.cookie) =>
        request(`actions/${id}/undo`, 'POST', {}, cookie);

      const archived = (await mark(ninth, 'archive')).json();
      assert.ok(archived.undoMs > 0 && archived.undoMs <= 5000);
      const undoable = async (cookie = owner.cookie) =>
        (await request('actions', 'GET', undefined, cookie))
          .json()
          .actions.filter((item: { undoMs: number }) => item.undoMs > 0);
      const listed = await undoable();
      assert.deepEqual(
        listed.map((item: { id: string; subject: string; target: string }) => [
          item.id,
          item.subject,
          item.target,
        ]),
        [[archived.action.id, 'Ninth action mail', 'Archive']],
      );
      assert.deepEqual(await undoable(other.cookie), []);
      assert.equal(
        (await undo(archived.action.id, other.cookie)).statusCode,
        404,
      );
      assert.equal(await inInbox(), false);
      assert.equal((await undo(archived.action.id)).statusCode, 200);
      assert.equal((await undo(archived.action.id)).statusCode, 200);
      assert.equal(await inInbox(), true);
      assert.deepEqual(await undoable(), []);
      await apply();
      assert.ok(providerHas('INBOX'));
      assert.ok(!providerHas('Archive'));

      const unread = await inboxUnread();
      const read = (await mark(ninth, 'read')).json();
      assert.equal(await inboxUnread(), unread - 1);
      assert.equal((await undo(read.action.id)).statusCode, 200);
      assert.equal(await inboxUnread(), unread);
      await apply();
      assert.equal(
        server.control
          .listMessages('INBOX', { raw: true })
          .find((message) => String(message.raw).includes('Ninth action mail'))
          ?.flags.includes('\\Seen'),
        false,
      );

      const trashed = (await mark(ninth, 'trash')).json();
      await pool.query(
        "UPDATE mail_actions SET undo_until=now()-interval '1 second' WHERE id=$1",
        [trashed.action.id],
      );
      const expired = await undo(trashed.action.id);
      assert.equal(expired.statusCode, 409);
      assert.match(expired.json().message, /undo window has passed/);
      assert.equal(await inInbox(), false);
      await apply();
      assert.ok(providerHas('Trash'));

      // Once the worker has claimed an action at its deadline, undo cannot cancel it.
      const restored = (await mark(ninth, 'restore')).json();
      await apply();
      assert.equal((await undo(restored.action.id)).statusCode, 409);
      assert.ok(providerHas('INBOX'));
      assert.equal(await inInbox(), true);
    },
  );

  await t.test(
    'failed actions retry once, with ownership and concurrent replay protection',
    async () => {
      const failed = (await mark(first.id, 'read')).json().action.id;
      for (let attempt = 0; attempt < 5; attempt++)
        await apply(async () => {
          throw new Error('Provider offline');
        });
      const retry = (cookie = owner.cookie, origin = testConfig.appUrl) =>
        request(`actions/${failed}/retry`, 'POST', {}, cookie, origin);
      assert.equal((await retry(other.cookie)).statusCode, 404);
      assert.equal((await retry('')).statusCode, 401);
      assert.equal(
        (await retry(owner.cookie, 'https://attacker.test')).statusCode,
        403,
      );
      const results = await Promise.all([retry(), retry()]);
      assert.deepEqual(
        results.map((result) => result.statusCode),
        [202, 202],
      );
      const row = (
        await pool.query(
          'SELECT state,attempts,error_code,completed_at FROM mail_actions WHERE id=$1',
          [failed],
        )
      ).rows[0];
      assert.deepEqual(row, {
        state: 'pending',
        attempts: 0,
        error_code: null,
        completed_at: null,
      });
      assert.equal(
        (await request(`messages/${first.id}`)).json().message.unread,
        false,
      );
      const listed = (await request('actions'))
        .json()
        .actions.find((item: { id: string }) => item.id === failed);
      assert.ok(listed.undoMs > 0 && listed.undoMs <= 5000);
      await apply();
      assert.equal(providerSeen(1), true);
      assert.equal((await retry()).statusCode, 200);
      assert.equal(
        Number(
          (
            await pool.query('SELECT count(*) FROM mail_actions WHERE id=$1', [
              failed,
            ])
          ).rows[0].count,
        ),
        1,
      );

      // The same retry path restores a failed move's original destination.
      const move = (
        await pool.query(
          "SELECT id FROM mail_actions WHERE state='failed' AND kind='trash' ORDER BY seq DESC LIMIT 1",
        )
      ).rows[0].id;
      assert.equal(
        (await request(`actions/${move}/retry`, 'POST', {})).statusCode,
        202,
      );
      await apply();
      assert.equal(
        (await pool.query('SELECT state FROM mail_actions WHERE id=$1', [move]))
          .rows[0].state,
        'applied',
      );
      assert.ok(
        server.control
          .listMessages('Trash', { raw: true })
          .some((message) => String(message.raw).includes('Fifth action mail')),
      );
    },
  );

  await t.test(
    'retry refuses newer intent and automatic backoff preserves action order',
    async () => {
      const failed = (await mark(first.id, 'unread')).json().action.id;
      for (let attempt = 0; attempt < 5; attempt++)
        await apply(async () => {
          throw new Error('Provider offline');
        });
      const newer = (await mark(first.id, 'read')).json().action.id;
      const refused = await request(`actions/${failed}/retry`, 'POST', {});
      assert.equal(refused.statusCode, 409);
      assert.match(refused.json().message, /newer action/);
      await apply();
      assert.equal(providerSeen(1), true);
      assert.equal(
        (await request(`actions/${newer}/retry`, 'POST', {})).statusCode,
        200,
      );

      const older = (await mark(first.id, 'unread')).json().action.id;
      await apply(async () => {
        throw new Error('Provider offline');
      });
      await mark(first.id, 'read');
      // The first intent is in backoff while the second becomes dispatchable.
      await pool.query(
        "UPDATE mail_actions SET next_attempt_at=now()-interval '1 second',undo_until=now()-interval '1 second' WHERE state='pending' AND id<>$1",
        [older],
      );
      await applyMailActions(pool, keys, owner.id, account);
      assert.equal(
        (
          await pool.query('SELECT state FROM mail_actions WHERE id=$1', [
            older,
          ])
        ).rows[0].state,
        'pending',
      );
      assert.equal(providerSeen(1), true);
      await apply();
      assert.equal(providerSeen(1), true);
    },
  );

  await t.test(
    'feedback keeps old unresolved actions visible and paginates completed history',
    async () => {
      const inserted = (
        await pool.query(
          `INSERT INTO mail_actions(id,user_id,account_id,message_id,kind,state,subject,created_at,completed_at)
      SELECT gen_random_uuid(),$1,$2,$3,'read',CASE WHEN n=1 THEN 'pending' WHEN n=2 THEN 'failed' ELSE 'applied' END,
      'Synthetic feedback '||n,clock_timestamp()-interval '9 days',
      CASE WHEN n=1 THEN NULL WHEN n=2 THEN clock_timestamp()-interval '9 days' ELSE clock_timestamp() END
      FROM generate_series(1,55) n RETURNING id,state`,
          [owner.id, account, first.id],
        )
      ).rows;
      try {
        const page = (await request('actions')).json();
        for (const row of inserted.filter((item) => item.state !== 'applied'))
          assert.ok(
            page.actions.some((item: { id: string }) => item.id === row.id),
          );
        assert.equal(page.actions.length, 50);
        assert.ok(page.nextCursor);
        const next = (
          await request(`actions?cursor=${encodeURIComponent(page.nextCursor)}`)
        ).json();
        const all = [...page.actions, ...next.actions].map(
          (item: { id: string }) => item.id,
        );
        assert.equal(all.length, new Set(all).size);
        assert.ok(inserted.every((item) => all.includes(item.id)));
        assert.equal((await request('actions?cursor=invalid')).statusCode, 400);
        assert.deepEqual(
          (
            await request(
              `actions?cursor=${encodeURIComponent(page.nextCursor)}`,
              'GET',
              undefined,
              other.cookie,
            )
          ).json().actions,
          [],
        );
      } finally {
        await pool.query('DELETE FROM mail_actions WHERE id=ANY($1::uuid[])', [
          inserted.map((item) => item.id),
        ]);
      }
    },
  );

  await t.test(
    'provider changes before metadata sync are conflicts, including successful no-op STOREs',
    async () => {
      for (const subject of [
        'External delete',
        'External move',
        'External flag race',
      ])
        server.control.addMessage('INBOX', {
          raw: rawMail(subject, `${randomUUID()}@example.test`),
          internaldate: new Date(),
          flags: [],
        });
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      const locate = async (subject: string) =>
        (
          await pool.query(
            'SELECT m.id,mm.uid FROM mail_messages m JOIN mail_memberships mm ON mm.message_id=m.id WHERE m.user_id=$1 AND m.subject=$2',
            [owner.id, subject],
          )
        ).rows[0];
      const deleted = await locate('External delete');
      const moved = await locate('External move');
      const raced = await locate('External flag race');
      const read = (await mark(deleted.id, 'read')).json().action.id;
      const archive = (await mark(moved.id, 'archive')).json().action.id;
      const flag = (await mark(raced.id, 'read')).json().action.id;
      server.control.expungeMessages('INBOX', [Number(deleted.uid)]);
      server.control.moveMessages('INBOX', [Number(moved.uid)], 'Receipts');
      await apply(async (...args) => {
        const client = await connectImap(...args);
        const store = client.messageFlagsAdd.bind(client);
        client.messageFlagsAdd = async (...params) => {
          const result = await store(...params);
          // An outside flag edit between STORE and confirmation is observable.
          server.control.setFlags(
            'INBOX',
            [Number(raced.uid)],
            ['\\Seen'],
            'remove',
          );
          return result;
        };
        return client;
      });
      const rows = (
        await pool.query(
          'SELECT id,state,error_code FROM mail_actions WHERE id=ANY($1::uuid[])',
          [[read, archive, flag]],
        )
      ).rows;
      assert.ok(rows.every((item) => item.state === 'conflict'));
      assert.equal(
        rows.find((item) => item.id === read)?.error_code,
        'message_missing',
      );
      assert.equal(
        rows.find((item) => item.id === archive)?.error_code,
        'message_missing',
      );
      assert.equal(
        rows.find((item) => item.id === flag)?.error_code,
        'flags_changed',
      );
      assert.equal(
        (await request(`actions/${read}/retry`, 'POST', {})).statusCode,
        409,
      );
      await syncAccount(pool, keys, owner.id, account);
      assert.equal((await request(`messages/${deleted.id}`)).statusCode, 404);
      assert.equal(
        (
          await pool.query('SELECT message_id FROM mail_actions WHERE id=$1', [
            read,
          ])
        ).rows[0].message_id,
        null,
      );
      assert.equal(
        (await request(`messages/${raced.id}`)).json().message.unread,
        true,
      );
    },
  );

  await t.test(
    'lost move acknowledgements and crash redelivery reconcile without duplicate moves',
    async () => {
      server.control.addMessage('INBOX', {
        raw: rawMail('Uncertain move', 'uncertain@example.test'),
        internaldate: new Date(),
        flags: [],
      });
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      const message = (
        await pool.query(
          "SELECT id FROM mail_messages WHERE user_id=$1 AND subject='Uncertain move'",
          [owner.id],
        )
      ).rows[0].id;
      const action = (await mark(message, 'archive')).json().action.id;
      await apply(async (...args) => {
        const client = await connectImap(...args);
        const move = client.messageMove.bind(client);
        client.messageMove = async (...params) => {
          await move(...params);
          throw new Error('Synthetic lost acknowledgement');
        };
        return client;
      });
      assert.deepEqual(
        (
          await pool.query(
            'SELECT state,error_code FROM mail_actions WHERE id=$1',
            [action],
          )
        ).rows[0],
        { state: 'conflict', error_code: 'move_unconfirmed' },
      );
      await apply();
      assert.equal(
        server.control
          .listMessages('Archive', { raw: true })
          .filter((item) =>
            String(item.raw).includes('Subject: Uncertain move\r\n'),
          ).length,
        1,
      );
      assert.equal(
        (await request(`actions/${action}/retry`, 'POST', {})).statusCode,
        409,
      );
      // A durable marker left by a killed worker also forbids an automatic re-send,
      // even when the source still exists (COPY may have succeeded on UIDPLUS).
      const crashed = (await mark(first.id, 'archive')).json().action.id;
      await pool.query(
        "UPDATE mail_actions SET error_code='move_unconfirmed' WHERE id=$1",
        [crashed],
      );
      let connected = false;
      await apply(async () => {
        connected = true;
        throw new Error('Must reconcile first');
      });
      assert.equal(connected, false);
      assert.deepEqual(
        (
          await pool.query(
            'SELECT state,error_code FROM mail_actions WHERE id=$1',
            [crashed],
          )
        ).rows[0],
        { state: 'conflict', error_code: 'move_unconfirmed' },
      );
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(
        (
          await pool.query('SELECT message_id FROM mail_actions WHERE id=$1', [
            action,
          ])
        ).rows[0].message_id,
        null,
      );
    },
  );

  await t.test(
    'provider folder deletions are conflicts before local metadata catches up',
    async () => {
      server.control.createMailbox('Disappearing source');
      server.control.createMailbox('Disappearing target');
      server.control.addMessage('Disappearing source', {
        raw: rawMail('Source disappeared', 'source@example.test'),
        internaldate: new Date(),
        flags: [],
      });
      await pool.query(
        'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
        [owner.id],
      );
      await syncAccount(pool, keys, owner.id, account);
      const message = (
        await pool.query(
          "SELECT id FROM mail_messages WHERE user_id=$1 AND subject='Source disappeared'",
          [owner.id],
        )
      ).rows[0].id;
      const target = (
        await pool.query(
          "SELECT id FROM mailboxes WHERE user_id=$1 AND path='Disappearing target'",
          [owner.id],
        )
      ).rows[0].id;
      const move = (
        await request(`messages/${first.id}/actions`, 'POST', {
          id: randomUUID(),
          kind: 'move',
          mailbox: target,
        })
      ).json().action.id;
      const read = (await mark(message, 'read')).json().action.id;
      server.control.deleteMailbox('Disappearing source');
      server.control.deleteMailbox('Disappearing target');
      await apply();
      const rows = (
        await pool.query(
          'SELECT id,state,error_code FROM mail_actions WHERE id=ANY($1::uuid[])',
          [[move, read]],
        )
      ).rows;
      assert.ok(rows.every((item) => item.state === 'conflict'));
      assert.equal(
        rows.find((item) => item.id === move)?.error_code,
        'folder_missing',
      );
      assert.equal(
        rows.find((item) => item.id === read)?.error_code,
        'source_missing',
      );
      await syncAccount(pool, keys, owner.id, account);
      assert.equal(
        (
          await pool.query('SELECT message_id FROM mail_actions WHERE id=$1', [
            read,
          ])
        ).rows[0].message_id,
        null,
      );
    },
  );

  await t.test(
    'changes from other clients become visible conflicts, not silent losses',
    async () => {
      for (const [subject, minute] of [
        ['Tenth action mail', 10],
        ['Eleventh action mail', 11],
      ] as const)
        server.control.addMessage('INBOX', {
          raw: rawMail(subject, `${minute}@example.test`),
          internaldate: new Date(`2026-10-27T12:${minute}:00Z`),
          flags: [],
        });
      const resync = async () => {
        await pool.query(
          'UPDATE mailboxes SET last_synced_at=NULL WHERE user_id=$1',
          [owner.id],
        );
        await syncAccount(pool, keys, owner.id, account);
      };
      await resync();
      const idOf = async (subject: string) =>
        (
          await pool.query(
            'SELECT id FROM mail_messages WHERE user_id=$1 AND subject=$2',
            [owner.id, subject],
          )
        ).rows[0]?.id as string;
      const uidOf = (path: string, subject: string) =>
        server.control
          .listMessages(path, { raw: true })
          .find((message) =>
            String(message.raw).includes(`Subject: ${subject}\r\n`),
          )?.uid;
      const activity = async (cookie = owner.cookie) =>
        (await request('actions', 'GET', undefined, cookie)).json().actions as {
          id: string;
          kind: string;
          state: string;
          subject: string;
          messageId: string | null;
          error: string | null;
        }[];

      // Another client deletes the message during the undo window.
      const tenth = await idOf('Tenth action mail');
      const archived = (await mark(tenth, 'archive')).json().action.id;
      const uid = uidOf('INBOX', 'Tenth action mail');
      assert.ok(uid);
      server.control.expungeMessages('INBOX', [uid]);
      await resync();
      assert.equal(await idOf('Tenth action mail'), undefined);
      await apply();
      const lost = (await activity()).find((item) => item.id === archived);
      assert.ok(lost);
      assert.equal(lost.state, 'conflict');
      assert.equal(lost.subject, 'Tenth action mail');
      assert.equal(lost.messageId, null);
      assert.match(lost.error ?? '', /another mail client/);

      // The destination folder disappears before dispatch.
      const eleventh = await idOf('Eleventh action mail');
      const trashed = (await mark(eleventh, 'trash')).json().action.id;
      server.control.deleteMailbox('Trash');
      await resync();
      assert.ok(
        (await request('messages'))
          .json()
          .messages.some((message: { id: string }) => message.id === eleventh),
      );
      await apply();
      const missing = (await activity()).find((item) => item.id === trashed);
      assert.equal(missing?.state, 'conflict');
      assert.equal(missing?.error, 'The destination folder no longer exists.');
      assert.ok(uidOf('INBOX', 'Eleventh action mail'));
      assert.equal(
        (await request(`messages/${eleventh}`)).json().message.lastAction.error,
        'The destination folder no longer exists.',
      );

      // Failures and conflicts stay listed until dismissed by their owner.
      assert.deepEqual(await activity(other.cookie), []);
      assert.equal(
        (await request(`actions/${archived}/dismiss`, 'POST', {}, other.cookie))
          .statusCode,
        404,
      );
      assert.equal(
        (await request(`actions/${archived}/dismiss`, 'POST', {})).statusCode,
        200,
      );
      assert.ok(!(await activity()).some((item) => item.id === archived));
      const pending = (await mark(eleventh, 'read')).json().action.id;
      assert.equal(
        (await request(`actions/${pending}/dismiss`, 'POST', {})).statusCode,
        404,
      );
      assert.ok((await activity()).some((item) => item.id === pending));
    },
  );

  await t.test(
    'durable pg-boss dispatch applies a pending action',
    async () => {
      await mark(second.id, 'unread');
      const boss = new PgBoss({ connectionString });
      const errors: unknown[] = [];
      boss.on('error', (error) => errors.push(error));
      let stop: (() => void) | undefined;
      try {
        await boss.start();
        stop = await startMailWorker(boss, pool, keys);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && providerSeen(2))
          await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(providerSeen(2), false);
        assert.deepEqual(errors, []);
      } finally {
        stop?.();
        await boss.stop({ graceful: true, timeout: 10000 });
      }
      assert.equal(
        (await request(`messages/${second.id}`)).json().message.lastAction
          .state,
        'applied',
      );
    },
  );
});
