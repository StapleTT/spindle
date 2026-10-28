import { createHash } from 'node:crypto';
import { SANITIZER_VERSION } from './sanitize.js';
import { mailView } from './view.js';

export class SearchError extends Error {}
type Term = { field: string; value: string; phrase: boolean; exclude: boolean };
export function parseSearch(query: string): Term[] {
  if (query.length > 500 || /\p{Cc}/u.test(query))
    throw new SearchError(
      'Use at most 500 characters without control characters.',
    );
  const words: string[] = [];
  let word = '',
    quoted = false;
  for (const char of query.trim()) {
    if (char === '"') {
      quoted = !quoted;
      word += char;
    } else if (/\s/u.test(char) && !quoted) {
      if (word) words.push(word);
      word = '';
    } else word += char;
  }
  if (quoted) throw new SearchError('Close the quoted search phrase.');
  if (word) words.push(word);
  if (words.length > 32) throw new SearchError('Use at most 32 search terms.');
  const terms = words.map((raw) => {
    const exclude = raw.startsWith('-');
    if (exclude) raw = raw.slice(1);
    const colon = raw.startsWith('"') ? -1 : raw.indexOf(':');
    const field = colon > 0 ? raw.slice(0, colon).toLowerCase() : '';
    const input = colon > 0 ? raw.slice(colon + 1) : raw;
    const phrase = input.startsWith('"') && input.endsWith('"');
    const value = phrase ? input.slice(1, -1) : input;
    if (
      !value ||
      value.includes('"') ||
      ![
        '',
        'from',
        'to',
        'subject',
        'body',
        'is',
        'has',
        'after',
        'before',
        'in',
      ].includes(field)
    )
      throw new SearchError(
        'Use words, quoted phrases, from:, to:, subject:, body:, is:read/unread, has:attachment, after:, before: or in:.',
      );
    if (field === 'is' && !['read', 'unread'].includes(value))
      throw new SearchError('Use is:read or is:unread.');
    if (field === 'has' && value !== 'attachment')
      throw new SearchError(
        'Use has:attachment for attachments in cached bodies.',
      );
    if (
      field === 'in' &&
      (!['anywhere', 'inbox', 'archive', 'sent', 'trash', 'spam'].includes(
        value,
      ) ||
        exclude)
    )
      throw new SearchError(
        'Use in:inbox/archive/sent/trash/spam/anywhere without a minus.',
      );
    if (
      ['before', 'after'].includes(field) &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        value.startsWith('0000') ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw new SearchError('Dates must be valid YYYY-MM-DD values (UTC).');
    return { field, value, phrase, exclude };
  });
  if (terms.filter((term) => term.field === 'in').length > 1)
    throw new SearchError('Choose one in: scope.');
  return terms;
}
export const unreadCondition = `NOT EXISTS(SELECT 1 FROM mail_memberships seen WHERE seen.user_id=$1 AND seen.message_id=m.id AND ($3::uuid IS NULL OR COALESCE(seen.pending_mailbox_id,seen.mailbox_id)=$3) AND '\\Seen'=ANY(seen.flags))`;
export const cachedBodyCondition = `c.user_id=m.user_id AND c.account_id=m.account_id AND c.message_id=m.id AND c.state='ready' AND c.expires_at>clock_timestamp() AND c.sanitizer_version=${SANITIZER_VERSION}`;
export function searchCondition(query: string, values: unknown[]) {
  const terms = parseSearch(query);
  const scope = terms.find((term) => term.field === 'in')?.value;
  const base = mailView(query.trim() ? (scope ?? 'search') : 'inbox');
  const clauses: string[] = [];
  const bind = (value: unknown) => {
    values.push(value);
    return `$${values.length}`;
  };
  for (const term of terms) {
    const { field, value, phrase, exclude } = term;
    let sql = '';
    if (field === 'in') continue;
    if (field === 'is')
      sql = value === 'unread' ? unreadCondition : `NOT (${unreadCondition})`;
    else if (field === 'has')
      sql = `EXISTS(SELECT 1 FROM mail_content c WHERE ${cachedBodyCondition} AND jsonb_array_length(c.attachments)>0)`;
    else if (field === 'after' || field === 'before')
      sql = `m.received_at ${field === 'after' ? '>=' : '<'} ${bind(value)}::timestamptz`;
    else {
      const q = `${phrase ? 'phraseto_tsquery' : 'plainto_tsquery'}('simple',${bind(value)})`;
      const body = `EXISTS(SELECT 1 FROM mail_content c WHERE ${cachedBodyCondition} AND c.search_vector @@ ${q})`;
      if (field === 'body') sql = body;
      else if (field === 'subject')
        sql = `m.search_vector @@ ${q} AND to_tsvector('simple',m.subject) @@ ${q}`;
      else if (field === 'from' || field === 'to') {
        const text =
          field === 'from'
            ? 'mail_search_people(m.sender)'
            : `mail_search_people(m.recipients->'to')`;
        sql = `m.search_vector @@ ${q} AND to_tsvector('simple',left(coalesce(${text},'')||' '||translate(coalesce(${text},''),'@._+-','     '),100000)) @@ ${q}`;
      } else sql = `m.search_vector @@ ${q} OR ${body}`;
    }
    clauses.push(`${exclude ? 'NOT ' : ''}(${sql})`);
  }
  return {
    base,
    condition: `${base}${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`,
  };
}
export function searchKey(
  owner: string,
  account: string | undefined,
  mailbox: string | undefined,
  query: string,
) {
  return query.trim()
    ? createHash('sha256')
        .update(
          JSON.stringify([
            owner,
            account ?? null,
            mailbox ?? null,
            query.trim(),
          ]),
        )
        .digest('hex')
    : undefined;
}
export const searchProperty = { type: 'string', maxLength: 500 };
