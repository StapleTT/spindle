import { type FormEvent, lazy, Suspense, useState } from 'react';
import { AccountColorPicker } from './account-color-picker.js';
import { accountColorStyle, Icon, initials, ThemeChoice } from './brand.js';
import type { Signature } from './draft-api.js';
import {
  businessCenter,
  dns,
  hideImage,
  keyboard,
  lock,
  mail,
  manageAccounts,
  notifications,
  palette,
  passkey,
  pin,
  shield,
  shieldLock,
  signature,
  undo,
} from './icons.js';
import { commands } from './keyboard-triage.js';
import { mailApi as api } from './mail-api.js';
import { navigateMail } from './mail-navigation.js';
import { SmtpSettings } from './smtp-settings.js';

const SignatureSettings = lazy(() =>
  import('./signature-settings.js').then((module) => ({
    default: module.SignatureSettings,
  })),
);

export type Account = {
  id: string;
  name: string;
  color: string | null;
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
  signature: Signature | null;
};

export type Density = 'comfortable' | 'compact';

export const accountStatus = (account: Account) =>
  account.status === 'error'
    ? 'Sync failed. Check your server settings and app password, then reconnect. Automatic retries continue.'
    : account.status === 'syncing'
      ? `Syncing mail${account.foldersRemaining ? ` · ${account.foldersRemaining} folders remaining` : ''}…`
      : account.status === 'pending'
        ? 'Waiting for the sync worker…'
        : 'Up to date at last check.';

const tabs = [
  ['accounts', 'Accounts', manageAccounts],
  ['appearance', 'Appearance', palette],
  ['signatures', 'Signatures', signature],
  ['security', 'Security', shieldLock],
  ['shortcuts', 'Shortcuts', keyboard],
] as const;
type Tab = (typeof tabs)[number][0];

// Fixed protections are status labels, not inert preference controls.
const protections = [
  [
    shield,
    'Load images through the privacy proxy',
    'Images are fetched by Spindle, so senders never see your IP address or cookies.',
    true,
  ],
  [
    hideImage,
    'Block remote images by default',
    'Images stay blocked until you display them for a message.',
    true,
  ],
  [
    pin,
    'Two-step verification',
    'Coming soon. Ask for an authenticator code on new devices.',
    false,
  ],
  [
    undo,
    'Undo send',
    'Outgoing mail waits at least five seconds so you can cancel it.',
    true,
  ],
] as const;

export function Settings({
  accounts,
  configured,
  density,
  onDensity,
  onNotify,
  onRefresh,
  onReload,
  onSignature,
  onColor,
  notificationsSlot,
}: {
  accounts: Account[];
  configured: boolean;
  density: Density;
  onDensity: (density: Density) => void;
  onNotify: (text: string) => void;
  onRefresh: () => void;
  onReload: () => void;
  onSignature: (accountId: string, signature: Signature) => void;
  onColor: (accountId: string, color: string | null) => void;
  notificationsSlot: (element: HTMLElement | null) => void;
}) {
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const saved = sessionStorage.getItem('spindle-settings-tab');
      return tabs.some(([id]) => id === saved) ? (saved as Tab) : 'accounts';
    } catch {
      return 'accounts';
    }
  });
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [disconnect, setDisconnect] = useState<Account | null>(null);
  const [smtpAccount, setSmtpAccount] = useState<Account | null>(null);
  const [signatureAccount, setSignatureAccount] = useState<Account | null>(
    null,
  );

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
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
      onNotify(
        'Account saved. Connection and mail sync run in the background; this view updates automatically.',
      );
      onRefresh();
    } catch (error) {
      onNotify(error instanceof Error ? error.message : 'Unable to connect.');
    } finally {
      setBusy(false);
    }
  }

  async function sync(id: string) {
    setBusy(true);
    try {
      await api(`accounts/${id}/sync`, { method: 'POST', body: '{}' });
      onNotify(
        'Sync requested. Your stored mail stays available while the worker checks for updates.',
      );
    } catch (error) {
      onNotify(
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
      onNotify(
        'Disconnected. Only the local mirror was removed. Your provider mail is unchanged.',
      );
      onRefresh();
    } catch (error) {
      onNotify(
        error instanceof Error ? error.message : 'Unable to disconnect.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pane settings" aria-labelledby="settings-title">
      <nav className="settings-tabs" aria-label="Settings sections">
        <h2 id="settings-title">Settings</h2>
        {tabs.map(([id, label, icon]) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            onClick={() => {
              setTab(id);
              try {
                sessionStorage.setItem('spindle-settings-tab', id);
              } catch {
                /* The section still opens without storage. */
              }
            }}
          >
            <Icon src={icon} />
            {label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {tab === 'accounts' && (
          <>
            <div className="settings-head">
              <h3>Accounts</h3>
              <p>
                Mail is synced into Spindle so every view opens instantly.
                Changes are saved back to your provider.
              </p>
            </div>
            {!configured && (
              <p role="alert" className="error">
                The operator needs to configure mail encryption before you can
                connect accounts.
              </p>
            )}
            {accounts.length > 0 && (
              <ul className="settings-list" aria-label="Connected accounts">
                {accounts.map((item, index) => (
                  <li
                    key={item.id}
                    className="account-row"
                    style={accountColorStyle(item.color, index)}
                  >
                    <span className="avatar" aria-hidden="true">
                      {initials(item.name)}
                    </span>
                    <div className="account-row-text">
                      <p>
                        <strong>{item.name}</strong>
                        <span className="badge">IMAP</span>
                      </p>
                      <p className="muted">
                        {item.username} · {item.host}
                      </p>
                      <p className="muted">
                        <span
                          className={`status-dot ${item.status}`}
                          aria-hidden="true"
                        />
                        {accountStatus(item)}
                        {item.lastSyncedAt &&
                          ` Last checked: ${new Date(item.lastSyncedAt).toLocaleString()}.`}{' '}
                        History:{' '}
                        {item.historySince
                          ? `since ${new Date(item.historySince).toLocaleDateString()}`
                          : 'all available mail'}
                      </p>
                      <div className="account-buttons">
                        <button
                          type="button"
                          className="text-button"
                          disabled={busy}
                          onClick={() => void sync(item.id)}
                        >
                          Sync now
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          aria-label={`Outgoing SMTP for ${item.name}`}
                          onClick={() => setSmtpAccount(item)}
                        >
                          Outgoing SMTP
                        </button>
                        <button
                          type="button"
                          className="text-button"
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
                          className="text-button"
                          disabled={busy}
                          onClick={() => {
                            setDisconnect(item);
                            setShowConnect(false);
                          }}
                        >
                          Disconnect
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {smtpAccount && (
              <div className="settings-panel">
                <SmtpSettings
                  key={smtpAccount.id}
                  account={smtpAccount}
                  onClose={() => setSmtpAccount(null)}
                  onChange={onReload}
                />
              </div>
            )}
            {disconnect && (
              <section
                className="settings-panel"
                aria-labelledby="disconnect-title"
              >
                <h3 id="disconnect-title">Disconnect {disconnect.name}</h3>
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
                  <div className="form-actions">
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy}
                      onClick={() => setDisconnect(null)}
                    >
                      Cancel
                    </button>
                    <button type="submit" disabled={busy}>
                      Confirm disconnect
                    </button>
                  </div>
                </form>
              </section>
            )}
            <div className="settings-group">
              <h4>Add an account</h4>
              <div className="provider-cards">
                <button type="button" className="provider-card" disabled>
                  <Icon src={mail} />
                  <strong>Google</strong>
                  <span>Coming soon</span>
                </button>
                <button type="button" className="provider-card" disabled>
                  <Icon src={businessCenter} />
                  <strong>Microsoft</strong>
                  <span>Coming soon</span>
                </button>
                <button
                  type="button"
                  className="provider-card imap"
                  aria-label="Connect IMAP account"
                  aria-expanded={showConnect && !editing}
                  disabled={!configured || busy}
                  onClick={() => {
                    setEditing(null);
                    setShowConnect(!showConnect || Boolean(editing));
                    setDisconnect(null);
                  }}
                >
                  <Icon src={dns} />
                  <strong>IMAP / SMTP</strong>
                  <span>Fastmail, iCloud, Yahoo and any IMAP server</span>
                </button>
              </div>
              {showConnect && (
                <section
                  className="settings-panel connect"
                  aria-labelledby="connect-title"
                >
                  <h3 id="connect-title">
                    {editing
                      ? 'Reconnect IMAP account'
                      : 'Connect IMAP account'}
                  </h3>
                  <form
                    key={editing?.id ?? 'new'}
                    onSubmit={(event) => void connect(event)}
                    aria-busy={busy}
                  >
                    <label className="wide">
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
                        placeholder="imap.fastmail.com"
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
                    <label className="wide">
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
                    <label className="wide">
                      IMAP password or app password
                      <input
                        name="password"
                        type="password"
                        required
                        maxLength={1024}
                        autoComplete="new-password"
                      />
                    </label>
                    <div className="form-actions wide">
                      <span className="tls-note">
                        <Icon src={lock} />
                        TLS is required. Headers and flags are stored locally;
                        bodies are cached when opened. Up to five accounts.
                      </span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={busy}
                        onClick={() => {
                          setShowConnect(false);
                          setEditing(null);
                        }}
                      >
                        Cancel
                      </button>
                      <button type="submit" disabled={busy}>
                        {busy ? 'Saving…' : 'Save and sync'}
                      </button>
                    </div>
                  </form>
                </section>
              )}
            </div>
          </>
        )}
        {tab === 'appearance' && (
          <>
            <h3>Appearance</h3>
            <div className="settings-group">
              <h4>Theme</h4>
              <ThemeChoice />
            </div>
            <div className="settings-group">
              <h4>List density</h4>
              <fieldset className="segmented">
                <legend className="visually-hidden">List density</legend>
                {(['comfortable', 'compact'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={density === option}
                    onClick={() => onDensity(option)}
                  >
                    {option === 'comfortable' ? 'Comfortable' : 'Compact'}
                  </button>
                ))}
              </fieldset>
            </div>
            {accounts.length > 0 && (
              <div className="settings-group">
                <h4>Account colors</h4>
                <p className="muted small">
                  Saved to your account and shared across your devices.
                </p>
                <ul className="account-colors">
                  {accounts.map((item, index) => (
                    <li
                      key={item.id}
                      style={accountColorStyle(item.color, index)}
                    >
                      <span className="dot" aria-hidden="true" />
                      <strong>{item.name}</strong>
                      <AccountColorPicker
                        account={item}
                        index={index}
                        onChange={(color) => onColor(item.id, color)}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {tab === 'signatures' && (
          <>
            <h3>Signatures &amp; identities</h3>
            {!accounts.length && (
              <p className="muted">Connect an account to add a signature.</p>
            )}
            {accounts.map((item, index) => (
              <div key={item.id} className="settings-group">
                <p className="identity">
                  <span
                    className="dot"
                    style={accountColorStyle(item.color, index)}
                    aria-hidden="true"
                  />
                  <strong>{item.name}</strong>
                  <span className="muted">
                    · sends as {item.sender ?? item.username}
                  </span>
                </p>
                {signatureAccount?.id === item.id ? (
                  <Suspense
                    fallback={<p role="status">Loading signature settings…</p>}
                  >
                    <SignatureSettings
                      key={item.id}
                      account={item}
                      onClose={() => setSignatureAccount(null)}
                      onChange={(value) => onSignature(item.id, value)}
                    />
                  </Suspense>
                ) : (
                  <button
                    type="button"
                    className="signature-preview"
                    aria-label={`Email signature for ${item.name}`}
                    onClick={() => setSignatureAccount(item)}
                  >
                    {item.signature?.text?.trim() || 'Add a signature'}
                  </button>
                )}
              </div>
            ))}
          </>
        )}
        {tab === 'security' && (
          <>
            <h3>Security &amp; privacy</h3>
            <ul className="settings-list">
              {protections.map(([icon, label, description, on]) => (
                <li key={label} className="switch-row">
                  <Icon src={icon} />
                  <div>
                    <strong>{label}</strong>
                    <p className="muted">{description}</p>
                  </div>
                  <span className="protection-status">
                    {on ? 'Always on' : 'Coming soon'}
                  </span>
                </li>
              ))}
            </ul>
            <div className="settings-group">
              <h4>
                <Icon src={notifications} /> Notifications
              </h4>
              <div ref={notificationsSlot} />
            </div>
            <div className="settings-group">
              <h4>Passkeys</h4>
              <p className="muted">
                Passkey sign-in is coming soon. Spindle uses your verified email
                and password today.
              </p>
              <button type="button" className="outlined" disabled>
                <Icon src={passkey} />
                Add a passkey
              </button>
            </div>
          </>
        )}
        {tab === 'shortcuts' && (
          <>
            <h3>Keyboard shortcuts</h3>
            <ul className="shortcut-grid">
              {commands
                .filter(([, , key]) => key)
                .map(([command, label, key]) => (
                  <li key={command}>
                    <span>{label}</span>
                    <kbd>{key.toUpperCase()}</kbd>
                  </li>
                ))}
              <li>
                <span>Commands</span>
                <kbd>?</kbd>
              </li>
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
