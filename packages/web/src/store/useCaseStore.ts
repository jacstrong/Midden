import { create } from 'zustand';
import { emptyState, type Actor, type CaseState, type Op, type PresenceEntry } from '@midden/core';
import type {
  CaseStoreAdapter,
  Capabilities,
  Connection,
  DispatchOptions,
  DispatchResult,
} from './CaseStore';
import type { ServerSink } from './ServerStore';
import { LocalFileStore } from './LocalFileStore';
import { toast } from './useToasts';
import type { CaseAccess } from '../lib/api';

export interface RemoteTouch {
  by: Actor;
  at: string;
}

export interface CaseStoreState {
  state: CaseState;
  seq: number;
  connection: Connection;
  capabilities: Capabilities;
  /** Unsaved changes since the last file save (file-based adapters only). */
  dirty: boolean;
  fileName: string | null;
  fileHandle: FileSystemFileHandle | null;
  adapter: CaseStoreAdapter;
  /** Hosted mode only. */
  caseId: string | null;
  me: Actor | null;
  access: CaseAccess;
  presence: PresenceEntry[];
  /** entityId → field → who changed it remotely while it may be open in an editor. */
  remoteTouches: Record<string, Record<string, RemoteTouch>>;

  dispatch(op: Op, opts?: DispatchOptions): Promise<DispatchResult>;
  replace(
    state: CaseState,
    opts?: { fileName?: string | null; fileHandle?: FileSystemFileHandle | null },
  ): Promise<void>;
  markSaved(): void;
  attachAdapter(
    adapter: CaseStoreAdapter,
    ctx?: { caseId?: string | null; me?: Actor | null; access?: CaseAccess },
  ): void;
  clearTouches(entityId: string): void;
}

const FULL_ACCESS: CaseAccess = { read: true, edit: true, manage: true, role: 'local' };

export const useCaseStore = create<CaseStoreState>((set, get) => {
  const sink: ServerSink = {
    setState(state, seq) {
      set({ state, seq });
    },
    setConnection(connection) {
      set({ connection });
    },
    notify(message, kind) {
      toast(message, kind);
    },
    setPresence(presence) {
      set({ presence });
    },
    remoteTouch(entityId, fields, by) {
      set((s) => {
        const at = new Date().toISOString();
        const cur = { ...(s.remoteTouches[entityId] ?? {}) };
        for (const f of fields) cur[f] = { by, at };
        return { remoteTouches: { ...s.remoteTouches, [entityId]: cur } };
      });
    },
  };
  const initial = new LocalFileStore(emptyState());
  const store: CaseStoreState = {
    state: emptyState(),
    seq: 0,
    connection: 'local',
    capabilities: initial.capabilities,
    dirty: false,
    fileName: null,
    fileHandle: null,
    adapter: initial,
    caseId: null,
    me: null,
    access: FULL_ACCESS,
    presence: [],
    remoteTouches: {},

    async dispatch(op, opts) {
      const r = await get().adapter.dispatch(op, opts);
      if (r.ok && get().capabilities.fileBased) set({ dirty: true });
      if (!r.ok && r.error) toast(r.error, 'bad');
      return r;
    },
    async replace(state, opts = {}) {
      await get().adapter.replace(state);
      set({
        dirty: false,
        fileName: opts.fileName === undefined ? get().fileName : opts.fileName,
        fileHandle: opts.fileHandle === undefined ? get().fileHandle : opts.fileHandle,
      });
    },
    markSaved() {
      set({ dirty: false });
    },
    attachAdapter(adapter, ctx = {}) {
      get().adapter.close();
      set({
        adapter,
        capabilities: adapter.capabilities,
        dirty: false,
        state: emptyState(),
        seq: 0,
        presence: [],
        remoteTouches: {},
        caseId: ctx.caseId ?? null,
        me: ctx.me ?? null,
        access: ctx.access ?? FULL_ACCESS,
        fileName: null,
        fileHandle: null,
      });
      adapter.attach(sink);
    },
    clearTouches(entityId) {
      set((s) => {
        if (!s.remoteTouches[entityId]) return s;
        const { [entityId]: _drop, ...rest } = s.remoteTouches;
        return { remoteTouches: rest };
      });
    },
  };
  queueMicrotask(() => initial.attach(sink));
  return store;
});

/** Convenience for non-React code. */
export const dispatchOp = (op: Op): Promise<DispatchResult> => useCaseStore.getState().dispatch(op);
