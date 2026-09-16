import type { ParsedCaseFile } from '@midden/core';
import { Modal } from './Modal';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { applyImport } from '../lib/caseActions';

export function ImportDialog({
  parsed,
  fileName,
  fileHandle,
}: {
  parsed: ParsedCaseFile;
  fileName: string;
  fileHandle: FileSystemFileHandle | null;
}) {
  const state = useCaseStore((s) => s.state);
  const fileBased = useCaseStore((s) => s.capabilities.fileBased);
  const closeModal = useUiStore((s) => s.closeModal);
  const go = (mode: 'merge' | 'replace'): void => {
    closeModal();
    void applyImport(parsed, mode, fileName, fileHandle);
  };
  return (
    <Modal
      title="Open case file"
      onClose={closeModal}
      narrow
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn" onClick={() => go('merge')} data-testid="import-merge">
            Merge
          </button>
          {fileBased && (
            <button className="btn mag" onClick={() => go('replace')} data-testid="import-replace">
              Replace
            </button>
          )}
        </>
      }
    >
      <p style={{ margin: 0, lineHeight: 1.7 }}>
        This investigation already holds <b>{Object.keys(state.events).length}</b> events across{' '}
        <b>{Object.keys(state.hosts).length}</b> hosts. The file you picked has{' '}
        <b>{parsed.report.events}</b> events.
      </p>
      <p style={{ color: 'var(--dim)', margin: '10px 0 0' }}>
        Replacing discards what is on screen. Merging keeps both and skips anything with an ID you
        already have.
      </p>
      {parsed.report.dropped.length > 0 && (
        <p style={{ color: 'var(--am)', margin: '10px 0 0' }}>
          {parsed.report.dropped.length} entries in the file could not be read and will be skipped.
        </p>
      )}
    </Modal>
  );
}
