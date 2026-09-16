import { describe, expect, it, vi } from 'vitest';
import { apply, demoCaseState, emptyState, type Op } from '@midden/core';
import type { AdapterSink, Capabilities, CaseStoreAdapter, DispatchResult } from './CaseStore';
import { LocalFileStore } from './LocalFileStore';
import { useCaseStore } from './useCaseStore';
import { useUiStore } from './useUiStore';
import { loadDemo } from '../lib/caseActions';
import { parseHash } from '../lib/router';

describe('LocalFileStore through the case store', () => {
  it('applies ops locally and tracks dirty state', async () => {
    const cs = useCaseStore.getState();
    cs.attachAdapter(new LocalFileStore(emptyState()));
    await useCaseStore.getState().replace(demoCaseState());
    expect(useCaseStore.getState().dirty).toBe(false);
    await useCaseStore
      .getState()
      .dispatch({ type: 'host.set', id: 'h_vpn', patch: { status: 'compromised' } });
    const s = useCaseStore.getState();
    expect(s.state.hosts.h_vpn?.status).toBe('compromised');
    expect(s.dirty).toBe(true);
    expect(s.seq).toBeGreaterThan(0);
    s.markSaved();
    expect(useCaseStore.getState().dirty).toBe(false);
    // a no-op dispatch does not bump seq
    const before = useCaseStore.getState().seq;
    await useCaseStore.getState().dispatch({ type: 'noop' });
    expect(useCaseStore.getState().seq).toBe(before);
  });
});

describe('hash router', () => {
  it('parses known views only', () => {
    expect(parseHash('#/timeline')).toBe('timeline');
    expect(parseHash('#graph')).toBe('graph');
    expect(parseHash('#/nope')).toBeNull();
    expect(parseHash('')).toBeNull();
  });
});

describe('the example case in a hosted case', () => {
  /** Minimal hosted adapter: records ops, and fails loudly if anything tries to replace. */
  class FakeHostedStore implements CaseStoreAdapter {
    readonly capabilities: Capabilities = {
      multiUser: true,
      attachments: true,
      history: true,
      pagedTerrain: true,
      fileBased: false,
    };
    readonly ops: Op[] = [];
    private sink: AdapterSink | null = null;
    private state = emptyState();
    private seq = 0;

    attach(sink: AdapterSink): void {
      this.sink = sink;
      sink.setState(this.state, this.seq);
      sink.setConnection('online');
    }
    dispatch(op: Op): Promise<DispatchResult> {
      this.ops.push(op);
      this.state = apply(this.state, op);
      this.seq += 1;
      this.sink?.setState(this.state, this.seq);
      return Promise.resolve({ ok: true, seq: this.seq });
    }
    replace(): Promise<void> {
      throw new Error('replace must never be called on a hosted case');
    }
    close(): void {}
  }

  it('merges rather than replacing, so nobody else loses work', async () => {
    const adapter = new FakeHostedStore();
    useCaseStore.getState().attachAdapter(adapter);

    loadDemo(); // the empty-state button, which in file mode replaces the document

    const modal = useUiStore.getState().modal;
    expect(modal.kind).toBe('confirm');
    if (modal.kind !== 'confirm') throw new Error('expected a confirmation');
    modal.onOk();
    await vi.waitFor(() => expect(adapter.ops.length).toBeGreaterThan(0));

    expect(adapter.ops.every((op) => op.type !== 'noop')).toBe(true);
    const demo = demoCaseState();
    const s = useCaseStore.getState().state;
    expect(Object.keys(s.events)).toHaveLength(Object.keys(demo.events).length);
    expect(Object.keys(s.hosts)).toHaveLength(Object.keys(demo.hosts).length);
  });
});
