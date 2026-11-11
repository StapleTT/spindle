export type ConversationItem = {
  id: string;
  copyKey?: string;
  subject: string;
  sender: { name: string; address: string }[];
  receivedAt: string;
  unread: boolean;
  matchesView: boolean;
  headersPending: boolean;
  folders: { name: string; path: string; role: string | null }[];
};

// Collapse matching cross-folder envelopes for display, never storage or actions.
export function relatedConversationItems(
  messages: ConversationItem[],
  selected: string,
) {
  const groups = new Map<
    string,
    { items: ConversationItem[]; folders: Set<string> }[]
  >();
  for (const item of messages) {
    const key = item.copyKey ?? item.id;
    const candidates = groups.get(key) ?? [];
    const group = candidates.find(
      (candidate) =>
        item.folders.length > 0 &&
        candidate.folders.size > 0 &&
        item.folders.every((folder) => !candidate.folders.has(folder.path)),
    );
    if (group) {
      group.items.push(item);
      for (const folder of item.folders) group.folders.add(folder.path);
    } else {
      candidates.push({
        items: [item],
        folders: new Set(item.folders.map((folder) => folder.path)),
      });
      groups.set(key, candidates);
    }
  }
  const related: ConversationItem[] = [];
  for (const candidates of groups.values()) {
    for (const group of candidates) {
      if (group.items.some((item) => item.id === selected)) continue;
      const inView = group.items.filter((item) => item.matchesView);
      const candidates = inView.length ? inView : group.items;
      const representative =
        candidates.find((item) =>
          item.folders.some((folder) => folder.role !== '\\All'),
        ) ?? candidates[0];
      if (!representative) continue;
      related.push({
        ...representative,
        folders: [
          ...new Map(
            group.items
              .flatMap((item) => item.folders)
              .map((folder) => [folder.path, folder]),
          ).values(),
        ],
      });
    }
  }
  // Preserve the server's date/UUID order, including timestamp ties and separate deliveries.
  const position = new Map(messages.map((item, index) => [item.id, index]));
  return related.sort(
    (a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0),
  );
}
