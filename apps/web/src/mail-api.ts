export async function mailApi<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/mail/${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.message ?? 'Unable to load your mail.');
  return data as T;
}

export type MailAction = {
  id: string;
  kind: 'read' | 'unread' | 'archive' | 'trash' | 'move' | 'restore';
  state: 'pending' | 'applied' | 'failed';
};

// Each user intent gets one operation ID, so a repeated request cannot duplicate it.
// Moves answer with the destination folder path; read changes have none.
export async function requestAction(
  id: string,
  kind: MailAction['kind'],
  mailbox?: string,
) {
  return mailApi<{ action: MailAction; target: string | null }>(
    `messages/${id}/actions`,
    {
      method: 'POST',
      body: JSON.stringify({ id: crypto.randomUUID(), kind, mailbox }),
    },
  );
}

export function movedNotice(
  kind: MailAction['kind'],
  subject: string,
  target: string | null,
) {
  return `${actionText[kind].done} “${subject || '(No subject)'}”${target && (kind === 'move' || kind === 'restore') ? ` to ${target}` : ''}. Moving it at your provider.`;
}

export const actionText = {
  read: { pending: 'Marking as read', done: 'Marked as read' },
  unread: { pending: 'Marking as unread', done: 'Marked as unread' },
  archive: { pending: 'Archiving', done: 'Archived' },
  trash: { pending: 'Moving to Trash', done: 'Moved to Trash' },
  move: { pending: 'Moving', done: 'Moved' },
  restore: { pending: 'Restoring', done: 'Restored' },
};
