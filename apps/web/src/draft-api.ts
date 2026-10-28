import { mailApi } from './mail-api.js';
import { navigateMail } from './mail-navigation.js';

export type DraftContent = {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  format: 'rich' | 'plain';
  html: string;
  text: string;
};
export type ReplyContext = {
  kind: 'reply' | 'replyAll' | 'forward' | 'copy';
  sourceMessageId: string;
  originalSubject: string;
  inReplyTo: string | null;
  references: string[];
  warnings: string[];
};
export type DraftValue = {
  accountId: string | null;
  content: DraftContent;
  copyOf?: string;
  attachmentIds?: string[];
};
export type Draft = DraftValue & {
  id: string;
  revision: number;
  saveId: string | null;
  updatedAt: string;
  replyContext?: ReplyContext | null;
  forwarded?: { text: string; imageCount: number } | null;
  outbox?: { id: string; state: string } | null;
};
export type DraftSummary = Pick<
  Draft,
  'id' | 'accountId' | 'revision' | 'updatedAt'
> & { subject: string };
export type Recovery = {
  value: DraftValue;
  revision: number;
  saveId: string | null;
  editId: string;
};
export const emptyContent = (): DraftContent => ({
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  format: 'rich',
  html: '<p></p>',
  text: '',
});
export const draftValue = ({
  accountId,
  content,
  attachmentIds,
}: DraftValue): DraftValue => ({
  accountId,
  content,
  attachmentIds: attachmentIds ?? [],
});
export const sameValue = (a: DraftValue, b: DraftValue) =>
  a.accountId === b.accountId &&
  JSON.stringify(a.attachmentIds ?? []) ===
    JSON.stringify(b.attachmentIds ?? []) &&
  (Object.keys(a.content) as (keyof DraftContent)[]).every(
    (key) => a.content[key] === b.content[key],
  );

const prefix = (user: string) => `spindle:drafts:${user}:`;
const key = (user: string, id: string) => `${prefix(user)}${id}`;
export function readRecovery(user: string, id: string): Recovery | null {
  try {
    const item = JSON.parse(
      sessionStorage.getItem(key(user, id)) ?? 'null',
    ) as Recovery | null;
    if (
      !item ||
      !Number.isInteger(item.revision) ||
      item.revision < 0 ||
      typeof item.editId !== 'string' ||
      !(item.saveId === null || typeof item.saveId === 'string') ||
      !item.value ||
      !(
        item.value.accountId === null ||
        typeof item.value.accountId === 'string'
      )
    )
      return null;
    if (
      item.value.copyOf !== undefined &&
      typeof item.value.copyOf !== 'string'
    )
      return null;
    const content = item.value.content;
    if (
      item.value.attachmentIds !== undefined &&
      (!Array.isArray(item.value.attachmentIds) ||
        item.value.attachmentIds.length > 10 ||
        item.value.attachmentIds.some((id) => typeof id !== 'string'))
    )
      return null;
    if (
      !content ||
      !['rich', 'plain'].includes(content.format) ||
      !['to', 'cc', 'bcc', 'subject', 'html', 'text'].every(
        (field) => typeof content[field as keyof DraftContent] === 'string',
      )
    )
      return null;
    return item;
  } catch {
    return null;
  }
}
export function writeRecovery(user: string, id: string, recovery: Recovery) {
  try {
    sessionStorage.setItem(key(user, id), JSON.stringify(recovery));
    return true;
  } catch {
    return false;
  }
}
export function removeRecovery(user: string, id: string) {
  try {
    sessionStorage.removeItem(key(user, id));
  } catch {
    /* Storage may be disabled. */
  }
}
export function recoveryDrafts(user: string): DraftSummary[] {
  try {
    return Object.keys(sessionStorage)
      .filter((name) => name.startsWith(prefix(user)))
      .flatMap((name) => {
        const id = name.slice(prefix(user).length);
        const item = readRecovery(user, id);
        return item
          ? [
              {
                id,
                accountId: item.value.accountId,
                subject: item.value.content.subject,
                revision: item.revision,
                updatedAt: '',
              },
            ]
          : [];
      });
  } catch {
    return [];
  }
}
export async function getDraft(id: string, signal?: AbortSignal) {
  return (
    await mailApi<{ draft: Draft }>(`drafts/${id}`, { signal: signal ?? null })
  ).draft;
}

export function plainHtml(text: string) {
  return text
    .split('\n')
    .map(
      (line) =>
        `<p>${line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</p>`,
    )
    .join('');
}

export function startDraft(
  user: string,
  account: string | null,
  value?: DraftValue,
) {
  const id = crypto.randomUUID();
  const saved = writeRecovery(user, id, {
    value: value ?? { accountId: account, content: emptyContent() },
    revision: 0,
    saveId: null,
    editId: crypto.randomUUID(),
  });
  if (!saved) return null;
  navigateMail({ draft: id, view: 'drafts', message: '' });
  return id;
}
