import { useRef, useState } from 'react';
import type { AttachmentMeta } from '@midden/core';
import { api, ApiError, apiUpload } from '../lib/api';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { toast } from '../store/useToasts';

const KB = 1024;
function humanSize(bytes: number): string {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < KB * KB) return `${(bytes / KB).toFixed(0)} KB`;
  return `${(bytes / (KB * KB)).toFixed(1)} MB`;
}

/** Evidence files attached to one event or host. Hosted mode only; the standalone has no blob store. */
export function Attachments({
  targetKind,
  targetId,
}: {
  targetKind: 'event' | 'host';
  targetId: string;
}) {
  const caseId = useCaseStore((s) => s.caseId);
  const canAttach = useCaseStore((s) => s.capabilities.attachments);
  const canEdit = useCaseStore((s) => s.access.edit);
  const all = useCaseStore((s) => s.state.attachments);
  const confirm = useUiStore((s) => s.confirm);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  if (!canAttach || !caseId) return null;
  const items = Object.values(all).filter(
    (a) => a.target.kind === targetKind && a.target.id === targetId,
  );

  const upload = async (file: File): Promise<void> => {
    setBusy(true);
    const form = new FormData();
    form.append('file', file, file.name);
    form.append('targetKind', targetKind);
    form.append('targetId', targetId);
    try {
      await apiUpload<{ attachment: AttachmentMeta }>(`/api/cases/${caseId}/attachments`, form);
      toast(`Attached ${file.name}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Upload failed', 'bad');
    } finally {
      setBusy(false);
    }
  };

  const remove = (a: AttachmentMeta): void => {
    confirm(
      'Remove attachment',
      `Remove ${a.name} from this ${targetKind}? The file is deleted from the server.`,
      'Remove',
      () => {
        void api('DELETE', `/api/cases/${caseId}/attachments/${a.id}`)
          .then(() => toast('Attachment removed', 'warn'))
          .catch((err: unknown) =>
            toast(err instanceof ApiError ? err.message : 'Could not remove it', 'bad'),
          );
      },
      true,
    );
  };

  return (
    <fieldset className="fs">
      <legend>Evidence files</legend>
      {items.length === 0 && (
        <div className="hint">
          Nothing attached yet. Screenshots, log excerpts and small captures all work.
        </div>
      )}
      <div className="attachgrid">
        {items.map((a) => {
          const href = `/api/cases/${caseId}/attachments/${a.id}`;
          const isImage = a.mime.startsWith('image/');
          return (
            <div key={a.id} className="attach" data-testid="attachment">
              <a href={href} target="_blank" rel="noopener" title={`${a.name} · ${a.mime}`}>
                {isImage ? (
                  <img src={href} alt={a.name} />
                ) : (
                  <span className="attachicon">
                    {a.mime.includes('pdf') ? 'PDF' : a.mime.startsWith('text/') ? 'TXT' : 'FILE'}
                  </span>
                )}
                <span className="attachname">{a.name}</span>
              </a>
              <span className="attachmeta">
                {humanSize(a.size)}
                {canEdit && (
                  <button
                    className="btn sm ghost"
                    onClick={() => remove(a)}
                    data-testid="attachment-remove"
                  >
                    ✕
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
      {canEdit && (
        <>
          <button
            className="btn"
            disabled={busy}
            onClick={() => input.current?.click()}
            style={{ marginTop: 8 }}
            data-testid="attach-file"
          >
            {busy ? 'Uploading…' : '+ Attach a file'}
          </button>
          <input
            ref={input}
            type="file"
            style={{ display: 'none' }}
            data-testid="attach-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
        </>
      )}
    </fieldset>
  );
}
