import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Draft,
  type DraftContent,
  type DraftValue,
  draftValue,
  getDraft,
  readRecovery,
  removeRecovery,
  sameValue,
  writeRecovery,
} from './draft-api.js';
import { MailApiError, mailApi } from './mail-api.js';
import { useMailRevision } from './mail-events.js';

type Status =
  | 'loading'
  | 'saved'
  | 'unsaved'
  | 'saving'
  | 'failed'
  | 'conflict';
type Attempt = {
  value: DraftValue;
  revision: number;
  saveId: string;
  editId: string;
};

export function useDraft(user: string, id: string) {
  const liveRevision = useMailRevision(['drafts', 'files', 'outbox']);
  const [value, setValue] = useState<DraftValue | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const [recoveryFailed, setRecoveryFailed] = useState(false);
  const [editorVersion, setEditorVersion] = useState(0);
  const [replyContext, setReplyContext] = useState<Draft['replyContext']>(null);
  const [forwarded, setForwarded] = useState<Draft['forwarded']>(null);
  const [providerSync, setProviderSync] = useState<
    NonNullable<Draft['providerSync']>
  >([]);
  const [outbox, setOutbox] = useState<Draft['outbox']>(null);
  const [conflict, setConflict] = useState<Draft | null>(null);
  const [changed, setChanged] = useState(0);
  const alive = useRef(false);
  const latest = useRef<DraftValue | null>(null);
  const revision = useRef(0);
  const editId = useRef('');
  const dirty = useRef(false);
  const blocked = useRef(false);
  const pending = useRef<Attempt | null>(null);
  const saving = useRef<Promise<boolean> | null>(null);

  const remember = useCallback(() => {
    if (!latest.current) return;
    const ok = writeRecovery(user, id, {
      value: latest.current,
      revision: revision.current,
      saveId: pending.current?.saveId ?? null,
      editId: editId.current,
    });
    if (alive.current) setRecoveryFailed(!ok);
  }, [id, user]);

  const save = useCallback((): Promise<boolean> => {
    if (saving.current) return saving.current;
    if (!latest.current || blocked.current) return Promise.resolve(false);
    if (!dirty.current) return Promise.resolve(true);
    const attempt = pending.current ?? {
      value: latest.current,
      revision: revision.current,
      saveId: crypto.randomUUID(),
      editId: editId.current,
    };
    pending.current = attempt;
    remember();
    if (alive.current) {
      setStatus('saving');
      setError('');
    }
    const task = (async () => {
      try {
        const { draft } = await mailApi<{ draft: Draft }>(`drafts/${id}`, {
          method: 'PUT',
          body: JSON.stringify({
            ...attempt.value,
            revision: attempt.revision,
            saveId: attempt.saveId,
          }),
        });
        const stored = readRecovery(user, id);
        const ownsRecovery =
          stored?.editId === editId.current && stored.saveId === attempt.saveId;
        revision.current = draft.revision;
        if (alive.current) setReplyContext(draft.replyContext ?? null);
        if (alive.current) setForwarded(draft.forwarded ?? null);
        if (alive.current) setProviderSync(draft.providerSync ?? []);
        pending.current = null;
        if (editId.current === attempt.editId) {
          latest.current = draftValue(draft);
          dirty.current = false;
          if (ownsRecovery) removeRecovery(user, id);
          if (alive.current) {
            setValue(latest.current);
            setStatus('saved');
            setRecoveryFailed(false);
          }
        } else {
          dirty.current = true;
          if (ownsRecovery) remember();
          if (alive.current) {
            setStatus('unsaved');
            setChanged((n) => n + 1);
          }
        }
        return true;
      } catch (failure) {
        if (
          failure instanceof MailApiError &&
          failure.status === 409 &&
          ['conflict', 'outbox'].includes(failure.code ?? '')
        ) {
          blocked.current = true;
          if (alive.current) {
            setStatus('conflict');
            getDraft(id)
              .then((remote) => {
                if (alive.current) {
                  setConflict(remote);
                  setOutbox(remote.outbox ?? null);
                  setReplyContext(remote.replyContext ?? null);
                  setForwarded(remote.forwarded ?? null);
                  setProviderSync(remote.providerSync ?? []);
                }
              })
              .catch(() => {});
          }
        } else {
          // An unknown response keeps the exact request for idempotent replay.
          if (failure instanceof MailApiError && failure.status < 500)
            pending.current = null;
          if (alive.current) setStatus('failed');
        }
        if (alive.current)
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to save this draft.',
          );
        return false;
      } finally {
        saving.current = null;
      }
    })();
    saving.current = task;
    return task;
  }, [id, user, remember]);

  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    async function load() {
      const recovery = readRecovery(user, id);
      try {
        let remote: Draft | null = null;
        try {
          remote = await getDraft(id, controller.signal);
        } catch (failure) {
          if (
            !(
              failure instanceof MailApiError &&
              failure.status === 404 &&
              recovery
            )
          )
            throw failure;
        }
        if (controller.signal.aborted) return;
        const canRecover =
          recovery &&
          (remote
            ? remote.revision === recovery.revision ||
              (recovery.saveId && remote.saveId === recovery.saveId)
            : recovery.revision === 0);
        revision.current =
          recovery && !canRecover ? recovery.revision : (remote?.revision ?? 0);
        latest.current = recovery?.value ?? (remote && draftValue(remote));
        editId.current = recovery?.editId ?? crypto.randomUUID();
        dirty.current = Boolean(
          recovery && (!remote || !sameValue(recovery.value, remote)),
        );
        blocked.current = Boolean(remote?.outbox || (recovery && !canRecover));
        setOutbox(remote?.outbox ?? null);
        setReplyContext(remote?.replyContext ?? null);
        setForwarded(remote?.forwarded ?? null);
        setProviderSync(remote?.providerSync ?? []);
        setValue(latest.current);
        setConflict(blocked.current ? remote : null);
        setStatus(
          blocked.current ? 'conflict' : dirty.current ? 'unsaved' : 'saved',
        );
        if (blocked.current)
          setError(
            remote?.outbox
              ? 'This draft is frozen in Outbox. Review its send status; keep a separate copy of any unsaved edits.'
              : 'This draft changed or was removed elsewhere. Your recovered edits are preserved.',
          );
        else if (dirty.current) {
          remember();
          setChanged((n) => n + 1);
        } else removeRecovery(user, id);
      } catch (failure) {
        if (controller.signal.aborted) return;
        // Recovery text remains editable offline; saving uses its recorded revision.
        if (recovery) {
          latest.current = recovery.value;
          revision.current = recovery.revision;
          editId.current = recovery.editId;
          dirty.current = true;
          setValue(recovery.value);
        }
        setStatus('failed');
        setError(
          failure instanceof Error
            ? failure.message
            : 'Unable to load this draft.',
        );
      }
    }
    void load();
    return () => {
      controller.abort();
      void save();
      alive.current = false;
    };
  }, [id, user, save, remember]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Every edit restarts the save debounce.
  useEffect(() => {
    if (!dirty.current || blocked.current) return;
    const timer = setTimeout(
      () => void save(),
      status === 'failed' ? 5000 : 750,
    );
    return () => clearTimeout(timer);
  }, [changed, status, save]);

  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirty.current) event.preventDefault();
    };
    const online = () => void save();
    window.addEventListener('beforeunload', leave);
    window.addEventListener('online', online);
    return () => {
      window.removeEventListener('beforeunload', leave);
      window.removeEventListener('online', online);
    };
  }, [save]);

  function update(patch: Partial<DraftValue>, content?: Partial<DraftContent>) {
    if (!latest.current) return;
    latest.current = {
      ...latest.current,
      ...patch,
      content: { ...latest.current.content, ...content },
    };
    editId.current = crypto.randomUUID();
    dirty.current = true;
    remember();
    setValue(latest.current);
    setChanged((n) => n + 1);
    if (!blocked.current) setStatus('unsaved');
  }
  async function flush() {
    do {
      if (!(await save())) return false;
    } while (dirty.current);
    return true;
  }
  const adoptSaved = useCallback(
    (remote: Draft) => {
      latest.current = draftValue(remote);
      revision.current = remote.revision;
      editId.current = crypto.randomUUID();
      dirty.current = false;
      blocked.current = Boolean(remote.outbox);
      setOutbox(remote.outbox ?? null);
      setReplyContext(remote.replyContext ?? null);
      setForwarded(remote.forwarded ?? null);
      setProviderSync(remote.providerSync ?? []);
      pending.current = null;
      removeRecovery(user, id);
      setValue(latest.current);
      setConflict(null);
      setError('');
      setStatus(remote.outbox ? 'conflict' : 'saved');
      setEditorVersion((n) => n + 1);
    },
    [id, user],
  );
  async function loadSaved() {
    try {
      const remote = await getDraft(id);
      adoptSaved(remote);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to load saved version.',
      );
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    function poll() {
      if (!latest.current) return;
      void getDraft(id, controller.signal)
        .then((remote) => {
          if (controller.signal.aborted || remote.revision < revision.current)
            return;
          setProviderSync(remote.providerSync ?? []);
          if (
            !dirty.current &&
            !saving.current &&
            !blocked.current &&
            remote.revision > revision.current
          )
            adoptSaved(remote);
        })
        .catch(() => {});
    }
    if (liveRevision) poll();
    const timer = setInterval(poll, 5000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [id, adoptSaved, liveRevision]);
  async function discard() {
    if (saving.current) await saving.current;
    if (blocked.current) {
      setError(
        'Load the saved version before discarding a conflicted draft. Your edits are still preserved.',
      );
      return false;
    }
    // A lost create response may already have saved revision 1. Confirm the
    // exact pending request before deletion rather than leaving a server copy.
    if (pending.current) {
      setError(
        'Confirm the last save before discarding. Use Retry save when the connection is restored.',
      );
      return false;
    }
    try {
      if (revision.current)
        await mailApi(`drafts/${id}`, {
          method: 'DELETE',
          body: JSON.stringify({ revision: revision.current }),
        });
      dirty.current = false;
      blocked.current = true;
      removeRecovery(user, id);
      return true;
    } catch (failure) {
      if (failure instanceof MailApiError && failure.status === 404) {
        dirty.current = false;
        blocked.current = true;
        removeRecovery(user, id);
        return true;
      }
      setError(
        failure instanceof Error ? failure.message : 'Unable to discard draft.',
      );
      return false;
    }
  }
  return {
    value,
    replyContext,
    forwarded,
    providerSync,
    outbox,
    currentRevision: () => revision.current,
    status,
    error,
    recoveryFailed,
    editorVersion,
    conflict,
    update,
    save,
    flush,
    loadSaved,
    discard,
  };
}
