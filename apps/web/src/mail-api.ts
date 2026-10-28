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
  kind: 'read' | 'unread';
  state: 'pending' | 'applied' | 'failed';
};

// Each user intent gets one operation ID, so a repeated request cannot duplicate it.
export async function markMessage(id: string, kind: MailAction['kind']) {
  return (
    await mailApi<{ action: MailAction }>(`messages/${id}/actions`, {
      method: 'POST',
      body: JSON.stringify({ id: crypto.randomUUID(), kind }),
    })
  ).action;
}
