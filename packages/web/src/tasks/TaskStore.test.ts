import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTaskOp,
  emptyTaskState,
  emptyState,
  type NewTask,
  type ServerMessage,
  type TaskDirectory,
  type TaskOp,
  type TaskState,
} from '@midden/core';
import { SocketHub } from '../lib/socket';
import { ServerStore, type ServerSink } from '../store/ServerStore';
import { TaskStore, type TaskSink } from './TaskStore';

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: { t: string; [k: string]: unknown }[] = [];
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
  ofType(t: string) {
    return this.sent.filter((m) => m.t === t);
  }
}

const me = { id: 'u1', name: 'Ann' };
const bob = { id: 'u2', name: 'Bob' };
const T0 = '2026-01-01T00:00:00.000Z';
const DIR: TaskDirectory = { users: [], teams: [], cases: [] };

const newTask = (id: string, extra: Partial<NewTask> = {}): NewTask => ({
  id,
  title: `Task ${id}`,
  description: '',
  statusId: 'st_todo',
  priority: 'medium',
  runId: '',
  labels: [],
  dueAt: '',
  caseId: '',
  hostId: '',
  eventId: '',
  ...extra,
});

function sink() {
  const s = {
    states: [] as TaskState[],
    conns: [] as string[],
    notes: [] as string[],
    setState: (st: TaskState) => void s.states.push(st),
    setConnection: (c: string) => void s.conns.push(c),
    notify: (m: string) => void s.notes.push(m),
    last: () => s.states.at(-1)!,
  };
  return s as typeof s & TaskSink;
}

/** A server-side state with one task in it, as the server would have logged it. */
function seeded(): TaskState {
  return applyTaskOp(
    emptyTaskState(),
    { type: 'task.add', task: newTask('t1', { num: 1 }) },
    { actorId: bob.id, ts: T0 },
  );
}

describe('TaskStore', () => {
  let hub: SocketHub;
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
    hub = new SocketHub('ws://test/api/ws');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function online(state = seeded(), seq = 1) {
    const sk = sink();
    const store = new TaskStore(me, sk, hub);
    store.start();
    const ws = FakeSocket.instances[0]!;
    ws.open();
    ws.push({ t: 'tasks.snapshot', seq, state, directory: DIR });
    return { sk, store, ws };
  }

  it('says hello, applies its own ops at once, settles on echo and ack', async () => {
    const { sk, store, ws } = online();
    expect(ws.sent[0]).toEqual({ t: 'tasks.hello' });
    expect(sk.conns).toEqual(['connecting', 'online']);
    expect(sk.last().tasks.t1!.title).toBe('Task t1');

    const op: TaskOp = { type: 'task.set', id: 't1', patch: { title: 'Sweep DNS logs' } };
    const p = store.dispatch(op);
    expect(sk.last().tasks.t1!.title).toBe('Sweep DNS logs');
    const sent = ws.ofType('tasks.op')[0]!;
    expect(sent).toMatchObject({ baseSeq: 1, op });

    ws.push({
      t: 'tasks.op',
      seq: 2,
      op,
      actor: me,
      ts: T0,
      clientOpId: sent.clientOpId as string,
    });
    ws.push({ t: 'tasks.ack', clientOpId: sent.clientOpId as string, seq: 2 });
    await expect(p).resolves.toEqual({ ok: true, seq: 2 });
    expect(sk.last().tasks.t1!.title).toBe('Sweep DNS logs');
  });

  it('rebases its pending op on top of someone else’s', () => {
    const { sk, store, ws } = online();
    void store.dispatch({ type: 'task.set', id: 't1', patch: { title: 'Mine' } });
    ws.push({
      t: 'tasks.op',
      seq: 2,
      op: { type: 'task.set', id: 't1', patch: { title: 'Theirs', priority: 'high' } },
      actor: bob,
      ts: T0,
    });
    expect(sk.last().tasks.t1).toMatchObject({ title: 'Mine', priority: 'high' });
  });

  it('refuses an invalid op before sending it', async () => {
    const { sk, store, ws } = online();
    const r = await store.dispatch({ type: 'task.set', id: 'nope', patch: { title: 'x' } });
    expect(r.ok).toBe(false);
    expect(ws.ofType('tasks.op')).toHaveLength(0);
    expect(sk.notes).toHaveLength(1);
  });

  it('rolls back when the server rejects', async () => {
    const { sk, store, ws } = online();
    const p = store.dispatch({ type: 'task.set', id: 't1', patch: { title: 'Nope' } });
    const sent = ws.ofType('tasks.op')[0]!;
    ws.push({
      t: 'tasks.reject',
      clientOpId: sent.clientOpId as string,
      code: 'perm',
      message: 'Viewers can’t edit tasks',
    });
    await expect(p).resolves.toEqual({ ok: false, error: 'Viewers can’t edit tasks' });
    expect(sk.last().tasks.t1!.title).toBe('Task t1');
    expect(sk.notes).toEqual(['Viewers can’t edit tasks']);
  });

  it('adds tasks it is shown and forgets ones it is told to hide', () => {
    const { sk, ws } = online();
    const comment = {
      id: 'c1',
      taskId: 't9',
      authorId: bob.id,
      body: 'hi',
      createdAt: T0,
      editedAt: '',
      deletedAt: '',
    };
    const t9 = { ...seeded().tasks.t1!, id: 't9', num: 9, title: 'Now visible' };
    ws.push({
      t: 'tasks.op',
      seq: 2,
      op: { type: 'noop' },
      actor: bob,
      ts: T0,
      show: { tasks: [t9], comments: [comment] },
    });
    expect(sk.last().tasks.t9!.title).toBe('Now visible');
    expect(sk.last().comments.c1!.body).toBe('hi');
    ws.push({ t: 'tasks.op', seq: 3, op: { type: 'noop' }, actor: bob, ts: T0, hide: ['t9'] });
    expect(sk.last().tasks.t9).toBeUndefined();
    expect(sk.last().comments.c1).toBeUndefined();
    // a replayed op is ignored
    ws.push({
      t: 'tasks.op',
      seq: 3,
      op: { type: 'task.set', id: 't1', patch: { title: 'late' } },
      actor: bob,
      ts: T0,
    });
    expect(sk.last().tasks.t1!.title).toBe('Task t1');
  });

  it('resends pending ops with the same id after a reconnect', () => {
    const { sk, store, ws } = online();
    void store.dispatch({ type: 'task.set', id: 't1', patch: { title: 'Offline edit' } });
    const first = ws.ofType('tasks.op')[0]!;
    ws.close();
    expect(sk.conns.at(-1)).toBe('offline');
    vi.advanceTimersByTime(500);
    const ws2 = FakeSocket.instances[1]!;
    ws2.open();
    expect(ws2.sent[0]).toEqual({ t: 'tasks.hello' });
    ws2.push({ t: 'tasks.snapshot', seq: 1, state: seeded(), directory: DIR });
    expect(ws2.ofType('tasks.op')[0]).toEqual(first);
    expect(sk.last().tasks.t1!.title).toBe('Offline edit');
  });

  it('won’t take changes while offline', async () => {
    const sk = sink();
    const store = new TaskStore(me, sk, hub);
    store.start();
    await expect(store.dispatch({ type: 'noop' })).resolves.toMatchObject({ ok: false });
  });
});

describe('SocketHub', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('carries the case and the task channel on one socket', () => {
    const hub = new SocketHub('ws://test/api/ws');
    const tasks = new TaskStore(me, sink(), hub);
    tasks.start();
    const ws = FakeSocket.instances[0]!;
    ws.open();

    // the case store joins an already-open socket: no second socket, hello at once
    const cs = new ServerStore('case_1', me, hub);
    cs.attach({
      setState: () => {},
      setConnection: () => {},
      notify: () => {},
      setPresence: () => {},
      remoteTouch: () => {},
    } as unknown as ServerSink);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(ws.sent.map((m) => m.t)).toEqual(['tasks.hello', 'hello']);

    // each channel takes its own messages
    ws.push({ t: 'snapshot', seq: 0, state: emptyState(T0) });
    ws.push({ t: 'tasks.snapshot', seq: 0, state: emptyTaskState(), directory: DIR });
    expect(cs.isOnline).toBe(true);
    expect(tasks.isOnline).toBe(true);

    // leaving the case keeps the socket for tasks; the last channel out closes it
    cs.close();
    expect(ws.sent.at(-1)).toEqual({ t: 'leave' });
    expect(ws.readyState).toBe(1);
    tasks.stop();
    expect(ws.readyState).toBe(3);
  });

  it('shares one hub per URL', () => {
    expect(SocketHub.shared('ws://a/x')).toBe(SocketHub.shared('ws://a/x'));
    expect(SocketHub.shared('ws://a/x')).not.toBe(SocketHub.shared('ws://b/x'));
  });
});
