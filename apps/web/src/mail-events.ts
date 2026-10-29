import { useEffect, useState } from 'react';

export const mailTopics = [
  'mail',
  'accounts',
  'actions',
  'outbox',
  'drafts',
  'files',
  'searches',
] as const;
type Topic = (typeof mailTopics)[number];
const changed = 'spindle:mail-changed';
let connected = false;
export const mailPollDelay = (fallback: number) =>
  connected ? 30000 : fallback;
export function subscribeMailChanges(
  topics: readonly string[],
  refresh: () => void,
) {
  const listener = (event: Event) => {
    if (
      (event as CustomEvent<Topic[]>).detail.some((topic) =>
        topics.includes(topic),
      )
    )
      refresh();
  };
  window.addEventListener(changed, listener);
  return () => window.removeEventListener(changed, listener);
}
export function useMailRevision(topics: readonly string[]) {
  const [revision, setRevision] = useState(0);
  const key = topics.join(',');
  useEffect(
    () => subscribeMailChanges(key.split(','), () => setRevision((n) => n + 1)),
    [key],
  );
  return revision;
}
export function useMailEvents(user: string) {
  const [live, setLive] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A different signed-in user must get a new stream and no old callbacks.
  useEffect(() => {
    let active = true,
      source: EventSource | undefined,
      retry: ReturnType<typeof setTimeout> | undefined,
      flushTimer: ReturnType<typeof setTimeout> | undefined,
      lastFlush = 0,
      lastId = '',
      lastSequence = 0;
    const authCheck = new AbortController();
    let checkingSession = false;
    async function checkSession() {
      if (checkingSession) return;
      checkingSession = true;
      try {
        const response = await fetch('/api/me', {
          cache: 'no-store',
          signal: authCheck.signal,
        });
        if (active && (response.status === 401 || response.status === 403))
          window.dispatchEvent(new Event('spindle:session-check'));
      } catch {
        /* An outage keeps cached mail and recovery text visible. */
      } finally {
        checkingSession = false;
      }
    }
    const queued = new Set<Topic>();
    function flush() {
      clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!active || !queued.size) return;
      lastFlush = Date.now();
      const topics = [...queued];
      queued.clear();
      window.dispatchEvent(new CustomEvent(changed, { detail: topics }));
    }
    function invalidate(topics: readonly Topic[], now = false) {
      for (const topic of topics) queued.add(topic);
      if (now) flush();
      else if (!flushTimer)
        flushTimer = setTimeout(
          flush,
          Math.max(100, 2000 - (Date.now() - lastFlush)),
        );
    }
    function open() {
      if (!active) return;
      source?.close();
      source = new EventSource('/api/mail/events');
      const current = source;
      function receive(event: MessageEvent<string>, reset: boolean) {
        if (!active || source !== current) return;
        try {
          const [id, rawSequence] = event.lastEventId.split(':');
          const sequence = Number(rawSequence);
          const payload = JSON.parse(event.data);
          if (
            !id ||
            !Number.isSafeInteger(sequence) ||
            sequence < 1 ||
            !Array.isArray(payload.topics) ||
            payload.topics.length > mailTopics.length ||
            !payload.topics.every((topic: unknown) =>
              mailTopics.includes(topic as Topic),
            )
          )
            return;
          if (reset) {
            lastId = id;
            lastSequence = 0;
          } else if (id !== lastId) return;
          if (sequence <= lastSequence) return;
          lastSequence = sequence;
          connected = true;
          setLive(true);
          invalidate(reset ? mailTopics : payload.topics, reset);
        } catch {
          /* Ignore malformed frames; fallback reads still recover state. */
        }
      }
      current.addEventListener('reset', (event) =>
        receive(event as MessageEvent<string>, true),
      );
      current.addEventListener('change', (event) =>
        receive(event as MessageEvent<string>, false),
      );
      current.addEventListener('session-ended', () => {
        if (!active || source !== current) return;
        current.close();
        connected = false;
        setLive(false);
        window.dispatchEvent(new Event('spindle:session-check'));
        reconnect();
      });
      current.onerror = () => {
        if (!active || source !== current) return;
        const wasLive = connected;
        connected = false;
        setLive(false);
        if (wasLive) invalidate(mailTopics, true);
        void checkSession();
        if (current.readyState === EventSource.CLOSED) reconnect();
      };
    }
    function reconnect() {
      if (!retry)
        retry = setTimeout(() => {
          retry = undefined;
          open();
        }, 5000);
    }
    const foreground = () => {
      if (document.visibilityState === 'visible') invalidate(mailTopics, true);
    };
    window.addEventListener('online', foreground);
    document.addEventListener('visibilitychange', foreground);
    open();
    return () => {
      active = false;
      connected = false;
      source?.close();
      authCheck.abort();
      clearTimeout(retry);
      clearTimeout(flushTimer);
      window.removeEventListener('online', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [user]);
  return live;
}
