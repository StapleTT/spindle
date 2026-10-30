import { type CSSProperties, useId, useRef, useState } from 'react';
import { accountColorStyle, Icon } from './brand.js';
import { type Hsl, hexToHsl, hslToHex, isHexColor } from './color.js';
import { check, close } from './icons.js';
import { mailApi } from './mail-api.js';

const suggested = [
  'Coral',
  'Blue',
  'Green',
  'Orchid',
  'Amber',
  'Teal',
  'Indigo',
  'Rose',
];

export function AccountColorPicker({
  account,
  index,
  onChange,
}: {
  account: { id: string; name: string; color: string | null };
  index: number;
  onChange: (color: string | null) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    trigger = useRef<HTMLButtonElement>(null),
    title = useId();
  const [value, setValue] = useState(''),
    [input, setInput] = useState(''),
    [hsl, setHsl] = useState<Hsl>([0, 0, 0]);
  const [busy, setBusy] = useState(false),
    [issue, setIssue] = useState('');
  function select(hex: string) {
    setValue(hex.toLowerCase());
    setInput(hex.toLowerCase());
    setHsl(hexToHsl(hex));
    setIssue('');
  }
  function preset(name: string) {
    return getComputedStyle(document.documentElement)
      .getPropertyValue(`--picker-${name.toLowerCase()}`)
      .trim();
  }
  function dismiss() {
    dialog.current?.close();
    trigger.current?.focus();
  }
  async function save(color: string | null) {
    setBusy(true);
    setIssue('');
    try {
      const data = await mailApi<{ account: { color: string | null } }>(
        `accounts/${account.id}/color`,
        { method: 'PATCH', body: JSON.stringify({ color }) },
      );
      onChange(data.account.color);
      dismiss();
    } catch (error) {
      setIssue(
        error instanceof Error ? error.message : 'Unable to save color.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="account-color-trigger outlined"
        aria-label={`Change color for ${account.name}`}
        aria-haspopup="dialog"
        onClick={() => {
          select(account.color ?? preset(suggested[index % 4] ?? 'Coral'));
          dialog.current?.showModal();
        }}
      >
        <span className="dot" aria-hidden="true" />
        Change color
      </button>
      <dialog
        ref={dialog}
        className="color-picker"
        aria-labelledby={title}
        onCancel={(event) => {
          event.preventDefault();
          if (!busy) dismiss();
        }}
      >
        <header>
          <div>
            <h3 id={title}>Account color</h3>
            <p className="muted">{account.name}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close color picker"
            disabled={busy}
            onClick={dismiss}
          >
            <Icon src={close} />
          </button>
        </header>
        <div className="color-preview" style={accountColorStyle(value, index)}>
          <span className="avatar" aria-hidden="true">
            <Icon src={check} />
          </span>
          <div>
            <strong>{account.name}</strong>
            <p>Preview in your inbox</p>
          </div>
          <span className="dot" aria-hidden="true" />
        </div>
        <fieldset className="suggested-colors" disabled={busy}>
          <legend>Suggested colors</legend>
          {suggested.map((name) => (
            <button
              key={name}
              type="button"
              className="color-swatch"
              aria-label={name}
              aria-pressed={value === preset(name)}
              title={name}
              style={
                {
                  '--swatch': `var(--picker-${name.toLowerCase()})`,
                } as CSSProperties
              }
              onClick={() => select(preset(name))}
            >
              <span className="visually-hidden">Use {name}</span>
            </button>
          ))}
        </fieldset>
        <fieldset
          className="color-sliders"
          disabled={busy}
          style={
            {
              '--picker-hue': `${hsl[0]}`,
              '--picker-saturation': `${hsl[1]}%`,
            } as CSSProperties
          }
        >
          <legend>Custom color</legend>
          {(['Hue', 'Saturation', 'Lightness'] as const).map((label, part) => (
            <label key={label}>
              {label}
              <input
                type="range"
                className={`color-range color-${label.toLowerCase()}`}
                min="0"
                max={part === 0 ? 359 : 100}
                step="1"
                value={Math.round(hsl[part] ?? 0)}
                onChange={(event) => {
                  const next: Hsl = [...hsl];
                  next[part] = Number(event.target.value);
                  setHsl(next);
                  const hex = hslToHex(next);
                  setValue(hex);
                  setInput(hex);
                  setIssue('');
                }}
              />
            </label>
          ))}
        </fieldset>
        <label>
          Hex color
          <input
            value={input}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={!isHexColor(input)}
            disabled={busy}
            onChange={(event) => {
              setInput(event.target.value);
              if (isHexColor(event.target.value)) select(event.target.value);
            }}
          />
        </label>
        {!isHexColor(input) && (
          <p className="error">Enter # followed by six hex digits.</p>
        )}
        {issue && (
          <p role="alert" className="error">
            {issue}
          </p>
        )}
        <footer>
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Use default
          </button>
          <button
            type="button"
            className="outlined"
            disabled={busy}
            onClick={dismiss}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || !isHexColor(input)}
            onClick={() => void save(value)}
          >
            {busy ? 'Saving…' : 'Save color'}
          </button>
        </footer>
      </dialog>
    </>
  );
}
