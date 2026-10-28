import { useEffect, useRef, useState } from 'react';
import {
  actionText,
  type MailAction,
  mailApi,
  requestAction,
  type Undoable,
} from './mail-api.js';
import { mailHref, navigateMail } from './mail-navigation.js';

type Person = { name: string; address: string };
type Attachment = {
  index: number;
  filename: string;
  contentType: string;
  size: number;
  state: 'missing' | 'pending' | 'ready' | 'failed';
};
type Detail = {
  message: {
    id: string;
    subject: string;
    sender: Person[];
    recipients: { to: Person[]; cc: Person[] };
    accountName: string;
    receivedAt: string;
    messageId: string | null;
    unread: boolean;
    accountId: string;
    lastAction: MailAction | null;
    canMove: { archive: boolean | null; trash: boolean | null } | null;
    folderId: string | null;
    restoreTo: { id: string; path: string } | null;
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
    attachments?: Attachment[];
  };
};

function people(values: Person[]) {
  return values
    .map((person) =>
      person.name ? `${person.name} <${person.address}>` : person.address,
    )
    .join(', ');
}

function formatSize(bytes: number) {
  const [value, unit] =
    bytes < 1024
      ? [bytes, 'byte']
      : bytes < 1024 * 1024
        ? [bytes / 1024, 'kilobyte']
        : [bytes / 1024 / 1024, 'megabyte'];
  return new Intl.NumberFormat(undefined, {
    style: 'unit',
    unit,
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(value);
}

function AttachmentItem({
  message,
  attachment,
  configured,
}: {
  message: string;
  attachment: Attachment;
  configured: boolean;
}) {
  const [state, setState] = useState<Attachment['state'] | 'error'>(
    attachment.state,
  );
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);

  // Polls until the worker finishes; opens the short-lived download link when asked.
  async function fetchFile(retry: boolean, open: boolean) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState('pending');
    setError('');
    let body = JSON.stringify({ retry });
    try {
      for (;;) {
        const result = await mailApi<{
          state: Attachment['state'];
          url?: string;
          message?: string;
        }>(`messages/${message}/attachments/${attachment.index}`, {
          method: 'POST',
          body,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        body = '{}';
        if (result.state === 'ready') {
          setState('ready');
          if (open && result.url) window.location.assign(result.url);
          return;
        }
        if (result.state === 'failed') {
          setState('failed');
          setError(result.message ?? 'This attachment could not be fetched.');
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
        if (controller.signal.aborted) return;
      }
    } catch (failure) {
      if (controller.signal.aborted) return;
      setState('error');
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to fetch this attachment.',
      );
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: resume once per mounted attachment
  useEffect(() => {
    if (configured && attachment.state === 'pending')
      void fetchFile(false, false);
    return () => request.current?.abort();
  }, []);

  return (
    <li>
      <span className="attachment-name">{attachment.filename}</span>{' '}
      <span className="attachment-meta">
        {attachment.contentType}, {formatSize(attachment.size)}
      </span>{' '}
      {!configured ? (
        <span>Unavailable: downloads need the isolated content server.</span>
      ) : state === 'pending' ? (
        <span role="status">Fetching attachment…</span>
      ) : state === 'failed' || state === 'error' ? (
        <>
          <span role="alert" className="error">
            {error}
          </span>{' '}
          <button
            type="button"
            onClick={() => void fetchFile(state === 'failed', true)}
          >
            Retry download
          </button>
        </>
      ) : (
        <button
          type="button"
          aria-label={`Download ${attachment.filename}`}
          onClick={() => void fetchFile(false, true)}
        >
          Download
        </button>
      )}
    </li>
  );
}

export function Reader({
  id,
  account,
  mailbox,
  folders,
  onChange,
  onAction,
}: {
  id: string;
  account: string;
  mailbox: string;
  folders: { id: string; accountId: string; path: string }[];
  onChange: () => void;
  onAction: (action: Undoable) => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<'html' | 'text'>('html');
  const [htmlUrl, setHtmlUrl] = useState<string | null>(null);
  const [images, setImages] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageError, setImageError] = useState('');
  const [ownAction, setOwnAction] = useState('');
  const [actionError, setActionError] = useState('');
  const [destination, setDestination] = useState('');
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

  const lastAction = detail?.message.lastAction ?? null;
  const pendingAction = lastAction?.state === 'pending';

  // Follow the durable action until the worker reports the provider outcome.
  useEffect(() => {
    if (!pendingAction) return;
    const controller = new AbortController();
    const timer = setInterval(async () => {
      try {
        const current = await mailApi<Detail>(endpoint, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDetail((value) =>
          value ? { ...value, message: current.message } : value,
        );
        if (current.message.lastAction?.state !== 'pending') onChange();
      } catch {
        // The interval keeps polling while the action is pending.
      }
    }, 1500);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [pendingAction, endpoint, onChange]);

  async function mark(kind: MailAction['kind'], folder?: string) {
    setActionError('');
    try {
      const { action, target, undoMs } = await requestAction(id, kind, folder);
      onAction({
        id: action.id,
        kind,
        subject: detail?.message.subject ?? '',
        target,
        undoMs,
      });
      if (kind !== 'read' && kind !== 'unread') {
        // The message has left this view; continue with its neighbor.
        navigateMail({ message: detail?.next ?? detail?.previous ?? '' });
        return;
      }
      setOwnAction(action.id);
      setDetail((value) =>
        value
          ? {
              ...value,
              message: {
                ...value.message,
                unread: kind === 'unread',
                lastAction: action,
              },
            }
          : value,
      );
      onChange();
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : 'Unable to update mail.',
      );
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
        <div className="account-actions">
          <button
            type="button"
            disabled={pendingAction}
            onClick={() => void mark(detail.message.unread ? 'read' : 'unread')}
          >
            {detail.message.unread ? 'Mark as read' : 'Mark as unread'}
          </button>
          <button
            type="button"
            disabled={pendingAction || !detail.message.canMove?.archive}
            onClick={() => void mark('archive')}
          >
            Archive
          </button>
          <button
            type="button"
            disabled={pendingAction || !detail.message.canMove?.trash}
            onClick={() => void mark('trash')}
          >
            Move to trash
          </button>
          {detail.message.restoreTo && (
            <button
              type="button"
              disabled={pendingAction}
              onClick={() => void mark('restore')}
            >
              Restore to {detail.message.restoreTo.path}
            </button>
          )}
          <label>
            Move to folder{' '}
            <select
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
            >
              <option value="">Choose a folder</option>
              {folders
                .filter(
                  (folder) =>
                    folder.accountId === detail.message.accountId &&
                    folder.id !== detail.message.folderId,
                )
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {folder.path}
                  </option>
                ))}
            </select>
          </label>
          <button
            type="button"
            disabled={pendingAction || !destination}
            onClick={() => void mark('move', destination)}
          >
            Move
          </button>
          <span role="status">
            {lastAction?.state === 'pending'
              ? `${actionText[lastAction.kind].pending}… saving to your provider.`
              : lastAction?.id !== ownAction
                ? ''
                : lastAction.state === 'applied'
                  ? `${actionText[lastAction.kind].done}.`
                  : lastAction.state === 'cancelled'
                    ? 'Undone.'
                    : ''}
          </span>
          {lastAction?.state === 'failed' && (
            <span role="alert" className="error">
              {actionText[lastAction.kind].pending} failed at your provider; the
              change was undone.{' '}
              {(lastAction.kind === 'read' || lastAction.kind === 'unread') && (
                <button
                  type="button"
                  onClick={() => void mark(lastAction.kind)}
                >
                  Try again
                </button>
              )}
            </span>
          )}
          {actionError && (
            <span role="alert" className="error">
              {actionError}
            </span>
          )}
        </div>
      )}
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
          {Boolean(detail.content.attachments?.length) && (
            <section className="attachments" aria-label="Attachments">
              <h3>Attachments</h3>
              <ul>
                {detail.content.attachments?.map((attachment) => (
                  <AttachmentItem
                    key={`${id}:${attachment.index}`}
                    message={id}
                    attachment={attachment}
                    configured={detail.content.configured}
                  />
                ))}
              </ul>
            </section>
          )}
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
