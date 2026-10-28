import { type RefObject, useEffect, useRef, useState } from 'react';
export const typingTarget = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  !!target.closest(
    'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"]',
  );
const commands = [
  ['search', 'Search mail', '/'],
  ['compose', 'Compose', 'c'],
  ['open', 'Open focused message', 'o'],
  ['next', 'Next message / list row', 'j'],
  ['previous', 'Previous message / list row', 'k'],
  ['back', 'Back to message list', 'u'],
  ['toggle', 'Toggle read/unread', 'm'],
  ['archive', 'Archive', 'e'],
  ['trash', 'Move to Trash', '#'],
  ['reply', 'Reply', 'r'],
  ['reply-all', 'Reply all', 'a'],
  ['forward', 'Forward', 'f'],
  ['undo', 'Undo latest available action', 'z'],
  ['select', 'Toggle selected row', 'x'],
  ['older', 'Older list page', 'n'],
  ['newest', 'Newest list page', 'p'],
  ['inbox', 'Unified inbox', ''],
  ['drafts', 'Local drafts', ''],
  ['outbox', 'Outbox', ''],
] as const;
export function KeyboardTriage({
  root,
}: {
  root: RefObject<HTMLElement | null>;
}) {
  const [open, setOpen] = useState(false),
    [filter, setFilter] = useState('');
  const dialog = useRef<HTMLDialogElement>(null),
    returnFocus = useRef<HTMLElement | null>(null),
    lastRow = useRef<HTMLElement | null>(null);
  function contextRow() {
    const origin = open ? returnFocus.current : document.activeElement;
    const row = origin?.closest<HTMLElement>('[data-message-row]');
    return row && root.current?.contains(row) ? row : null;
  }
  function element(command: string) {
    const node = root.current;
    if (!node) return null;
    if (command === 'open')
      return (
        (lastRow.current && node.contains(lastRow.current)
          ? lastRow.current
          : node.querySelector<HTMLElement>('[data-message-row]')
        )?.querySelector<HTMLElement>('.message-open') ?? null
      );
    const reader = node.querySelector('.reader');
    if (
      ['toggle', 'archive', 'trash', 'reply', 'reply-all', 'forward'].includes(
        command,
      )
    )
      return (
        (
          contextRow() ??
          reader ??
          (lastRow.current && node.contains(lastRow.current)
            ? lastRow.current
            : null)
        )?.querySelector<HTMLElement>(`[data-mail-command="${command}"]`) ??
        null
      );
    if (command === 'select')
      return (
        (lastRow.current && node.contains(lastRow.current)
          ? lastRow.current
          : null
        )?.querySelector<HTMLElement>('[data-mail-command="select"]') ?? null
      );
    return node.querySelector<HTMLElement>(`[data-mail-command="${command}"]`);
  }
  function perform(command: string) {
    const node = root.current;
    if (!node) return;
    if (
      (command === 'next' || command === 'previous') &&
      (!node.querySelector('.reader') || contextRow())
    ) {
      const rows = Array.from(
        node.querySelectorAll<HTMLElement>('[data-message-row]'),
      );
      if (!rows.length) return;
      const index = rows.indexOf(lastRow.current as HTMLElement);
      const next =
        index < 0
          ? 0
          : Math.max(
              0,
              Math.min(rows.length - 1, index + (command === 'next' ? 1 : -1)),
            );
      rows[next]?.querySelector<HTMLElement>('.message-open')?.focus();
      return;
    }
    const target = element(command);
    if (!target || target.matches(':disabled')) return;
    if (command === 'search') target.focus();
    else target.click();
  }
  function show() {
    returnFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setFilter('');
    setOpen(true);
  }
  // Commands always use the current rendered controls, including their disabled states.
  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const row =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-message-row]')
          : null;
      if (row) lastRow.current = row;
    };
    const key = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target !== document.body &&
        !root.current?.contains(event.target)
      )
        return;
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        typingTarget(event.target) ||
        open ||
        (event.target instanceof Element && event.target.closest('dialog'))
      )
        return;
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === 'k' &&
        !event.altKey
      ) {
        event.preventDefault();
        show();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === '?') {
        event.preventDefault();
        show();
        return;
      }
      const command = commands.find((item) => item[2] === event.key);
      if (!command || (event.repeat && !['j', 'k'].includes(event.key))) return;
      if (
        ['r', 'a', 'f'].includes(event.key) &&
        !root.current?.querySelector('.reader')
      )
        return;
      event.preventDefault();
      perform(command[0]);
    };
    root.current?.addEventListener('focusin', remember);
    window.addEventListener('keydown', key);
    const node = root.current;
    return () => {
      node?.removeEventListener('focusin', remember);
      window.removeEventListener('keydown', key);
    };
  });
  useEffect(() => {
    if (open) {
      dialog.current?.showModal();
      dialog.current?.querySelector('input')?.focus();
    } else dialog.current?.close();
  }, [open]);
  function close() {
    dialog.current?.close();
    setOpen(false);
    if (returnFocus.current?.isConnected) returnFocus.current.focus();
  }
  const filtered = commands.filter((item) =>
    item[1].toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <>
      <button type="button" onClick={show}>
        Commands and keyboard shortcuts
      </button>
      <dialog
        ref={dialog}
        aria-labelledby="commands-title"
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
          const buttons = Array.from(
            dialog.current?.querySelectorAll<HTMLButtonElement>(
              '[data-command-option]:not(:disabled)',
            ) ?? [],
          );
          if (!buttons.length) return;
          event.preventDefault();
          const index = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          buttons[
            (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }}
      >
        <h2 id="commands-title">Commands and keyboard shortcuts</h2>
        <p>
          Shortcuts pause in inputs, editors and while composing with an IME.
          j/k select rows on the current page; n/p change list pages. Opening
          mail does not mark it read.
        </p>
        <label>
          Find a command
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <ul>
          {filtered.map(([command, label, key]) => (
            <li key={command}>
              <button
                type="button"
                data-command-option
                disabled={
                  (!['next', 'previous'].includes(command) &&
                    !element(command)) ||
                  element(command)?.matches(':disabled')
                }
                onClick={() => {
                  close();
                  perform(command);
                }}
              >
                {label}
                {key ? ` — ${key}` : ''}
              </button>
            </li>
          ))}
        </ul>
        <button type="button" onClick={close}>
          Close commands
        </button>
      </dialog>
    </>
  );
}
