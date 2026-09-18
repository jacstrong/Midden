import { useEffect } from 'react';
import { useUiStore } from '../store/useUiStore';
import { useCaseStore } from '../store/useCaseStore';
import { useAutosave } from './autosave';
import { exportJson } from './caseActions';

/** N new event · H new host · / search · Ctrl+S save · Esc close. */
export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      const ui = useUiStore.getState();
      if (ev.key === 'Escape' && ui.modal.kind !== 'none') {
        ui.closeModal();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
        ev.preventDefault();
        if (useCaseStore.getState().capabilities.fileBased) void exportJson();
        return;
      }
      const tag = (ev.target as HTMLElement | null)?.tagName?.toLowerCase() ?? '';
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        (ev.target as HTMLElement | null)?.isContentEditable
      )
        return;
      if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
      if (ui.modal.kind !== 'none') return;
      if (ev.key === '/') {
        ev.preventDefault();
        ui.setSidebarOpen(true);
        document.getElementById('fSearch')?.focus();
      } else if (ev.key.toLowerCase() === 'n' && useCaseStore.getState().access.edit) {
        ev.preventDefault();
        ui.openModal({ kind: 'event', id: null });
      } else if (ev.key.toLowerCase() === 'h' && useCaseStore.getState().access.edit) {
        ev.preventDefault();
        ui.openModal({ kind: 'host', id: null });
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

/**
 * Warn before leaving with unsaved file-based changes, but only when they would actually be
 * lost: work that autosave has in this browser comes back on the next load.
 */
export function useUnloadGuard(): void {
  useEffect(() => {
    const onUnload = (ev: BeforeUnloadEvent): void => {
      const cs = useCaseStore.getState();
      if (!cs.dirty || !cs.capabilities.fileBased) return;
      if (useAutosave.getState().status.kind === 'saved') return;
      ev.preventDefault();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);
}
