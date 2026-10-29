import { type FormEvent, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { authClient } from './auth-client.js';
import { Mail } from './mail.js';
import './style.css';

type View = 'login' | 'signup' | 'forgot' | 'reset';
const params = new URLSearchParams(window.location.search);
const resetToken = params.get('token');
const initialView = params.get('view');
const callbackURL = `${window.location.origin}/?verified=1`;
// Keep recovery credentials out of browser history and subsequent referrers.
if (params.has('token'))
  window.history.replaceState(null, '', window.location.pathname);

function App() {
  const { data: session, isPending, refetch } = authClient.useSession();
  const [view, setView] = useState<View>(
    initialView === 'signup' ||
      initialView === 'forgot' ||
      initialView === 'reset'
      ? initialView
      : 'login',
  );
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [registrationMode, setRegistrationMode] = useState('invite');
  const [message, setMessage] = useState(
    params.has('error')
      ? 'This email link is invalid or expired. Request a new one.'
      : params.has('verified')
        ? 'Email verified. You can now sign in.'
        : '',
  );
  const [error, setError] = useState(false);
  const feedback = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/auth-config', { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (data?.registrationMode === 'public') setRegistrationMode('public');
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (message) feedback.current?.focus();
  }, [message]);

  useEffect(() => {
    const check = () => void refetch();
    window.addEventListener('spindle:session-check', check);
    return () => window.removeEventListener('spindle:session-check', check);
  }, [refetch]);

  function notify(text: string, failed = false) {
    setError(failed);
    setMessage(text);
  }
  function navigate(next: View) {
    setView(next);
    setPassword('');
    setConfirmation('');
    setMessage('');
    setError(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if ((view === 'signup' || view === 'reset') && password !== confirmation) {
      notify('The passwords do not match.', true);
      return;
    }
    if (view === 'reset' && !resetToken) {
      notify(
        'This reset link is invalid. Request another password reset.',
        true,
      );
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const address = email.trim().toLowerCase();
      if (view === 'login') {
        const result = await authClient.signIn.email({
          email: address,
          password,
        });
        if (result.error)
          notify(
            result.error.code === 'EMAIL_NOT_VERIFIED'
              ? 'Verify your email before signing in. You can resend the verification email below.'
              : 'Unable to sign in. Check your email and password.',
            true,
          );
        else {
          setPassword('');
          await refetch();
        }
      } else if (view === 'signup') {
        const result = await authClient.signUp.email({
          email: address,
          password,
          name: address.split('@')[0] || 'Spindle user',
          callbackURL,
        });
        if (result.error)
          notify(
            result.error.message ?? 'Unable to create your account.',
            true,
          );
        else {
          navigate('login');
          notify(
            'If registration is available for this email, check your inbox for a verification link. If you already have an account, sign in or reset your password.',
          );
        }
      } else if (view === 'forgot') {
        const result = await authClient.requestPasswordReset({
          email: address,
          redirectTo: `${window.location.origin}/?view=reset`,
        });
        if (result.error)
          notify(
            'Unable to request a reset right now. Please try again later.',
            true,
          );
        else
          notify(
            'If an account exists for that email, you will receive a password reset link.',
          );
      } else {
        const result = await authClient.resetPassword({
          newPassword: password,
          token: resetToken ?? '',
        });
        if (result.error)
          notify(
            'This reset link is invalid or expired. Request another password reset.',
            true,
          );
        else {
          navigate('login');
          notify('Password updated. Sign in with your new password.');
        }
      }
    } catch {
      notify('Unable to reach Spindle. Please try again.', true);
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (!email.trim()) {
      notify('Enter your email address first.', true);
      return;
    }
    setBusy(true);
    try {
      const result = await authClient.sendVerificationEmail({
        email: email.trim().toLowerCase(),
        callbackURL,
      });
      notify(
        result.error
          ? 'Unable to resend right now. Please try again later.'
          : 'If your account needs verification, a new email has been sent.',
        Boolean(result.error),
      );
    } catch {
      notify('Unable to reach Spindle. Please try again.', true);
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const result = await authClient.signOut();
      if (result.error) notify('Unable to sign out. Please try again.', true);
      else {
        navigate('login');
        await refetch();
      }
    } catch {
      notify('Unable to sign out. Please try again.', true);
    } finally {
      setBusy(false);
    }
  }

  const title = {
    login: 'Sign in',
    signup: 'Create your account',
    forgot: 'Reset your password',
    reset: 'Choose a new password',
  }[view];
  return (
    <main className={session ? 'signed-in' : undefined}>
      <header>
        <h1>Spindle</h1>
        <p>Your private mailboxes, together.</p>
      </header>
      {message && (
        <p
          ref={feedback}
          tabIndex={-1}
          role={error ? 'alert' : 'status'}
          className={error ? 'error' : 'notice'}
        >
          {message}
        </p>
      )}
      {isPending ? (
        <p role="status">Loading your session…</p>
      ) : session ? (
        <section aria-labelledby="signed-in-title">
          <h2 id="signed-in-title">You’re signed in</h2>
          <p>{session.user.email}</p>
          <button type="button" disabled={busy} onClick={() => void signOut()}>
            Sign out
          </button>
          {session.user.emailVerified ? (
            <Mail key={session.user.id} userId={session.user.id} />
          ) : (
            <p>Verify your email to access your mail.</p>
          )}
        </section>
      ) : (
        <section aria-labelledby="auth-title">
          <h2 id="auth-title">{title}</h2>
          {view === 'signup' && (
            <p>
              {registrationMode === 'invite'
                ? 'The beta is invite-only. Use the email address that received your invitation.'
                : 'Create an account and verify your email to get started.'}
            </p>
          )}
          <form onSubmit={(event) => void submit(event)} aria-busy={busy}>
            {view !== 'reset' && (
              <label htmlFor="email">
                Email address
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  maxLength={254}
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
            )}
            {view !== 'forgot' && (
              <label htmlFor="password">
                Password
                <input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete={
                    view === 'login' ? 'current-password' : 'new-password'
                  }
                  minLength={view === 'login' ? 1 : 15}
                  maxLength={128}
                  required
                  aria-describedby={
                    view === 'login' ? undefined : 'password-hint'
                  }
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>
            )}
            {(view === 'signup' || view === 'reset') && (
              <>
                <p id="password-hint">
                  Use 15–128 characters. A password manager is recommended.
                </p>
                <label htmlFor="confirmation">
                  Confirm password
                  <input
                    id="confirmation"
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    required
                    maxLength={128}
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              </>
            )}
            <button type="submit" disabled={busy}>
              {busy
                ? 'Please wait…'
                : view === 'forgot'
                  ? 'Send reset link'
                  : view === 'reset'
                    ? 'Update password'
                    : title}
            </button>
          </form>
          <nav aria-label="Account access">
            {view !== 'login' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => navigate('login')}
              >
                Back to sign in
              </button>
            )}
            {view === 'login' && (
              <>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => navigate('signup')}
                >
                  Create an account
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => navigate('forgot')}
                >
                  Forgot password?
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resend()}
                >
                  Resend verification email
                </button>
              </>
            )}
            {view === 'reset' && (
              <button
                type="button"
                disabled={busy}
                onClick={() => navigate('forgot')}
              >
                Request another reset link
              </button>
            )}
          </nav>
        </section>
      )}
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
