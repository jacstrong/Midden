import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState, type ServerMessage } from '@midden/core';
import { ServerStore, type ServerSink } from './ServerStore';

/** Minimal in-memory WebSocket double the adapter can drive. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(JSON.parse(d));
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  push(m: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
}

function sink(): ServerSink & {
  states: unknown[];
  conns: string[];
  notes: string[];
  touches: unknown[];
} {
  const s = {
    states: [] as unknown[],
    conns: [] as string[],
    notes: [] as string[],
    touches: [] as unknown[],
    setState: (st: unknown) => void s.states.push(st),
    setConnection: (c: string) => void s.conns.push(c),
    notify: (m: string) => void s.notes.push(m),
    setPresence: () => {},
    remoteTouch: (id: string, fields: string[], by: unknown) =>
      void s.touches.push({ id, fields, by }),
  };
  return s as unknown as ServerSink & typeof s;
}

describe('ServerStore', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('says hello, takes a snapshot, applies optimistically, settles on echo + ack', async () => {
    const me = { id: 'u1', name: 'Ann' };
    const store = new ServerStore('case_1', me, 'ws://test/api/ws');
    const sk = sink();
    store.attach(sk);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    expect(ws.sent[0]).toEqual({ t: 'hello', caseId: 'case_1', lastSeq: null });
    expect(store.isOnline).toBe(false);
    ws.push({ t: 'snapshot', seq: 3, state: emptyState('2026-01-01T00:00:00.000Z') });
    expect(store.isOnline).toBe(true);
    expect(sk.conns).toEqual(['connecting', 'online']);

    const p = store.dispatch({
      type: 'host.add',
      host: {
        id: 'h1',
        name: 'WKS',
        ip: '',
        os: '',
        role: '',
        zone: '',
        crit: 'moderate',
        status: 'unknown',
        owner: '',
        tags: [],
        notes: '',
      },
    });
    const last = sk.states.at(-1) as { hosts: Record<string, unknown> };
    expect(last.hosts.h1).toBeDefined(); // optimistic
    const sentOp = ws.sent.at(-1) as { t: string; clientOpId: string; baseSeq: number };
    expect(sentOp).toMatchObject({ t: 'op', baseSeq: 3 });
    // an explicit baseSeq (captured when an editor opened) is sent as-is, never above the current seq
    void store.dispatch({ type: 'noop' }, { baseSeq: 1 });
    expect((ws.sent.at(-1) as { baseSeq: number }).baseSeq).toBe(1);
    void store.dispatch({ type: 'noop' }, { baseSeq: 99 });
    expect((ws.sent.at(-1) as { baseSeq: number }).baseSeq).toBe(3);

    ws.push({
      t: 'op',
      seq: 4,
      op: (sentOp as unknown as { op: never }).op,
      actor: me,
      ts: 'now',
      clientOpId: sentOp.clientOpId,
    });
    ws.push({ t: 'ack', clientOpId: sentOp.clientOpId, seq: 4 });
    await expect(p).resolves.toEqual({ ok: true, seq: 4 });
    const settled = sk.states.at(-1) as { hosts: Record<string, unknown> };
    expect(settled.hosts.h1).toBeDefined();
    expect(sk.touches).toEqual([]); // own op never marks fields
  });

  it('rolls back on reject, marks remote changes, and warns on overwrites', async () => {
    const me = { id: 'u1', name: 'Ann' };
    const bob = { id: 'u2', name: 'Bob' };
    const store = new ServerStore('case_1', me, 'ws://test/api/ws');
    const sk = sink();
    store.attach(sk);
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.push({ t: 'snapshot', seq: 0, state: emptyState() });
    const p = store.dispatch({ type: 'host.set', id: 'ghost', patch: { name: 'x' } });
    const sent = ws.sent.at(-1) as { clientOpId: string };
    ws.push({
      t: 'reject',
      clientOpId: sent.clientOpId,
      code: 'notfound',
      message: 'Host ghost does not exist',
    });
    await expect(p).resolves.toEqual({ ok: false, error: 'Host ghost does not exist' });
    expect(sk.notes.at(-1)).toMatch(/rejected/);

    ws.push({
      t: 'op',
      seq: 1,
      op: {
        type: 'host.add',
        host: {
          id: 'h1',
          name: 'B',
          ip: '',
          os: '',
          role: '',
          zone: '',
          crit: 'moderate',
          status: 'unknown',
          owner: '',
          tags: [],
          notes: '',
        },
      },
      actor: bob,
      ts: 'now',
    });
    ws.push({
      t: 'op',
      seq: 2,
      op: { type: 'host.set', id: 'h1', patch: { status: 'compromised', notes: 'n' } },
      actor: bob,
      ts: 'now',
    });
    expect(sk.touches.at(-1)).toEqual({ id: 'h1', fields: ['status', 'notes'], by: bob });
    const st = sk.states.at(-1) as { hosts: Record<string, { status: string }> };
    expect(st.hosts.h1?.status).toBe('compromised');

    ws.push({
      t: 'ack',
      clientOpId: 'other',
      seq: 3,
      overwrote: [{ field: 'h1/status', bySeq: 2, byActor: bob }],
    });
    expect(sk.notes.at(-1)).toBe('Bob also changed status — your value won');
  });

  it('refuses edits while offline and resends pending ops after reconnecting', async () => {
    const me = { id: 'u1', name: 'Ann' };
    const store = new ServerStore('case_1', me, 'ws://test/api/ws');
    const sk = sink();
    store.attach(sk);
    const ws1 = FakeSocket.instances[0]!;
    ws1.open();
    ws1.push({ t: 'snapshot', seq: 5, state: emptyState() });
    const pending = store.dispatch({ type: 'noop' });
    const sent = ws1.sent.at(-1) as { clientOpId: string };
    ws1.close(); // drops before ack
    expect(sk.conns.at(-1)).toBe('offline');
    await expect(store.dispatch({ type: 'noop' })).resolves.toEqual({
      ok: false,
      error: 'Offline — reconnect to make changes',
    });

    vi.advanceTimersByTime(600);
    const ws2 = FakeSocket.instances[1]!;
    expect(ws2).toBeDefined();
    ws2.open();
    expect(ws2.sent[0]).toEqual({ t: 'hello', caseId: 'case_1', lastSeq: 5 });
    ws2.push({ t: 'ops', ops: [] });
    const resent = ws2.sent.find((m) => (m as { t: string }).t === 'op') as { clientOpId: string };
    expect(resent.clientOpId).toBe(sent.clientOpId);
    ws2.push({ t: 'ack', clientOpId: sent.clientOpId, seq: 6 });
    await expect(pending).resolves.toEqual({ ok: true, seq: 6 });
    store.close();
  });
});
