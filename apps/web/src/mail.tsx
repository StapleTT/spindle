import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ActionStatus } from './action-status.js';
import { startDraft } from './draft-api.js';

const Composer = lazy(() =>
  import('./composer.js').then((module) => ({ default: module.Composer })),
);

import { DraftList } from './drafts.js';
import { mailApi as api, requestAction, type Undoable } from './mail-api.js';
import { mailHref, navigateMail, useMailLocation } from './mail-navigation.js';
import { Outbox, OutboxFeedback, useOutbox } from './outbox.js';
import { Reader } from './reader.js';
import { SmtpSettings } from './smtp-settings.js';

type Account = {
  id: string;
  name: string;
  host: string;
  port: number;
  transport: 'tls' | 'starttls';
  username: string;
  status: string;
  lastSyncedAt: string | null;
  foldersRemaining: number;
  historySince: string | null;
  smtpState: string | null;
  sender: string | null;
  senderName: string | null;
};
type Mailbox = {
  id: string;
  accountId: string;
  name: string;
  path: string;
  role: string | null;
  total: number;
  unread: number;
  initialComplete: boolean;
};
type Message = {
  id: string;
  accountId: string;
  accountName: string;
  subject: string;
  sender: { name: string; address: string }[];
  receivedAt: string;
  unread: boolean;
};
type Page = { messages: Message[]; nextCursor: string | null };

export function Mail({ userId }: { userId: string }) {
  const outgoing = useOutbox();
  const [smtpAccount, setSmtpAccount] = useState<Account | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [configured, setConfigured] = useState(true);
  const {
    account,
    mailbox,
    cursor,
    message: messageId,
    draft: draftId,
    view,
  } = useMailLocation();
  const [page, setPage] = useState<Page>({ messages: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [disconnect, setDisconnect] = useState<Account | null>(null);
  const [refresh, setRefresh] = useState(0);
  const feedback = useRef<HTMLParagraphElement>(null);

  const query = new URLSearchParams({ limit: '50' });
  if (account) query.set('account', account);
  if (mailbox) query.set('mailbox', mailbox);
  if (cursor) query.set('cursor', cursor);
  const queryString = query.toString();
  const load = useCallback(
    async (signal: AbortSignal) => {
      const [connections, folders, messages] = await Promise.all([
        api<{ accounts: Account[]; configured: boolean }>('accounts', {
          signal,
        }),
        api<{ mailboxes: Mailbox[] }>('mailboxes', { signal }),
        api<Page>(`messages?${queryString}`, { signal }),
      ]);
      if (signal.aborted) return;
      setAccounts(connections.accounts);
      setConfigured(connections.configured);
      setMailboxes(folders.mailboxes);
      setPage(messages);
      setFailure('');
      setLoading(false);
    },
    [queryString],
  );

  // Refreshes counts and rows in place, without the loading state of a new view.
  const reload = useCallback(() => {
    load(new AbortController().signal).catch(() => {});
  }, [load]);

  const [latestAction, setLatestAction] = useState<Undoable | null>(null);
  const track = useCallback((action: Undoable) => setLatestAction(action), []);
  const [actionRevision, setActionRevision] = useState(0);
  const refreshActions = useCallback(() => {
    reload();
    setActionRevision((value) => value + 1);
  }, [reload]);

  async function toggleRead(message: Message) {
    const kind = message.unread ? 'read' : 'unread';
    setPage((current) => ({
      ...current,
      messages: current.messages.map((item) =>
        item.id === message.id ? { ...item, unread: !message.unread } : item,
      ),
    }));
    try {
      const { action, target, undoMs } = await requestAction(message.id, kind);
      track({ id: action.id, kind, subject: message.subject, target, undoMs });
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Unable to update mail.',
      );
    }
    reload();
  }

  async function moveMessage(
    message: Message,
    kind: 'archive' | 'trash' | 'restore',
  ) {
    setPage((current) => ({
      ...current,
      messages: current.messages.filter((item) => item.id !== message.id),
    }));
    try {
      const { action, target, undoMs } = await requestAction(message.id, kind);
      track({ id: action.id, kind, subject: message.subject, target, undoMs });
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Unable to update mail.',
      );
    }
    reload();
  }

  // Only provider-designated folders are offered, and not from inside that folder.
  function canMove(message: Message, role: string) {
    return mailboxes.some(
      (box) =>
        box.accountId === message.accountId &&
        box.role === role &&
        box.id !== mailbox,
    );
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit refresh reruns the same inbox query.
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setPage({ messages: [], nextCursor: null });
    async function poll() {
      try {
        await load(controller.signal);
      } catch (error) {
        if (!controller.signal.aborted) {
          setFailure(
            error instanceof Error
              ? error.message
              : 'Unable to load your mail.',
          );
          setLoading(false);
        }
      }
    }
    void poll();
    const timer = setInterval(() => void poll(), 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load, refresh]);

  useEffect(() => {
    if (notice) feedback.current?.focus();
  }, [notice]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setNotice('');
    try {
      await api('accounts', {
        method: 'POST',
        body: JSON.stringify({
          name: values.get('name'),
          host: values.get('host'),
          port: Number(values.get('port')),
          transport: values.get('transport'),
          username: values.get('username'),
          password: values.get('password'),
          history: values.get('history'),
        }),
      });
      form.reset();
      setShowConnect(false);
      setEditing(null);
      setNotice(
        'Account saved. Connection and mail sync run in the background; this view updates automatically.',
      );
      setRefresh((value) => value + 1);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Unable to connect.');
    } finally {
      setBusy(false);
    }
  }

  async function sync(id: string) {
    setBusy(true);
    try {
      await api(`accounts/${id}/sync`, { method: 'POST', body: '{}' });
      setNotice(
        'Sync requested. Your stored mail stays available while the worker checks for updates.',
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Unable to request sync.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function remove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!disconnect) return;
    const form = event.currentTarget;
    const password = new FormData(form).get('password');
    setBusy(true);
    try {
      await api(`accounts/${disconnect.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ password }),
      });
      form.reset();
      setDisconnect(null);
      navigateMail({ account: '', mailbox: '', cursor: '', message: '' });
      setNotice(
        'Disconnected. Only the local mirror was removed. Your provider mail is unchanged.',
      );
      setRefresh((value) => value + 1);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Unable to disconnect.',
      );
    } finally {
      setBusy(false);
    }
  }

  const selected = mailboxes.find((box) => box.id === mailbox);
  return (
    <section className="mail" aria-label="Your mail">
      {notice && (
        <p ref={feedback} tabIndex={-1} role="status" className="notice">
          {notice}
        </p>
      )}
      <ActionStatus fresh={latestAction} onChange={refreshActions} />
      <OutboxFeedback messages={outgoing.messages} />
      {failure && (
        <p role="alert" className="error">
          {failure}{' '}
          <button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
          >
            Try again
          </button>
        </p>
      )}
      {!configured && (
        <p role="alert">
          The operator needs to configure mail encryption before you can connect
          accounts.
        </p>
      )}
      <div className="mail-layout">
        <aside aria-label="Mail accounts and folders">
          <h2>Mailboxes</h2>
          <button
            type="button"
            onClick={() => {
              if (
                !startDraft(
                  userId,
                  account || selected?.accountId || accounts[0]?.id || null,
                )
              )
                setNotice(
                  'Unable to keep draft recovery text in this browser. Enable browser storage or free some space before composing.',
                );
            }}
          >
            Compose
          </button>
          <button
            type="button"
            aria-pressed={view === 'drafts'}
            onClick={() =>
              navigateMail({ draft: '', view: 'drafts', message: '' })
            }
          >
            Local drafts
          </button>
          <button
            type="button"
            aria-pressed={
              !account && !mailbox && view !== 'drafts' && view !== 'outbox'
            }
            onClick={() => {
              navigateMail({
                account: '',
                mailbox: '',
                cursor: '',
                message: '',
              });
            }}
          >
            Unified inbox
          </button>
          <button
            type="button"
            aria-pressed={view === 'outbox'}
            onClick={() =>
              navigateMail({ view: 'outbox', draft: '', message: '' })
            }
          >
            Outbox
          </button>
          {accounts.map((item) => (
            <section
              className="mail-account"
              key={item.id}
              aria-label={item.name}
            >
              <h3>{item.name}</h3>
              <p className="account-status">
                {item.status === 'error'
                  ? 'Sync failed. Check your server settings and app password, then reconnect. Automatic retries continue.'
                  : item.status === 'syncing'
                    ? `Syncing mail${item.foldersRemaining ? ` · ${item.foldersRemaining} folders remaining` : ''}…`
                    : item.status === 'pending'
                      ? 'Waiting for the sync worker…'
                      : 'Up to date at last check.'}
              </p>
              {item.lastSyncedAt && (
                <p className="account-status">
                  Last checked: {new Date(item.lastSyncedAt).toLocaleString()}
                </p>
              )}
              <p className="account-status">
                History:{' '}
                {item.historySince
                  ? `since ${new Date(item.historySince).toLocaleDateString()}`
                  : 'all available mail'}
              </p>
              <button
                type="button"
                aria-pressed={account === item.id && !mailbox}
                onClick={() => {
                  navigateMail({
                    account: item.id,
                    mailbox: '',
                    cursor: '',
                    message: '',
                  });
                }}
              >
                Inbox
              </button>
              <ul className="folder-list">
                {mailboxes
                  .filter((box) => box.accountId === item.id)
                  .map((box) => (
                    <li key={box.id}>
                      <button
                        type="button"
                        aria-pressed={mailbox === box.id}
                        onClick={() => {
                          navigateMail({
                            account: item.id,
                            mailbox: box.id,
                            cursor: '',
                            message: '',
                          });
                        }}
                      >
                        {box.path}{' '}
                        <span>
                          ({box.unread} unread / {box.total})
                        </span>
                      </button>
                    </li>
                  ))}
              </ul>
              <button
                type="button"
                aria-label={`Outgoing SMTP for ${item.name}`}
                onClick={() => setSmtpAccount(item)}
              >
                Outgoing SMTP
              </button>
              <div className="account-actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void sync(item.id)}
                >
                  Sync now
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEditing(item);
                    setShowConnect(true);
                    setDisconnect(null);
                  }}
                >
                  Reconnect
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDisconnect(item);
                    setShowConnect(false);
                  }}
                >
                  Disconnect
                </button>
              </div>
            </section>
          ))}
          <button
            type="button"
            disabled={!configured || busy}
            onClick={() => {
              setEditing(null);
              setShowConnect(true);
              setDisconnect(null);
            }}
          >
            Connect IMAP account
          </button>
        </aside>
        <div className="mail-content">
          {smtpAccount && (
            <SmtpSettings
              key={smtpAccount.id}
              account={smtpAccount}
              onClose={() => setSmtpAccount(null)}
              onChange={reload}
            />
          )}
          {showConnect && (
            <section aria-labelledby="connect-title">
              <h2 id="connect-title">
                {editing ? 'Reconnect IMAP account' : 'Connect IMAP account'}
              </h2>
              <p>
                Use your provider’s IMAP settings and app password where
                required. Only encrypted connections with valid certificates are
                accepted.
              </p>
              <form
                key={editing?.id ?? 'new'}
                onSubmit={(event) => void connect(event)}
                aria-busy={busy}
              >
                <label>
                  Account name
                  <input
                    name="name"
                    required
                    maxLength={100}
                    defaultValue={editing?.name ?? ''}
                  />
                </label>
                <label>
                  IMAP server
                  <input
                    name="host"
                    required
                    maxLength={253}
                    autoCapitalize="none"
                    readOnly={Boolean(editing)}
                    defaultValue={editing?.host ?? ''}
                    placeholder="imap.example.com"
                  />
                </label>
                <label>
                  Port
                  <input
                    name="port"
                    type="number"
                    required
                    min={1}
                    max={65535}
                    readOnly={Boolean(editing)}
                    defaultValue={editing?.port ?? 993}
                  />
                </label>
                <label>
                  Encryption
                  <select
                    name="transport"
                    defaultValue={editing?.transport ?? 'tls'}
                  >
                    <option value="tls">TLS (usually port 993)</option>
                    <option value="starttls">
                      Required STARTTLS (usually port 143)
                    </option>
                  </select>
                </label>
                <label>
                  IMAP username
                  <input
                    name="username"
                    required
                    maxLength={320}
                    autoComplete="username"
                    autoCapitalize="none"
                    readOnly={Boolean(editing)}
                    defaultValue={editing?.username ?? ''}
                  />
                </label>
                <label>
                  IMAP password or app password
                  <input
                    name="password"
                    type="password"
                    required
                    maxLength={1024}
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  Mail history
                  <select
                    name="history"
                    defaultValue={
                      editing?.historySince === null ? 'all' : '90d'
                    }
                    disabled={Boolean(editing)}
                  >
                    <option value="90d">Last 90 days, then new mail</option>
                    <option value="all">All available mail</option>
                  </select>
                </label>
                {editing && (
                  <input
                    type="hidden"
                    name="history"
                    value={editing.historySince ? '90d' : 'all'}
                  />
                )}
                <p>
                  Stores mail headers and flags locally. Message bodies are
                  cached when opened. Up to five accounts.
                </p>
                <button type="submit" disabled={busy}>
                  {busy ? 'Saving…' : 'Save and sync'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setShowConnect(false);
                    setEditing(null);
                  }}
                >
                  Cancel
                </button>
              </form>
            </section>
          )}
          {disconnect && (
            <section aria-labelledby="disconnect-title">
              <h2 id="disconnect-title">Disconnect {disconnect.name}</h2>
              <p>
                This removes the account, saved credentials and synchronized
                mail from Spindle. Mail at your provider stays intact. Local
                drafts are kept without a selected account.
              </p>
              <form onSubmit={(event) => void remove(event)}>
                <label>
                  Confirm your Spindle password
                  <input
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    maxLength={128}
                    required
                  />
                </label>
                <button type="submit" disabled={busy}>
                  Confirm disconnect
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDisconnect(null)}
                >
                  Cancel
                </button>
              </form>
            </section>
          )}
          {draftId ? (
            <Suspense fallback={<p role="status">Loading composer…</p>}>
              <Composer
                key={draftId}
                id={draftId}
                user={userId}
                accounts={accounts}
              />
            </Suspense>
          ) : view === 'drafts' ? (
            <DraftList user={userId} />
          ) : view === 'outbox' ? (
            <Outbox data={outgoing} />
          ) : messageId ? (
            <Reader
              key={`${messageId}:${account}:${mailbox}`}
              id={messageId}
              account={account}
              mailbox={mailbox}
              folders={mailboxes}
              onChange={reload}
              actionRevision={actionRevision}
              userId={userId}
              onAction={(action) => {
                track(action);
                reload();
              }}
            />
          ) : (
            <>
              <h2>
                {selected?.path ??
                  (account
                    ? `${accounts.find((item) => item.id === account)?.name ?? 'Account'} inbox`
                    : 'Unified inbox')}
              </h2>
              <p className="account-status">
                Mail from local storage. Open a message to read it. Sync
                continues in the background.
              </p>
              {loading ? (
                <p role="status">Loading mail…</p>
              ) : page.messages.length === 0 ? (
                <p>
                  {accounts.length
                    ? 'No synchronized mail in this view yet. If you just connected an account, wait for the worker to finish its first check.'
                    : 'Connect an IMAP account to see your mail here.'}
                </p>
              ) : (
                <ul className="message-list" aria-label="Messages">
                  {page.messages.map((message) => (
                    <li
                      key={message.id}
                      className={message.unread ? 'unread' : ''}
                    >
                      <div className="message-heading">
                        <span>
                          {message.sender
                            .map((sender) => sender.name || sender.address)
                            .join(', ') || 'Unknown sender'}
                        </span>
                        <time dateTime={message.receivedAt}>
                          {new Date(message.receivedAt).toLocaleString()}
                        </time>
                      </div>
                      <a
                        className="message-subject message-open"
                        href={mailHref({ message: message.id })}
                      >
                        {message.subject || '(No subject)'}
                      </a>
                      <div className="account-status">
                        {message.accountName}
                        {message.unread ? ' · Unread' : ''}{' '}
                        <button
                          type="button"
                          aria-label={`Mark “${message.subject || '(No subject)'}” as ${message.unread ? 'read' : 'unread'}`}
                          onClick={() => void toggleRead(message)}
                        >
                          {message.unread ? 'Mark read' : 'Mark unread'}
                        </button>{' '}
                        {canMove(message, '\\Archive') && (
                          <button
                            type="button"
                            aria-label={`Archive “${message.subject || '(No subject)'}”`}
                            onClick={() => void moveMessage(message, 'archive')}
                          >
                            Archive
                          </button>
                        )}{' '}
                        {['\\Archive', '\\Trash'].includes(
                          selected?.role ?? '',
                        ) && (
                          <button
                            type="button"
                            aria-label={`Restore “${message.subject || '(No subject)'}”`}
                            onClick={() => void moveMessage(message, 'restore')}
                          >
                            Restore
                          </button>
                        )}{' '}
                        {canMove(message, '\\Trash') && (
                          <button
                            type="button"
                            aria-label={`Move “${message.subject || '(No subject)'}” to trash`}
                            onClick={() => void moveMessage(message, 'trash')}
                          >
                            Trash
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <div className="account-actions">
                {cursor && (
                  <button
                    type="button"
                    onClick={() => navigateMail({ cursor: '', message: '' })}
                  >
                    Newest messages
                  </button>
                )}
                {page.nextCursor && (
                  <button
                    type="button"
                    onClick={() =>
                      navigateMail({
                        cursor: page.nextCursor ?? '',
                        message: '',
                      })
                    }
                  >
                    Older messages
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
