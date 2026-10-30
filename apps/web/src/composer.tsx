import { useEffect, useRef, useState } from 'react';
import { Icon } from './brand.js';
import { DateTimeInput, futureInstant, localTime } from './date-time.js';
import { plainHtml, removeRecovery, startDraft } from './draft-api.js';
import { DraftAttachments } from './draft-attachments.js';
import { ForwardPreview } from './forward-preview.js';
import {
  arrowDropDown,
  close as closeIcon,
  link as linkIcon,
  minimize,
  moreVert,
  openInFull,
  textFormat,
  trash,
} from './icons.js';
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

type Panel = 'schedule' | 'format' | 'link' | 'more';

// Gmail-style schedule presets in the browser's local time.
function quickTimes(now = new Date()): [string, Date][] {
  const at = (days: number, hour: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + days);
    date.setHours(hour, 0, 0, 0);
    return date;
  };
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    ['Tomorrow morning', at(1, 8)],
    ['Tomorrow afternoon', at(1, 13)],
    ['Monday morning', at(toMonday, 8)],
  ];
}

export function Composer({
  id,
  user,
  accounts,
  minimized = false,
  onMinimize,
}: {
  id: string;
  user: string;
  accounts: Account[];
  minimized?: boolean;
  onMinimize?: () => void;
}) {
  const draft = useDraft(user, id);
  const { conversation, schedule } = useMailLocation();
  // Only one toolbar panel is open at a time, like Gmail's compose window.
  const [panel, setPanel] = useState<Panel | null>(
    schedule ? 'schedule' : null,
  );
  const [ccOpen, setCcOpen] = useState(false);
  const [bccOpen, setBccOpen] = useState(false);
  const [attachSlot, setAttachSlot] = useState<HTMLElement | null>(null);
  // Pop-ups float above the toolbar so they never change the window's size.
  const [popoverLayer, setPopoverLayer] = useState<HTMLElement | null>(null);
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
  const saveStatus = {
    loading: 'Loading draft…',
    saved: 'Saved to Spindle.',
    unsaved: 'Unsaved changes…',
    saving: 'Saving draft…',
    failed: 'Draft not saved. Retrying automatically.',
    conflict: 'Draft conflict. Your edits are preserved.',
  }[draft.status];
  const saveAndClose = async () => {
    setBusy(true);
    if (await draft.flush()) close();
    setBusy(false);
  };
  // Gmail-style: optional rows stay hidden until needed (From only when there
  // is a choice); hidden inputs still hold their values.
  const showFrom =
    accounts.length !== 1 || !selectedAccount || Boolean(accountMissing);
  const showCc = ccOpen || Boolean(content.cc);
  const showBcc = bccOpen || Boolean(content.bcc);
  const toggle = (name: Panel) => setPanel(panel === name ? null : name);
  return (
    <section
      className={`composer${minimized ? ' minimized' : ''}`}
      aria-labelledby="composer-heading"
    >
      <header className="composer-head">
        <h2 id="composer-heading" ref={heading} tabIndex={-1}>
          {composeTitle}
          {content.subject && minimized ? `: ${content.subject}` : ''}
        </h2>
        <p role="status" aria-live="polite" className="save-status">
          {saveStatus}
        </p>
        {onMinimize && (
          <button
            type="button"
            className="icon-button small"
            aria-expanded={!minimized}
            title={minimized ? 'Expand' : 'Minimize'}
            onClick={onMinimize}
          >
            <Icon src={minimized ? openInFull : minimize} />
            <span className="visually-hidden">
              {minimized ? 'Expand composer' : 'Minimize composer'}
            </span>
          </button>
        )}
        <button
          type="button"
          className="icon-button small"
          title="Save & close"
          disabled={busy || draft.status === 'conflict'}
          onClick={() => void saveAndClose()}
        >
          <Icon src={closeIcon} />
          <span className="visually-hidden">Save and close</span>
        </button>
      </header>
      <div className="composer-card">
        <p className="visually-hidden">
          Drafts are saved privately in Spindle. Sending uses the selected
          account’s checked SMTP settings.
        </p>
        {draft.replyContext && (
          <div className="reply-context">
            {draft.replyContext.sourceMessageId && (
              <a
                href={mailHref({
                  message: draft.replyContext.sourceMessageId,
                  ...(conversation
                    ? { conversation }
                    : {
                        q: 'in:anywhere',
                        account: '',
                        mailbox: '',
                        cursor: '',
                      }),
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
            <p
              className={
                draft.replyContext.kind === 'replyAll'
                  ? undefined
                  : 'visually-hidden'
              }
            >
              Review To and Cc before sending, especially for mailing lists or
              aliases.
            </p>
          </div>
        )}
        <ProviderDraftStatus
          items={draft.providerSync}
          accountId={value.accountId}
          disabled={
            busy || draft.status === 'conflict' || Boolean(draft.outbox)
          }
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
          <p className="notice">
            <button type="button" onClick={() => void draft.save()}>
              Retry save
            </button>
          </p>
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
                <pre className="plain-message">
                  {draft.conflict.content.text}
                </pre>
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
          <p role="status" className="notice">
            A send request is unconfirmed. Recover its original request and
            delivery time before scheduling or sending another copy.{' '}
            <button type="button" disabled={busy} onClick={() => void send()}>
              Recover send request
            </button>
          </p>
        )}
        {value.accountId && selectedAccount?.smtpState !== 'ready' && (
          <p className="notice">
            Configure outgoing SMTP for this account before sending.
          </p>
        )}
        {selectedAccount?.smtpState === 'ready' && (
          <p className="visually-hidden">
            From:{' '}
            {selectedAccount.senderName
              ? `${selectedAccount.senderName} <${selectedAccount.sender}>`
              : selectedAccount.sender}
          </p>
        )}
        <fieldset disabled={busy} className="composer-fields">
          <label className="compose-row" hidden={!showFrom}>
            <span aria-hidden="true">From</span>
            <span className="visually-hidden">Sending account</span>
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
          <div className="compose-recipients">
            <RecipientInput
              label="To"
              value={content.to}
              values={[content.to, content.cc, content.bcc]}
              field={0}
              account={value.accountId}
              onChange={(next) => draft.update({}, { to: next })}
            />
            <span className="recipient-toggles">
              {!showCc && (
                <button
                  type="button"
                  className="text-toggle"
                  aria-label="Add Cc recipients"
                  onClick={() => setCcOpen(true)}
                >
                  Cc
                </button>
              )}
              {!showBcc && (
                <button
                  type="button"
                  className="text-toggle"
                  aria-label="Add Bcc recipients"
                  onClick={() => setBccOpen(true)}
                >
                  Bcc
                </button>
              )}
            </span>
          </div>
          <div hidden={!showCc}>
            <RecipientInput
              label="Cc"
              value={content.cc}
              values={[content.to, content.cc, content.bcc]}
              field={1}
              account={value.accountId}
              onChange={(next) => draft.update({}, { cc: next })}
            />
          </div>
          <div hidden={!showBcc}>
            <RecipientInput
              label="Bcc"
              value={content.bcc}
              values={[content.to, content.cc, content.bcc]}
              field={2}
              account={value.accountId}
              onChange={(next) => draft.update({}, { bcc: next })}
            />
          </div>
          <p className="visually-hidden">
            Separate recipients with commas. Incomplete addresses can be saved
            while you compose.
          </p>
          <label className="compose-row subject">
            <span className="visually-hidden">Subject</span>
            <input
              type="text"
              maxLength={1000}
              placeholder="Subject"
              value={content.subject}
              onChange={(event) =>
                draft.update({}, { subject: event.target.value })
              }
            />
          </label>
          {content.format === 'rich' ? (
            <RichEditor
              key={draft.editorVersion}
              disabled={busy}
              html={content.html}
              showFormatting={panel === 'format'}
              showLink={panel === 'link'}
              onLinkDone={() => setPanel(null)}
              toolsTarget={popoverLayer}
              onChange={(html, text) => draft.update({}, { html, text })}
            />
          ) : (
            <label className="compose-body">
              <span className="visually-hidden">Message body</span>
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
          pickerSlot={attachSlot}
        />
        <div className="composer-actions">
          <span className="send-split">
            <button
              type="button"
              className="filled"
              disabled={cannotSend || panel === 'schedule' || unconfirmed}
              onClick={() => void send()}
            >
              Send
            </button>
            <button
              type="button"
              className="filled"
              title="Schedule send"
              disabled={cannotSend || unconfirmed}
              aria-expanded={panel === 'schedule'}
              onClick={() => toggle('schedule')}
            >
              <Icon src={arrowDropDown} />
              <span className="visually-hidden">Send later</span>
            </button>
          </span>
          {content.format === 'rich' && (
            <>
              <button
                type="button"
                className="icon-button"
                title="Formatting options"
                aria-expanded={panel === 'format'}
                onClick={() => toggle('format')}
              >
                <Icon src={textFormat} />
                <span className="visually-hidden">Formatting options</span>
              </button>
              <button
                type="button"
                className="icon-button"
                title="Insert link"
                aria-expanded={panel === 'link'}
                onClick={() => toggle('link')}
              >
                <Icon src={linkIcon} />
                <span className="visually-hidden">Insert link</span>
              </button>
            </>
          )}
          <span className="attach-slot" ref={setAttachSlot} />
          <button
            type="button"
            className="icon-button"
            title="More options"
            aria-expanded={panel === 'more'}
            onClick={() => toggle('more')}
          >
            <Icon src={moreVert} />
            <span className="visually-hidden">More options</span>
          </button>
          <span className="toolbar-spacer" />
          <button
            type="button"
            className="icon-button"
            title="Discard draft"
            disabled={busy || draft.status === 'conflict'}
            onClick={() => setConfirmDiscard(true)}
          >
            <Icon src={trash} />
            <span className="visually-hidden">Discard draft</span>
          </button>
        </div>
      </div>
      {!minimized && (
        <div className="compose-popovers" ref={setPopoverLayer}>
          {panel === 'schedule' && (
            <form
              className="popover compose-popover schedule"
              aria-label="Schedule send"
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  void send(futureInstant(sendTime));
                } catch (error) {
                  setSendError((error as Error).message);
                }
              }}
            >
              <p className="popover-title">Schedule send</p>
              <ul className="quick-times">
                {quickTimes().map(([label, at]) => (
                  <li key={label}>
                    <button
                      type="button"
                      disabled={cannotSend || unconfirmed}
                      onClick={() => void send(at.toISOString())}
                    >
                      <span>{label}</span>
                      <span className="muted">
                        {at.toLocaleString(undefined, {
                          weekday: 'short',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="pick-time">
                <DateTimeInput
                  label="Send at"
                  value={sendTime}
                  onChange={setSendTime}
                  compact
                />
              </div>
              <p className="visually-hidden">
                The saved message and attachments will be frozen in Outbox until
                dispatch. You can reschedule or cancel and edit there.
              </p>
              <div className="form-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy || unconfirmed}
                  aria-label="Cancel scheduling"
                  onClick={() => setPanel(null)}
                >
                  Cancel
                </button>
                <button type="submit" disabled={cannotSend || unconfirmed}>
                  Schedule send
                </button>
              </div>
            </form>
          )}
          {panel === 'more' && (
            <div className="popover compose-popover more">
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
                    setPanel(null);
                  }}
                >
                  <option value="rich">Rich text</option>
                  <option value="plain">Plain text</option>
                </select>
              </label>
              <p className="muted small">
                Switching to plain text removes formatting
                {draft.forwarded
                  ? ' from the note and forwarded original when sending'
                  : ''}
                .
              </p>
            </div>
          )}
          {confirmDiscard && (
            <fieldset className="popover compose-popover confirm-discard">
              <legend>Confirm discard</legend>
              <p>Discard this draft and its text permanently?</p>
              <div className="form-actions">
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => setConfirmDiscard(false)}
                >
                  Keep editing
                </button>
                <button
                  type="button"
                  className="filled"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    if (await draft.discard()) close();
                    setBusy(false);
                  }}
                >
                  Confirm discard draft
                </button>
              </div>
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
