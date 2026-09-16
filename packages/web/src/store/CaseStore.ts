/**
 * The storage adapter behind the case store. Two implementations: LocalFileStore (standalone
 * build: apply locally, persist by downloading a .json) and ServerStore (hosted build:
 * REST + WebSocket op log). Views branch on `capabilities`, never on how the page was loaded.
 */
import type { CaseState, Op } from '@midden/core';

export interface Capabilities {
  /** Other people can be editing the same case right now. */
  multiUser: boolean;
  attachments: boolean;
  history: boolean;
  /** Terrain is paged from a server rather than held in memory. */
  pagedTerrain: boolean;
  /** Save means "download a file" rather than "already persisted". */
  fileBased: boolean;
}

export type Connection = 'local' | 'connecting' | 'online' | 'offline';

export interface DispatchOptions {
  baseSeq?: number | undefined;
}

export interface DispatchResult {
  ok: boolean;
  seq?: number;
  error?: string;
}

export interface CaseStoreAdapter {
  readonly capabilities: Capabilities;
  /** Called once with the zustand-side hooks so the adapter can push state in. */
  attach(sink: AdapterSink): void;
  /** `baseSeq` is the case seq the user was looking at when they started the edit (for conflict notices). */
  dispatch(op: Op, opts?: DispatchOptions): Promise<DispatchResult>;
  /** Replace the whole document (open a file, load the demo). */
  replace(state: CaseState): Promise<void>;
  close(): void;
}

export interface AdapterSink {
  setState(state: CaseState, seq: number): void;
  setConnection(c: Connection): void;
  notify(message: string, kind?: 'info' | 'warn' | 'bad'): void;
}
