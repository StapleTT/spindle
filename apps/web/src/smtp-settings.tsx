import { type FormEvent, useEffect, useState } from 'react';
import { mailApi } from './mail-api.js';

type Settings = {
  host: string;
  port: number;
  transport: 'tls' | 'starttls';
  username: string;
  displayName: string;
  saveSentCopy: boolean;
  state: string;
  error: string | null;
};
export function SmtpSettings({
  account,
  onClose,
  onChange,
}: {
  account: { id: string; name: string; username: string };
  onClose: () => void;
  onChange: () => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [defaultDisplayName, setDefaultDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit save/test reloads the same settings query.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const result = await mailApi<{
          smtp: Settings | null;
          defaultDisplayName: string;
        }>(`accounts/${account.id}/smtp`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setSettings(result.smtp);
        setDefaultDisplayName(result.defaultDisplayName);
        setLoaded(true);
        setError('');
        if (result.smtp?.state === 'pending')
          timer = setTimeout(() => void load(), 2000);
        else onChange();
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load SMTP settings.',
          );
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [account.id, attempt, onChange]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget,
      values = new FormData(form);
    setBusy(true);
    setError('');
    const password = String(values.get('password') ?? '');
    try {
      await mailApi(`accounts/${account.id}/smtp`, {
        method: 'PUT',
        body: JSON.stringify({
          host: values.get('host'),
          port: Number(values.get('port')),
          transport: values.get('transport'),
          username: values.get('username'),
          displayName: values.get('displayName'),
          saveSentCopy: values.get('sentCopy') === 'spindle',
          ...(password ? { password } : {}),
        }),
      });
      const input = form.elements.namedItem('password');
      if (input instanceof HTMLInputElement) input.value = '';
      setAttempt((value) => value + 1);
      onChange();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save SMTP settings.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="smtp-title">
      <h2 id="smtp-title">Outgoing SMTP — {account.name}</h2>
      <p>
        Use your mail provider’s outgoing server and app password. The SMTP
        login email is the From address; alternate send-as identities are not
        supported yet.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loaded ? (
        <p role="status">Loading outgoing settings…</p>
      ) : (
        <>
          <p role="status">
            {settings?.state === 'ready'
              ? 'SMTP connection checked. Ready to send.'
              : settings?.state === 'pending'
                ? 'Checking SMTP connection in the background…'
                : (settings?.error ?? 'SMTP sending is not configured.')}
          </p>
          <form onSubmit={(event) => void submit(event)}>
            <label>
              SMTP server
              <input
                name="host"
                required
                maxLength={253}
                defaultValue={settings?.host ?? ''}
                placeholder="smtp.example.com"
                autoCapitalize="none"
              />
            </label>
            <label>
              SMTP port
              <input
                name="port"
                required
                type="number"
                min={1}
                max={65535}
                defaultValue={settings?.port ?? 587}
              />
            </label>
            <label>
              SMTP encryption
              <select
                name="transport"
                defaultValue={settings?.transport ?? 'starttls'}
              >
                <option value="starttls">
                  Required STARTTLS (usually 587)
                </option>
                <option value="tls">TLS (usually 465)</option>
              </select>
            </label>
            <label>
              SMTP login email / From address
              <input
                name="username"
                required
                type="email"
                maxLength={254}
                autoComplete="username"
                defaultValue={
                  settings?.username ??
                  (account.username.includes('@') ? account.username : '')
                }
              />
            </label>
            <label>
              Sender display name
              <input
                name="displayName"
                type="text"
                maxLength={200}
                autoComplete="name"
                defaultValue={settings?.displayName ?? defaultDisplayName}
              />
            </label>
            <p>
              The name recipients see beside your email address. Leave blank to
              show only the email address.
            </p>
            <label>
              SMTP password or app password
              <input
                name="password"
                type="password"
                maxLength={1024}
                required={!settings}
                autoComplete="new-password"
              />
            </label>
            {settings && (
              <p>
                Leave the password blank to keep it when the connection fields
                are unchanged.
              </p>
            )}
            <label>
              Sent folder handling
              <select
                name="sentCopy"
                defaultValue={settings?.saveSentCopy ? 'spindle' : 'provider'}
              >
                <option value="provider">
                  Provider saves Sent — check only
                </option>
                <option value="spindle">
                  Spindle saves a copy in provider Sent
                </option>
              </select>
            </label>
            <p>
              Choose Spindle copies only if your provider does not already save
              sent messages automatically.
            </p>
            <button type="submit" disabled={busy}>
              Save and check SMTP
            </button>
          </form>
          {settings && (
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await mailApi(`accounts/${account.id}/smtp/test`, {
                    method: 'POST',
                    body: '{}',
                  });
                  setAttempt((value) => value + 1);
                } catch (failure) {
                  setError(
                    failure instanceof Error
                      ? failure.message
                      : 'Unable to check SMTP.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check connection again
            </button>
          )}
        </>
      )}
      <button type="button" disabled={busy} onClick={onClose}>
        Close outgoing settings
      </button>
    </section>
  );
}
