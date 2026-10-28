import { useEffect, useState } from 'react';
import { type DraftSummary, recoveryDrafts } from './draft-api.js';
import { mailApi } from './mail-api.js';
import { mailHref } from './mail-navigation.js';

export function DraftList({ user }: { user: string }) {
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const recoveries = recoveryDrafts(user);
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
  }, [attempt]);
  const entries = [
    ...new Map(
      [...drafts, ...recoveries].map((draft) => [draft.id, draft]),
    ).values(),
  ];
  return (
    <section aria-labelledby="drafts-heading">
      <h2 id="drafts-heading">Local drafts</h2>
      <p>
        Saved in Spindle. Drafts with recovery edits also have text kept in this
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
            {recoveries.some((item) => item.id === draft.id) ? (
              <span>Recovery edits in this tab</span>
            ) : (
              <time dateTime={draft.updatedAt}>
                {new Date(draft.updatedAt).toLocaleString()}
              </time>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
