import { useEffect, useState } from 'react';
import { MailApiError, mailApi } from './mail-api.js';
import { mailPollDelay, subscribeMailChanges } from './mail-events.js';
import { navigateMail } from './mail-navigation.js';

type Preference = { enabled: boolean; previews: boolean };
type Arrival = { id: string; sender: string; subject: string };
type Feed = {
  userId: string;
  serverTime: string;
  unreadCount: number;
  arrivals: Arrival[];
};
const preferenceKey = (user: string) => `spindle:notifications:${user}`;
function readPreference(user: string): Preference {
  try {
    const value = JSON.parse(
      localStorage.getItem(preferenceKey(user)) ?? 'null',
    );
    return {
      enabled: value?.enabled === true,
      previews: value?.previews === true,
    };
  } catch {
    return { enabled: false, previews: false };
  }
}

export function OpenNotifications({ user }: { user: string }) {
  const [preference, setPreference] = useState(() => readPreference(user));
  const [permission, setPermission] = useState(() =>
    typeof Notification === 'undefined'
      ? 'unsupported'
      : Notification.permission,
  );
  const [issue, setIssue] = useState(''),
    [count, setCount] = useState<number | null>(null),
    [requesting, setRequesting] = useState(false);
  const supported =
    typeof Notification !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator.locks?.request === 'function';
  function change(next: Preference) {
    try {
      localStorage.setItem(preferenceKey(user), JSON.stringify(next));
      setPreference(next);
      setIssue('');
    } catch {
      setIssue(
        'Browser storage is unavailable. Notifications need shared storage to avoid duplicate alerts.',
      );
    }
  }
  async function enable() {
    if (!supported) return;
    setRequesting(true);
    setIssue('');
    try {
      // Check storage before prompting; the permission request stays in this user gesture.
      const current = readPreference(user);
      localStorage.setItem(preferenceKey(user), JSON.stringify(current));
      const granted =
        Notification.permission === 'granted'
          ? 'granted'
          : await Notification.requestPermission();
      setPermission(granted);
      if (granted === 'granted') change({ ...current, enabled: true });
      else
        setIssue(
          granted === 'denied'
            ? 'Notifications are blocked. Allow them in your browser’s site settings, then enable here.'
            : 'Notification permission was not granted. You can enable it later.',
        );
    } catch {
      setIssue(
        'Notifications could not be enabled. Check browser permission and storage settings.',
      );
    } finally {
      setRequesting(false);
    }
  }
  useEffect(() => {
    const storage = (event: StorageEvent) => {
      if (event.key === preferenceKey(user) || event.key === null)
        setPreference(readPreference(user));
    };
    window.addEventListener('storage', storage);
    return () => window.removeEventListener('storage', storage);
  }, [user]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A privacy preference change must also close any already displayed preview.
  useEffect(() => {
    let active = true,
      paused = false,
      busy = false,
      again = false,
      epoch: string | undefined;
    let lifecycle = 0,
      controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const originalTitle = document.title;
    let current: { notification: Notification; ids: string[] } | undefined;
    function close() {
      current?.notification.close();
      current = undefined;
    }
    function schedule(delay: number) {
      clearTimeout(timer);
      if (active && !paused) timer = setTimeout(() => void poll(), delay);
    }
    async function deliver(data: Feed, phase: number) {
      if (
        !supported ||
        !preference.enabled ||
        Notification.permission !== 'granted' ||
        !data.arrivals.length
      )
        return;
      await navigator.locks.request(
        `spindle:notifications:${user}`,
        { ifAvailable: true },
        (lock) => {
          if (
            !lock ||
            !active ||
            paused ||
            phase !== lifecycle ||
            !readPreference(user).enabled ||
            Notification.permission !== 'granted'
          )
            return;
          const latestPreference = readPreference(user);
          const now = Date.parse(data.serverTime),
            key = `spindle:notification-receipts:${user}`;
          let receipts: { id: string; at: number }[];
          try {
            const stored = JSON.parse(localStorage.getItem(key) ?? '[]');
            receipts = Array.isArray(stored)
              ? stored.filter(
                  (row) =>
                    typeof row?.id === 'string' &&
                    Number.isFinite(row.at) &&
                    row.at > now - 360000,
                )
              : [];
            const seen = new Set(receipts.map((row) => row.id)),
              fresh = data.arrivals.filter((row) => !seen.has(row.id));
            if (!fresh.length) return;
            if (receipts.length + fresh.length > 1000) {
              setIssue(
                'Notification limit reached. Inbox updates continue; alerts resume after the burst.',
              );
              return;
            }
            receipts.push(...fresh.map((row) => ({ id: row.id, at: now })));
            localStorage.setItem(key, JSON.stringify(receipts));
            // Claim first: a closed/crashed tab may miss a popup but cannot duplicate it in another tab.
            close();
            const first = fresh[0];
            if (!first) return;
            const notification = new Notification('Spindle', {
              body: latestPreference.previews
                ? fresh.length === 1
                  ? `${first.sender || 'New message'} — ${first.subject || '(No subject)'}`
                  : 'New messages are available in your inbox.'
                : 'New mail is available in your inbox.',
              tag: 'spindle-new-mail',
            });
            current = { notification, ids: fresh.map((row) => row.id) };
            notification.onclick = () => {
              if (!active || paused || current?.notification !== notification)
                return;
              close();
              window.focus();
              const clickPhase = lifecycle,
                signal = controller.signal;
              void (async () => {
                const response = await fetch('/api/me', {
                  cache: 'no-store',
                  signal,
                });
                if (!response.ok || (await response.json()).user?.id !== user)
                  return;
                if (!active || paused || clickPhase !== lifecycle) return;
                await mailApi(`messages/${first.id}?q=in:anywhere`, { signal });
                if (active && !paused && clickPhase === lifecycle)
                  navigateMail({
                    q: 'in:anywhere',
                    account: '',
                    mailbox: '',
                    cursor: '',
                    message: first.id,
                    conversation: '',
                    draft: '',
                    view: '',
                  });
              })().catch(() => {});
            };
            setIssue('');
          } catch {
            setIssue(
              'The browser could not display notifications. Check site permissions, storage and operating-system settings.',
            );
          }
        },
      );
    }
    async function poll() {
      if (!active || paused) return;
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      const phase = lifecycle;
      try {
        const data = await mailApi<Feed>(
          `notifications${preference.enabled && epoch ? `?since=${encodeURIComponent(epoch)}` : ''}`,
          { signal: controller.signal },
        );
        if (!active || paused || phase !== lifecycle) return;
        if (data.userId !== user) {
          close();
          window.dispatchEvent(new Event('spindle:session-check'));
          return;
        }
        setCount(data.unreadCount);
        document.title = data.unreadCount
          ? `(${data.unreadCount}) ${originalTitle}`
          : originalTitle;
        if (typeof Notification !== 'undefined')
          setPermission(Notification.permission);
        const available = new Set(data.arrivals.map((row) => row.id));
        if (
          current &&
          (!current.ids.some((id) => available.has(id)) ||
            !preference.enabled ||
            Notification.permission !== 'granted')
        )
          close();
        if (!epoch) {
          epoch = data.serverTime;
        } else await deliver(data, phase);
      } catch (error) {
        if (!active || phase !== lifecycle) return;
        if (
          error instanceof MailApiError &&
          [401, 403].includes(error.status)
        ) {
          close();
          setCount(null);
          document.title = originalTitle;
          window.dispatchEvent(new Event('spindle:session-check'));
        }
      } finally {
        busy = false;
        const delay = again ? 100 : mailPollDelay(10000);
        again = false;
        schedule(delay);
      }
    }
    const changed = () => {
      void poll();
    };
    const unsubscribe = subscribeMailChanges(['mail', 'accounts'], changed);
    const pagehide = () => {
      lifecycle++;
      controller.abort();
      controller = new AbortController();
      paused = true;
      epoch = undefined;
      clearTimeout(timer);
      close();
      document.title = originalTitle;
    };
    const pageshow = () => {
      paused = false;
      void poll();
    };
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('pageshow', pageshow);
    void poll();
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
      close();
      document.title = originalTitle;
      unsubscribe();
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('pageshow', pageshow);
    };
  }, [user, preference.enabled, preference.previews, supported]);
  return (
    <section aria-label="Notifications" className="notification-settings">
      <details>
        <summary>
          Notifications{preference.enabled ? ' on' : ' off'}
          {count !== null ? ` · ${count} unread in inbox` : ''}
        </summary>
        <p>
          Notify about new unread inbox mail while Spindle is open, including
          background tabs. Muted and snoozed conversations stay quiet. This
          setting applies to this browser for your user.
        </p>
        {!supported && (
          <p>
            Open-app notifications require a supported browser with
            Notifications, secure browsing and browser locks.
          </p>
        )}
        {supported && (
          <>
            {preference.enabled ? (
              <button
                type="button"
                onClick={() => change({ ...preference, enabled: false })}
              >
                Disable notifications
              </button>
            ) : (
              <button
                type="button"
                disabled={requesting}
                onClick={() => void enable()}
              >
                Enable notifications
              </button>
            )}
            <label>
              <input
                type="checkbox"
                checked={preference.previews}
                disabled={!preference.enabled}
                onChange={(event) =>
                  change({ ...preference, previews: event.target.checked })
                }
              />
              Show sender and subject in notifications
            </label>
            <p>
              Browser permission: {permission}. Message details are hidden by
              default.
            </p>
          </>
        )}
      </details>
      {issue && <p role="status">{issue}</p>}
    </section>
  );
}
