import { type FormEvent, useEffect, useState } from 'react';
import { DateTimeInput, futureInstant, localTime } from './date-time.js';
import { mailApi } from './mail-api.js';
import { navigateMail } from './mail-navigation.js';

export type ConversationState = {
  pinned: boolean;
  muted: boolean;
  snoozedUntil: string | null;
  version: string;
};

export function ConversationControls({
  anchor,
  state,
  onChange,
  onReload,
}: {
  anchor: string;
  state: ConversationState;
  onChange: (state: ConversationState) => void;
  onReload: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [choosing, setChoosing] = useState(false),
    [time, setTime] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: A freshly read version clears a previous conflict without resetting the snooze editor.
  useEffect(() => {
    setError('');
  }, [state.version]);
  async function change(
    patch: Partial<
      Pick<ConversationState, 'pinned' | 'muted' | 'snoozedUntil'>
    >,
  ) {
    setBusy(true);
    setError('');
    try {
      const result = await mailApi<{ state: ConversationState }>(
        `messages/${anchor}/conversation/state`,
        {
          method: 'PATCH',
          body: JSON.stringify({ version: state.version, ...patch }),
        },
      );
      onChange(result.state);
      setChoosing(false);
      if ('snoozedUntil' in patch)
        navigateMail({ message: '', conversation: '', cursor: '' });
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to update conversation settings.',
      );
    } finally {
      setBusy(false);
    }
  }
  function snooze(event: FormEvent) {
    event.preventDefault();
    try {
      void change({ snoozedUntil: futureInstant(time) });
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <section aria-label="Conversation settings">
      <p className="account-status">
        These settings apply to this conversation in this account, including new
        replies. Mute keeps mail visible and unread; it suppresses future
        Spindle notifications.
      </p>
      <div className="account-actions">
        <button
          type="button"
          disabled={busy}
          aria-pressed={state.pinned}
          onClick={() => void change({ pinned: !state.pinned })}
        >
          {state.pinned ? 'Unpin conversation' : 'Pin conversation'}
        </button>
        <button
          type="button"
          disabled={busy}
          aria-pressed={state.muted}
          onClick={() => void change({ muted: !state.muted })}
        >
          {state.muted ? 'Unmute conversation' : 'Mute conversation'}
        </button>
        <button
          type="button"
          disabled={busy}
          aria-expanded={choosing}
          onClick={() => {
            setTime(
              localTime(new Date(state.snoozedUntil ?? Date.now() + 3600000)),
            );
            setChoosing(!choosing);
          }}
        >
          {state.snoozedUntil ? 'Reschedule snooze' : 'Snooze conversation'}
        </button>
        {state.snoozedUntil && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void change({ snoozedUntil: null })}
          >
            Unsnooze conversation
          </button>
        )}
      </div>
      {state.snoozedUntil && (
        <p role="status">
          Snoozed until{' '}
          <time dateTime={state.snoozedUntil}>
            {new Date(state.snoozedUntil).toLocaleString(undefined, {
              timeZoneName: 'short',
            })}
          </time>
          . New replies stay snoozed until then.
        </p>
      )}
      {choosing && (
        <form onSubmit={snooze}>
          <DateTimeInput label="Snooze until" value={time} onChange={setTime} />
          <button type="submit" disabled={busy}>
            {state.snoozedUntil ? 'Save snooze time' : 'Snooze'}
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() => setChoosing(false)}
          >
            Cancel snooze
          </button>
        </form>
      )}
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" disabled={busy} onClick={onReload}>
            Reload settings
          </button>
        </p>
      )}
    </section>
  );
}
