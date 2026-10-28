import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef, useState } from 'react';
import { plainHtml, removeRecovery, startDraft } from './draft-api.js';
import { navigateMail } from './mail-navigation.js';
import { useDraft } from './use-draft.js';

type Account = { id: string; name: string; username: string };
const safeLink = (value: string) => {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
};

function RichEditor({
  html,
  onChange,
}: {
  html: string;
  onChange: (html: string, text: string) => void;
}) {
  const [link, setLink] = useState('');
  const [error, setError] = useState('');
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        code: false,
        codeBlock: false,
        horizontalRule: false,
        underline: false,
        link: {
          openOnClick: false,
          autolink: false,
          linkOnPaste: false,
          protocols: ['https', 'http', 'mailto'],
          isAllowedUri: safeLink,
        },
      }),
    ],
    content: html,
    editorProps: {
      attributes: {
        role: 'textbox',
        'aria-label': 'Message body',
        'aria-multiline': 'true',
      },
      // Paste text only; remote images, arbitrary HTML and tracking URLs never
      // enter the app document. Formatting is applied through the editor schema.
      handlePaste(view, event) {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const { schema } = view.state;
        const paragraph = schema.nodes.paragraph;
        if (!paragraph) return true;
        const paragraphs = text
          .slice(0, 100000)
          .split(/\r?\n/)
          .map((line) =>
            paragraph.create(null, line ? schema.text(line) : null),
          );
        view.dispatch(
          view.state.tr.replaceSelection(
            new Slice(Fragment.fromArray(paragraphs), 0, 0),
          ),
        );
        return true;
      },
      handleDrop: () => true,
    },
    onUpdate: ({ editor: current }) =>
      onChange(current.getHTML(), current.getText({ blockSeparator: '\n' })),
  });
  const marks = useEditorState({
    editor,
    selector: ({ editor: current }) => ({
      bold: current?.isActive('bold') ?? false,
      italic: current?.isActive('italic') ?? false,
      strike: current?.isActive('strike') ?? false,
      bullet: current?.isActive('bulletList') ?? false,
      ordered: current?.isActive('orderedList') ?? false,
      quote: current?.isActive('blockquote') ?? false,
    }),
  });
  return (
    <div className="rich-editor">
      <fieldset className="editor-toolbar">
        <legend>Text formatting</legend>
        <button
          type="button"
          aria-pressed={marks?.bold}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          Bold
        </button>
        <button
          type="button"
          aria-pressed={marks?.italic}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          Italic
        </button>
        <button
          type="button"
          aria-pressed={marks?.strike}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          Strikethrough
        </button>
        <button
          type="button"
          aria-pressed={marks?.bullet}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          Bullet list
        </button>
        <button
          type="button"
          aria-pressed={marks?.ordered}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          Numbered list
        </button>
        <button
          type="button"
          aria-pressed={marks?.quote}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          Quote
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().undo().run()}
        >
          Undo typing
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().redo().run()}
        >
          Redo typing
        </button>
      </fieldset>
      <EditorContent editor={editor} />
      <div className="editor-links">
        <label>
          Link URL
          <input
            type="url"
            value={link}
            maxLength={2000}
            onChange={(event) => setLink(event.target.value)}
            placeholder="https://example.com"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            if (!safeLink(link.trim())) {
              setError('Use a complete http, https or mailto link.');
              return;
            }
            editor
              ?.chain()
              .focus()
              .extendMarkRange('link')
              .setLink({ href: link.trim() })
              .run();
            setError('');
            setLink('');
          }}
        >
          Apply link to selected text
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().unsetLink().run()}
        >
          Remove link
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <p className="account-status">
        Pasted content is plain text. Images and file attachments are not added
        to drafts yet.
      </p>
    </div>
  );
}

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
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copyError, setCopyError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  const value = draft.value;
  const close = () => navigateMail({ draft: '', view: 'drafts' });
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
        <button type="button" onClick={close}>
          Back to drafts
        </button>
      </section>
    );
  const content = value.content;
  const accountMissing =
    value.accountId &&
    !accounts.some((account) => account.id === value.accountId);
  return (
    <section className="composer" aria-labelledby="composer-heading">
      <h2 id="composer-heading" ref={heading} tabIndex={-1}>
        New message
      </h2>
      <p>
        Drafts are saved privately in Spindle. Sending and synchronization to
        your provider’s Drafts folder are coming later.
      </p>
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
            Another tab changed this draft, or it was removed. Choose how to
            keep your work.
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
              if (startDraft(user, value.accountId, value))
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
        <label key={field}>
          {field === 'to' ? 'To' : field === 'cc' ? 'Cc' : 'Bcc'}
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            maxLength={4000}
            value={content[field]}
            onChange={(event) =>
              draft.update({}, { [field]: event.target.value })
            }
          />
        </label>
      ))}
      <p className="account-status">
        Separate recipients with commas. Incomplete addresses can be saved while
        you compose.
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
        Switching to plain text removes formatting.
      </p>
      {content.format === 'rich' ? (
        <RichEditor
          key={draft.editorVersion}
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
            onChange={(event) => draft.update({}, { text: event.target.value })}
          />
        </label>
      )}
      <div className="account-actions">
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
