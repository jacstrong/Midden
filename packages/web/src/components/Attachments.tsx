import type { AttachmentMeta } from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore, type ModalState } from '../store/useUiStore';
import { humanSize } from './AttachmentDialogs';

/**
 * Evidence files attached to one event or host. Hosted mode only; the standalone has no blob
 * store. Uploading and inspecting happen in their own dialogs, which return to this editor.
 */
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
  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);

  if (!canAttach || !caseId) return null;
  const items = Object.values(all).filter(
    (a) => a.target.kind === targetKind && a.target.id === targetId,
  );
  const returnTo: ModalState | undefined = modal.kind === 'none' ? undefined : modal;
  const open = (a: AttachmentMeta): void => openModal({ kind: 'attachment', id: a.id, returnTo });

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
          const isImage = a.mime.startsWith('image/') && !a.dangerous;
          return (
            <button
              key={a.id}
              type="button"
              className={a.dangerous ? 'attach dangerous' : 'attach'}
              onClick={() => open(a)}
              title={a.note ? `${a.name}\n${a.note}` : a.name}
              data-testid="attachment"
              data-dangerous={a.dangerous ? '1' : undefined}
            >
              {isImage ? (
                <img src={href} alt={a.name} />
              ) : (
                <span className="attachicon">
                  {a.dangerous
                    ? 'ZIP'
                    : a.mime.includes('pdf')
                      ? 'PDF'
                      : a.mime.startsWith('text/')
                        ? 'TXT'
                        : 'FILE'}
                </span>
              )}
              <span className="attachname">{a.name}</span>
              <span className="attachmeta">
                {humanSize(a.size)}
                {a.dangerous && <span className="badge dangerbadge">dangerous</span>}
              </span>
            </button>
          );
        })}
      </div>
      {canEdit && (
        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={() => openModal({ kind: 'attach-upload', targetKind, targetId, returnTo })}
          data-testid="attach-file"
        >
          + Attach a file
        </button>
      )}
    </fieldset>
  );
}
