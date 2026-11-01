import { type FormEvent, useEffect, useRef, useState } from 'react';
import { accountApi } from './account-api.js';
import { Icon } from './brand.js';
import { devices, lock, mail, manageAccounts } from './icons.js';

type Account = {
  user: { id: string; name: string; email: string };
  pendingEmail: { email: string; expiresAt: string } | null;
};
type DeviceSession = {
  id: string;
  current: boolean;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};
type SessionPage = { sessions: DeviceSession[]; nextCursor: string | null };
type Section = 'profile' | 'password' | 'email' | 'sessions';

export function AccountSecurity() {
  const [account, setAccount] = useState<Account | null>(null);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState<Section | 'loading' | ''>('');
  const [loadError, setLoadError] = useState('');
  const [feedback, setFeedback] = useState<{
    section: Section;
    text: string;
    error: boolean;
  } | null>(null);
  const generation = useRef(0);

  async function load(signal?: AbortSignal, cursor?: string) {
    const requested = ++generation.current;
    const [profile, page] = await Promise.all([
      accountApi<Account>('', undefined, signal),
      accountApi<SessionPage>(
        `/sessions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        undefined,
        signal,
      ),
    ]);
    if (signal?.aborted || requested !== generation.current) return;
    setAccount(profile);
    setSessions((current) =>
      cursor
        ? [
            ...new Map(
              [...current, ...page.sessions].map((session) => [
                session.id,
                session,
              ]),
            ).values(),
          ]
        : page.sessions,
    );
    setNextCursor(page.nextCursor);
    setLoadError('');
  }

  // Account ownership is tied to the signed-in app; it remounts on a user change.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Mount/focus refresh the first page without replacing unsaved form values.
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void load(controller.signal).catch((error: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(
            error instanceof Error
              ? error.message
              : 'Unable to load account settings.',
          );
      });
    };
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  async function perform(section: Section, task: () => Promise<string>) {
    if (busy) return;
    generation.current++;
    setBusy(section);
    setFeedback(null);
    try {
      const text = await task();
      setFeedback({ section, text, error: false });
    } catch (error) {
      setFeedback({
        section,
        text:
          error instanceof Error
            ? error.message
            : 'Unable to update your account.',
        error: true,
      });
    } finally {
      setBusy('');
    }
  }

  function status(section: Section) {
    return (
      feedback?.section === section && (
        <p
          role={feedback.error ? 'alert' : 'status'}
          className={feedback.error ? 'error' : 'muted small'}
        >
          {feedback.text}
        </p>
      )
    );
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    await perform('profile', async () => {
      await accountApi('/profile', {
        name: String(values.get('name') ?? '').trim(),
      });
      await load();
      window.dispatchEvent(new Event('spindle:session-check'));
      return 'Profile name saved.';
    });
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    if (values.get('newPassword') !== values.get('confirmation')) {
      setFeedback({
        section: 'password',
        text: 'The new passwords do not match.',
        error: true,
      });
      return;
    }
    await perform('password', async () => {
      await accountApi('/password', {
        currentPassword: values.get('currentPassword'),
        newPassword: values.get('newPassword'),
      });
      form.reset();
      window.location.assign('/login?passwordChanged=1');
      return 'Password changed. Sign in again.';
    });
  }

  async function changeEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const cancel =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ===
      'cancel';
    const currentPassword = form.elements.namedItem(
      'currentPassword',
    ) as HTMLInputElement;
    if (!currentPassword.reportValidity()) return;
    const values = new FormData(form);
    await perform('email', async () => {
      const result = await accountApi<{ message?: string }>(
        cancel ? '/email/cancel' : '/email',
        {
          currentPassword: values.get('currentPassword'),
          ...(!cancel
            ? { newEmail: String(values.get('newEmail') ?? '').trim() }
            : {}),
        },
      );
      currentPassword.value = '';
      await load();
      return cancel
        ? 'Email change cancelled. Your sign-in email is unchanged.'
        : (result.message ??
            'Check the new email address for a verification link.');
    });
  }

  async function revoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const sessionId = (
      event.nativeEvent as SubmitEvent
    ).submitter?.getAttribute('value');
    if (!sessionId) return;
    await perform('sessions', async () => {
      await accountApi(
        sessionId === 'others' ? '/sessions/revoke-others' : '/sessions/revoke',
        {
          currentPassword: values.get('currentPassword'),
          ...(sessionId !== 'others' ? { sessionId } : {}),
        },
      );
      form.reset();
      await load();
      return sessionId === 'others'
        ? 'Other devices signed out. This device stays signed in.'
        : 'Device signed out.';
    });
  }

  return (
    <div className="account-security">
      {loadError && (
        <p role="alert" className="error">
          {loadError}{' '}
          <button
            type="button"
            disabled={Boolean(busy)}
            onClick={() =>
              void load().catch((error: unknown) =>
                setLoadError(
                  error instanceof Error
                    ? error.message
                    : 'Unable to load settings.',
                ),
              )
            }
          >
            Reload account settings
          </button>
        </p>
      )}
      {!account ? (
        !loadError && <p role="status">Loading account settings…</p>
      ) : (
        <>
          <section className="settings-panel" aria-labelledby="profile-title">
            <div className="settings-group">
              <h4 id="profile-title">
                <Icon src={manageAccounts} /> Your profile
              </h4>
              <p className="muted small">Your name in Spindle.</p>
            </div>
            <form onSubmit={(event) => void saveProfile(event)}>
              <fieldset disabled={Boolean(busy)}>
                <label>
                  Profile name
                  <input
                    name="name"
                    defaultValue={account.user.name}
                    autoComplete="name"
                    required
                    maxLength={100}
                  />
                </label>
                <div className="account-settings-actions">
                  <button type="submit">
                    {busy === 'profile' ? 'Saving…' : 'Save profile name'}
                  </button>
                </div>
              </fieldset>
              {status('profile')}
            </form>
          </section>
          <section className="settings-panel" aria-labelledby="password-title">
            <div className="settings-group">
              <h4 id="password-title">
                <Icon src={lock} /> Password
              </h4>
              <p className="muted small">
                Use 15–128 characters. Changing your password signs you out on
                every device.
              </p>
            </div>
            <form onSubmit={(event) => void changePassword(event)}>
              <fieldset disabled={Boolean(busy)}>
                <label>
                  Current password
                  <input
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                  />
                </label>
                <div className="account-settings-fields">
                  <label>
                    New password
                    <input
                      name="newPassword"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={15}
                      maxLength={128}
                    />
                  </label>
                  <label>
                    Confirm new password
                    <input
                      name="confirmation"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={15}
                      maxLength={128}
                    />
                  </label>
                </div>
                <div className="account-settings-actions">
                  <button type="submit">
                    {busy === 'password' ? 'Changing…' : 'Change password'}
                  </button>
                </div>
              </fieldset>
              {status('password')}
            </form>
          </section>
          <section
            className="settings-panel"
            aria-labelledby="login-email-title"
          >
            <div className="settings-group">
              <h4 id="login-email-title">
                <Icon src={mail} /> Sign-in email
              </h4>
              <p className="account-settings-email">
                {account.user.email} <span className="badge">Verified</span>
              </p>
              <p className="muted small">
                Verify your replacement address before it becomes your sign-in
                email. Confirming signs you out on every device.
              </p>
            </div>
            {account.pendingEmail && (
              <p className="notice" role="status">
                Awaiting verification for{' '}
                <strong>{account.pendingEmail.email}</strong>. The link expires{' '}
                {new Date(account.pendingEmail.expiresAt).toLocaleString()}.
                Sending another link replaces the previous one.
              </p>
            )}
            <form onSubmit={(event) => void changeEmail(event)}>
              <fieldset disabled={Boolean(busy)}>
                <label>
                  New sign-in email
                  <input
                    name="newEmail"
                    type="email"
                    autoComplete="email"
                    defaultValue={account.pendingEmail?.email ?? ''}
                    required
                    maxLength={254}
                  />
                </label>
                <label>
                  Current password
                  <input
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                  />
                </label>
                <div className="account-settings-actions">
                  <button type="submit">
                    {busy === 'email' ? 'Saving…' : 'Send verification link'}
                  </button>
                  {account.pendingEmail && (
                    <button
                      type="submit"
                      className="outlined"
                      value="cancel"
                      formNoValidate
                    >
                      Cancel email change
                    </button>
                  )}
                </div>
              </fieldset>
              {status('email')}
            </form>
          </section>
          <section className="settings-panel" aria-labelledby="sessions-title">
            <div className="settings-group">
              <h4 id="sessions-title">
                <Icon src={devices} /> Active sessions
              </h4>
              <p className="muted small">
                Review where you’re signed in. Confirm your current password to
                sign out another device.
              </p>
            </div>
            <form onSubmit={(event) => void revoke(event)}>
              <fieldset disabled={Boolean(busy)}>
                <label>
                  Current password for device sign-out
                  <input
                    name="currentPassword"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                  />
                </label>
                <ul
                  className="settings-list session-list"
                  aria-label="Active device sessions"
                >
                  {sessions.map((session) => (
                    <li key={session.id} className="session-row">
                      <Icon src={devices} />
                      <div className="session-row-text">
                        <p>
                          <strong>
                            {session.current ? 'This device' : 'Other device'}
                          </strong>{' '}
                          {session.current && (
                            <span className="badge">Current session</span>
                          )}
                        </p>
                        <p className="muted small">
                          {session.ipAddress || 'Network address unavailable'}
                        </p>
                        <p className="muted small">
                          Signed in{' '}
                          {new Date(session.createdAt).toLocaleString()}
                        </p>
                        <p className="muted small">
                          Refreshed{' '}
                          {new Date(session.updatedAt).toLocaleString()} ·
                          Expires {new Date(session.expiresAt).toLocaleString()}
                        </p>
                        {session.userAgent && (
                          <details className="session-agent">
                            <summary>Browser details</summary>
                            <p>{session.userAgent}</p>
                          </details>
                        )}
                      </div>
                      {!session.current && (
                        <button
                          type="submit"
                          className="outlined"
                          value={session.id}
                          aria-label={`Sign out session from ${new Date(session.createdAt).toLocaleString()}`}
                        >
                          Sign out
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="account-settings-actions">
                  <button
                    type="submit"
                    value="others"
                    className="outlined"
                    disabled={!sessions.some((session) => !session.current)}
                  >
                    {busy === 'sessions'
                      ? 'Signing out…'
                      : 'Sign out other devices'}
                  </button>
                </div>
              </fieldset>
              {status('sessions')}
            </form>
            {nextCursor && (
              <button
                type="button"
                className="text-button"
                disabled={Boolean(busy)}
                onClick={async () => {
                  setBusy('loading');
                  try {
                    await load(undefined, nextCursor);
                  } catch (error) {
                    setLoadError(
                      error instanceof Error
                        ? error.message
                        : 'Unable to load sessions.',
                    );
                  } finally {
                    setBusy('');
                  }
                }}
              >
                Show more sessions
              </button>
            )}
          </section>
        </>
      )}
    </div>
  );
}
