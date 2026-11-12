import { useEffect, useState } from 'react';
import { Icon } from './brand.js';
import {
  type DraftSummary,
  recoveryDrafts,
  removeRecovery,
} from './draft-api.js';
import { trash } from './icons.js';
import { MailApiError, mailApi } from './mail-api.js';
import { useMailRevision } from './mail-events.js';
import { mailHref, useMailLocation } from './mail-navigation.js';

export function DraftList({
  user,
  accountId = '',
}: {
  user: string;
  accountId?: string;
}) {
  const liveRevision = useMailRevision([
    'drafts',
    'files',
    'outbox',
    'accounts',
  ]);
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState('');
  const [deleting, setDeleting] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const open = useMailLocation().draft;
  const recoveries = recoveryDrafts(user);
  // Quick delete: a second click confirms, because draft text cannot be
  // recovered. Recovery-only drafts never reached the server.
  async function remove(draft: DraftSummary) {
    setDeleting(draft.id);
    setDeleteError('');
    const saved = drafts.find((item) => item.id === draft.id);
    try {
      if (saved)
        await mailApi(`drafts/${draft.id}`, {
          method: 'DELETE',
          body: JSON.stringify({ revision: saved.revision }),
        });
      removeRecovery(user, draft.id);
      setDrafts((items) => items.filter((item) => item.id !== draft.id));
    } catch (failure) {
      if (failure instanceof MailApiError && failure.status === 404) {
        removeRecovery(user, draft.id);
        setDrafts((items) => items.filter((item) => item.id !== draft.id));
      } else
        setDeleteError(
          failure instanceof Error
            ? failure.message
            : 'Unable to delete this draft.',
        );
    } finally {
      setDeleting('');
      setConfirming('');
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry reloads the same draft list.
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await mailApi<{ drafts: DraftSummary[] }>('drafts', {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) {
          setDrafts(result.drafts);
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load drafts.',
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [attempt, accountId, liveRevision]);
  const entries = [
    ...new Map(
      [...drafts, ...recoveries].map((draft) => [draft.id, draft]),
    ).values(),
  ].filter((draft) => !accountId || draft.accountId === accountId);
  return (
    <section aria-labelledby="drafts-heading">
      <h2 id="drafts-heading">Local drafts</h2>
      <p>
        Drafts are saved in Spindle only; they are not copied to your mail
        provider’s Drafts folder. Recovery edits also have text kept in this
        browser tab.
      </p>
      {loading && <p role="status">Loading drafts…</p>}
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry loading drafts
          </button>
        </p>
      )}
      {deleteError && (
        <p role="alert" className="error">
          {deleteError}
        </p>
      )}
      {!loading && entries.length === 0 && (
        <p>No local drafts yet. Choose Compose to start one.</p>
      )}
      <ul className="message-list" aria-label="Local drafts">
        {entries.map((draft) => (
          <li key={draft.id}>
            <a
              className="message-open"
              href={mailHref({ draft: draft.id, view: 'drafts', message: '' })}
            >
              {draft.subject || '(No subject)'}
            </a>
            {draft.sendError && (
              <span className="error">Not sent: {draft.sendError}</span>
            )}
            {recoveries.some((item) => item.id === draft.id) ? (
              <span>Recovery edits in this tab</span>
            ) : (
              <time dateTime={draft.updatedAt}>
                {new Date(draft.updatedAt).toLocaleString()}
              </time>
            )}
            {draft.id !== open &&
              (confirming === draft.id ? (
                <span className="draft-delete">
                  <button
                    type="button"
                    className="danger"
                    disabled={deleting === draft.id}
                    onClick={() => void remove(draft)}
                  >
                    Delete permanently
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => setConfirming('')}
                  >
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="icon-button small draft-delete-start"
                  title="Delete draft"
                  onClick={() => setConfirming(draft.id)}
                >
                  <Icon src={trash} />
                  <span className="visually-hidden">
                    Delete draft {draft.subject || '(No subject)'}
                  </span>
                </button>
              ))}
          </li>
        ))}
      </ul>
    </section>
  );
}
