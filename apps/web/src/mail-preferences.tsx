import { useEffect, useRef, useState } from 'react';
import { Icon } from './brand.js';
import { hideImage, shield, undo } from './icons.js';
import { mailApi } from './mail-api.js';
import { mailPollDelay, useMailRevision } from './mail-events.js';

type Preferences = {
  imageProxy: boolean;
  blockRemoteImages: boolean;
  undoSend: boolean;
};
const controls = [
  [
    'imageProxy',
    shield,
    'Load images through the privacy proxy',
    'When off, allowed HTTPS images load directly in your browser. Image hosts can see your IP address and may track opens.',
  ],
  [
    'blockRemoteImages',
    hideImage,
    'Block remote images by default',
    'When on, display images separately for each message. When off, images load automatically and may notify senders.',
  ],
  [
    'undoSend',
    undo,
    'Undo send',
    'Add a five-second cancellation window to future immediate sends. When off, sending can start immediately. Scheduled sends keep their chosen time.',
  ],
] as const;

export function MailPreferenceSettings() {
  const revision = useMailRevision(['accounts']);
  const [preferences, setPreferences] = useState<Preferences | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  const generation = useRef(0),
    writing = useRef(false),
    saveRequest = useRef<AbortController | null>(null);
  useEffect(() => () => saveRequest.current?.abort(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: SSE invalidation and explicit retry refresh persisted preferences.
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      const current = ++generation.current;
      try {
        if (writing.current) return;
        const result = await mailApi<{ preferences: Preferences }>(
          'preferences',
          { signal: controller.signal },
        );
        if (!controller.signal.aborted && current === generation.current) {
          setPreferences(result.preferences);
          setError('');
        }
      } catch (failure) {
        if (!controller.signal.aborted && current === generation.current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load preferences.',
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
  }, [revision, attempt]);
  async function toggle(key: keyof Preferences) {
    if (!preferences || busy) return;
    generation.current++;
    writing.current = true;
    setBusy(true);
    setError('');
    const controller = new AbortController();
    saveRequest.current = controller;
    try {
      const result = await mailApi<{ preferences: Preferences }>(
        'preferences',
        {
          method: 'PATCH',
          body: JSON.stringify({ [key]: !preferences[key] }),
          signal: controller.signal,
        },
      );
      if (!controller.signal.aborted) setPreferences(result.preferences);
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof Error
            ? failure.message
            : 'Unable to save preference.',
        );
    } finally {
      writing.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <p className="muted small">
        Saved for your user across devices. Image defaults apply when opening a
        message or preview.
      </p>
      {!preferences && !error && <p role="status">Loading preferences…</p>}
      <ul className="settings-list">
        {controls.map(([key, icon, label, description]) => (
          <li key={key} className="switch-row">
            <Icon src={icon} />
            <div>
              <strong>{label}</strong>
              <p className="muted">{description}</p>
            </div>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-label={label}
              aria-checked={preferences?.[key] ?? true}
              disabled={!preferences || busy}
              onClick={() => void toggle(key)}
            />
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button
            type="button"
            className="text-button"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Reload preferences
          </button>
        </p>
      )}
    </>
  );
}
