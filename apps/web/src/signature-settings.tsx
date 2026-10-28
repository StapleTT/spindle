import { useEffect, useState } from 'react';
import { plainHtml, type Signature } from './draft-api.js';
import { mailApi } from './mail-api.js';
import { RichEditor } from './rich-editor.js';

export function SignatureSettings({
  account,
  onClose,
  onChange,
}: {
  account: { id: string; name: string };
  onClose: () => void;
  onChange: (signature: Signature) => void;
}) {
  const [signature, setSignature] = useState<Signature | null>(null);
  const [format, setFormat] = useState<'rich' | 'plain'>('rich');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editorVersion, setEditorVersion] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reload is explicit so a conflict never discards edits.
  useEffect(() => {
    const controller = new AbortController();
    setSignature(null);
    setError('');
    setSaved(false);
    void mailApi<{ signature: Signature }>(`accounts/${account.id}/signature`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setSignature(result.signature);
          setEditorVersion((n) => n + 1);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load signature.',
          );
      });
    return () => controller.abort();
  }, [account.id, attempt]);
  function update(patch: Partial<Signature>) {
    setSignature((current) => (current ? { ...current, ...patch } : null));
    setSaved(false);
  }
  async function save() {
    if (!signature) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const result = await mailApi<{ signature: Signature }>(
        `accounts/${account.id}/signature`,
        {
          method: 'PUT',
          body: JSON.stringify({
            html: signature.html,
            newMessages: signature.newMessages,
            repliesForwards: signature.repliesForwards,
            revision: signature.revision,
          }),
        },
      );
      setSignature(result.signature);
      setSaved(true);
      onChange(result.signature);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save signature.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="signature-heading">
      <h2 id="signature-heading">Email signature — {account.name}</h2>
      <p>
        Inserted once into new drafts as editable text, above replies and
        forwarded originals. Existing drafts keep their text when you change
        these settings or switch accounts.
      </p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {saved && <p role="status">Signature saved.</p>}
      {!signature && error && (
        <button type="button" onClick={() => setAttempt((n) => n + 1)}>
          Retry loading signature
        </button>
      )}
      {!signature ? (
        <p role="status">Loading signature…</p>
      ) : (
        <fieldset disabled={busy}>
          <legend>Signature settings</legend>
          <label>
            <input
              type="checkbox"
              checked={signature.newMessages}
              onChange={(event) =>
                update({ newMessages: event.target.checked })
              }
            />
            Use for new messages
          </label>
          <label>
            <input
              type="checkbox"
              checked={signature.repliesForwards}
              onChange={(event) =>
                update({ repliesForwards: event.target.checked })
              }
            />
            Use for replies and forwards
          </label>
          <label>
            Signature format
            <select
              value={format}
              onChange={(event) => {
                const next = event.target.value as 'rich' | 'plain';
                setFormat(next);
                setEditorVersion((n) => n + 1);
                if (next === 'plain')
                  update({ html: plainHtml(signature.text) });
              }}
            >
              <option value="rich">Rich text</option>
              <option value="plain">Plain text</option>
            </select>
          </label>
          {format === 'rich' ? (
            <RichEditor
              key={editorVersion}
              html={signature.html}
              label="Signature body"
              disabled={busy}
              onChange={(html, text) => update({ html, text })}
            />
          ) : (
            <label>
              Signature body
              <textarea
                rows={5}
                maxLength={10000}
                value={signature.text}
                onChange={(event) =>
                  update({
                    text: event.target.value,
                    html: plainHtml(event.target.value),
                  })
                }
              />
            </label>
          )}
          <p>
            The plain-text alternative follows your signature text. Choosing
            Plain text removes formatting. Links are supported; images and
            pasted HTML are excluded.
          </p>
          {format === 'rich' && (
            <details>
              <summary>Plain-text signature preview</summary>
              <pre className="plain-message">{signature.text}</pre>
            </details>
          )}
          <button type="button" disabled={busy} onClick={() => void save()}>
            Save signature
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (
                window.confirm(
                  'Reload the saved signature and discard unsaved signature settings?',
                )
              )
                setAttempt((n) => n + 1);
            }}
          >
            Reload saved signature
          </button>
        </fieldset>
      )}
      <button type="button" disabled={busy} onClick={onClose}>
        Close signature settings
      </button>
    </section>
  );
}
