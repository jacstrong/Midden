import { apply, type CaseState, type Op } from '@midden/core';
import type { AdapterSink, CaseStoreAdapter, DispatchOptions, DispatchResult } from './CaseStore';

/** Standalone adapter: state lives in memory; the .json file is the persistence layer. */
export class LocalFileStore implements CaseStoreAdapter {
  readonly capabilities = {
    multiUser: false,
    attachments: false,
    history: false,
    pagedTerrain: false,
    fileBased: true,
  };
  private sink: AdapterSink | null = null;
  private state: CaseState;
  private seq = 0;

  constructor(initial: CaseState) {
    this.state = initial;
  }

  attach(sink: AdapterSink): void {
    this.sink = sink;
    sink.setConnection('local');
    sink.setState(this.state, this.seq);
  }

  async dispatch(op: Op, _opts?: DispatchOptions): Promise<DispatchResult> {
    const next = apply(this.state, op);
    if (next === this.state) return { ok: true, seq: this.seq };
    this.state = next;
    this.seq += 1;
    this.sink?.setState(this.state, this.seq);
    return { ok: true, seq: this.seq };
  }

  async replace(state: CaseState): Promise<void> {
    this.state = state;
    this.seq += 1;
    this.sink?.setState(this.state, this.seq);
  }

  close(): void {
    this.sink = null;
  }
}
