import { useEffect, useRef, useState } from 'react';
import {
  actionText,
  type MailAction,
  MailApiError,
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
    replyHeaders: 'missing' | 'pending' | 'ready' | 'failed';
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
  query = '',
  account,
  mailbox,
  folders,
  onChange,
  onAction,
  actionRevision,
  userId,
}: {
  id: string;
  query?: string;
  account: string;
  mailbox: string;
  folders: { id: string; accountId: string; path: string }[];
  onChange: () => void;
  onAction: (action: Undoable) => void;
  actionRevision: number;
  userId: string;
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
  const [responseBusy, setResponseBusy] = useState(false);
  const responseIds = useRef(new Map<string, string>());
  const responseActive = useRef(true);
  useEffect(() => {
    responseActive.current = true;
    return () => {
      responseActive.current = false;
    };
  }, []);
  const [destination, setDestination] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const imageRequest = useRef<AbortController | null>(null);
  const params = new URLSearchParams();
  if (account) params.set('account', account);
  if (mailbox) params.set('mailbox', mailbox);
  if (query) params.set('q', query);
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
    return () => {
      controller.abort();
      imageRequest.current?.abort();
      if (timer) clearTimeout(timer);
    };
  }, [id, endpoint, attempt]);

  useEffect(() => {
    if (detail?.message.id) heading.current?.focus();
  }, [detail?.message.id]);

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
    if (!pendingAction && !actionRevision) return;
    const controller = new AbortController();
    async function poll() {
      try {
        const current = await mailApi<Detail>(endpoint, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setDetail((value) =>
          value ? { ...value, message: current.message } : value,
        );
        if (pendingAction && current.message.lastAction?.state !== 'pending')
          onChange();
      } catch {
        // The interval keeps polling while the action is pending.
      }
    }
    void poll();
    const timer = pendingAction
      ? setInterval(() => void poll(), 1500)
      : undefined;
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [pendingAction, endpoint, onChange, actionRevision]);

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
      if (!responseActive.current) return;
      let leftView = kind !== 'read' && kind !== 'unread';
      if (!leftView && query) {
        try {
          await mailApi<Detail>(endpoint);
        } catch (failure) {
          if (failure instanceof MailApiError && failure.status === 404)
            leftView = true;
          else throw failure;
        }
      }
      if (!responseActive.current) return;
      if (leftView) {
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

  async function respond(kind: 'reply' | 'replyAll' | 'forward') {
    setResponseBusy(true);
    setActionError('');
    const key = `spindle:respond:${userId}:${id}:${kind}`;
    let operation = responseIds.current.get(key);
    try {
      operation ??= sessionStorage.getItem(key) || undefined;
    } catch {
      /* Server draft creation still works without browser storage. */
    }
    operation ??= crypto.randomUUID();
    responseIds.current.set(key, operation);
    try {
      sessionStorage.setItem(key, operation);
    } catch {
      /* The in-memory ID still protects retries. */
    }
    const clear = () => {
      try {
        if (sessionStorage.getItem(key) === operation)
          sessionStorage.removeItem(key);
      } catch {
        /* Storage may be disabled. */
      }
      responseIds.current.delete(key);
    };
    try {
      const deadline = Date.now() + 60000;
      while (responseActive.current) {
        const result = await mailApi<
          { draft: { id: string } } | { state: 'preparing' }
        >(`messages/${id}/compose`, {
          method: 'POST',
          body: JSON.stringify({ id: operation, kind }),
        });
        if ('draft' in result) {
          clear();
          if (responseActive.current)
            navigateMail({
              draft: result.draft.id,
              view: 'drafts',
              message: '',
            });
          return;
        }
        for (;;) {
          if (!responseActive.current) return;
          if (Date.now() >= deadline)
            throw new Error(
              'Headers are still being fetched. Try this response again shortly.',
            );
          await new Promise((resolve) => setTimeout(resolve, 1500));
          if (!responseActive.current) return;
          const current = await mailApi<Detail>(endpoint);
          if (current.content.replyHeaders === 'ready') break;
          if (current.content.replyHeaders === 'failed')
            throw new Error(
              'Unable to fetch response headers. The cached message is still available. Try again when the provider is reachable.',
            );
          if (current.content.state !== 'ready')
            throw new Error(
              'Reload the original message before preparing a response.',
            );
        }
      }
    } catch (failure) {
      if (failure instanceof MailApiError && failure.status < 500) clear();
      if (responseActive.current)
        setActionError(
          failure instanceof Error
            ? failure.message
            : 'Unable to prepare this response.',
        );
    } finally {
      if (responseActive.current) setResponseBusy(false);
    }
  }

  async function showHtml() {
    setView('html');
    await displayImages(images);
  }

  return (
    <section className="reader" aria-labelledby="reader-title">
      <nav className="reader-navigation" aria-label="Message navigation">
        <a data-mail-command="back" href={mailHref({ message: '' })}>
          Back to message list
        </a>
        {detail?.previous ? (
          <a
            data-mail-command="previous"
            href={mailHref({ message: detail.previous })}
          >
            Previous message
          </a>
        ) : (
          <button type="button" disabled>
            Previous message
          </button>
        )}
        {detail?.next ? (
          <a data-mail-command="next" href={mailHref({ message: detail.next })}>
            Next message
          </a>
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
            disabled={responseBusy || detail.content.state !== 'ready'}
            data-mail-command="reply"
            onClick={() => void respond('reply')}
          >
            Reply
          </button>
          <button
            type="button"
            disabled={responseBusy || detail.content.state !== 'ready'}
            data-mail-command="reply-all"
            onClick={() => void respond('replyAll')}
          >
            Reply all
          </button>
          <button
            type="button"
            disabled={responseBusy || detail.content.state !== 'ready'}
            data-mail-command="forward"
            onClick={() => void respond('forward')}
          >
            Forward
          </button>
          {responseBusy && <span role="status">Preparing response…</span>}
          <button
            type="button"
            disabled={pendingAction}
            data-mail-command="toggle"
            onClick={() => void mark(detail.message.unread ? 'read' : 'unread')}
          >
            {detail.message.unread ? 'Mark as read' : 'Mark as unread'}
          </button>
          <button
            type="button"
            disabled={pendingAction || !detail.message.canMove?.archive}
            data-mail-command="archive"
            onClick={() => void mark('archive')}
          >
            Archive
          </button>
          <button
            type="button"
            disabled={pendingAction || !detail.message.canMove?.trash}
            data-mail-command="trash"
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
          {(lastAction?.state === 'failed' ||
            lastAction?.state === 'conflict') && (
            <span role="alert" className="error">
              {lastAction.error ?? 'The provider did not confirm this action.'}{' '}
              See Recent actions for its status and available controls.
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
