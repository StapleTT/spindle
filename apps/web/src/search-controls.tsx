import { useEffect, useState } from 'react';
import { mailApi } from './mail-api.js';
import { useMailRevision } from './mail-events.js';
import { navigateMail } from './mail-navigation.js';
export type SearchCoverage = { messages: number; cachedBodies: number };
type SavedSearch = {
  id: string;
  name: string;
  query: string;
  accountId: string | null;
  mailboxId: string | null;
};
export function SearchControls({
  query,
  account,
  mailbox,
  accounts,
  folders,
  coverage,
  split,
  onSplit,
}: {
  query: string;
  account: string;
  mailbox: string;
  accounts: { id: string; name: string }[];
  folders: {
    id: string;
    accountId: string;
    path: string;
    role: string | null;
  }[];
  coverage: SearchCoverage | null;
  split: boolean;
  onSplit: () => void;
}) {
  const liveRevision = useMailRevision(['searches']);
  const [text, setText] = useState(query),
    [accountId, setAccount] = useState(account),
    [mailboxId, setMailbox] = useState(mailbox);
  const [saved, setSaved] = useState<SavedSearch[]>([]),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    setText(query);
    setAccount(account);
    setMailbox(mailbox);
  }, [query, account, mailbox]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Save/delete/retry explicitly refresh saved searches.
  useEffect(() => {
    const controller = new AbortController();
    void mailApi<{ searches: SavedSearch[] }>('searches', {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setSaved(result.searches);
          setError('');
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to load saved searches.',
          );
      });
    return () => controller.abort();
  }, [revision, liveRevision]);
  function apply(q = text) {
    navigateMail({
      q: q.trim(),
      account: accountId,
      mailbox: mailboxId,
      cursor: '',
      message: '',
      draft: '',
      view: '',
    });
  }
  async function save() {
    setBusy(true);
    setError('');
    try {
      await mailApi(`searches/${crypto.randomUUID()}`, {
        method: 'PUT',
        body: JSON.stringify({
          name,
          query,
          accountId: account || null,
          mailboxId: mailbox || null,
        }),
      });
      setName('');
      setRevision((n) => n + 1);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to save search.',
      );
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    setBusy(true);
    try {
      await mailApi(`searches/${id}`, { method: 'DELETE' });
      setRevision((n) => n + 1);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : 'Unable to remove search.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Mail search">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <label>
          Search mail
          <input
            id="mail-search"
            data-mail-command="search"
            type="search"
            maxLength={500}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={'Words, "exact phrase", from:person, is:unread'}
          />
        </label>
        <div className="search-filters">
          <label>
            Search account
            <select
              value={accountId}
              onChange={(event) => {
                setAccount(event.target.value);
                setMailbox('');
              }}
            >
              <option value="">All accounts</option>
              {accounts.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Search folder
            <select
              value={mailboxId}
              onChange={(event) => setMailbox(event.target.value)}
            >
              <option value="">All searchable folders</option>
              {folders
                .filter(
                  (folder) =>
                    (!accountId || folder.accountId === accountId) &&
                    folder.role !== '\\Drafts',
                )
                .map((folder) => (
                  <option key={folder.id} value={folder.id}>
                    {
                      accounts.find((item) => item.id === folder.accountId)
                        ?.name
                    }{' '}
                    / {folder.path}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <div className="account-actions">
          <button type="submit">Search</button>
          <button
            type="button"
            onClick={() => {
              setText('');
              navigateMail({
                q: '',
                cursor: '',
                message: '',
                draft: '',
                view: '',
              });
            }}
          >
            Clear search
          </button>
          <button
            type="button"
            onClick={() => apply(`${text} is:unread`.trim())}
          >
            Search unread
          </button>
        </div>
      </form>
      <p className="account-status">
        Search uses synchronized headers and the first 100,000 characters of
        indexed header text and cached bodies. Bodies and attachment filters
        cover only currently cached content; opening mail fills the bounded
        cache.
      </p>
      {query && coverage && (
        <p role="status">
          Body search coverage: {coverage.cachedBodies} of {coverage.messages}{' '}
          messages in this scope. Sync history limits still apply.
        </p>
      )}
      <details>
        <summary>Search syntax</summary>
        <p>
          Combine words or quoted phrases with from:, to:, subject:, body:,
          is:read, is:unread, has:attachment, after:YYYY-MM-DD and
          before:YYYY-MM-DD (UTC). Prefix a term with - to exclude it. Search
          includes received folders, Sent and Archive; choose a folder or use
          in:inbox/archive/sent/trash/spam/anywhere. Bcc headers are not
          indexed.
        </p>
      </details>
      <div className="account-actions">
        <label>
          Saved search name
          <input
            value={name}
            maxLength={80}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={
            busy ||
            !query.trim() ||
            !name.trim() ||
            text.trim() !== query.trim() ||
            accountId !== account ||
            mailboxId !== mailbox
          }
          onClick={() => void save()}
        >
          Save current search
        </button>
        <button type="button" aria-pressed={split} onClick={onSplit}>
          Split reader
        </button>
      </div>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRevision((n) => n + 1)}>
            Reload saved searches
          </button>
        </p>
      )}
      {saved.length > 0 && (
        <ul className="saved-searches" aria-label="Saved searches">
          {saved.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() =>
                  navigateMail({
                    q: item.query,
                    account: item.accountId ?? '',
                    mailbox: item.mailboxId ?? '',
                    cursor: '',
                    message: '',
                    draft: '',
                    view: '',
                  })
                }
              >
                {item.name}
              </button>
              <button
                type="button"
                disabled={busy}
                aria-label={`Remove saved search ${item.name}`}
                onClick={() => void remove(item.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
