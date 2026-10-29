import { useEffect, useId, useRef, useState } from 'react';
import { mailApi } from './mail-api.js';
import { useMailRevision } from './mail-events.js';
import {
  type Contact,
  enteredRecipients,
  insertRecipient,
  recipientPart,
} from './recipient-addresses.js';

export function RecipientInput({
  label,
  value,
  values,
  field,
  account,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  field: number;
  account: string | null;
  onChange: (value: string) => void;
}) {
  const liveRevision = useMailRevision(['mail', 'accounts']);
  const input = useRef<HTMLInputElement>(null),
    id = useId(),
    generation = useRef(0);
  const [caret, setCaret] = useState({ start: 0, end: 0 }),
    [focused, setFocused] = useState(false),
    [dismissed, setDismissed] = useState(false),
    [composing, setComposing] = useState(false),
    [active, setActive] = useState(-1);
  const [result, setResult] = useState<{
    key: string;
    contacts: Contact[];
    limited: boolean;
    error: boolean;
  }>({ key: '', contacts: [], limited: false, error: false });
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const part = recipientPart(value, caret.start, caret.end),
    query = part?.query ?? '';
  const key = JSON.stringify([query, account, liveRevision]);
  useEffect(() => {
    const requested = ++generation.current,
      controller = new AbortController();
    setActive(-1);
    setLoading(false);
    if (!query || !focused || dismissed || composing)
      return () => controller.abort();
    const timer = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams({ q: query });
      if (account) params.set('account', account);
      void mailApi<{ contacts: Contact[]; limited: boolean }>(
        `contacts?${params}`,
        { signal: controller.signal },
      )
        .then((data) => {
          if (!controller.signal.aborted && generation.current === requested)
            setResult({ key, ...data, error: false });
        })
        .catch(() => {
          if (!controller.signal.aborted && generation.current === requested)
            setResult({ key, contacts: [], limited: false, error: true });
        })
        .finally(() => {
          if (!controller.signal.aborted && generation.current === requested)
            setLoading(false);
        });
    }, 300);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, account, key, focused, dismissed, composing]);
  const excluded = enteredRecipients(values, field, part);
  const contacts =
    result.key === key
      ? result.contacts.filter(
          (person) => !excluded.has(person.address.toLowerCase()),
        )
      : [];
  const open =
    focused &&
    !dismissed &&
    !composing &&
    Boolean(query) &&
    contacts.length > 0;
  useEffect(() => {
    if (open && active >= 0)
      document
        .getElementById(`${id}-${active}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [open, active, id]);
  const pick = (contact: Contact) => {
    if (!part) return;
    const next = insertRecipient(value, part, contact);
    if (next.value.length > 4000) {
      setNotice(
        'This recipient would exceed the field limit. Remove another recipient or shorten a display name first.',
      );
      return;
    }
    onChange(next.value);
    setDismissed(true);
    setActive(-1);
    requestAnimationFrame(() => {
      if (
        document.activeElement === input.current &&
        input.current?.value === next.value
      )
        input.current.setSelectionRange(next.caret, next.caret);
    });
  };
  return (
    <div className="recipient-field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={input}
        id={id}
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={`${id}-suggestions`}
        aria-activedescendant={
          open && active >= 0 && contacts[active]
            ? `${id}-${active}`
            : undefined
        }
        autoComplete="off"
        spellCheck={false}
        maxLength={4000}
        value={value}
        onFocus={(event) => {
          setFocused(true);
          setCaret({
            start: event.currentTarget.selectionStart ?? 0,
            end: event.currentTarget.selectionEnd ?? 0,
          });
        }}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
          setActive(-1);
          setResult({ key: '', contacts: [], limited: false, error: false });
        }}
        onChange={(event) => {
          setNotice('');
          onChange(event.target.value);
          setCaret({
            start: event.target.selectionStart ?? 0,
            end: event.target.selectionEnd ?? 0,
          });
          setDismissed(false);
          setActive(-1);
        }}
        onSelect={(event) =>
          setCaret({
            start: event.currentTarget.selectionStart ?? 0,
            end: event.currentTarget.selectionEnd ?? 0,
          })
        }
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.keyCode === 229 ||
            composing
          )
            return;
          if (open && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
            event.preventDefault();
            setActive((n) =>
              event.key === 'ArrowDown'
                ? (n + 1) % contacts.length
                : n < 0
                  ? contacts.length - 1
                  : (n + contacts.length - 1) % contacts.length,
            );
          } else if (
            open &&
            event.key === 'Enter' &&
            active >= 0 &&
            contacts[active]
          ) {
            event.preventDefault();
            pick(contacts[active]);
          } else if (event.key === 'Escape' || event.key === 'Tab') {
            if (open && event.key === 'Escape') event.preventDefault();
            setDismissed(true);
            setActive(-1);
          }
        }}
      />
      {notice && <p role="alert">{notice}</p>}
      {open && (
        <div
          id={`${id}-suggestions`}
          role="listbox"
          aria-label={`${label} recipient suggestions`}
          className="recipient-suggestions"
        >
          {contacts.map((contact, index) => (
            <div
              key={contact.address}
              id={`${id}-${index}`}
              role="option"
              aria-selected={active === index}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => pick(contact)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  pick(contact);
                }
              }}
            >
              {contact.name && <span>{contact.name} — </span>}
              {contact.address}
            </div>
          ))}
        </div>
      )}
      {focused && query && !dismissed && !composing && (
        <p className="account-status" role="status">
          {loading
            ? 'Finding recipients…'
            : result.key !== key
              ? ''
              : result.error
                ? 'Suggestions unavailable. You can still type an address.'
                : contacts.length
                  ? `${contacts.length} suggestions. Use Up/Down and Enter to select; Escape dismisses.`
                  : 'No matching recipients.'}
          {result.key === key && result.limited
            ? ' Suggestions use the latest 2,000 matching messages.'
            : ''}
        </p>
      )}
    </div>
  );
}
