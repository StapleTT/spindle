import { useEffect, useRef, useState } from 'react';
import { mailApi } from './mail-api.js';
import { mailHref } from './mail-navigation.js';

type Person = { name: string; address: string };
type Detail = {
  message: {
    id: string;
    subject: string;
    sender: Person[];
    recipients: { to: Person[]; cc: Person[] };
    accountName: string;
    receivedAt: string;
    messageId: string | null;
  };
  previous: string | null;
  next: string | null;
  content: {
    state: 'missing' | 'pending' | 'ready' | 'failed';
    configured: boolean;
    plainText?: string;
    hasHtml?: boolean;
    imageCount?: number;
    htmlUrl?: string | null;
    message?: string;
  };
};

function people(values: Person[]) {
  return values
    .map((person) =>
      person.name ? `${person.name} <${person.address}>` : person.address,
    )
    .join(', ');
}

export function Reader({
  id,
  account,
  mailbox,
}: {
  id: string;
  account: string;
  mailbox: string;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<'html' | 'text'>('html');
  const [htmlUrl, setHtmlUrl] = useState<string | null>(null);
  const [images, setImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const imageRequest = useRef<AbortController | null>(null);
  const params = new URLSearchParams();
  if (account) params.set('account', account);
  if (mailbox) params.set('mailbox', mailbox);
  const endpoint = `messages/${id}?${params}`;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let requested = false;
    setDetail(null);
    setError('');
    setImages(false);
    setHtmlUrl(null);
    async function load() {
      try {
        if (attempt && !requested) {
          await mailApi(`messages/${id}/content`, {
            method: 'POST',
            body: '{"retry":true}',
            signal: controller.signal,
          });
          requested = true;
        }
        const current = await mailApi<Detail>(endpoint, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDetail(current);
        if (current.content.state === 'missing' && !requested) {
          await mailApi(`messages/${id}/content`, {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
          });
          requested = true;
        }
        if (
          current.content.state === 'missing' ||
          current.content.state === 'pending'
        )
          timer = setTimeout(() => void load(), 1500);
        else setHtmlUrl(current.content.htmlUrl ?? null);
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load this message.',
          );
      }
    }
    void load();
    heading.current?.focus();
    return () => {
      controller.abort();
      imageRequest.current?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, endpoint, attempt]);

  async function displayImages(show: boolean) {
    if (!show) {
      setImages(false);
      setHtmlUrl(null);
    }
    imageRequest.current?.abort();
    const controller = new AbortController();
    imageRequest.current = controller;
    setBusy(true);
    setImageError('');
    try {
      const result = show
        ? await mailApi<{ htmlUrl: string }>(`messages/${id}/images`, {
            method: 'POST',
            body: '{}',
            signal: controller.signal,
          })
        : (await mailApi<Detail>(endpoint, { signal: controller.signal }))
            .content;
      if (controller.signal.aborted) return;
      setHtmlUrl(result.htmlUrl ?? null);
      setImages(show);
    } catch (failure) {
      if (!controller.signal.aborted)
        setImageError(
          failure instanceof Error
            ? failure.message
            : 'Unable to update images.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  async function showHtml() {
    setView('html');
    await displayImages(images);
  }

  return (
    <section className="reader" aria-labelledby="reader-title">
      <nav className="reader-navigation" aria-label="Message navigation">
        <a href={mailHref({ message: '' })}>Back to message list</a>
        {detail?.previous ? (
          <a href={mailHref({ message: detail.previous })}>Previous message</a>
        ) : (
          <button type="button" disabled>
            Previous message
          </button>
        )}
        {detail?.next ? (
          <a href={mailHref({ message: detail.next })}>Next message</a>
        ) : (
          <button type="button" disabled>
            Next message
          </button>
        )}
      </nav>
      <h2 id="reader-title" ref={heading} tabIndex={-1}>
        {detail?.message.subject ||
          (detail ? '(No subject)' : 'Loading message…')}
      </h2>
      {detail && (
        <dl className="message-details">
          <dt>From</dt>
          <dd>{people(detail.message.sender) || 'Unknown sender'}</dd>
          <dt>To</dt>
          <dd>{people(detail.message.recipients.to)}</dd>
          {detail.message.recipients.cc.length > 0 && (
            <>
              <dt>Cc</dt>
              <dd>{people(detail.message.recipients.cc)}</dd>
            </>
          )}
          <dt>Account</dt>
          <dd>{detail.message.accountName}</dd>
          <dt>Received</dt>
          <dd>
            <time dateTime={detail.message.receivedAt}>
              {new Date(detail.message.receivedAt).toLocaleString()}
            </time>
          </dd>
        </dl>
      )}
      {error ? (
        <p role="alert" className="error">
          {error}{' '}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry loading
          </button>
        </p>
      ) : !detail || ['pending', 'missing'].includes(detail.content.state) ? (
        <p role="status">Fetching message content…</p>
      ) : detail.content.state === 'failed' ? (
        <p role="alert" className="error">
          {detail.content.message}
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry loading
          </button>
        </p>
      ) : (
        <>
          {detail.content.hasHtml && (
            <fieldset className="account-actions">
              <legend>Body format</legend>
              <button
                type="button"
                aria-pressed={view === 'html'}
                disabled={busy || !detail.content.configured}
                onClick={() => void showHtml()}
              >
                Formatted message
              </button>
              <button
                type="button"
                aria-pressed={view === 'text'}
                onClick={() => setView('text')}
              >
                Plain text
              </button>
            </fieldset>
          )}
          {!detail.content.configured && detail.content.hasHtml && (
            <p role="status">
              Formatted mail needs the isolated content server. Plain text is
              available below.
            </p>
          )}
          {view === 'html' &&
          detail.content.hasHtml &&
          detail.content.configured ? (
            <>
              {Boolean(detail.content.imageCount) && (
                <div className="reader-images">
                  <p>
                    {images
                      ? 'Images are enabled for this message.'
                      : 'Images are blocked. Remote images may notify the sender when loaded.'}
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void displayImages(!images)}
                  >
                    {busy
                      ? 'Updating images…'
                      : images
                        ? 'Hide images'
                        : 'Display images'}
                  </button>
                </div>
              )}
              {imageError && <p role="alert">{imageError}</p>}
              {htmlUrl && (
                <iframe
                  className="message-frame"
                  title="Message body"
                  src={htmlUrl}
                  referrerPolicy="no-referrer"
                  sandbox="allow-popups allow-popups-to-escape-sandbox"
                />
              )}
            </>
          ) : (
            <pre className="plain-message">
              {detail.content.plainText ||
                'This message has no plain-text alternative.'}
            </pre>
          )}
        </>
      )}
    </section>
  );
}
