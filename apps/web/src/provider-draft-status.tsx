import { useState } from 'react';
import type { ProviderSync } from './draft-api.js';
import { mailApi } from './mail-api.js';

export function providerDraftText(item: ProviderSync) {
  if (item.state === 'synced') return 'Saved to provider Drafts.';
  if (item.state === 'pending') return 'Syncing to provider Drafts…';
  if (item.state === 'waiting')
    return 'Waiting for attachment uploads and security checks before syncing.';
  if (item.state === 'unknown')
    return 'Provider save is unconfirmed. Check again before creating another copy.';
  if (item.code === 'draft_removed')
    return 'The provider copy was removed or sent elsewhere. Sync is paused. Review before saving it to provider Drafts again.';
  if (item.code === 'safe_delete_unavailable')
    return 'This server cannot safely replace or remove this draft. The provider copy has been kept.';
  if (item.code === 'draft_ambiguous')
    return 'Multiple provider copies match this draft. Review them in your other mail client.';
  if (item.state === 'conflict')
    return 'Provider draft conflict. Both versions are preserved for review.';
  if (item.code === 'drafts_folder_unavailable')
    return 'No accessible provider Drafts folder. Your local draft is safe.';
  return 'Provider Drafts sync failed. Your local draft is safe.';
}
export function ProviderDraftStatus({
  items,
  accountId,
  disabled,
  onResolve,
}: {
  items: ProviderSync[];
  accountId: string | null;
  disabled: boolean;
  onResolve: (
    id: string,
    action: 'retry' | 'useProvider' | 'keepLocal' | 'leaveProvider',
  ) => Promise<void>;
}) {
  const [version, setVersion] = useState<{
    subject: string;
    text: string;
    attachments: number;
  } | null>(null);
  const [error, setError] = useState('');
  return (
    <section aria-label="Provider draft status">
      {items.length === 0 ? (
        <p>
          Saved drafts with a selected account sync to provider Drafts in the
          background.
        </p>
      ) : (
        items.map((item) => (
          <div key={item.id}>
            <p
              role={
                ['conflict', 'unknown', 'failed'].includes(item.state)
                  ? 'alert'
                  : 'status'
              }
            >
              {providerDraftText(item)}
            </p>
            {['failed', 'unknown', 'waiting'].includes(item.state) && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => void onResolve(item.id, 'retry')}
              >
                {item.state === 'unknown'
                  ? 'Check provider again'
                  : 'Retry provider sync'}
              </button>
            )}
            {item.state === 'conflict' && item.accountId === accountId && (
              <>
                {item.hasProviderVersion && (
                  <>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        void mailApi<{
                          subject: string;
                          text: string;
                          attachments: number;
                        }>(`draft-sync/${item.id}/version`)
                          .then(setVersion)
                          .catch((failure) =>
                            setError(
                              failure instanceof Error
                                ? failure.message
                                : 'Unable to compare provider version.',
                            ),
                          );
                      }}
                    >
                      Compare provider version
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Replace the local draft with the provider version? Save a separate copy first to keep both.',
                          )
                        )
                          void onResolve(item.id, 'useProvider');
                      }}
                    >
                      Use provider version
                    </button>
                  </>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void onResolve(item.id, 'keepLocal')}
                >
                  {item.code === 'draft_removed'
                    ? 'Save to provider Drafts again'
                    : 'Keep local as a separate provider draft'}
                </button>
              </>
            )}
            {item.accountId !== accountId &&
              ['conflict', 'unknown', 'failed'].includes(item.state) && (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => void onResolve(item.id, 'leaveProvider')}
                >
                  Leave original provider copy
                </button>
              )}
          </div>
        ))
      )}
      {version && (
        <details open>
          <summary>
            Provider version: {version.subject || '(No subject)'}
          </summary>
          <pre className="plain-message">{version.text}</pre>
          <p>{version.attachments} attached files</p>
        </details>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
