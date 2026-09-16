import { create } from 'zustand';
import {
  defaultFilters,
  type Filters,
  type GraphMode,
  type TzMode,
  type ParsedCaseFile,
  type Event,
  type Host,
} from '@midden/core';

export type ViewId =
  'graph' | 'timeline' | 'hosts' | 'pivot' | 'matrix' | 'scans' | 'map' | 'builder' | 'report';
export const VIEW_IDS: ViewId[] = [
  'graph',
  'timeline',
  'hosts',
  'pivot',
  'matrix',
  'scans',
  'map',
  'builder',
  'report',
];

export type ModalState =
  | { kind: 'none' }
  | { kind: 'event'; id: string | null; draft?: Partial<Event> | undefined; afterHost?: undefined }
  | {
      kind: 'host';
      id: string | null;
      after?: ((id: string) => void) | undefined;
      returnTo?: ModalState | undefined;
    }
  | { kind: 'case' }
  | { kind: 'menu' }
  | {
      kind: 'import';
      parsed: ParsedCaseFile;
      fileName: string;
      fileHandle: FileSystemFileHandle | null;
    }
  | {
      kind: 'confirm';
      title: string;
      message: string;
      okLabel: string;
      danger: boolean;
      onOk: () => void;
      /** Modal to restore afterwards, so confirming from inside an editor does not close it. */
      returnTo?: ModalState | undefined;
    };

export interface UiState {
  view: ViewId;
  tz: TzMode;
  filters: Filters;
  sel: string | null;
  expanded: Record<string, true>;
  gmode: GraphMode;
  laneAll: boolean;
  matrixOnly: boolean;
  /** Scan selected in the scans and map views. */
  scanId: string | null;
  sidebarOpen: boolean;
  modal: ModalState;

  setView(v: ViewId): void;
  setTz(tz: TzMode): void;
  setFilters(patch: Partial<Filters>): void;
  clearFilters(): void;
  toggleConf(id: string): void;
  toggleFlag(flag: Filters['flags'][number]): void;
  select(id: string | null): void;
  toggleExpanded(id: string): void;
  setExpandedAll(ids: string[] | null): void;
  setGmode(m: GraphMode): void;
  setLaneAll(v: boolean): void;
  setMatrixOnly(v: boolean): void;
  setScanId(id: string | null): void;
  setSidebarOpen(v: boolean): void;
  openModal(m: ModalState): void;
  closeModal(): void;
  confirm(
    title: string,
    message: string,
    okLabel: string,
    onOk: () => void,
    danger?: boolean,
  ): void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'graph',
  tz: 'utc',
  filters: defaultFilters(),
  sel: null,
  expanded: {},
  gmode: 'seq',
  laneAll: false,
  matrixOnly: false,
  scanId: null,
  sidebarOpen: false,
  modal: { kind: 'none' },

  setView: (view) => set({ view }),
  setTz: (tz) => set({ tz }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  clearFilters: () => set({ filters: defaultFilters() }),
  toggleConf: (id) =>
    set((s) => ({
      filters: {
        ...s.filters,
        conf: s.filters.conf.includes(id)
          ? s.filters.conf.filter((x) => x !== id)
          : [...s.filters.conf, id],
      },
    })),
  toggleFlag: (flag) =>
    set((s) => ({
      filters: {
        ...s.filters,
        flags: s.filters.flags.includes(flag)
          ? s.filters.flags.filter((x) => x !== flag)
          : [...s.filters.flags, flag],
      },
    })),
  select: (id) => set((s) => ({ sel: s.sel === id ? null : id })),
  toggleExpanded: (id) =>
    set((s) => {
      const expanded = { ...s.expanded };
      if (expanded[id]) delete expanded[id];
      else expanded[id] = true;
      return { expanded };
    }),
  setExpandedAll: (ids) =>
    set({ expanded: ids ? Object.fromEntries(ids.map((id) => [id, true as const])) : {} }),
  setGmode: (gmode) => set({ gmode }),
  setLaneAll: (laneAll) => set({ laneAll }),
  setMatrixOnly: (matrixOnly) => set({ matrixOnly }),
  setScanId: (scanId) => set({ scanId }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: { kind: 'none' } }),
  confirm: (title, message, okLabel, onOk, danger = false) => {
    const current = get().modal;
    const returnTo = current.kind === 'none' || current.kind === 'confirm' ? undefined : current;
    get().openModal({ kind: 'confirm', title, message, okLabel, onOk, danger, returnTo });
  },
}));

export type { Host };
