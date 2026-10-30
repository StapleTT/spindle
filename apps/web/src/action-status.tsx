import { useEffect, useRef, useState } from 'react';
import { Icon } from './brand.js';
import { close } from './icons.js';
import {
  type ActionFeedback,
  actionNotice,
  actionText,
  mailApi,
  type Undoable,
} from './mail-api.js';
import { mailPollDelay, useMailRevision } from './mail-events.js';

type Page = { actions: ActionFeedback[]; nextCursor: string | null };
type TimedAction = ActionFeedback & { until: number };

// Owned by the mail shell, so outcomes continue arriving after reader navigation.
// The snackbar stack shows the newest actions; older ones stay one click away.
const visibleActions = 3;

export function ActionStatus({
  fresh,
  onChange,
}: {
  fresh: Undoable | null;
  onChange: () => void;
}) {
  const liveRevision = useMailRevision(['actions']);
  const [actions, setActions] = useState<TimedAction[]>([]);
  const [pages, setPages] = useState(1);
  const [more, setMore] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  const previous = useRef('');

  useEffect(() => {
    if (fresh)
      setActions((list) => [
        {
          ...fresh,
          state: 'pending',
          messageId: null,
          until: Date.now() + fresh.undoMs,
        },
        ...list.filter((item) => item.id !== fresh.id),
      ]);
  }, [fresh]);

  // Poll sequentially and cancel stale responses. Errors keep the last known view
  // visible and explicitly say that the current provider outcome is unavailable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: New intent or a write refreshes the same status query immediately.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        let cursor: string | null = null;
        const entries: TimedAction[] = [];
        for (let page = 0; page < pages; page++) {
          const result: Page = await mailApi<Page>(
            `actions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
            { signal: controller.signal },
          );
          entries.push(
            ...result.actions.map((action) => ({
              ...action,
              until: Date.now() + action.undoMs,
            })),
          );
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        if (controller.signal.aborted) return;
        // An action can finish between page requests and change its sort group.
        const unique = [
          ...new Map(entries.map((item) => [item.id, item])).values(),
        ];
        const signature = unique
          .map((item) => `${item.id}:${item.state}`)
          .join(',');
        if (previous.current && signature !== previous.current) onChange();
        previous.current = signature;
        setActions(unique);
        setMore(Boolean(cursor));
        setError('');
      } catch {
        if (!controller.signal.aborted)
          setError(
            'Action status is unavailable. Showing the last known state; checking again automatically.',
          );
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void poll(), mailPollDelay(2000));
      }
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [fresh, pages, revision, onChange, liveRevision]);

  useEffect(() => {
    if (!actions.some((action) => action.until > Date.now())) return;
    const timer = setInterval(() => tick((value) => value + 1), 250);
    return () => clearInterval(timer);
  }, [actions]);

  async function change(
    action: TimedAction,
    operation: 'undo' | 'retry' | 'dismiss',
  ) {
    setBusy(action.id);
    setNotice('');
    try {
      await mailApi(`actions/${action.id}/${operation}`, {
        method: 'POST',
        body: '{}',
      });
      if (operation === 'undo') setNotice(`Undone: ${actionNotice(action)}`);
      if (operation === 'dismiss' || operation === 'undo')
        setActions((list) => list.filter((item) => item.id !== action.id));
      onChange();
    } catch (failure) {
      setNotice(
        failure instanceof Error
          ? failure.message
          : 'Unable to update this action.',
      );
    } finally {
      setBusy(null);
      setRevision((value) => value + 1);
    }
  }

  return (
    <section aria-label="Action status" className="snackbars-actions">
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="status" className="error">
          {error}
        </p>
      )}
      <ul
        className={`action-status${expanded ? ' expanded' : ''}`}
        aria-label="Recent actions"
        aria-live="polite"
        aria-relevant="additions text"
      >
        {actions.map((action) => (
          <li key={action.id}>
            <span className="snack-text">
              <strong>
                {action.state === 'applied'
                  ? 'Completed'
                  : action.state === 'conflict'
                    ? 'Conflict'
                    : action.state === 'failed'
                      ? 'Failed'
                      : 'Pending'}
                :{' '}
              </strong>
              {action.state === 'applied'
                ? actionNotice(action)
                : `${actionText[action.kind].pending} “${action.subject || '(No subject)'}”${action.target ? ` → ${action.target}` : ''}.`}{' '}
              {action.state === 'pending' &&
                'Waiting for provider confirmation. '}
              {action.error && <span className="error">{action.error} </span>}
            </span>
            {action.state === 'pending' && action.until > Date.now() && (
              <button
                type="button"
                disabled={busy !== null}
                data-mail-command="undo"
                className="snack-action"
                aria-label={`Undo: ${actionNotice(action)}`}
                onClick={() => void change(action, 'undo')}
              >
                Undo
              </button>
            )}
            {action.state === 'failed' && action.messageId && (
              <button
                type="button"
                disabled={busy !== null}
                aria-label={`Retry: ${actionNotice(action)}`}
                className="snack-action"
                onClick={() => void change(action, 'retry')}
              >
                Retry
              </button>
            )}
            {action.state !== 'pending' && (
              <button
                type="button"
                disabled={busy !== null}
                aria-label={`Dismiss: ${actionNotice(action)}`}
                className="icon-button small"
                title="Dismiss"
                onClick={() => void change(action, 'dismiss')}
              >
                <Icon src={close} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {(actions.length > visibleActions || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded
            ? 'Show fewer actions'
            : `All recent actions (${actions.length})`}
        </button>
      )}
      {expanded && more && (
        <button type="button" onClick={() => setPages((value) => value + 1)}>
          Show more actions
        </button>
      )}
    </section>
  );
}
