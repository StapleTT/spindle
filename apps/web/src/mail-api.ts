export class MailApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function mailApi<T>(path: string, options: RequestInit = {}) {
  const response = await fetch(`/api/mail/${path}`, {
    ...options,
    headers: {
      ...(options.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok)
    throw new MailApiError(
      data.message ?? 'Unable to load your mail.',
      response.status,
      data.code,
    );
  return data as T;
}

// Ask the worker to cache a body the user is likely to open next: reader
// neighbours and hovered or focused rows. Best effort and deduplicated; the
// reader still requests the body itself when it opens the message.
const warmed = new Map<string, number>();
export function prefetchContent(id: string) {
  const now = Date.now();
  if (now - (warmed.get(id) ?? 0) < 60000) return;
  if (warmed.size >= 500) warmed.clear();
  warmed.set(id, now);
  mailApi(`messages/${id}/prefetch`, { method: 'POST' }).catch(() => {});
}

export type MailAction = {
  id: string;
  kind: 'read' | 'unread' | 'archive' | 'trash' | 'move' | 'restore';
  state: 'pending' | 'applied' | 'failed' | 'cancelled' | 'conflict';
  error?: string | null;
};

// Each user intent gets one operation ID, so a repeated request cannot duplicate it.
// Moves answer with the destination folder name; read changes have none.
export async function requestAction(
  id: string,
  kind: MailAction['kind'],
  mailbox?: string,
) {
  return mailApi<{ action: MailAction; target: string | null; undoMs: number }>(
    `messages/${id}/actions`,
    {
      method: 'POST',
      body: JSON.stringify({ id: crypto.randomUUID(), kind, mailbox }),
    },
  );
}

// An action the server will still cancel; listed again after reloads until its deadline.
export type Undoable = {
  id: string;
  kind: MailAction['kind'];
  subject: string;
  target: string | null;
  undoMs: number;
};

export type ActionFeedback = Undoable &
  MailAction & {
    messageId: string | null;
  };

export function actionNotice({ kind, subject, target }: Undoable) {
  const name = `“${subject || '(No subject)'}”`;
  if (kind === 'read' || kind === 'unread') return `Marked ${name} as ${kind}.`;
  return `${actionText[kind].done} ${name}${target && (kind === 'move' || kind === 'restore') ? ` to ${target}` : ''}.`;
}

export const actionText = {
  read: { pending: 'Marking as read', done: 'Marked as read' },
  unread: { pending: 'Marking as unread', done: 'Marked as unread' },
  archive: { pending: 'Archiving', done: 'Archived' },
  trash: { pending: 'Moving to Trash', done: 'Moved to Trash' },
  move: { pending: 'Moving', done: 'Moved' },
  restore: { pending: 'Restoring', done: 'Restored' },
};
