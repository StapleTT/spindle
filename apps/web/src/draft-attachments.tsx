import { useEffect, useRef, useState } from 'react';
import { mailApi } from './mail-api.js';

type FileInfo = {
  id: string;
  filename: string;
  size: number;
  state: string;
  code?: string | null;
};
const labels: Record<string, string> = {
  uploading: 'Uploading',
  pending_fetch: 'Fetching original file',
  fetching: 'Fetching original file',
  pending_scan: 'Waiting for security check',
  scanning: 'Checking file',
  ready: 'Ready',
  failed: 'Check failed',
  quarantined: 'Blocked by security check',
};
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

export function DraftAttachments({
  ids,
  onChange,
  onReady,
  disabled,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  onReady: (ready: boolean) => void;
  disabled: boolean;
}) {
  const [files, setFiles] = useState<Record<string, FileInfo>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const requests = useRef(new Map<string, XMLHttpRequest>());
  const currentIds = useRef(ids);
  currentIds.current = ids;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const request of requests.current.values()) request.abort();
    };
  }, []);
  const key = ids.join(',');
  // biome-ignore lint/correctness/useExhaustiveDependencies: key captures the complete ID list; attempt retries a failed check.
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const result = await mailApi<{ files: FileInfo[] }>(
          `uploads?ids=${encodeURIComponent(key)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setFiles(
          Object.fromEntries(result.files.map((file) => [file.id, file])),
        );
        if (
          result.files.some(
            (file) => !['ready', 'failed', 'quarantined'].includes(file.state),
          )
        )
          timer = setTimeout(() => void load(), 1500);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(
            failure instanceof Error
              ? failure.message
              : 'Unable to check attachments.',
          );
          timer = setTimeout(() => void load(), 5000);
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, attempt]);
  useEffect(() => {
    onReady(ids.every((id) => files[id]?.state === 'ready'));
  }, [ids, files, onReady]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (requests.current.size) event.preventDefault();
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, []);

  async function upload(selected: File[]) {
    setError('');
    if (ids.length + selected.length > 10) {
      setError('Choose up to 10 attachments per draft.');
      return;
    }
    if (selected.some((file) => file.size > 10 * 1024 * 1024)) {
      setError('Each attachment must be 10 MiB or smaller.');
      return;
    }
    if (
      ids.reduce((sum, id) => sum + (files[id]?.size ?? 0), 0) +
        selected.reduce((sum, file) => sum + file.size, 0) >
      20 * 1024 * 1024
    ) {
      setError('Attachments must total 20 MiB or less.');
      return;
    }
    setUploading(true);
    try {
      for (const file of selected) {
        if (!alive.current) return;
        const id = crypto.randomUUID();
        const result = await mailApi<{ file: FileInfo }>('uploads', {
          method: 'POST',
          body: JSON.stringify({ id, filename: file.name, size: file.size }),
        });
        if (!alive.current) return;
        const next = [...currentIds.current, id];
        currentIds.current = next;
        onChange(next);
        setFiles((value) => ({ ...value, [id]: result.file }));
        await new Promise<void>((resolve, reject) => {
          const request = new XMLHttpRequest();
          requests.current.set(id, request);
          request.open('PUT', `/api/mail/uploads/${id}`);
          request.setRequestHeader('content-type', 'application/octet-stream');
          request.upload.onprogress = (event) => {
            if (alive.current && event.lengthComputable)
              setProgress((value) => ({
                ...value,
                [id]: Math.round((event.loaded / event.total) * 100),
              }));
          };
          request.onload = () => {
            if (request.status >= 200 && request.status < 300) resolve();
            else {
              let message = 'Upload failed. Select the file again.';
              try {
                message = JSON.parse(request.responseText).message ?? message;
              } catch {}
              reject(new Error(message));
            }
          };
          request.onerror = () =>
            reject(new Error('Upload interrupted. Select the file again.'));
          request.onabort = () => reject(new Error('Upload cancelled.'));
          request.send(file);
        }).finally(() => requests.current.delete(id));
        if (alive.current) setAttempt((value) => value + 1);
      }
    } catch (failure) {
      if (alive.current) {
        setError(failure instanceof Error ? failure.message : 'Upload failed.');
        setAttempt((value) => value + 1);
      }
    } finally {
      if (alive.current) setUploading(false);
    }
  }
  return (
    <section aria-label="Attachments" className="attachments">
      <h3>Attachments</h3>
      <label>
        Add files
        <input
          type="file"
          multiple
          disabled={disabled || uploading}
          onChange={(event) => {
            const selected = Array.from(event.target.files ?? []);
            event.target.value = '';
            void upload(selected);
          }}
        />
      </label>
      <p>
        Up to 10 files, 10 MiB each and 20 MiB total. Files must pass a security
        check before sending. Keep this draft open until uploads finish.
      </p>
      {ids.length > 0 && (
        <ul>
          {ids.map((id) => {
            const file = files[id];
            return (
              <li key={id}>
                <span>
                  {file?.filename ?? 'Attachment unavailable'}
                  {file ? ` (${size(file.size)})` : ''}
                </span>{' '}
                <span role="status">
                  {file
                    ? (labels[file.state] ?? file.state)
                    : 'Loading attachment…'}
                  {file?.state === 'uploading' && progress[id] !== undefined
                    ? ` ${progress[id]}%`
                    : ''}
                </span>{' '}
                {file?.state === 'failed' && (
                  <span>
                    {file.code === 'upload_failed'
                      ? 'Select the file again; this upload was interrupted.'
                      : file.code === 'source_unavailable'
                        ? 'Original file unavailable. Retry fetching it or remove it.'
                        : 'Security check unavailable. Retry when the scanner is running.'}{' '}
                    {file.code !== 'upload_failed' && (
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          void mailApi(`uploads/${id}/retry`, {
                            method: 'POST',
                            body: '{}',
                          })
                            .then(() => setAttempt((value) => value + 1))
                            .catch((failure) =>
                              setError(
                                failure instanceof Error
                                  ? failure.message
                                  : 'Retry failed.',
                              ),
                            );
                        }}
                      >
                        Retry{' '}
                        {file.code === 'source_unavailable' ? 'fetch' : 'check'}
                      </button>
                    )}
                  </span>
                )}
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`Remove ${file?.filename ?? 'attachment'}`}
                  onClick={() => {
                    requests.current.get(id)?.abort();
                    const next = currentIds.current.filter(
                      (value) => value !== id,
                    );
                    currentIds.current = next;
                    onChange(next);
                  }}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {uploading && <p role="status">Uploading attachments…</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
