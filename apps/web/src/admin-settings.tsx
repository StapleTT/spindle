import { type FormEvent, useEffect, useRef, useState } from 'react';
import { securityEventLabels } from './account-api.js';
import { Icon } from './brand.js';
import { history, mail, manageAccounts, shieldLock } from './icons.js';

type User = {
  id: string;
  name: string;
  email: string;
  role: 'admin' | 'user';
  emailVerified: boolean;
  suspended: boolean;
  deletionDueAt: string | null;
  revision: number;
  createdAt: string;
  accountCount: number;
  sessionCount: number;
  current: boolean;
};
type Invite = {
  id: string;
  email: string;
  role: string;
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  delivery: string;
  expiresAt: string;
  createdAt: string;
};
type Audit = {
  id: string;
  action: string;
  targetId: string;
  actorEmail: string | null;
  createdAt: string;
  details: { email?: string; role?: string; suspended?: boolean };
};
type SecurityEvent = {
  id: string;
  type: string;
  userId: string;
  email: string | null;
  ipAddress: string | null;
  createdAt: string;
};
type Tab = 'users' | 'invites' | 'audit' | 'security';
type Change = {
  title: string;
  description: string;
  path: string;
  body: object;
  operationId: string;
};
async function adminApi<T>(
  path: string,
  body?: object,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api/admin/${path}`, {
    method: body ? 'POST' : 'GET',
    cache: 'no-store',
    ...(body
      ? {
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }
      : {}),
    ...(signal ? { signal } : {}),
  });
  const value = await response.json();
  if (!response.ok) {
    if (value.code === 'ADMIN_LOCKED')
      window.dispatchEvent(new Event('spindle:admin-locked'));
    else if (response.status === 401 || response.status === 403)
      window.dispatchEvent(new Event('spindle:session-check'));
    throw new Error(
      value.message ?? 'Unable to complete this administration request.',
    );
  }
  return value as T;
}
const actions: Record<string, string> = {
  'user.suspend': 'Suspended user',
  'user.resume': 'Resumed user',
  'user.role': 'Changed role',
  'user.sessions': 'Signed out user devices',
  'user.delete': 'Deleted user',
  'invite.send': 'Issued invitation',
  'invite.revoke': 'Revoked invitation',
};
export function AdminSettings() {
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const accessGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    const check = () => {
      const requested = ++accessGeneration.current;
      void adminApi<{ unlocked: boolean }>(
        'access',
        undefined,
        controller.signal,
      )
        .then((value) => {
          if (
            !controller.signal.aborted &&
            requested === accessGeneration.current
          ) {
            setUnlocked(value.unlocked);
            setError('');
          }
        })
        .catch((failure: unknown) => {
          if (
            !controller.signal.aborted &&
            requested === accessGeneration.current
          ) {
            setUnlocked(false);
            setError(
              failure instanceof Error
                ? failure.message
                : 'Unable to check administration access.',
            );
          }
        });
    };
    check();
    window.addEventListener('focus', check);
    const lock = () => {
      accessGeneration.current++;
      setUnlocked(false);
      setError('Unlock administration to continue.');
    };
    window.addEventListener('spindle:admin-locked', lock);
    return () => {
      controller.abort();
      window.removeEventListener('focus', check);
      window.removeEventListener('spindle:admin-locked', lock);
    };
  }, []);
  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const currentPassword = new FormData(form).get('currentPassword');
    accessGeneration.current++;
    setBusy(true);
    setError('');
    try {
      const result = await adminApi<{ unlocked: boolean }>('unlock', {
        currentPassword,
      });
      form.reset();
      setUnlocked(result.unlocked);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to unlock administration.',
      );
    } finally {
      accessGeneration.current++;
      setBusy(false);
    }
  }
  if (unlocked === null)
    return <p role="status">Checking administration access…</p>;
  if (unlocked) return <AdminPanel />;
  return (
    <section
      className="settings-panel account-security"
      aria-labelledby="admin-unlock-title"
    >
      <div className="settings-group">
        <h3 id="admin-unlock-title">
          <Icon src={shieldLock} /> Unlock administration
        </h3>
        <p className="muted small">
          Enter your current password once to view and manage administration.
          Access stays unlocked for this sign-in session.
        </p>
      </div>
      <form onSubmit={(event) => void unlock(event)}>
        <label>
          Current password
          <input
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
            disabled={busy}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="admin-toolbar">
          <button type="submit" disabled={busy}>
            {busy ? 'Unlocking…' : 'Unlock administration'}
          </button>
        </div>
      </form>
    </section>
  );
}
function AdminPanel() {
  const [tab, setTab] = useState<Tab>('users');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [security, setSecurity] = useState<SecurityEvent[]>([]);
  const [overview, setOverview] = useState<{
    users: number;
    suspended: number;
    deletions: number;
    invitations: number;
  } | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [change, setChange] = useState<Change | null>(null);
  const [revision, setRevision] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const loadGeneration = useRef(0);
  const previousFocus = useRef<HTMLElement | null>(null);
  const canClose = useRef(true);
  canClose.current = !saving;

  async function load(signal?: AbortSignal, next?: string) {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const query = new URLSearchParams();
      if (search && (tab === 'users' || tab === 'invites'))
        query.set('search', search);
      if (next) query.set('cursor', next);
      const [summary, page] = await Promise.all([
        adminApi<{
          users: number;
          suspended: number;
          deletions: number;
          invitations: number;
        }>('overview', undefined, signal),
        adminApi<{
          users?: User[];
          invites?: Invite[];
          events?: Audit[] & SecurityEvent[];
          nextCursor: string | null;
        }>(`${tab}?${query}`, undefined, signal),
      ]);
      if (signal?.aborted || generation !== loadGeneration.current) return;
      setOverview(summary);
      setCursor(page.nextCursor);
      if (tab === 'users')
        setUsers((current) =>
          next ? [...current, ...(page.users ?? [])] : (page.users ?? []),
        );
      if (tab === 'invites')
        setInvites((current) =>
          next ? [...current, ...(page.invites ?? [])] : (page.invites ?? []),
        );
      if (tab === 'audit')
        setAudit((current) =>
          next ? [...current, ...(page.events ?? [])] : (page.events ?? []),
        );
      if (tab === 'security')
        setSecurity((current) =>
          next ? [...current, ...(page.events ?? [])] : (page.events ?? []),
        );
      setError('');
    } catch (failure) {
      if (!signal?.aborted && generation === loadGeneration.current)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Unable to load administration.',
        );
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload only on submitted scope, tab or explicit refresh; unsaved fields stay local.
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [tab, search, revision]);
  useEffect(() => {
    if (change) dialog.current?.showModal();
  }, [change]);
  function close() {
    if (!canClose.current) return;
    dialog.current?.close();
    setChange(null);
    previousFocus.current?.focus();
  }
  function prepare(
    title: string,
    description: string,
    path: string,
    body: object,
  ) {
    previousFocus.current = document.activeElement as HTMLElement | null;
    setError('');
    setNotice('');
    setChange({
      title,
      description,
      path,
      body,
      operationId: crypto.randomUUID(),
    });
  }
  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!change || saving) return;
    const form = event.currentTarget;
    setSaving(true);
    setError('');
    try {
      const result = await adminApi<{ delivery?: string; replayed?: boolean }>(
        change.path,
        {
          ...change.body,
          operationId: change.operationId,
        },
      );
      form.reset();
      dialog.current?.close();
      setChange(null);
      previousFocus.current?.focus();
      setNotice(
        result.delivery === 'failed'
          ? 'Invitation saved, but email delivery failed. Use Resend to try again.'
          : result.replayed
            ? 'The previous operation was already recorded. Refreshing its current state.'
            : change.title === 'Send invitation' ||
                change.title === 'Resend invitation'
              ? 'Invitation saved and email sent.'
              : 'Change saved.',
      );
      setRevision((value) => value + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save this change.',
      );
    } finally {
      setSaving(false);
    }
  }
  function userChange(
    user: User,
    action: 'suspend' | 'resume' | 'sessions' | 'role' | 'delete',
  ) {
    const role = user.role === 'admin' ? 'user' : 'admin';
    const title =
      action === 'delete'
        ? 'Delete user'
        : action === 'role'
          ? `Make ${role}`
          : action === 'sessions'
            ? 'Sign out devices'
            : action === 'suspend'
              ? 'Suspend user'
              : 'Resume user';
    prepare(
      title,
      action === 'delete'
        ? `Permanently delete ${user.email} and all of their Spindle data: connected accounts, synchronized mail, drafts, outbox and settings. Mail at their providers is not affected. This cannot be undone.`
        : action === 'suspend'
          ? `Suspend ${user.email}. Their sessions and background account leases will be revoked. Mail and drafts are retained. Queued sends are held until access is resumed. Work already submitted to a provider may still complete.`
          : action === 'role'
            ? `Set ${user.email} to ${role}. Their current sessions will be revoked.`
            : action === 'sessions'
              ? `Sign ${user.email} out on every device. Their data stays saved.`
              : `Allow ${user.email} to sign in and resume background sync. Queued mail and overdue scheduled messages may send.`,
      `users/${encodeURIComponent(user.id)}`,
      {
        action,
        expectedRevision: user.revision,
        ...(action === 'role' ? { role } : {}),
      },
    );
  }
  return (
    <div className="admin-settings">
      <div className="settings-head">
        <h3>Administration</h3>
        <p>Manage access to Spindle. Users’ mail remains private.</p>
      </div>
      {overview && (
        <dl className="admin-overview" aria-label="Administration overview">
          <div>
            <dt>Users</dt>
            <dd>{overview.users}</dd>
          </div>
          <div>
            <dt>Suspended</dt>
            <dd>{overview.suspended}</dd>
          </div>
          <div>
            <dt>Pending deletion</dt>
            <dd>{overview.deletions}</dd>
          </div>
          <div>
            <dt>Pending invites</dt>
            <dd>{overview.invitations}</dd>
          </div>
        </dl>
      )}
      <nav className="admin-toolbar" aria-label="Administration sections">
        {(['users', 'invites', 'audit', 'security'] as const).map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={tab === item}
            onClick={() => {
              setTab(item);
              setCursor(null);
              setSearch('');
              setError('');
              setNotice('');
            }}
          >
            <Icon
              src={
                item === 'users'
                  ? manageAccounts
                  : item === 'invites'
                    ? mail
                    : item === 'audit'
                      ? shieldLock
                      : history
              }
            />
            {item === 'users'
              ? 'Users'
              : item === 'invites'
                ? 'Invitations'
                : item === 'audit'
                  ? 'Activity'
                  : 'Sign-ins'}
          </button>
        ))}
        <button
          type="button"
          className="text-button"
          disabled={loading || saving}
          onClick={() => setRevision((value) => value + 1)}
        >
          Refresh administration
        </button>
      </nav>
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {error && !change && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {(tab === 'users' || tab === 'invites') && (
        <form
          key={tab}
          className="admin-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            setCursor(null);
            setSearch(
              String(
                new FormData(event.currentTarget).get('search') ?? '',
              ).trim(),
            );
            setRevision((value) => value + 1);
          }}
        >
          <label className="admin-search">
            Search {tab === 'users' ? 'users' : 'invitations'}
            <input
              name="search"
              type="search"
              maxLength={100}
              defaultValue={search}
            />
          </label>
          <button type="submit" disabled={loading}>
            Search
          </button>
        </form>
      )}
      {tab === 'invites' && (
        <section
          className="settings-panel"
          aria-labelledby="admin-invite-title"
        >
          <h4 id="admin-invite-title">Invite someone</h4>
          <p className="muted small">
            Invitations last seven days and create regular users. Promote
            administrators after they join.
          </p>
          <form
            className="admin-toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              const email = String(
                new FormData(event.currentTarget).get('email') ?? '',
              )
                .trim()
                .toLowerCase();
              prepare(
                'Send invitation',
                `Email an invitation to ${email}. They must verify their address before signing in.`,
                'invites',
                { email, expectedId: null },
              );
            }}
          >
            <label className="admin-search">
              Invitation email
              <input
                name="email"
                type="email"
                required
                maxLength={254}
                autoComplete="off"
              />
            </label>
            <button type="submit" disabled={saving}>
              Send invitation
            </button>
          </form>
        </section>
      )}
      {loading && <p role="status">Loading administration…</p>}
      {tab === 'users' && (
        <ul className="admin-list" aria-label="Users">
          {users.map((user) => (
            <li className="settings-panel admin-row" key={user.id}>
              <div className="admin-row-text">
                <h4>
                  {user.name}
                  {user.current && <span className="badge">This account</span>}
                </h4>
                <p>{user.email}</p>
                <div className="admin-badges">
                  <span className="badge">
                    {user.role === 'admin' ? 'Admin' : 'User'}
                  </span>
                  <span className="badge">
                    {user.deletionDueAt
                      ? `Deletion scheduled ${new Date(user.deletionDueAt).toLocaleDateString()}`
                      : user.suspended
                        ? 'Suspended'
                        : user.emailVerified
                          ? 'Verified'
                          : 'Unverified'}
                  </span>
                </div>
                <p className="muted small">
                  Joined {new Date(user.createdAt).toLocaleDateString()} ·{' '}
                  {user.accountCount} connected accounts · {user.sessionCount}{' '}
                  active sessions
                </p>
              </div>
              <div className="admin-row-actions">
                {!user.deletionDueAt && (
                  <button
                    type="button"
                    className="outlined"
                    disabled={user.current}
                    onClick={() =>
                      userChange(user, user.suspended ? 'resume' : 'suspend')
                    }
                  >
                    {user.suspended ? 'Resume' : 'Suspend'}
                  </button>
                )}
                <button
                  type="button"
                  className="outlined"
                  disabled={user.current}
                  onClick={() => userChange(user, 'sessions')}
                >
                  Sign out devices
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={user.current}
                  onClick={() => userChange(user, 'role')}
                >
                  {user.role === 'admin' ? 'Make user' : 'Make admin'}
                </button>
                {user.suspended && !user.current && (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => userChange(user, 'delete')}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {tab === 'invites' && (
        <ul className="admin-list" aria-label="Invitations">
          {invites.map((invite) => (
            <li className="settings-panel admin-row" key={invite.id}>
              <div className="admin-row-text">
                <h4>{invite.email}</h4>
                <div className="admin-badges">
                  <span className="badge">{invite.status}</span>
                  <span className="badge">Email {invite.delivery}</span>
                </div>
                <p className="muted small">
                  Expires {new Date(invite.expiresAt).toLocaleString()}
                </p>
              </div>
              {invite.status !== 'accepted' && invite.role !== 'admin' && (
                <div className="admin-row-actions">
                  <button
                    type="button"
                    className="outlined"
                    onClick={() =>
                      prepare(
                        'Resend invitation',
                        `Replace the invitation for ${invite.email} with a new seven-day invitation and send it.`,
                        'invites',
                        { email: invite.email, expectedId: invite.id },
                      )
                    }
                  >
                    Resend
                  </button>
                  {invite.status !== 'revoked' && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        prepare(
                          'Revoke invitation',
                          `Prevent ${invite.email} from registering with this invitation.`,
                          'invites/revoke',
                          { inviteId: invite.id },
                        )
                      }
                    >
                      Revoke
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {tab === 'audit' && (
        <ul className="admin-list" aria-label="Admin activity">
          {audit.map((event) => (
            <li className="settings-panel admin-row" key={event.id}>
              <div className="admin-row-text">
                <h4>{actions[event.action] ?? event.action}</h4>
                <p>{event.details.email ?? event.targetId}</p>
                {event.action === 'user.role' && (
                  <p className="muted small">Role: {event.details.role}</p>
                )}
                <p className="muted small">
                  {event.actorEmail ?? 'Former administrator'} ·{' '}
                  {new Date(event.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {tab === 'security' && (
        <ul className="admin-list" aria-label="Sign-in and account events">
          {security.map((event) => (
            <li className="settings-panel admin-row" key={event.id}>
              <div className="admin-row-text">
                <h4>{securityEventLabels[event.type] ?? event.type}</h4>
                <p>{event.email ?? `Deleted user ${event.userId}`}</p>
                <p className="muted small">
                  {event.ipAddress || 'Network address unavailable'} ·{' '}
                  {new Date(event.createdAt).toLocaleString()}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!loading &&
        !error &&
        (tab === 'users'
          ? users.length === 0
          : tab === 'invites'
            ? invites.length === 0
            : tab === 'audit'
              ? audit.length === 0
              : security.length === 0) && (
          <p className="muted">
            {tab === 'audit'
              ? 'No administration activity yet.'
              : tab === 'security'
                ? 'No sign-in or account events yet.'
                : 'No matches found.'}
          </p>
        )}
      {cursor && (
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(undefined, cursor)}
        >
          Show more{' '}
          {tab === 'audit' || tab === 'security'
            ? 'activity'
            : tab === 'invites'
              ? 'invitations'
              : 'users'}
        </button>
      )}
      {change && (
        <dialog
          className="admin-confirm"
          ref={dialog}
          aria-labelledby="admin-confirm-title"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
        >
          <form onSubmit={(event) => void confirm(event)}>
            <h3 id="admin-confirm-title">{change.title}</h3>
            <p>{change.description}</p>
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="admin-toolbar">
              <button type="button" disabled={saving} onClick={close}>
                Cancel
              </button>
              <button type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </div>
  );
}
