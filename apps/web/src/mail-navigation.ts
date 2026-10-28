import { useSyncExternalStore } from 'react';

export type MailLocation = {
  account: string;
  mailbox: string;
  cursor: string;
  message: string;
  draft: string;
  view: string;
};

function readLocation(): MailLocation {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return {
    account: params.get('account') ?? '',
    mailbox: params.get('mailbox') ?? '',
    cursor: params.get('cursor') ?? '',
    message: params.get('message') ?? '',
    draft: params.get('draft') ?? '',
    view: params.get('view') ?? '',
  };
}

export function mailHref(patch: Partial<MailLocation>) {
  const next = { ...readLocation(), ...patch };
  // Existing folder/reader links leave the drafts workspace explicitly.
  if (patch.draft === undefined && patch.view === undefined) {
    next.draft = '';
    next.view = '';
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next))
    if (value) params.set(key, value);
  return `#${params.toString()}`;
}

export function navigateMail(patch: Partial<MailLocation>) {
  window.history.pushState(null, '', mailHref(patch));
  window.dispatchEvent(new Event('spindle:mail-navigation'));
}

function subscribe(update: () => void) {
  window.addEventListener('hashchange', update);
  window.addEventListener('popstate', update);
  window.addEventListener('spindle:mail-navigation', update);
  return () => {
    window.removeEventListener('hashchange', update);
    window.removeEventListener('popstate', update);
    window.removeEventListener('spindle:mail-navigation', update);
  };
}

export function useMailLocation() {
  useSyncExternalStore(subscribe, () => window.location.hash);
  return readLocation();
}
