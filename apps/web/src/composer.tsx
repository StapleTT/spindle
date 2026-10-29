import { useEffect, useRef, useState } from 'react';
import { DateTimeInput, futureInstant, localTime } from './date-time.js';
import { plainHtml, removeRecovery, startDraft } from './draft-api.js';
import { DraftAttachments } from './draft-attachments.js';
import { ForwardPreview } from './forward-preview.js';
import { MailApiError, mailApi } from './mail-api.js';
import { mailHref, navigateMail, useMailLocation } from './mail-navigation.js';
import { ProviderDraftStatus } from './provider-draft-status.js';
import { RecipientInput } from './recipient-input.js';
import { RichEditor } from './rich-editor.js';
import { useDraft } from './use-draft.js';

type Account = {
  id: string;
  name: string;
  username: string;
  smtpState?: string | null;
  sender?: string | null;
  senderName?: string | null;
};

export function Composer({
  id,
  user,
  accounts,
}: {
  id: string;
  user: string;
  accounts: Account[];
}) {
  const draft = useDraft(user, id);
  const { conversation, schedule } = useMailLocation();
  const [scheduling, setScheduling] = useState(Boolean(schedule));
  const [sendTime, setSendTime] = useState(() =>
    localTime(new Date(schedule || Date.now() + 3600000)),
  );
  const cacheKey = `spindle:send:${user}:${id}`;
  const [unconfirmed, setUnconfirmed] = useState(() => {
    try {
      return Boolean(sessionStorage.getItem(cacheKey));
    } catch {
      return false;
    }
  });
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState('');
  const [copyError, setCopyError] = useState('');
  const [attachmentsReady, setAttachmentsReady] = useState(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const value = draft.value;
  const close = () =>
    navigateMail({ draft: '', view: 'drafts', conversation: '' });
  if (!value)
    return (
      <section aria-label="Composer">
        <h2 ref={heading} tabIndex={-1}>
          New message
        </h2>
        <p role="status">
          {draft.status === 'loading' ? 'Loading draft…' : draft.error}
        </p>
        {draft.status === 'failed' && (
          <button type="button" onClick={() => window.location.reload()}>
            Retry loading draft
          </button>
        )}
        {unconfirmed && (
          <button type="button" disabled={busy} onClick={() => void send()}>
            Recover send request
          </button>
        )}
        {sendError && <p role="alert">{sendError}</p>}
        <button type="button" onClick={close}>
          Back to drafts
        </button>
      </section>
    );
  async function send(scheduledAt?: string) {
    setBusy(true);
    setSendError('');
    try {
      let operation: {
        id: string;
        revision: number;
        scheduledAt?: string;
      } | null = JSON.parse(sessionStorage.getItem(cacheKey) ?? 'null');
      if (!operation) {
        if (!(await draft.flush())) return;
        operation = {
          id: crypto.randomUUID(),
          revision: draft.currentRevision(),
          ...(scheduledAt ? { scheduledAt } : {}),
        };
        sessionStorage.setItem(cacheKey, JSON.stringify(operation));
      }
      setUnconfirmed(true);
      const result = await mailApi<{ outbox: { state: string } }>(
        `drafts/${id}/send`,
        { method: 'POST', body: JSON.stringify(operation) },
      );
      sessionStorage.removeItem(cacheKey);
      setUnconfirmed(false);
      if (result.outbox.state === 'cancelled') {
        setSendError(
          'The previous send was cancelled. Review your draft before sending again.',
        );
        return;
      }
      navigateMail({ draft: '', view: 'outbox', message: '' });
    } catch (error) {
      if (error instanceof MailApiError && error.status < 500) {
        sessionStorage.removeItem(cacheKey);
        setUnconfirmed(false);
      }
      setSendError(
        error instanceof Error
          ? error.message
          : 'Unable to queue this message. Your draft is preserved.',
      );
    } finally {
      setBusy(false);
    }
  }
  const selectedAccount = accounts.find(
    (account) => account.id === value.accountId,
  );
  const composeTitle = draft.replyContext
    ? {
        reply: 'Reply',
        replyAll: 'Reply all',
        forward: 'Forward',
        copy: 'Recovered draft copy',
      }[draft.replyContext.kind]
    : 'New message';
  const content = value.content;
  const accountMissing =
    value.accountId &&
    !accounts.some((account) => account.id === value.accountId);
  const cannotSend =
    busy ||
    Boolean(draft.outbox) ||
    !attachmentsReady ||
    draft.providerSync.some(
      (item) =>
        item.accountId === value.accountId &&
        ['conflict', 'unknown'].includes(item.state),
    ) ||
    draft.status === 'conflict' ||
    selectedAccount?.smtpState !== 'ready';
  return (
    <section className="composer" aria-labelledby="composer-heading">
      <h2 id="composer-heading" ref={heading} tabIndex={-1}>
        {composeTitle}
      </h2>
      {draft.replyContext && (
        <div className="reply-context">
          {draft.replyContext.sourceMessageId && (
            <a
              href={mailHref({
                message: draft.replyContext.sourceMessageId,
                ...(conversation
                  ? { conversation }
                  : { q: 'in:anywhere', account: '', mailbox: '', cursor: '' }),
              })}
            >
              Back to original message
            </a>
          )}
          {draft.replyContext.warnings.map((warning) => (
            <p key={warning} role="status">
              {warning}
            </p>
          ))}
          <p>
            Review To and Cc before sending, especially for mailing lists or
            aliases.
          </p>
        </div>
      )}
      <p>
        Drafts are saved privately in Spindle. Sending uses the selected
        account’s checked SMTP settings.
      </p>
      <ProviderDraftStatus
        items={draft.providerSync}
        accountId={value.accountId}
        disabled={busy || draft.status === 'conflict' || Boolean(draft.outbox)}
        onResolve={async (id, action) => {
          setBusy(true);
          setSendError('');
          try {
            if (!(await draft.flush())) return;
            await mailApi(`draft-sync/${id}`, {
              method: 'POST',
              body: JSON.stringify({
                action,
                revision: draft.currentRevision(),
              }),
            });
            await draft.loadSaved();
          } catch (error) {
            setSendError(
              error instanceof Error
                ? error.message
                : 'Unable to resolve provider draft.',
            );
          } finally {
            setBusy(false);
          }
        }}
      />
      <p role="status" aria-live="polite">
        {
          {
            loading: 'Loading draft…',
            saved: 'Saved to Spindle.',
            unsaved: 'Unsaved changes…',
            saving: 'Saving draft…',
            failed: 'Draft not saved. Retrying automatically.',
            conflict: 'Draft conflict. Your edits are preserved.',
          }[draft.status]
        }
      </p>
      {draft.recoveryFailed && (
        <p role="alert" className="error">
          Browser recovery storage is unavailable or full. Keep this page open
          until the draft says Saved.
        </p>
      )}
      {draft.error && (
        <p role="alert" className="error">
          {draft.error}
        </p>
      )}
      {draft.status === 'failed' && (
        <button type="button" onClick={() => void draft.save()}>
          Retry save
        </button>
      )}
      {draft.status === 'conflict' && (
        <div className="notice">
          <p>
            The saved draft changed or was removed. Choose how to keep your
            work.
          </p>
          {draft.conflict && (
            <details>
              <summary>Compare saved version</summary>
              <p>{draft.conflict.content.subject || '(No subject)'}</p>
              <pre className="plain-message">{draft.conflict.content.text}</pre>
            </details>
          )}
          <button
            type="button"
            onClick={() => {
              if (startDraft(user, value.accountId, { ...value, copyOf: id }))
                removeRecovery(user, id);
              else
                setCopyError(
                  'Unable to keep a recovery copy in this browser. Your edits remain here; free storage before trying again.',
                );
            }}
          >
            Save my edits as a new draft
          </button>
          {draft.conflict && (
            <button type="button" onClick={() => void draft.loadSaved()}>
              Discard my edits and load saved version
            </button>
          )}
          {copyError && <p role="alert">{copyError}</p>}
        </div>
      )}
      {draft.outbox && (
        <p className="notice">
          This draft is in Outbox. Sending may already have started.{' '}
          <a href={mailHref({ view: 'outbox', draft: '', message: '' })}>
            Review Outbox before making another copy.
          </a>
        </p>
      )}
      {sendError && (
        <p role="alert" className="error">
          <span>{sendError}</span>{' '}
          <a href={mailHref({ view: 'outbox', draft: '', message: '' })}>
            Review Outbox
          </a>
        </p>
      )}
      {unconfirmed && (
        <p role="status">
          A send request is unconfirmed. Recover its original request and
          delivery time before scheduling or sending another copy.{' '}
          <button type="button" disabled={busy} onClick={() => void send()}>
            Recover send request
          </button>
        </p>
      )}
      <fieldset disabled={busy} className="composer-fields">
        <label>
          Sending account
          <select
            value={value.accountId ?? ''}
            onChange={(event) =>
              draft.update({ accountId: event.target.value || null })
            }
          >
            <option value="">No account selected</option>
            {accountMissing && (
              <option value={value.accountId ?? ''}>
                Unavailable account — choose another
              </option>
            )}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} ({account.username})
              </option>
            ))}
          </select>
        </label>
        {(['to', 'cc', 'bcc'] as const).map((field) => (
          <RecipientInput
            key={field}
            label={field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'}
            value={content[field]}
            values={[content.to, content.cc, content.bcc]}
            field={['to', 'cc', 'bcc'].indexOf(field)}
            account={value.accountId}
            onChange={(next) => draft.update({}, { [field]: next })}
          />
        ))}
        <p className="account-status">
          Separate recipients with commas. Incomplete addresses can be saved
          while you compose.
        </p>
        <label>
          Subject
          <input
            type="text"
            maxLength={1000}
            value={content.subject}
            onChange={(event) =>
              draft.update({}, { subject: event.target.value })
            }
          />
        </label>
        <label>
          Message format
          <select
            value={content.format}
            onChange={(event) => {
              const format = event.target.value as 'rich' | 'plain';
              draft.update(
                {},
                {
                  format,
                  html: format === 'rich' ? plainHtml(content.text) : '',
                },
              );
            }}
          >
            <option value="rich">Rich text</option>
            <option value="plain">Plain text</option>
          </select>
        </label>
        <p className="account-status">
          Switching to plain text removes formatting
          {draft.forwarded
            ? ' from the note and forwarded original when sending'
            : ''}
          .
        </p>
        {content.format === 'rich' ? (
          <RichEditor
            key={draft.editorVersion}
            disabled={busy}
            html={content.html}
            onChange={(html, text) => draft.update({}, { html, text })}
          />
        ) : (
          <label>
            Message body
            <textarea
              rows={12}
              maxLength={100000}
              value={content.text}
              onChange={(event) =>
                draft.update({}, { text: event.target.value })
              }
            />
          </label>
        )}
        {draft.forwarded &&
          (content.format === 'rich' ? (
            <ForwardPreview
              key={draft.editorVersion}
              id={id}
              text={draft.forwarded.text}
              imageCount={draft.forwarded.imageCount}
              origin={draft.forwarded.origin}
            />
          ) : (
            <section aria-label="Forwarded original">
              <h3>Forwarded original</h3>
              <pre className="plain-message">{draft.forwarded.text}</pre>
            </section>
          ))}
      </fieldset>
      <DraftAttachments
        ids={value.attachmentIds ?? []}
        onChange={(attachmentIds) => draft.update({ attachmentIds })}
        onReady={setAttachmentsReady}
        disabled={busy || Boolean(draft.outbox)}
      />
      {selectedAccount?.smtpState === 'ready' ? (
        <p>
          From:{' '}
          {selectedAccount.senderName
            ? `${selectedAccount.senderName} <${selectedAccount.sender}>`
            : selectedAccount.sender}
        </p>
      ) : (
        <p>Configure outgoing SMTP for this account before sending.</p>
      )}
      <div className="account-actions">
        <button
          type="button"
          disabled={cannotSend || scheduling || unconfirmed}
          onClick={() => void send()}
        >
          Send
        </button>
        <button
          type="button"
          disabled={cannotSend || unconfirmed}
          aria-expanded={scheduling}
          onClick={() => setScheduling(!scheduling)}
        >
          Send later
        </button>

        <button
          type="button"
          disabled={busy || draft.status === 'conflict'}
          onClick={async () => {
            setBusy(true);
            if (await draft.flush()) close();
            setBusy(false);
          }}
        >
          Save and close
        </button>
        <button
          type="button"
          disabled={busy || draft.status === 'conflict'}
          onClick={() => setConfirmDiscard(true)}
        >
          Discard draft
        </button>
      </div>
      {scheduling && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            try {
              void send(futureInstant(sendTime));
            } catch (error) {
              setSendError((error as Error).message);
            }
          }}
        >
          <DateTimeInput
            label="Send at"
            value={sendTime}
            onChange={setSendTime}
          />
          <p>
            The saved message and attachments will be frozen in Outbox until
            dispatch. You can reschedule or cancel and edit there.
          </p>
          <button type="submit" disabled={cannotSend || unconfirmed}>
            Schedule send
          </button>{' '}
          <button
            type="button"
            disabled={busy || unconfirmed}
            onClick={() => setScheduling(false)}
          >
            Cancel scheduling
          </button>
        </form>
      )}
      {confirmDiscard && (
        <fieldset className="notice">
          <legend>Confirm discard</legend>
          <p>Discard this draft and its text permanently?</p>
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              if (await draft.discard()) close();
              setBusy(false);
            }}
          >
            Confirm discard draft
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setConfirmDiscard(false)}
          >
            Keep editing
          </button>
        </fieldset>
      )}
    </section>
  );
}
