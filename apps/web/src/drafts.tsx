import { useEffect, useState } from 'react';
import { type DraftSummary, recoveryDrafts } from './draft-api.js';
import { mailApi } from './mail-api.js';
import { useMailRevision } from './mail-events.js';
import { mailHref } from './mail-navigation.js';
import { providerDraftText } from './provider-draft-status.js';

type SyncIssue = {
  id: string;
  draftId: string | null;
  subject: string;
  accountName: string;
  accountId: string;
  state: string;
  message: string;
  import: boolean;
};

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
  const [issues, setIssues] = useState<SyncIssue[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const recoveries = recoveryDrafts(user);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Explicit retry reloads the same draft list.
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const [result, sync] = await Promise.all([
          mailApi<{ drafts: DraftSummary[] }>('drafts', {
            signal: controller.signal,
          }),
          mailApi<{ issues: SyncIssue[] }>('draft-sync', {
            signal: controller.signal,
          }),
        ]);
        if (!controller.signal.aborted) {
          setDrafts(result.drafts);
          setIssues(
            sync.issues.filter(
              (issue) => !accountId || issue.accountId === accountId,
            ),
          );
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
  async function resolve(issue: SyncIssue, action: 'retry' | 'leaveProvider') {
    setBusy(true);
    try {
      await mailApi(`draft-sync/${issue.id}`, {
        method: 'POST',
        body: JSON.stringify({ action, import: issue.import }),
      });
      setAttempt((n) => n + 1);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to update provider sync.',
      );
    } finally {
      setBusy(false);
    }
  }
  const entries = [
    ...new Map(
      [...drafts, ...recoveries].map((draft) => [draft.id, draft]),
    ).values(),
  ].filter((draft) => !accountId || draft.accountId === accountId);
  return (
    <section aria-labelledby="drafts-heading">
      <h2 id="drafts-heading">Local drafts</h2>
      <p>
        Saved in Spindle and synchronized with the selected account’s Drafts
        folder. Provider drafts open here for editing after background import.
        Recovery edits also have text kept in this browser tab.
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
      {issues.length > 0 && (
        <section aria-label="Provider draft sync issues">
          <h3>Provider Drafts needs attention</h3>
          {issues.map((issue) => (
            <div key={issue.id}>
              <p role="alert">
                {issue.accountName} — {issue.subject || '(No subject)'}:{' '}
                {issue.message}
              </p>
              {issue.draftId ? (
                <a
                  href={mailHref({
                    draft: issue.draftId,
                    view: 'drafts',
                    message: '',
                  })}
                >
                  Review draft
                </a>
              ) : (
                <>
                  {!issue.import && issue.state !== 'conflict' && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resolve(issue, 'retry')}
                    >
                      Check provider again
                    </button>
                  )}
                  {!issue.import && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void resolve(issue, 'leaveProvider')}
                    >
                      Leave original provider copy
                    </button>
                  )}
                </>
              )}
              {issue.import && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resolve(issue, 'retry')}
                >
                  Retry importing draft
                </button>
              )}
            </div>
          ))}
        </section>
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
            {draft.providerSync?.map((item) => (
              <span key={item.id}>{providerDraftText(item)}</span>
            ))}
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
