import { Parser } from 'htmlparser2';
import type { ParsedMail } from 'mailparser';
import { emailAddress } from './smtp.js';

export type Person = { name: string; address: string };
export type ReplyKind = 'reply' | 'replyAll' | 'forward';
export type ReplyMetadata = {
  from: Person[];
  to: Person[];
  cc: Person[];
  replyTo: Person[] | null;
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  truncatedRecipients: boolean;
};
export type ReplyContext = {
  kind: ReplyKind | 'copy';
  sourceMessageId: string;
  originalSubject: string;
  inReplyTo: string | null;
  references: string[];
  warnings: string[];
};

const header = (value: string | undefined, limit = 1000) =>
  Array.from((value ?? '').replace(/\p{Cc}/gu, ' ').trim())
    .slice(0, limit)
    .join('');
export function messageId(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 512 &&
    /^<[^<>\s@]+@[^<>\s@]+>$/.test(value) &&
    !/[^\x21-\x7e]/.test(value)
    ? value
    : null;
}
export function referenceIds(value: unknown): string[] {
  const pieces = (Array.isArray(value) ? value : [value]).filter(
    (item): item is string => typeof item === 'string',
  );
  const ids = [
    ...new Set(
      pieces
        .flatMap((item) => item.match(/<[^<>]*>/g) ?? [])
        .filter((item) => messageId(item)),
    ),
  ];
  return ids[0] && ids.length > 100 ? [ids[0], ...ids.slice(-99)] : ids;
}
export function replyMetadata(parsed: ParsedMail): ReplyMetadata {
  let truncatedRecipients = false;
  const people = (objects: ParsedMail['to']) => {
    const entries = (
      Array.isArray(objects) ? objects : objects ? [objects] : []
    ).flatMap((object) => object.value);
    if (entries.length > 100) truncatedRecipients = true;
    return entries.slice(0, 100).map((person) => ({
      name: header(person.name, 200),
      address:
        typeof person.address === 'string' && !/\p{Cc}/u.test(person.address)
          ? Array.from(person.address).slice(0, 320).join('')
          : '',
    }));
  };
  return {
    from: people(parsed.from),
    to: people(parsed.to),
    cc: people(parsed.cc),
    replyTo: parsed.headers.has('reply-to') ? people(parsed.replyTo) : null,
    subject: header(parsed.subject),
    messageId: messageId(parsed.messageId),
    inReplyTo: messageId(parsed.inReplyTo),
    references: referenceIds(parsed.references),
    truncatedRecipients,
  };
}
export function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function htmlText(html: string) {
  let text = '',
    ignore = 0;
  const hidden = new Set([
    'script',
    'style',
    'head',
    'iframe',
    'object',
    'template',
    'noscript',
    'svg',
    'math',
  ]);
  const blocks = new Set([
    'p',
    'div',
    'tr',
    'li',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'section',
  ]);
  const parser = new Parser({
    onopentag(tag) {
      if (hidden.has(tag)) ignore++;
      if (!ignore && (tag === 'br' || blocks.has(tag))) text += '\n';
      if (!ignore && (tag === 'td' || tag === 'th')) text += ' ';
    },
    ontext(value) {
      if (!ignore) text += value;
    },
    onclosetag(tag) {
      if (hidden.has(tag)) ignore = Math.max(0, ignore - 1);
      if (!ignore && blocks.has(tag)) text += '\n';
    },
  });
  parser.end(html);
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function responseDraft(
  kind: ReplyKind,
  source: {
    id: string;
    accountId: string;
    date: Date | string;
    plain: string;
    html: string;
    metadata: ReplyMetadata;
    attachments: number;
  },
  identities: string[],
) {
  const meta = source.metadata,
    warnings: string[] = [];
  if (kind !== 'forward' && meta.truncatedRecipients)
    throw new Error(
      'The original has too many addresses to prepare a reliable reply. Compose a new message and select recipients.',
    );
  const self = new Set(
    identities.filter(emailAddress).map((value) => value.toLowerCase()),
  );
  const seen = new Set<string>();
  const recipients = (people: Person[]) =>
    people.flatMap((person) => {
      if (!emailAddress(person.address)) {
        warnings.push(
          'Some original addresses are invalid or unsupported. Review the recipients.',
        );
        return [];
      }
      const key = person.address.toLowerCase();
      if (self.has(key) || seen.has(key)) return [];
      seen.add(key);
      return [{ name: header(person.name, 200), address: person.address }];
    });
  const ownSender =
    meta.from.length > 0 &&
    meta.from.every((person) => self.has(person.address.toLowerCase()));
  let to: Person[] = [],
    cc: Person[] = [];
  if (kind !== 'forward') {
    const primary = ownSender ? meta.to : (meta.replyTo ?? meta.from);
    to = recipients(primary);
    if (kind === 'replyAll') {
      if (!ownSender) to.push(...recipients(meta.to));
      cc = recipients(meta.cc);
    }
    if (!to.length && !cc.length)
      warnings.push(
        'No reply recipient could be selected. Choose recipients before sending.',
      );
  }
  const format = (people: Person[]) =>
    people
      .map((person) =>
        person.name
          ? `"${person.name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" <${person.address}>`
          : person.address,
      )
      .join(', ');
  const toText = format(to),
    ccText = format(cc);
  if (
    to.length + cc.length > 50 ||
    toText.length > 4000 ||
    ccText.length > 4000
  )
    throw new Error(
      'This reply has too many recipients. Use Reply and choose the recipients manually.',
    );
  const subject = header(
    (kind === 'forward' ? /^\s*(?:fw|fwd)\s*:/i : /^\s*re\s*:/i).test(
      meta.subject,
    )
      ? meta.subject
      : `${kind === 'forward' ? 'Fwd' : 'Re'}: ${meta.subject}`,
  );
  const parent = kind === 'forward' ? null : messageId(meta.messageId);
  const references = parent
    ? [
        ...new Set([
          ...(meta.references.length
            ? referenceIds(meta.references).filter((id) => id !== parent)
            : referenceIds(meta.inReplyTo).filter((id) => id !== parent)),
          parent,
        ]),
      ]
    : [];
  // Preserve the root and most recent ancestors, including the direct parent.
  while (references.length > 30 || references.join(' ').length > 8000)
    references.splice(1, 1);
  if (kind !== 'forward' && !parent)
    warnings.push(
      'The original has no valid Message-ID. This reply may appear as a new conversation.',
    );
  if (source.attachments > 0)
    warnings.push('Original attachments are not included.');
  const display = (people: Person[]) =>
    header(
      people
        .slice(0, 20)
        .map((person) =>
          header(
            person.name ? `${person.name} <${person.address}>` : person.address,
            520,
          ),
        )
        .join(', '),
      2000,
    );
  const date = new Date(source.date);
  const when = Number.isFinite(date.getTime()) ? date.toISOString() : '';
  const lead =
    kind === 'forward'
      ? `---------- Forwarded message ----------\nFrom: ${display(meta.from)}\nDate: ${when}\nSubject: ${meta.subject}\nTo: ${display(meta.to)}${meta.cc.length ? `\nCc: ${display(meta.cc)}` : ''}\n\n`
      : `On ${when}, ${display(meta.from)} wrote:\n\n`;
  const original =
    lead + (source.plain.trim() ? source.plain : htmlText(source.html));
  // Older plain-only caches contain the sanitizer's empty wrapper.
  const forwarded =
    kind === 'forward' &&
    source.html &&
    source.html !== '<div class="spindle-email-body"></div>'
      ? {
          html: `<div>${lead
            .split('\n')
            .map((line) => `<p>${escapeHtml(line)}</p>`)
            .join('')}</div>${source.html}`,
          text: original,
        }
      : null;
  const chars = Array.from(original);
  let quote = chars.slice(0, 10000).join('');
  if (!forwarded && chars.length > 10000) {
    quote += '\n[Original message shortened]';
    warnings.push('The quoted original was shortened to fit draft limits.');
  }
  const html =
    '<p></p><blockquote>' +
    quote
      .split('\n')
      .map((line) => `<p>${escapeHtml(line)}</p>`)
      .join('') +
    '</blockquote>';
  const replyContext: ReplyContext = {
    kind,
    sourceMessageId: source.id,
    originalSubject: meta.subject,
    inReplyTo: parent,
    references,
    warnings: [...new Set(warnings)],
  };
  // JSON escaping and Unicode must also fit the persisted context byte limit.
  while (
    references.length > 2 &&
    Buffer.byteLength(JSON.stringify(replyContext)) > 14000
  )
    references.splice(1, 1);
  return {
    accountId: source.accountId,
    content: {
      to: toText,
      cc: ccText,
      bcc: '',
      subject,
      format: 'rich' as const,
      html: forwarded ? '<p></p>' : html,
      text: forwarded ? '' : `\n${quote}`,
    },
    replyContext,
    forwarded,
  };
}
