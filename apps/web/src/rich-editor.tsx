import { Fragment, Slice } from '@tiptap/pm/model';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useState } from 'react';

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
}: {
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
      <p className="account-status">Pasted content is plain text.</p>
    </div>
  );
}
