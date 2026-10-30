import type { ReactNode } from 'react';
import { useState } from 'react';
import { Icon } from './brand.js';
import {
  archive,
  close,
  markEmailRead,
  markEmailUnread,
  trash,
} from './icons.js';
import { type MailAction, mailApi } from './mail-api.js';

type Batch = {
  kind: 'read' | 'unread' | 'archive' | 'trash';
  items: { id: string; messageId: string; subject: string }[];
};
type Result = { messageId: string; error?: string; action?: MailAction };
export function BatchActions({
  user,
  selected,
  onComplete,
  onClear,
  children,
}: {
  onClear: () => void;
  children: ReactNode;
  user: string;
  selected: { id: string; subject: string }[];
  onComplete: () => void;
}) {
  const key = `spindle:batch:${user}`;
  const [pending, setPending] = useState<Batch | null>(() => {
    try {
      const data = JSON.parse(sessionStorage.getItem(key) ?? 'null');
      return data &&
        ['read', 'unread', 'archive', 'trash'].includes(data.kind) &&
        Array.isArray(data.items) &&
        data.items.length > 0 &&
        data.items.length <= 50 &&
        data.items.every(
          (item: { id: unknown; messageId: unknown; subject: unknown }) =>
            typeof item.id === 'string' &&
            typeof item.messageId === 'string' &&
            typeof item.subject === 'string',
        )
        ? data
        : null;
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [results, setResults] = useState<Result[]>([]),
    [labels, setLabels] = useState<Record<string, string>>({});
  async function run(batch: Batch) {
    setBusy(true);
    setError('');
    setPending(batch);
    setLabels(
      Object.fromEntries(
        batch.items.map((item) => [item.messageId, item.subject]),
      ),
    );
    try {
      sessionStorage.setItem(key, JSON.stringify(batch));
      const response = await mailApi<{ results: Result[] }>('batch-actions', {
        method: 'POST',
        body: JSON.stringify({
          kind: batch.kind,
          items: batch.items.map(({ id, messageId }) => ({ id, messageId })),
        }),
      });
      setResults(response.results);
      setPending(null);
      sessionStorage.removeItem(key);
      onComplete();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Batch response is unconfirmed. Retry the same request to check it.',
      );
    } finally {
      setBusy(false);
    }
  }
  const queue = (kind: Batch['kind']) =>
    void run({
      kind,
      items: selected.map((item) => ({
        id: crypto.randomUUID(),
        messageId: item.id,
        subject: item.subject,
      })),
    });
  const icons = {
    read: markEmailRead,
    unread: markEmailUnread,
    archive,
    trash,
  };
  return (
    <section aria-label="Selected message actions" className="batch">
      {selected.length > 0 && (
        <div className="batch-bar">
          <button
            type="button"
            className="icon-button"
            title="Clear selection"
            onClick={onClear}
          >
            <Icon src={close} />
            <span className="visually-hidden">Clear selection</span>
          </button>
          {children}
          <p className="batch-count">
            {selected.length} selected
            <span className="visually-hidden">
              {' '}
              on this page. Actions apply only to these selected messages (up to
              50).
            </span>
          </p>
          {(['read', 'unread', 'archive', 'trash'] as const).map((kind) => {
            const label =
              kind === 'read'
                ? 'Mark selected read'
                : kind === 'unread'
                  ? 'Mark selected unread'
                  : kind === 'archive'
                    ? 'Archive selected'
                    : 'Trash selected';
            return (
              <button
                type="button"
                key={kind}
                className="icon-button"
                title={label}
                disabled={busy || !!pending || selected.length > 50}
                onClick={() => queue(kind)}
              >
                <Icon src={icons[kind]} />
                <span className="visually-hidden">{label}</span>
              </button>
            );
          })}
        </div>
      )}
      {pending && (
        <p role="status" className="notice">
          {pending.items.length}-message {pending.kind} request is unconfirmed.{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(pending)}
          >
            Retry same batch request
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {results.length > 0 && (
        <details open className="batch-results">
          <summary>
            {results.filter((item) => item.action).length} queued or already
            recorded; {results.filter((item) => item.error).length} refused.
            Provider outcomes and undo are in Recent actions.
          </summary>
          <ul>
            {results.map((item) => (
              <li key={item.messageId}>
                {labels[item.messageId] || '(No subject)'}:{' '}
                {item.error ?? `Recorded: ${item.action?.state}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
