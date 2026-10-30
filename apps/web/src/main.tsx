import { type FormEvent, StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { authClient } from './auth-client.js';
import { Icon, SpindleLogo, ThemeToggle } from './brand.js';
import { passkey } from './icons.js';
import { Mail } from './mail.js';
import '@fontsource-variable/plus-jakarta-sans';
import '@fontsource-variable/jetbrains-mono';
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
  const subtitle = {
    login: 'One login for every mailbox you own.',
    signup:
      registrationMode === 'invite'
        ? 'The beta is invite-only. Use the email address that received your invitation.'
        : 'Create an account and verify your email to get started.',
    forgot: 'We’ll email you a link to choose a new password.',
    reset: 'Use 15–128 characters. A password manager is recommended.',
  }[view];
  const feedbackText = message && (
    <p
      ref={feedback}
      tabIndex={-1}
      role={error ? 'alert' : 'status'}
      className={error ? 'error' : 'notice'}
    >
      {message}
    </p>
  );
  if (session)
    return (
      <>
        <h1 className="visually-hidden">Spindle</h1>
        <h2 className="visually-hidden">You’re signed in</h2>
        {feedbackText}
        {session.user.emailVerified ? (
          <Mail
            key={session.user.id}
            userId={session.user.id}
            email={session.user.email}
            busy={busy}
            onSignOut={() => void signOut()}
          />
        ) : (
          <main className="auth">
            <ThemeToggle />
            <section className="auth-card">
              <div className="auth-brand">
                <SpindleLogo size={38} />
                Spindle
              </div>
              <p>Verify your email to access your mail.</p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </section>
          </main>
        )}
      </>
    );
  return (
    <main className="auth">
      <ThemeToggle />
      {isPending ? (
        <p role="status">Loading your session…</p>
      ) : (
        <form
          className="auth-card"
          onSubmit={(event) => void submit(event)}
          aria-busy={busy}
          aria-labelledby="auth-title"
        >
          <div className="auth-brand">
            <SpindleLogo size={38} />
            Spindle
          </div>
          <div className="auth-heading">
            <h1 id="auth-title">{title}</h1>
            <p id={view === 'reset' ? 'password-hint' : undefined}>
              {subtitle}
            </p>
          </div>
          {feedbackText}
          {view === 'login' && (
            <>
              <button type="button" className="auth-passkey" disabled>
                <Icon src={passkey} />
                Continue with a passkey
                <span className="soon">Coming soon</span>
              </button>
              <div className="auth-or">or</div>
            </>
          )}
          {view !== 'reset' && (
            <label htmlFor="email">
              <span>Email</span>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                maxLength={254}
                required
                placeholder="you@example.com"
                aria-label="Email address"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
          )}
          {view !== 'forgot' && (
            <div className="field">
              <span className="label-row">
                <label htmlFor="password">Password</label>
                {view === 'login' && (
                  <button
                    type="button"
                    className="text-link"
                    aria-label="Forgot password?"
                    disabled={busy}
                    onClick={() => navigate('forgot')}
                  >
                    Forgot?
                  </button>
                )}
              </span>
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
                placeholder="••••••••••"
                aria-describedby={
                  view === 'login' ? undefined : 'password-hint'
                }
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}
          {view === 'signup' && (
            <p id="password-hint" className="field-hint">
              Use 15–128 characters. A password manager is recommended.
            </p>
          )}
          {(view === 'signup' || view === 'reset') && (
            <label htmlFor="confirmation">
              <span>Confirm password</span>
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
          <nav className="auth-links" aria-label="Account access">
            {view === 'login' ? (
              <>
                <span>
                  New here?{' '}
                  <button
                    type="button"
                    className="text-link"
                    disabled={busy}
                    onClick={() => navigate('signup')}
                  >
                    Create an account
                  </button>
                </span>
                <button
                  type="button"
                  className="text-link"
                  disabled={busy}
                  onClick={() => void resend()}
                >
                  Resend verification email
                </button>
              </>
            ) : (
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => navigate('login')}
              >
                Back to sign in
              </button>
            )}
            {view === 'reset' && (
              <button
                type="button"
                className="text-link"
                disabled={busy}
                onClick={() => navigate('forgot')}
              >
                Request another reset link
              </button>
            )}
          </nav>
        </form>
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
