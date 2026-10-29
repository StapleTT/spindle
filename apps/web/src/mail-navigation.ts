import { useSyncExternalStore } from 'react';

export type MailLocation = {
  q: string;
  account: string;
  mailbox: string;
  cursor: string;
  message: string;
  conversation: string;
  draft: string;
  view: string;
};

function readLocation(): MailLocation {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return {
    q: params.get('q') ?? '',
    account: params.get('account') ?? '',
    mailbox: params.get('mailbox') ?? '',
    cursor: params.get('cursor') ?? '',
    message: params.get('message') ?? '',
    conversation: params.get('conversation') ?? '',
    draft: params.get('draft') ?? '',
    view: params.get('view') ?? '',
  };
}

export function mailHref(patch: Partial<MailLocation>) {
  const next = { ...readLocation(), ...patch };
  if (patch.message !== undefined && patch.conversation === undefined)
    next.conversation = '';
  if (patch.draft && patch.conversation === undefined) next.conversation = '';
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
