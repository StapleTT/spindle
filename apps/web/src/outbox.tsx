import { useEffect, useState } from 'react';
import { mailApi } from './mail-api.js';
import { mailHref } from './mail-navigation.js';

export type OutboxMessage = {
  id: string;
  state: string;
  subject: string;
  sender: string;
  recipients: string[];
  accepted: string[];
  rejected: string[];
  error: string | null;
  sentCopy: string;
  draftId: string | null;
  undoMs: number;
  createdAt: string;
};
type Page = { messages: OutboxMessage[]; nextCursor: string | null };
export function useOutbox() {
  const [messages, setMessages] = useState<OutboxMessage[]>([]),
    [error, setError] = useState('');
  const [pages, setPages] = useState(1),
    [more, setMore] = useState(false),
    [revision, setRevision] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A write refreshes the same outbox query immediately.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        let cursor: string | null = null;
        const entries: OutboxMessage[] = [];
        for (let index = 0; index < pages; index++) {
          const result: Page = await mailApi<Page>(
            `outbox${cursor ? `?before=${cursor}` : ''}`,
            { signal: controller.signal },
          );
          entries.push(...result.messages);
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (!controller.signal.aborted) {
          setMessages(entries);
          setMore(Boolean(cursor));
          setError('');
        }
      } catch {
        if (!controller.signal.aborted)
          setError(
            'Outbox status is unavailable. Showing the last known state; checking again automatically.',
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void load(), 2000);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [pages, revision]);
  return {
    messages,
    error,
    more,
    showMore: () => setPages((value) => value + 1),
    refresh: () => setRevision((value) => value + 1),
  };
}
const stateText: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending',
  accepted: 'Accepted by SMTP server',
  partial: 'Partially accepted',
  failed: 'Failed',
  unknown: 'Delivery status unknown',
  cancelled: 'Cancelled',
};
export function OutboxFeedback({ messages }: { messages: OutboxMessage[] }) {
  const recent = messages.find(
    (message) => !['accepted', 'cancelled'].includes(message.state),
  );
  if (!recent) return null;
  return (
    <p role="status">
      Outgoing mail: {stateText[recent.state]} — “
      {recent.subject || '(No subject)'}”.{' '}
      <a href={mailHref({ view: 'outbox', draft: '', message: '' })}>
        Review Outbox
      </a>
    </p>
  );
}
export function Outbox({ data }: { data: ReturnType<typeof useOutbox> }) {
  const [busy, setBusy] = useState(''),
    [notice, setNotice] = useState('');
  async function action(message: OutboxMessage, kind: 'cancel' | 'retry') {
    setBusy(message.id);
    setNotice('');
    try {
      await mailApi(`outbox/${message.id}/${kind}`, {
        method: 'POST',
        body: '{}',
      });
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : 'Unable to change this send.',
      );
    } finally {
      setBusy('');
      data.refresh();
    }
  }
  return (
    <section aria-labelledby="outbox-heading">
      <h2 id="outbox-heading">Outbox</h2>
      <p>
        Messages wait at least five seconds before dispatch. Cancel while
        queued; sending messages cannot be recalled. SMTP acceptance does not
        guarantee delivery to the recipient.
      </p>
      {data.error && (
        <p role="status" className="error">
          {data.error}
        </p>
      )}
      {notice && <p role="alert">{notice}</p>}
      {!data.messages.length && <p>No outgoing messages yet.</p>}
      <ul className="message-list" aria-label="Outgoing messages">
        {data.messages.map((message) => (
          <li key={message.id}>
            <strong>
              {stateText[message.state]}: {message.subject || '(No subject)'}
            </strong>
            <p>
              From {message.sender} · To {message.recipients.join(', ')}
            </p>
            {message.state === 'queued' && (
              <p>
                Waiting for dispatch
                {message.undoMs > 0
                  ? ` (at least ${Math.ceil(message.undoMs / 1000)} seconds)`
                  : ''}
                .
              </p>
            )}
            {message.error && <p className="error">{message.error}</p>}
            {message.state === 'partial' && (
              <p className="error">
                Accepted for: {message.accepted.join(', ')}. Rejected for:{' '}
                {message.rejected.join(', ')}. Do not resend the whole message;
                some recipients may already have it.
              </p>
            )}
            {['accepted', 'partial', 'unknown'].includes(message.state) && (
              <p>
                Sent-folder copy:{' '}
                {message.sentCopy === 'saved'
                  ? 'found or saved'
                  : message.sentCopy === 'unavailable'
                    ? 'no provider-designated Sent folder'
                    : message.sentCopy === 'failed'
                      ? 'could not confirm a copy; check your provider'
                      : message.sentCopy === 'unknown'
                        ? 'unconfirmed; checking without adding another copy'
                        : 'checking in the background'}
                .
              </p>
            )}
            {message.state === 'queued' && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void action(message, 'cancel')}
              >
                Cancel send
              </button>
            )}
            {message.state === 'failed' && message.draftId && (
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() => void action(message, 'retry')}
              >
                Retry send
              </button>
            )}
            {message.draftId && (
              <a
                href={mailHref({
                  view: 'drafts',
                  draft: message.draftId,
                  message: '',
                })}
              >
                {['failed', 'cancelled'].includes(message.state)
                  ? 'Open draft'
                  : 'Review preserved draft'}
              </a>
            )}
          </li>
        ))}
      </ul>
      {data.more && (
        <button type="button" onClick={data.showMore}>
          Show older outgoing messages
        </button>
      )}
    </section>
  );
}
