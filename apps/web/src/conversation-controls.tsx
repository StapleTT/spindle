import { type FormEvent, useEffect, useState } from 'react';
import { Icon } from './brand.js';
import { DateTimeInput, futureInstant, localTime } from './date-time.js';
import { keep, keepFill, notificationsOff, schedule } from './icons.js';
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
    <section aria-label="Conversation settings" className="conversation-tools">
      <p className="visually-hidden">
        These settings apply to this conversation in this account, including new
        replies. Mute keeps mail visible and unread; it suppresses future
        Spindle notifications.
      </p>
      <button
        type="button"
        className={`icon-button${state.pinned ? ' on' : ''}`}
        disabled={busy}
        aria-pressed={state.pinned}
        title={state.pinned ? 'Unpin (P)' : 'Pin (P)'}
        onClick={() => void change({ pinned: !state.pinned })}
      >
        <Icon src={state.pinned ? keepFill : keep} />
        <span className="visually-hidden">
          {state.pinned ? 'Unpin conversation' : 'Pin conversation'}
        </span>
      </button>
      <button
        type="button"
        className={`icon-button${state.muted ? ' on' : ''}`}
        disabled={busy}
        aria-pressed={state.muted}
        title={state.muted ? 'Unmute' : 'Mute'}
        onClick={() => void change({ muted: !state.muted })}
      >
        <Icon src={notificationsOff} />
        <span className="visually-hidden">
          {state.muted ? 'Unmute conversation' : 'Mute conversation'}
        </span>
      </button>
      <span className="popover-anchor">
        <button
          type="button"
          className={`icon-button${state.snoozedUntil ? ' on' : ''}`}
          disabled={busy}
          aria-expanded={choosing}
          title={state.snoozedUntil ? 'Reschedule snooze' : 'Snooze'}
          onClick={() => {
            setTime(
              localTime(new Date(state.snoozedUntil ?? Date.now() + 3600000)),
            );
            setChoosing(!choosing);
          }}
        >
          <Icon src={schedule} />
          <span className="visually-hidden">
            {state.snoozedUntil ? 'Reschedule snooze' : 'Snooze conversation'}
          </span>
        </button>
        {choosing && (
          <form className="popover" onSubmit={snooze}>
            <p className="popover-title">Snooze until</p>
            <DateTimeInput
              label="Snooze until"
              value={time}
              onChange={setTime}
            />
            <div className="form-actions">
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => setChoosing(false)}
              >
                Cancel snooze
              </button>
              <button type="submit" disabled={busy}>
                {state.snoozedUntil ? 'Save snooze time' : 'Snooze'}
              </button>
            </div>
          </form>
        )}
      </span>
      {state.snoozedUntil && (
        <p role="status" className="snooze-chip">
          Snoozed until{' '}
          <time dateTime={state.snoozedUntil}>
            {new Date(state.snoozedUntil).toLocaleString(undefined, {
              timeZoneName: 'short',
            })}
          </time>
          . New replies stay snoozed until then.{' '}
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void change({ snoozedUntil: null })}
          >
            Unsnooze conversation
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button type="button" disabled={busy} onClick={onReload}>
            Reload settings
          </button>
        </p>
      )}
    </section>
  );
}
