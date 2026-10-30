import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { AccountMenu } from './account-menu.js';
import { ActionStatus } from './action-status.js';
import { startDraft } from './draft-api.js';
import {
  mailPollDelay,
  subscribeMailChanges,
  useMailEvents,
} from './mail-events.js';

const Composer = lazy(() =>
  import('./composer.js').then((module) => ({ default: module.Composer })),
);

import { BatchActions } from './batch-actions.js';
import {
  accent,
  Icon,
  initials,
  SpindleLogo,
  shortTime,
  ThemeToggle,
} from './brand.js';
import { Conversation } from './conversation.js';
import { DraftList } from './drafts.js';
import {
  archive,
  check,
  close,
  doneAll,
  draft,
  edit,
  inbox,
  keep,
  keepFill,
  mail,
  markEmailRead,
  markEmailUnread,
  menu,
  newspaper,
  notificationsOff,
  outbox,
  reply,
  schedule,
  searchOff,
  send,
  settings,
  sync,
  trash,
  unarchive,
} from './icons.js';
import { KeyboardTriage } from './keyboard-triage.js';
import { mailApi as api, requestAction, type Undoable } from './mail-api.js';
import { mailHref, navigateMail, useMailLocation } from './mail-navigation.js';
import { OpenNotifications } from './notifications.js';
import { Outbox, OutboxFeedback, useOutbox } from './outbox.js';
import { Reader } from './reader.js';
import { SearchControls, type SearchCoverage } from './search-controls.js';
import {
  type Account,
  accountStatus,
  type Density,
  Settings,
} from './settings.js';

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
  pinned: boolean;
  muted: boolean;
  snoozedUntil: string | null;
};
type Page = {
  messages: Message[];
  nextCursor: string | null;
  coverage?: SearchCoverage | null;
};

export function Mail({
  userId,
  email,
  busy,
  onSignOut,
}: {
  userId: string;
  email: string;
  busy: boolean;
  onSignOut: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const live = useMailEvents(userId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [composeMinimized, setComposeMinimized] = useState(false);
  const [density, setDensity] = useState<Density>(() => {
    try {
      return localStorage.getItem('spindle-density') === 'compact'
        ? 'compact'
        : 'comfortable';
    } catch {
      return 'comfortable';
    }
  });
  // Portal targets: conversation controls/thread inside the reader, saved
  // searches in the drawer and notification settings in Settings.
  const [toolsEl, setToolsEl] = useState<HTMLElement | null>(null);
  const [threadEl, setThreadEl] = useState<HTMLElement | null>(null);
  const [savedEl, setSavedEl] = useState<HTMLElement | null>(null);
  const [notificationsEl, setNotificationsEl] = useState<HTMLElement | null>(
    null,
  );
  const focusNext = useRef<string | null>(null);
  const previousMessage = useRef('');
  const currentQuery = useRef('');
  const generation = useRef(0);
  const outgoing = useOutbox();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsReady, setAccountsReady] = useState(false);
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [configured, setConfigured] = useState(true);
  const {
    q,
    account,
    mailbox,
    cursor,
    message: messageId,
    conversation,
    draft: draftId,
    view,
  } = useMailLocation();
  const [page, setPage] = useState<Page>({ messages: [], nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const feedback = useRef<HTMLParagraphElement>(null);

  const query = new URLSearchParams({ limit: '50' });
  if (account) query.set('account', account);
  if (mailbox) query.set('mailbox', mailbox);
  if (cursor) query.set('cursor', cursor);
  if (q) query.set('q', q);
  const queryString = query.toString();
  currentQuery.current = queryString;
  const load = useCallback(
    async (signal: AbortSignal) => {
      if (currentQuery.current !== queryString) return;
      const requested = ++generation.current;
      const [connections, folders, messages] = await Promise.all([
        api<{ accounts: Account[]; configured: boolean }>('accounts', {
          signal,
        }),
        api<{ mailboxes: Mailbox[] }>('mailboxes', { signal }),
        api<Page>(`messages?${queryString}`, { signal }),
      ]);
      if (
        signal.aborted ||
        currentQuery.current !== queryString ||
        requested !== generation.current
      )
        return;
      setAccounts(connections.accounts);
      setAccountsReady(true);
      setConfigured(connections.configured);
      setMailboxes(folders.mailboxes);
      setPage(messages);
      setFailure('');
      setLoading(false);
    },
    [queryString],
  );

  const refreshAll = useCallback(() => setRefresh((value) => value + 1), []);

  // Refreshes counts and rows in place, without the loading state of a new view.
  const reload = useCallback(() => {
    load(new AbortController().signal).catch(() => {});
  }, [load]);

  useEffect(() => subscribeMailChanges(['mail', 'accounts'], reload), [reload]);

  const [latestAction, setLatestAction] = useState<Undoable | null>(null);
  const track = useCallback((action: Undoable) => setLatestAction(action), []);
  const [actionRevision, setActionRevision] = useState(0);
  const refreshActions = useCallback(() => {
    reload();
    setActionRevision((value) => value + 1);
  }, [reload]);

  async function toggleRead(message: Message) {
    const kind = message.unread ? 'read' : 'unread';
    const index = page.messages.findIndex((item) => item.id === message.id);
    if (q.includes('is:'))
      focusNext.current =
        page.messages[index + 1]?.id ?? page.messages[index - 1]?.id ?? null;
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
    const index = page.messages.findIndex((item) => item.id === message.id);
    focusNext.current =
      page.messages[index + 1]?.id ?? page.messages[index - 1]?.id ?? null;
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

  useEffect(() => {
    if (!messageId && previousMessage.current)
      focusNext.current = previousMessage.current;
    previousMessage.current = conversation || messageId;
  }, [messageId, conversation]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection belongs to the current query and page.
  useEffect(() => {
    setSelectedIds([]);
  }, [queryString]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Returning from the reader restores focus even when the page is unchanged.
  useEffect(() => {
    setSelectedIds((ids) =>
      ids.filter((id) => page.messages.some((message) => message.id === id)),
    );
    if (focusNext.current) {
      const target = root.current?.querySelector<HTMLElement>(
        focusNext.current === 'first'
          ? '[data-message-row] .message-open'
          : `[data-message-row="${focusNext.current}"] .message-open`,
      );
      if (target) {
        focusNext.current = null;
        target.focus();
      }
    }
  }, [page.messages, messageId]);
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
    let lastPoll = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastPoll >= mailPollDelay(10000)) {
        lastPoll = Date.now();
        void poll();
      }
    }, 1000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [load, refresh]);

  useEffect(() => {
    if (notice) feedback.current?.focus();
  }, [notice]);

  // Close the phone drawer after any navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation is the trigger.
  useEffect(() => {
    setDrawerOpen(false);
  }, [q, account, mailbox, view, messageId]);

  function compose() {
    const selectedId =
      account || selected?.accountId || accounts[0]?.id || null;
    if (
      !startDraft(
        userId,
        selectedId,
        undefined,
        accounts.find((item) => item.id === selectedId)?.signature,
      )
    )
      setNotice(
        'Unable to keep draft recovery text in this browser. Enable browser storage or free some space before composing.',
      );
  }

  async function syncAll() {
    try {
      await Promise.all(
        accounts.map((item) =>
          api(`accounts/${item.id}/sync`, { method: 'POST', body: '{}' }),
        ),
      );
      setNotice(
        accounts.length
          ? 'Sync requested for every account. Stored mail stays available while the worker checks for updates.'
          : 'Connect an account to start syncing.',
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Unable to request sync.',
      );
    }
  }

  const selected = mailboxes.find((box) => box.id === mailbox);
  const accentOf = (accountId: string) =>
    accent(
      Math.max(
        0,
        accounts.findIndex((item) => item.id === accountId),
      ),
    );
  const isInbox = (box: Mailbox) =>
    box.role === '\\Inbox' || box.path.toUpperCase() === 'INBOX';
  const inboxUnread = (accountId?: string) =>
    mailboxes
      .filter(
        (box) => isInbox(box) && (!accountId || box.accountId === accountId),
      )
      .reduce((sum, box) => sum + box.unread, 0);
  const inSettings = view === 'settings';
  const scope =
    view === 'drafts' || view === 'outbox'
      ? view
      : !q && !mailbox
        ? 'all'
        : (Object.entries(scopeQueries).find(
            ([, value]) => value === q && !mailbox,
          )?.[0] ?? '');
  const accountName = accounts.find((item) => item.id === account)?.name;
  const title = selected
    ? selected.path
    : scope === 'all' && accountName
      ? `${accountName} inbox`
      : scope && scope in scopeTitles
        ? scopeTitles[scope as keyof typeof scopeTitles]
        : q
          ? 'Search results'
          : 'All inboxes';
  const scopedBoxes = selected
    ? [selected]
    : !q
      ? mailboxes.filter(
          (box) => isInbox(box) && (!account || box.accountId === account),
        )
      : [];
  const total = scopedBoxes.length
    ? scopedBoxes.reduce((sum, box) => sum + box.total, 0)
    : null;
  const unread = scopedBoxes.length
    ? scopedBoxes.reduce((sum, box) => sum + box.unread, 0)
    : page.messages.filter((item) => item.unread).length;
  const subtitle = [
    total === null
      ? `${page.messages.length}${page.nextCursor ? '+' : ''} messages`
      : `${total} messages`,
    unread ? `${unread} unread` : '',
    selected && accountName ? accountName : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const syncing = accounts.some((item) =>
    ['syncing', 'pending'].includes(item.status),
  );
  const empty = !accounts.length
    ? ([
        inbox,
        'No accounts yet',
        'Connect an IMAP account to see your mail here.',
      ] as const)
    : syncing
      ? ([
          sync,
          'Syncing your mail',
          'No synchronized mail in this view yet. New mail appears here as soon as the first check finishes.',
        ] as const)
      : q && !scope
        ? ([
            searchOff,
            'No results',
            'Try a different word, or search all accounts.',
          ] as const)
        : (emptyStates[scope as keyof typeof emptyStates] ?? [
            inbox,
            'Nothing here',
            'Conversations will show up here.',
          ]);
  const clearSelection = () => setSelectedIds([]);

  const navItem = (
    id: string,
    label: string,
    short: string,
    icon: string,
    {
      count = 0,
      onClick,
      command,
      disabled,
      hideOnRail,
    }: {
      count?: number;
      onClick?: () => void;
      command?: string;
      disabled?: boolean;
      hideOnRail?: boolean;
    },
  ) => (
    <button
      key={id}
      type="button"
      className={`nav-item${hideOnRail ? ' rail-hidden' : ''}`}
      aria-describedby={disabled || count > 0 ? `nav-${id}-note` : undefined}
      data-mail-command={command}
      aria-pressed={!inSettings && scope === id}
      disabled={disabled}
      title={disabled ? `${label} · Coming soon` : undefined}
      onClick={onClick}
    >
      <span className="nav-icon">
        <Icon src={icon} />
        {count > 0 && (
          <span className="rail-count" aria-hidden="true">
            {count}
          </span>
        )}
      </span>
      <span className="nav-label">{label}</span>
      <span className="nav-short" aria-hidden="true">
        {short}
      </span>
      {disabled ? (
        <span className="soon" aria-hidden="true">
          Soon
        </span>
      ) : (
        count > 0 && (
          <span className="nav-count" aria-hidden="true">
            {count}
          </span>
        )
      )}
      <span id={`nav-${id}-note`} hidden>
        {disabled ? 'Coming soon' : count > 0 ? `${count} unread` : ''}
      </span>
    </button>
  );
  const goScope = (key: keyof typeof scopeQueries) => () =>
    navigateMail({
      q: scopeQueries[key],
      account: '',
      mailbox: '',
      cursor: '',
      message: '',
    });

  const rows = (
    <ul
      className={`message-list ${density}`}
      aria-label="Messages"
      aria-busy={loading}
    >
      {page.messages.map((message) => {
        const from =
          message.sender
            .map((sender) => sender.name || sender.address)
            .join(', ') || 'Unknown sender';
        const checked = selectedIds.includes(message.id);
        const subject = message.subject || '(No subject)';
        const tone = accentOf(message.accountId);
        return (
          <li
            key={message.id}
            data-message-row={message.id}
            className={`row${message.unread ? ' unread' : ''}${message.id === messageId ? ' selected' : ''}${checked ? ' checked' : ''}`}
          >
            <label className={`avatar a${tone}`} title="Select">
              <input
                data-mail-command="select"
                type="checkbox"
                checked={checked}
                onChange={(event) =>
                  setSelectedIds((ids) =>
                    event.target.checked
                      ? [...ids, message.id]
                      : ids.filter((id) => id !== message.id),
                  )
                }
              />
              <span aria-hidden="true">
                {checked ? <Icon src={check} /> : initials(from)}
              </span>
              <span className="visually-hidden">Select {subject}</span>
            </label>
            <div className="row-text">
              <p className="row-top">
                <span className="row-from">{from}</span>
                {message.pinned && (
                  <span className="row-flag" title="Pinned">
                    <Icon src={keepFill} />
                  </span>
                )}
                <time dateTime={message.receivedAt}>
                  {shortTime(message.receivedAt)}
                </time>
              </p>
              <a
                className="message-subject message-open"
                href={mailHref({ message: message.id })}
              >
                {subject}
              </a>
              <p className="row-meta">
                <span className={`dot a${tone}`} aria-hidden="true" />
                {message.accountName}
                {message.muted ? ' · Muted' : ''}
                {message.snoozedUntil
                  ? ` · Snoozed until ${new Date(message.snoozedUntil).toLocaleString()}`
                  : ''}
                {message.unread ? (
                  <span className="visually-hidden"> · Unread</span>
                ) : (
                  ''
                )}
              </p>
            </div>
            <div className="row-actions">
              {canMove(message, '\\Archive') && (
                <button
                  type="button"
                  className="icon-button small"
                  title="Archive (E)"
                  aria-label={`Archive “${subject}”`}
                  data-mail-command="archive"
                  onClick={() => void moveMessage(message, 'archive')}
                >
                  <Icon src={archive} />
                </button>
              )}
              <button
                type="button"
                className="icon-button small"
                title={message.unread ? 'Mark read (M)' : 'Mark unread (M)'}
                aria-label={`Mark “${subject}” as ${message.unread ? 'read' : 'unread'}`}
                data-mail-command="toggle"
                onClick={() => void toggleRead(message)}
              >
                <Icon src={message.unread ? markEmailRead : markEmailUnread} />
              </button>
              {['\\Archive', '\\Trash'].includes(selected?.role ?? '') && (
                <button
                  type="button"
                  className="icon-button small"
                  title="Restore"
                  aria-label={`Restore “${subject}”`}
                  onClick={() => void moveMessage(message, 'restore')}
                >
                  <Icon src={unarchive} />
                </button>
              )}
              {canMove(message, '\\Trash') && (
                <button
                  type="button"
                  className="icon-button small"
                  title="Delete (#)"
                  aria-label={`Move “${subject}” to trash`}
                  data-mail-command="trash"
                  onClick={() => void moveMessage(message, 'trash')}
                >
                  <Icon src={trash} />
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );

  const mailList = (
    <section className="pane list-pane" aria-labelledby="list-title">
      <BatchActions
        key={userId}
        user={userId}
        selected={page.messages.filter((message) =>
          selectedIds.includes(message.id),
        )}
        onClear={clearSelection}
        onComplete={() => {
          clearSelection();
          refreshActions();
        }}
      >
        <label className="select-page" title="Select all on this page">
          <input
            data-mail-command="select-page"
            type="checkbox"
            checked={
              page.messages.length > 0 &&
              selectedIds.length === page.messages.length
            }
            onChange={(event) =>
              setSelectedIds(
                event.target.checked
                  ? page.messages.map((item) => item.id)
                  : [],
              )
            }
          />
          <span className="visually-hidden">
            Select all messages on this page
          </span>
        </label>
      </BatchActions>
      <div className={`list-head${selectedIds.length ? ' hidden' : ''}`}>
        <div className="list-title">
          <h2 id="list-title">{title}</h2>
          <p>{subtitle}</p>
        </div>
        <button
          type="button"
          className={`live-pill${live ? '' : ' offline'}`}
          title={
            live
              ? 'Live updates connected. Sync all accounts now'
              : 'Live updates are reconnecting. Automatic refresh continues.'
          }
          onClick={() => void syncAll()}
        >
          <span className="dot" aria-hidden="true" />
          {live ? 'Live sync' : 'Reconnecting'}
        </button>
      </div>
      {accounts.length > 1 && (
        <fieldset className="account-chips">
          <legend className="visually-hidden">Filter by account</legend>
          <button
            type="button"
            aria-pressed={!account}
            onClick={() =>
              navigateMail({
                account: '',
                mailbox: '',
                cursor: '',
                message: '',
              })
            }
          >
            {!account && <Icon src={check} />}
            All accounts
          </button>
          {accounts.map((item, index) => (
            <button
              key={item.id}
              type="button"
              className={`a${accent(index)}`}
              aria-pressed={account === item.id && !mailbox}
              onClick={() =>
                navigateMail({
                  account: account === item.id ? '' : item.id,
                  mailbox: '',
                  cursor: '',
                  message: '',
                })
              }
            >
              {account === item.id && !mailbox ? (
                <Icon src={check} />
              ) : (
                <span className="dot" aria-hidden="true" />
              )}
              {item.name}
            </button>
          ))}
        </fieldset>
      )}
      <div className="list-scroll">
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
        {loading ? (
          <p role="status" className="list-loading">
            Loading mail…
          </p>
        ) : page.messages.length === 0 ? (
          <div className="empty-state">
            <span className="empty-icon">
              <Icon src={empty[0]} />
            </span>
            <p className="empty-title">{empty[1]}</p>
            <p>{empty[2]}</p>
            {!accounts.length && (
              <button
                type="button"
                className="filled"
                onClick={() => navigateMail({ view: 'settings', message: '' })}
              >
                Connect an account
              </button>
            )}
          </div>
        ) : (
          rows
        )}
        <div className="pager">
          {cursor && (
            <button
              type="button"
              className="text-button"
              data-mail-command="newest"
              onClick={() => {
                focusNext.current = 'first';
                navigateMail({ cursor: '', message: '' });
              }}
            >
              Newest messages
            </button>
          )}
          {page.nextCursor && (
            <button
              type="button"
              className="text-button"
              data-mail-command="older"
              onClick={() => {
                focusNext.current = 'first';
                navigateMail({
                  cursor: page.nextCursor ?? '',
                  message: '',
                });
              }}
            >
              Older messages
            </button>
          )}
        </div>
      </div>
    </section>
  );

  const placeholder = (
    <section className="pane reader-pane empty-reader" aria-label="Reader">
      <span className="empty-icon large">
        <Icon src={mail} />
      </span>
      <p className="empty-title">No conversation selected</p>
      <p className="hints">
        <span>
          <kbd>J</kbd>
          <kbd>K</kbd>move
        </span>
        <span>
          <kbd>E</kbd>archive
        </span>
        <span>
          <kbd>⌘K</kbd>commands
        </span>
      </p>
    </section>
  );

  const showingReader = Boolean(messageId) && !inSettings && !view;
  return (
    <section
      ref={root}
      className={`app${showingReader ? ' reading' : ''}${drawerOpen ? ' drawer-open' : ''}`}
      aria-label="Your mail"
    >
      <OpenNotifications user={userId} container={notificationsEl} />
      {drawerOpen && (
        <button
          type="button"
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <nav className="drawer" aria-label="Mail accounts and folders">
        <div className="drawer-brand">
          <SpindleLogo size={34} />
          <span>Spindle</span>
        </div>
        <h2 className="visually-hidden">Mailboxes</h2>
        <button
          data-mail-command="compose"
          type="button"
          className="fab"
          title="Compose (C)"
          disabled={!accountsReady}
          onClick={compose}
        >
          <Icon src={edit} />
          <span className="fab-label">Compose</span>
          <span className="fab-hint" aria-hidden="true">
            C
          </span>
        </button>
        {navItem('all', 'All inboxes', 'Inbox', inbox, {
          count: inboxUnread(),
          command: 'inbox',
          onClick: () =>
            navigateMail({
              q: '',
              account: '',
              mailbox: '',
              cursor: '',
              message: '',
            }),
        })}
        {navItem('needs', 'Needs reply', 'Reply', reply, { disabled: true })}
        {navItem('news', 'Newsletters', 'News', newspaper, { disabled: true })}
        {navItem('pinned', 'Pinned', 'Pinned', keep, {
          onClick: goScope('pinned'),
        })}
        {navItem('snoozed', 'Snoozed', 'Snoozed', schedule, {
          onClick: goScope('snoozed'),
        })}
        {navItem('muted', 'Muted', 'Muted', notificationsOff, {
          onClick: goScope('muted'),
          hideOnRail: true,
        })}
        {navItem('sent', 'Sent', 'Sent', send, { onClick: goScope('sent') })}
        {navItem('drafts', 'Drafts', 'Drafts', draft, {
          command: 'drafts',
          hideOnRail: true,
          onClick: () =>
            navigateMail({
              account: '',
              mailbox: '',
              cursor: '',
              draft: '',
              view: 'drafts',
              message: '',
            }),
        })}
        {navItem('outbox', 'Outbox', 'Outbox', outbox, {
          command: 'outbox',
          hideOnRail: true,
          onClick: () =>
            navigateMail({ view: 'outbox', draft: '', message: '' }),
        })}
        {navItem('archive', 'Archive', 'Archive', archive, {
          onClick: goScope('archive'),
        })}
        {navItem('trash', 'Trash', 'Trash', trash, {
          onClick: goScope('trash'),
          hideOnRail: true,
        })}
        {accounts.length > 0 && <p className="drawer-section">Accounts</p>}
        {accounts.map((item, index) => {
          const count = inboxUnread(item.id);
          return (
            <section
              key={item.id}
              className={`drawer-account a${accent(index)}`}
              aria-label={item.name}
            >
              <h3 className="visually-hidden">{item.name}</h3>
              <button
                type="button"
                className="nav-item account"
                aria-pressed={account === item.id && !mailbox}
                title={accountStatus(item)}
                onClick={() =>
                  navigateMail({
                    account: item.id,
                    mailbox: '',
                    cursor: '',
                    message: '',
                  })
                }
              >
                <span className="nav-icon">
                  <span className="dot" aria-hidden="true" />
                </span>
                <span className="nav-label">{item.name}</span>
                <span className="nav-short" aria-hidden="true">
                  {initials(item.name)}
                </span>
                {item.status === 'error' ? (
                  <span className="nav-count error-text" aria-hidden="true">
                    Sync failed
                  </span>
                ) : (
                  count > 0 && (
                    <span className="nav-count" aria-hidden="true">
                      {count}
                    </span>
                  )
                )}
              </button>
              <ul className="folder-list">
                {mailboxes
                  .filter((box) => box.accountId === item.id)
                  .map((box) => (
                    <li key={box.id}>
                      <button
                        type="button"
                        className="nav-item folder"
                        aria-pressed={mailbox === box.id}
                        aria-label={`${box.path} (${box.unread} unread / ${box.total})`}
                        onClick={() => {
                          navigateMail({
                            account: item.id,
                            mailbox: box.id,
                            cursor: '',
                            message: '',
                            draft: '',
                            view: box.role === '\\Drafts' ? 'drafts' : '',
                          });
                        }}
                      >
                        <span className="nav-label">{box.path}</span>
                        {box.unread > 0 && (
                          <span className="nav-count" aria-hidden="true">
                            {box.unread}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
              </ul>
            </section>
          );
        })}
        <div className="drawer-saved" ref={setSavedEl} />
        <span className="drawer-spacer" />
        <button
          type="button"
          className="nav-item"
          aria-pressed={inSettings}
          onClick={() => navigateMail({ view: 'settings', message: '' })}
        >
          <span className="nav-icon">
            <Icon src={settings} />
          </span>
          <span className="nav-label">Settings</span>
        </button>
      </nav>
      <main className="main">
        <header className="top-bar">
          <button
            type="button"
            className="icon-button menu-button"
            aria-label="Open navigation"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Icon src={menu} />
          </button>
          <SearchControls
            query={q}
            account={account}
            mailbox={mailbox}
            accounts={accounts}
            folders={mailboxes}
            coverage={page.coverage ?? null}
            savedSlot={savedEl}
          />
          <span className="toolbar-spacer" />
          <div className="top-actions">
            <KeyboardTriage root={root} />
            <ThemeToggle />
            <AccountMenu email={email} busy={busy} onSignOut={onSignOut} />
          </div>
        </header>
        {!configured && !inSettings && (
          <p role="alert" className="error">
            The operator needs to configure mail encryption before you can
            connect accounts.
          </p>
        )}
        <div className="panes">
          {inSettings ? (
            <Settings
              accounts={accounts}
              configured={configured}
              density={density}
              onDensity={(value) => {
                setDensity(value);
                try {
                  localStorage.setItem('spindle-density', value);
                } catch {
                  /* Density still applies for this visit. */
                }
              }}
              onNotify={setNotice}
              onRefresh={refreshAll}
              onReload={reload}
              onSignature={(accountId, signature) =>
                setAccounts((current) =>
                  current.map((item) =>
                    item.id === accountId ? { ...item, signature } : item,
                  ),
                )
              }
              notificationsSlot={setNotificationsEl}
            />
          ) : view === 'drafts' ||
            (!messageId && selected?.role === '\\Drafts') ? (
            <>
              <section className="pane list-pane">
                <div className="list-scroll">
                  <DraftList user={userId} accountId={account} />
                </div>
              </section>
              {placeholder}
            </>
          ) : view === 'outbox' ? (
            <>
              <section className="pane list-pane">
                <div className="list-scroll">
                  <Outbox data={outgoing} />
                </div>
              </section>
              {placeholder}
            </>
          ) : (
            <>
              {mailList}
              {messageId ? (
                <div className="pane reader-pane">
                  <Reader
                    key={`${messageId}:${account}:${mailbox}:${q}:${conversation}`}
                    id={messageId}
                    conversation={conversation}
                    query={q}
                    account={account}
                    mailbox={mailbox}
                    folders={mailboxes}
                    onChange={reload}
                    actionRevision={actionRevision}
                    userId={userId}
                    accentOf={accentOf}
                    toolsRef={setToolsEl}
                    threadRef={setThreadEl}
                    onAction={(action) => {
                      track(action);
                      reload();
                    }}
                  />
                  <Conversation
                    key={`${conversation || messageId}:${account}:${mailbox}:${q}`}
                    anchor={conversation || messageId}
                    selected={messageId}
                    account={account}
                    mailbox={mailbox}
                    query={q}
                    revision={`${actionRevision}:${latestAction?.id ?? ''}`}
                    onChange={reload}
                    tools={toolsEl}
                    thread={threadEl}
                  />
                </div>
              ) : (
                placeholder
              )}
            </>
          )}
        </div>
      </main>
      {!draftId && !showingReader && !inSettings && (
        <button
          type="button"
          className="fab mobile-fab"
          disabled={!accountsReady}
          onClick={compose}
        >
          <Icon src={edit} />
          Compose
        </button>
      )}
      {draftId && (
        <div className={`compose-sheet${composeMinimized ? ' minimized' : ''}`}>
          <Suspense fallback={<p role="status">Loading composer…</p>}>
            <Composer
              key={draftId}
              id={draftId}
              user={userId}
              accounts={accounts}
              minimized={composeMinimized}
              onMinimize={() => setComposeMinimized((value) => !value)}
            />
          </Suspense>
        </div>
      )}
      <div className="snackbars">
        {!live && (
          <p role="status">
            Live updates are reconnecting. Automatic refresh continues.
          </p>
        )}
        {notice && (
          <div className="snack">
            <p ref={feedback} tabIndex={-1} role="status">
              {notice}
            </p>
            <button
              type="button"
              className="icon-button small"
              title="Dismiss"
              onClick={() => setNotice('')}
            >
              <Icon src={close} />
              <span className="visually-hidden">Dismiss notice</span>
            </button>
          </div>
        )}
        <OutboxFeedback messages={outgoing.messages} />
        <ActionStatus fresh={latestAction} onChange={refreshActions} />
      </div>
    </section>
  );
}

const scopeQueries = {
  pinned: 'in:pinned',
  snoozed: 'in:snoozed',
  muted: 'in:muted',
  sent: 'in:sent',
  archive: 'in:archive',
  trash: 'in:trash',
};
const scopeTitles = {
  all: 'All inboxes',
  pinned: 'Pinned',
  snoozed: 'Snoozed',
  muted: 'Muted',
  sent: 'Sent',
  archive: 'Archive',
  trash: 'Trash',
};
const emptyStates = {
  all: [doneAll, 'Inbox zero', 'Everything across your accounts is handled.'],
  pinned: [keep, 'Nothing pinned', 'Pin a conversation to keep it on top.'],
  snoozed: [
    schedule,
    'Nothing snoozed',
    'Snoozed mail comes back when you asked it to.',
  ],
  trash: [trash, 'Trash is empty', 'Mail you move to Trash shows up here.'],
} as const;
