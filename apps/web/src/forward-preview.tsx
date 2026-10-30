import { useEffect, useState } from 'react';
import { mailApi } from './mail-api.js';
import { useThemedContentUrl } from './use-themed-content.js';

export function ForwardPreview({
  id,
  text,
  imageCount,
  origin,
}: {
  id: string;
  text: string;
  imageCount: number;
  origin?: 'provider' | undefined;
}) {
  const [images, setImages] = useState<boolean | undefined>(undefined);
  const [shownImages, setShownImages] = useState(false);
  const [htmlUrl, setHtmlUrl] = useState<string | null>(null);
  const themedHtmlUrl = useThemedContentUrl(
    htmlUrl,
    async (signal) =>
      (
        await mailApi<{ htmlUrl: string }>(`drafts/${id}/forward-preview`, {
          method: 'POST',
          body: JSON.stringify({ images: shownImages }),
          signal,
        })
      ).htmlUrl,
  );
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly renews the content grant.
  useEffect(() => {
    const controller = new AbortController();
    setHtmlUrl(null);
    setError('');
    void mailApi<{ htmlUrl: string; images: boolean }>(
      `drafts/${id}/forward-preview`,
      {
        method: 'POST',
        body: JSON.stringify({ images }),
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (!controller.signal.aborted) {
          setHtmlUrl(result.htmlUrl);
          setShownImages(result.images);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load the formatted original.',
          );
      });
    return () => controller.abort();
  }, [id, images, attempt]);
  return (
    <section
      aria-label={
        origin === 'provider' ? 'Original draft content' : 'Forwarded original'
      }
    >
      <h3>
        {origin === 'provider'
          ? 'Original draft content'
          : 'Forwarded original'}
      </h3>
      <p>
        {origin === 'provider'
          ? 'The original draft formatting is preserved below. Add your edits above, or continue editing the body in your other mail client.'
          : 'The original formatting will be included below your note.'}
      </p>
      {imageCount > 0 && !(shownImages && images === undefined) && (
        <div
          className={shownImages ? 'reader-image-controls' : 'reader-images'}
        >
          {!shownImages && (
            <p>
              Images are blocked in this preview. Remote images may notify the
              sender when loaded.
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              setHtmlUrl(null);
              setImages(!shownImages);
            }}
          >
            {shownImages ? 'Hide images' : 'Display images'}
          </button>
        </div>
      )}
      {error ? (
        <>
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry preview
            </button>
          </p>
          <pre className="plain-message">{text}</pre>
        </>
      ) : themedHtmlUrl ? (
        <iframe
          className="message-frame"
          title={
            origin === 'provider'
              ? 'Original draft body'
              : 'Forwarded message body'
          }
          src={themedHtmlUrl}
          referrerPolicy="no-referrer"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
        />
      ) : (
        <p role="status">Loading formatted original…</p>
      )}
    </section>
  );
}
