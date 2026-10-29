import { useEffect, useState } from 'react';
import {
  ConversationControls,
  type ConversationState,
} from './conversation-controls.js';
import { mailApi } from './mail-api.js';
import { mailPollDelay, useMailRevision } from './mail-events.js';
import { mailHref } from './mail-navigation.js';

type Item = {
  id: string;
  subject: string;
  sender: { name: string; address: string }[];
  receivedAt: string;
  unread: boolean;
  matchesView: boolean;
  headersPending: boolean;
  folders: { path: string; role: string | null }[];
};
type Page = {
  messages: Item[];
  total: number;
  nextCursor: string | null;
  state: ConversationState;
};
export function Conversation({
  anchor,
  selected,
  account,
  mailbox,
  query,
  revision,
  onChange,
}: {
  anchor: string;
  selected: string;
  account: string;
  mailbox: string;
  query: string;
  revision: string;
  onChange: () => void;
}) {
  const liveRevision = useMailRevision(['mail', 'accounts']);
  const [data, setData] = useState<Page | null>(null),
    [error, setError] = useState(''),
    [pages, setPages] = useState(1),
    [retry, setRetry] = useState(0);
  const params = new URLSearchParams();
  if (account) params.set('account', account);
  if (mailbox) params.set('mailbox', mailbox);
  if (query) params.set('q', query);
  const endpoint = `messages/${anchor}/conversation?${params}`;
  // Read local metadata only; expanding a conversation never fetches other bodies.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Action changes and Retry refresh the same local conversation.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        let cursor: string | null = null,
          total = 0;
        let pageState: ConversationState | undefined;
        const messages: Item[] = [];
        for (let index = 0; index < pages; index++) {
          const page: Page = await mailApi<Page>(
            `${endpoint}${cursor ? `&cursor=${cursor}` : ''}`,
            { signal: controller.signal },
          );
          messages.push(...page.messages);
          total = page.total;
          pageState = page.state;
          cursor = page.nextCursor;
          if (!cursor) break;
        }
        if (controller.signal.aborted) return;
        if (!pageState)
          throw new Error('Conversation settings are unavailable.');
        const state = pageState;
        setData((current) => ({
          messages: [
            ...new Map(messages.map((item) => [item.id, item])).values(),
          ],
          total,
          nextCursor: cursor,
          state:
            current && BigInt(current.state.version) > BigInt(state.version)
              ? current.state
              : state,
        }));
        setError('');
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load this conversation.',
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), mailPollDelay(10000));
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [endpoint, pages, revision, retry, liveRevision]);
  return (
    <section className="conversation" aria-label="Conversation">
      <h2>Conversation{data ? ` (${data.total} messages)` : ''}</h2>
      <p className="account-status">
        Related messages in this account, including Sent and mail outside this
        search or folder. Read, move and delete actions affect only the open
        message.
      </p>
      {error && (
        <p role="status">
          {error} {data && 'Showing the last known conversation.'}{' '}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Reload conversation
          </button>
        </p>
      )}
      {!data && !error && <p role="status">Loading conversation…</p>}
      {data && (
        <>
          <ConversationControls
            anchor={anchor}
            state={data.state}
            onChange={(state) => {
              setData((current) => (current ? { ...current, state } : current));
              onChange();
            }}
            onReload={() => setRetry((n) => n + 1)}
          />
          {data.messages.some((item) => item.headersPending) && (
            <p className="account-status">
              Some reply headers have not synchronized yet. More related
              messages may appear after background sync.
            </p>
          )}
          <ol aria-label="Conversation messages">
            {[...data.messages].reverse().map((item) => (
              <li key={item.id} className={item.unread ? 'unread' : ''}>
                <a
                  href={mailHref({ message: item.id, conversation: anchor })}
                  aria-current={item.id === selected ? 'true' : undefined}
                >
                  {item.subject || '(No subject)'}
                </a>{' '}
                <span>
                  {item.sender
                    .map((person) => person.name || person.address)
                    .join(', ') || 'Unknown sender'}{' '}
                  ·{' '}
                  <time dateTime={item.receivedAt}>
                    {new Date(item.receivedAt).toLocaleString()}
                  </time>{' '}
                  · {item.folders.map((folder) => folder.path).join(', ')}
                  {item.unread ? ' · Unread' : ''}
                  {!item.matchesView ? ' · Outside current view' : ''}
                </span>
              </li>
            ))}
          </ol>
          {data.nextCursor && (
            <button type="button" onClick={() => setPages((n) => n + 1)}>
              Show earlier conversation messages
            </button>
          )}
        </>
      )}
    </section>
  );
}
