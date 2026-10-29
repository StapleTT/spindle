export type Contact = { name: string; address: string };
type Part = { start: number; end: number };

// Only unquoted commas separate recipients; quoted names/comments may contain commas.
function parts(value: string): Part[] {
  const found: Part[] = [];
  let start = 0,
    quote = false,
    escaped = false,
    comments = 0,
    angle = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === '\\' && (quote || comments)) {
      escaped = true;
      continue;
    }
    if (c === '"' && !comments) {
      quote = !quote;
      continue;
    }
    if (quote) continue;
    if (c === '(') {
      comments++;
      continue;
    }
    if (c === ')' && comments) {
      comments--;
      continue;
    }
    if (comments) continue;
    if (c === '<') angle = true;
    if (c === '>') angle = false;
    if (c === ',' && !angle) {
      found.push({ start, end: i });
      start = i + 1;
    }
  }
  found.push({ start, end: value.length });
  return found;
}
export function recipientPart(value: string, caret: number, end = caret) {
  if (caret !== end || caret < 0 || caret > value.length) return null;
  const part = parts(value).find(
    (part) => caret >= part.start && caret <= part.end,
  );
  if (!part) return null;
  const text = value.slice(part.start, caret).trim(),
    bracket = text.lastIndexOf('<');
  const query = (
    bracket >= 0
      ? text.slice(bracket + 1).replace(/>.*$/, '')
      : text
          .replace(/^"/, '')
          .replace(/"$/, '')
          .replace(/\\(["\\])/g, '$1')
  ).trim();
  if (query.length < 2 || query.length > 100 || /\p{Cc}/u.test(query))
    return null;
  return { ...part, query };
}
export function enteredRecipients(
  values: string[],
  editing: number,
  part: Part | null,
) {
  const addresses = new Set<string>();
  values.forEach((value, field) => {
    for (const segment of parts(value)) {
      if (
        field === editing &&
        part &&
        segment.start === part.start &&
        segment.end === part.end
      )
        continue;
      const text = value.slice(segment.start, segment.end).trim();
      const address = /<([^<>]+)>$/.exec(text)?.[1] ?? text;
      if (/^[^\s<>(),;:]+@[^\s<>(),;:]+\.[^\s<>(),;:]+$/.test(address))
        addresses.add(address.toLowerCase());
    }
  });
  return addresses;
}
export function insertRecipient(value: string, part: Part, contact: Contact) {
  const name = contact.name.replace(/\p{Cc}/gu, ' ').trim();
  const formatted = name
    ? `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" <${contact.address}>`
    : contact.address;
  const prefix = value.slice(0, part.start) + (part.start ? ' ' : '');
  const suffix = value.slice(part.end) || ', ';
  return {
    value: prefix + formatted + suffix,
    caret:
      prefix.length + formatted.length + (part.end === value.length ? 2 : 0),
  };
}
