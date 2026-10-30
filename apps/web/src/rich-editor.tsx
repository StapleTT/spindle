import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './brand.js';
import {
  formatBold,
  formatItalic,
  formatListBulleted,
  formatListNumbered,
  formatQuote,
  formatStrikethrough,
  redo,
  undo,
} from './icons.js';

const safeLink = (value: string) => {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
};

export function RichEditor({
  html,
  onChange,
  disabled,
  label = 'Message body',
  showFormatting = true,
  showLink = true,
  onLinkDone,
  toolsTarget,
}: {
  // When set, the formatting bar and link row render there as pop-ups.
  toolsTarget?: HTMLElement | null;
  showFormatting?: boolean;
  showLink?: boolean;
  onLinkDone?: () => void;
  html: string;
  label?: string;
  disabled: boolean;
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
        'aria-label': label,
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
  useEffect(() => {
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);
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
  const tools = (
    <>
      <fieldset className="editor-toolbar" hidden={!showFormatting}>
        <legend className="visually-hidden">Text formatting</legend>
        <button
          type="button"
          aria-pressed={marks?.bold}
          onClick={() => editor?.chain().focus().toggleBold().run()}
        >
          <Icon src={formatBold} />
          <span className="visually-hidden">Bold</span>
        </button>
        <button
          type="button"
          aria-pressed={marks?.italic}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
        >
          <Icon src={formatItalic} />
          <span className="visually-hidden">Italic</span>
        </button>
        <button
          type="button"
          aria-pressed={marks?.strike}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
        >
          <Icon src={formatStrikethrough} />
          <span className="visually-hidden">Strikethrough</span>
        </button>
        <button
          type="button"
          aria-pressed={marks?.bullet}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
        >
          <Icon src={formatListBulleted} />
          <span className="visually-hidden">Bullet list</span>
        </button>
        <button
          type="button"
          aria-pressed={marks?.ordered}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
        >
          <Icon src={formatListNumbered} />
          <span className="visually-hidden">Numbered list</span>
        </button>
        <button
          type="button"
          aria-pressed={marks?.quote}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
        >
          <Icon src={formatQuote} />
          <span className="visually-hidden">Quote</span>
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().undo().run()}
        >
          <Icon src={undo} />
          <span className="visually-hidden">Undo typing</span>
        </button>
        <button
          type="button"
          onClick={() => editor?.chain().focus().redo().run()}
        >
          <Icon src={redo} />
          <span className="visually-hidden">Redo typing</span>
        </button>
      </fieldset>
      <div className="editor-links" hidden={!showLink}>
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
            onLinkDone?.();
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
    </>
  );
  return (
    <div className="rich-editor">
      {toolsTarget ? createPortal(tools, toolsTarget) : tools}
      <EditorContent editor={editor} />
      {showFormatting && !toolsTarget && (
        <p className="account-status">Pasted content is plain text.</p>
      )}
    </div>
  );
}
