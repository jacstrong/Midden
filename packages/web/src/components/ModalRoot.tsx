import { useUiStore } from '../store/useUiStore';
import { ConfirmModal } from './Modal';
import { EventEditor } from './EventEditor';
import { HostEditor } from './HostEditor';
import { CaseEditor } from './CaseEditor';
import { MenuModal } from './MenuModal';
import { ImportDialog } from './ImportDialog';

export function ModalRoot() {
  const modal = useUiStore((s) => s.modal);
  const closeModal = useUiStore((s) => s.closeModal);
  const openModal = useUiStore((s) => s.openModal);
  switch (modal.kind) {
    case 'none':
      return null;
    case 'event':
      return <EventEditor key={modal.id ?? 'new'} id={modal.id} draft={modal.draft} />;
    case 'host':
      return (
        <HostEditor
          key={modal.id ?? 'new'}
          id={modal.id}
          after={modal.after}
          returnTo={modal.returnTo}
        />
      );
    case 'case':
      return <CaseEditor />;
    case 'menu':
      return <MenuModal />;
    case 'import':
      return (
        <ImportDialog
          parsed={modal.parsed}
          fileName={modal.fileName}
          fileHandle={modal.fileHandle}
        />
      );
    case 'confirm':
      return (
        <ConfirmModal
          title={modal.title}
          message={modal.message}
          okLabel={modal.okLabel}
          danger={modal.danger}
          onOk={modal.onOk}
          onClose={() => (modal.returnTo ? openModal(modal.returnTo) : closeModal())}
        />
      );
  }
}
