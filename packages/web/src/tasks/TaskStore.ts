/**
 * The browser's copy of the tasks it may see, kept live over the task channel of the shared
 * socket. Like ServerStore: own ops apply optimistically and wait in a pending list until the
 * server echoes them; remote ops rebase; rejects roll back. A failed `checkTaskOp` is reported
 * before anything is sent, so "this needs approval" appears instantly.
 */
import {
  applyTaskOp,
  checkTaskOp,
  uid,
  type Actor,
  type ServerMessage,
  type TaskDirectory,
  type TaskOp,
  type TaskState,
} from '@midden/core';
import { create } from 'zustand';
import { SocketHub, type SocketChannel } from '../lib/socket';
import { toast } from '../store/useToasts';
import { useInbox } from './inbox';
import type { Connection, DispatchResult } from '../store/CaseStore';

interface Pending {
  clientOpId: string;
  op: TaskOp;
  baseSeq: number;
  ts: string;
  resolve: (r: DispatchResult) => void;
}

export interface TaskSink {
  setState(state: TaskState, seq: number, directory: TaskDirectory): void;
  setConnection(c: Connection): void;
  notify(message: string, kind?: 'info' | 'warn' | 'bad'): void;
  /** The person's inbox changed. */
  inbox?(m: Extract<ServerMessage, { t: 'notify' }>): void;
  /** The socket (re)connected and a fresh snapshot arrived. */
  reconnected?(): void;
}

const EMPTY_DIRECTORY: TaskDirectory = { users: [], teams: [], cases: [] };

export class TaskStore implements SocketChannel {
  private confirmed: TaskState | null = null;
  private seq = 0;
  private directory: TaskDirectory = EMPTY_DIRECTORY;
  private pending: Pending[] = [];
  private online = false;
  private stopped = false;

  constructor(
    readonly me: Actor,
    private readonly sink: TaskSink,
    private readonly hub: SocketHub = SocketHub.shared(),
  ) {}

  start(): void {
    this.hub.add(this);
  }

  stop(): void {
    this.stopped = true;
    this.hub.remove(this);
  }

  get isOnline(): boolean {
    return this.online;
  }

  onConnecting(): void {
    this.sink.setConnection('connecting');
  }

  onOpen(): void {
    if (!this.stopped) this.hub.send({ t: 'tasks.hello' });
  }

  onClose(): void {
    this.online = false;
    this.sink.setConnection('offline');
  }

  /** The state with pending ops on top, as the user should see it. */
  current(): TaskState | null {
    if (!this.confirmed) return null;
    let s = this.confirmed;
    for (const p of this.pending) s = applyTaskOp(s, p.op, { actorId: this.me.id, ts: p.ts });
    return s;
  }

  private publish(): void {
    const s = this.current();
    if (s) this.sink.setState(s, this.seq, this.directory);
  }

  onMessage(m: ServerMessage): void {
    switch (m.t) {
      case 'tasks.snapshot':
        this.confirmed = m.state;
        this.seq = m.seq;
        this.directory = m.directory;
        if (!this.online) {
          this.online = true;
          this.sink.setConnection('online');
          this.sink.reconnected?.();
          // resend anything still pending with the same ids (the server dedupes)
          for (const p of this.pending)
            this.hub.send({
              t: 'tasks.op',
              clientOpId: p.clientOpId,
              baseSeq: p.baseSeq,
              op: p.op,
            });
        }
        this.publish();
        break;
      case 'tasks.op': {
        if (!this.confirmed || m.seq <= this.seq) return;
        let s = applyTaskOp(this.confirmed, m.op, { actorId: m.actor.id, ts: m.ts });
        if (m.show) {
          s = { ...s, tasks: { ...s.tasks }, comments: { ...s.comments } };
          for (const t of m.show.tasks) s.tasks[t.id] = t;
          for (const c of m.show.comments) s.comments[c.id] = c;
        }
        if (m.hide?.length) {
          const gone = new Set(m.hide);
          s = {
            ...s,
            tasks: Object.fromEntries(Object.entries(s.tasks).filter(([id]) => !gone.has(id))),
            comments: Object.fromEntries(
              Object.entries(s.comments).filter(([, c]) => !gone.has(c.taskId)),
            ),
          };
        }
        this.confirmed = s;
        this.seq = m.seq;
        const i = m.clientOpId ? this.pending.findIndex((p) => p.clientOpId === m.clientOpId) : -1;
        if (i >= 0) this.pending.splice(i, 1)[0]!.resolve({ ok: true, seq: m.seq });
        this.publish();
        break;
      }
      case 'tasks.ack': {
        const i = this.pending.findIndex((p) => p.clientOpId === m.clientOpId);
        if (i >= 0) this.pending.splice(i, 1)[0]!.resolve({ ok: true, seq: m.seq });
        if (m.overwrote?.length) {
          const who = [...new Set(m.overwrote.map((o) => o.byActor.name))].join(', ');
          const fields = [...new Set(m.overwrote.map((o) => o.field.split('/').at(-1)))].join(', ');
          this.sink.notify(`${who} also changed ${fields} — your value won`, 'warn');
        }
        this.publish();
        break;
      }
      case 'tasks.reject': {
        const i = this.pending.findIndex((p) => p.clientOpId === m.clientOpId);
        if (i >= 0) this.pending.splice(i, 1)[0]!.resolve({ ok: false, error: m.message });
        this.sink.notify(m.message, 'bad');
        this.publish();
        break;
      }
      case 'notify':
        this.sink.inbox?.(m);
        break;
      default:
        break;
    }
  }

  dispatch(op: TaskOp): Promise<DispatchResult> {
    const s = this.current();
    if (!this.online || !s)
      return Promise.resolve({ ok: false, error: 'Offline — reconnect to make changes' });
    const ts = new Date().toISOString();
    const invalid = checkTaskOp(s, op, { actorId: this.me.id, ts });
    if (invalid) {
      this.sink.notify(invalid, 'bad');
      return Promise.resolve({ ok: false, error: invalid });
    }
    return new Promise((resolve) => {
      const clientOpId = uid('top');
      this.pending.push({ clientOpId, op, baseSeq: this.seq, ts, resolve });
      this.publish();
      this.hub.send({ t: 'tasks.op', clientOpId, baseSeq: this.seq, op });
    });
  }
}

/* ---- React side ---- */

export interface TasksState {
  state: TaskState | null;
  seq: number;
  directory: TaskDirectory;
  connection: Connection;
  me: Actor | null;
  store: TaskStore | null;
  start(me: Actor): void;
  stop(): void;
  dispatch(op: TaskOp): Promise<DispatchResult>;
}

export const useTasks = create<TasksState>((set, get) => ({
  state: null,
  seq: 0,
  directory: EMPTY_DIRECTORY,
  connection: 'offline',
  me: null,
  store: null,
  start(me) {
    const current = get().store;
    if (current && current.me.id === me.id) return;
    current?.stop();
    const store = new TaskStore(me, {
      setState: (state, seq, directory) => set({ state, seq, directory }),
      setConnection: (connection) => set({ connection }),
      notify: (message, kind) => toast(message, kind),
      inbox: (m) => useInbox.getState().receive(m),
      reconnected: () => void useInbox.getState().load(),
    });
    set({ store, me, state: null });
    store.start();
  },
  stop() {
    get().store?.stop();
    useInbox.getState().reset();
    set({ store: null, me: null, state: null, directory: EMPTY_DIRECTORY, connection: 'offline' });
  },
  dispatch(op) {
    const store = get().store;
    return store
      ? store.dispatch(op)
      : Promise.resolve({ ok: false, error: 'Tasks are not loaded yet' });
  },
}));
