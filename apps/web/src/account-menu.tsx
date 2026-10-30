import { useEffect, useRef, useState } from 'react';
import { Icon, initials } from './brand.js';
import { logout } from './icons.js';

// Avatar pop-up: who is signed in, and Sign out. A non-modal <dialog> so mail
// shortcuts pause while it has focus.
export function AccountMenu({
  email,
  busy,
  onSignOut,
}: {
  email: string;
  busy: boolean;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const close = (restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) trigger.current?.focus();
  };
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (!open) {
      node.close();
      return;
    }
    node.show();
    node.querySelector<HTMLElement>('button, a')?.focus();
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const letter = initials(email).slice(0, 1);
  return (
    <div className="account-anchor" ref={anchor}>
      <button
        ref={trigger}
        type="button"
        className="account-avatar"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={email}
        onClick={() => setOpen(!open)}
      >
        <span aria-hidden="true">{letter}</span>
        <span className="visually-hidden">Account: {email}</span>
      </button>
      <dialog
        ref={dialog}
        className="account-menu"
        aria-labelledby="account-menu-email"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          close();
        }}
      >
        <div className="account-menu-head">
          <span className="account-avatar large" aria-hidden="true">
            {letter}
          </span>
          <p id="account-menu-email">{email}</p>
          <p className="muted small">Signed in to Spindle</p>
        </div>
        <button
          type="button"
          className="outlined sign-out"
          disabled={busy}
          onClick={() => {
            close(false);
            onSignOut();
          }}
        >
          <Icon src={logout} />
          Sign out
        </button>
      </dialog>
    </div>
  );
}
