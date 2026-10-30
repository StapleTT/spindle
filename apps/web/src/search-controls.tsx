import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './brand.js';
import { bookmark, close, search, tune } from './icons.js';
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
  savedSlot,
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
  savedSlot: HTMLElement | null;
}) {
  const [options, setOptions] = useState(false);
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
  const savedList = saved.length > 0 && (
    <ul className="saved-searches" aria-label="Saved searches">
      {saved.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            className="nav-item"
            aria-pressed={
              query === item.query &&
              account === (item.accountId ?? '') &&
              mailbox === (item.mailboxId ?? '')
            }
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
            <Icon src={bookmark} />
            <span className="nav-label">{item.name}</span>
          </button>
          <button
            type="button"
            className="icon-button small"
            disabled={busy}
            aria-label={`Remove saved search ${item.name}`}
            title="Remove"
            onClick={() => void remove(item.id)}
          >
            <Icon src={close} />
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <section aria-label="Mail search" className="search">
      <search>
        <form
          className="search-bar"
          onSubmit={(event) => {
            event.preventDefault();
            setOptions(false);
            apply();
          }}
        >
          <Icon src={search} />
          <label className="visually-hidden" htmlFor="mail-search">
            Search mail
          </label>
          <input
            id="mail-search"
            data-mail-command="search"
            type="search"
            maxLength={500}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Search all mail"
          />
          {(text || query) && (
            <button
              type="button"
              className="icon-button small"
              title="Clear search"
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
              <Icon src={close} />
              <span className="visually-hidden">Clear search</span>
            </button>
          )}
          <kbd className="search-hint">/</kbd>
          <button
            type="button"
            className="icon-button small"
            aria-expanded={options}
            aria-controls="search-options"
            title="Search options"
            onClick={() => setOptions(!options)}
          >
            <Icon src={tune} />
            <span className="visually-hidden">Search options</span>
          </button>
        </form>
      </search>
      {options && (
        <div id="search-options" className="popover search-options">
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
          <div className="form-actions start">
            <button type="button" onClick={() => apply()}>
              Search
            </button>
            <button
              type="button"
              className="outlined"
              onClick={() => apply(`${text} is:unread`.trim())}
            >
              Search unread
            </button>
          </div>
          <p className="muted small">
            Search uses synchronized headers and the first 100,000 characters of
            indexed header text and cached bodies. Bodies and attachment filters
            cover only currently cached content; opening mail fills the bounded
            cache.
          </p>
          <details>
            <summary>Search syntax</summary>
            <p className="muted small">
              Combine words or quoted phrases with from:, to:, subject:, body:,
              is:read, is:unread, has:attachment, after:YYYY-MM-DD and
              before:YYYY-MM-DD (UTC). Prefix a term with - to exclude it.
              Search includes received folders, Sent and Archive; choose a
              folder or use in:inbox/archive/sent/trash/spam/anywhere. Bcc
              headers are not indexed.
            </p>
          </details>
          <div className="save-search">
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
              className="outlined"
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
          </div>
        </div>
      )}
      {query && coverage && (
        <p role="status" className="visually-hidden">
          Body search coverage: {coverage.cachedBodies} of {coverage.messages}{' '}
          messages in this scope. Sync history limits still apply.
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}{' '}
          <button type="button" onClick={() => setRevision((n) => n + 1)}>
            Reload saved searches
          </button>
        </p>
      )}
      {savedSlot && savedList && createPortal(savedList, savedSlot)}
    </section>
  );
}
