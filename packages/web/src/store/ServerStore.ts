/**
 * Hosted adapter: REST + WebSocket op log. Own ops apply optimistically and sit in a pending
 * list until the server echoes them; remote ops rebase the optimistic state; rejects roll back.
 * Editing is refused while disconnected (the plan's "edits need a connection" rule).
 */
import {
  apply,
  uid,
  type Actor,
  type CaseState,
  type ClientMessage,
  type Op,
  type PresenceEntry,
  type ServerMessage,
  touchedFields,
} from '@midden/core';
import type { AdapterSink, CaseStoreAdapter, DispatchOptions, DispatchResult } from './CaseStore';

interface Pending {
  clientOpId: string;
  op: Op;
  baseSeq: number;
  resolve: (r: DispatchResult) => void;
}

export interface ServerSink extends AdapterSink {
  setPresence(users: PresenceEntry[]): void;
  remoteTouch(entityId: string, fields: string[], by: Actor): void;
}

export class ServerStore implements CaseStoreAdapter {
  readonly capabilities = {
    multiUser: true,
    attachments: true,
    history: true,
    pagedTerrain: true,
    fileBased: false,
  };
  private sink: ServerSink | null = null;
  private ws: WebSocket | null = null;
  private confirmed: CaseState | null = null;
  private seq = 0;
  private pending: Pending[] = [];
  private closed = false;
  private backoff = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private online = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  /** Heartbeat: detect a dead socket (NAT timeout, sleep, airplane mode) within a few seconds. */
  static pingIntervalMs = 10_000;
  static pongTimeoutMs = 4_000;
  private presenceState: {
    view: string;
    selectedId?: string | undefined;
    editingId?: string | undefined;
  } = { view: 'graph' };

  constructor(
    readonly caseId: string,
    readonly me: Actor,
    private readonly wsUrl: string = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`,
  ) {}

  private readonly onBrowserOffline = (): void => {
    // The OS says the network is gone: drop the socket now instead of waiting for the heartbeat.
    this.ws?.close();
  };
  private readonly onBrowserOnline = (): void => {
    if (this.closed || this.ws) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.backoff = 500;
    this.connect();
  };

  attach(sink: AdapterSink): void {
    this.sink = sink as ServerSink;
    window.addEventListener('offline', this.onBrowserOffline);
    window.addEventListener('online', this.onBrowserOnline);
    this.connect();
  }

  get isOnline(): boolean {
    return this.online;
  }

  private connect(): void {
    if (this.closed) return;
    this.sink?.setConnection('connecting');
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.send({ t: 'hello', caseId: this.caseId, lastSeq: this.confirmed ? this.seq : null });
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(String(ev.data)) as ServerMessage);
    ws.onclose = () => {
      this.stopHeartbeat();
      this.online = false;
      this.ws = null;
      this.sink?.setConnection('offline');
      this.scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(10_000, this.backoff * 2);
  }

  private send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private publish(): void {
    if (!this.confirmed) return;
    let s = this.confirmed;
    for (const p of this.pending) s = apply(s, p.op);
    this.sink?.setState(s, this.seq);
  }

  private onMessage(m: ServerMessage): void {
    switch (m.t) {
      case 'snapshot':
        this.confirmed = m.state;
        this.seq = m.seq;
        this.becameOnline();
        break;
      case 'ops':
        for (const b of m.ops) this.applyRemote(b.seq, b.op, b.actor, b.clientOpId);
        this.becameOnline();
        break;
      case 'op':
        this.applyRemote(m.seq, m.op, m.actor, m.clientOpId);
        this.publish();
        break;
      case 'ack': {
        const i = this.pending.findIndex((p) => p.clientOpId === m.clientOpId);
        if (i >= 0) {
          const [p] = this.pending.splice(i, 1);
          p!.resolve({ ok: true, seq: m.seq });
        }
        if (m.overwrote?.length) {
          const who = [...new Set(m.overwrote.map((o) => o.byActor.name))].join(', ');
          const fields = m.overwrote.map((o) => o.field.split('/')[1]).join(', ');
          this.sink?.notify(`${who} also changed ${fields} — your value won`, 'warn');
        }
        this.publish();
        break;
      }
      case 'reject': {
        const i = this.pending.findIndex((p) => p.clientOpId === m.clientOpId);
        if (i >= 0) {
          const [p] = this.pending.splice(i, 1);
          p!.resolve({ ok: false, error: m.message });
        }
        this.sink?.notify(`Change rejected: ${m.message}`, 'bad');
        this.publish();
        break;
      }
      case 'presence':
        this.sink?.setPresence(m.users);
        break;
      case 'error':
        this.sink?.notify(m.message, 'bad');
        break;
      case 'pong':
        if (this.pongTimer) clearTimeout(this.pongTimer);
        this.pongTimer = null;
        break;
      case 'scan':
        break;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.send({ t: 'ping' });
      this.pongTimer = setTimeout(() => this.ws?.close(), ServerStore.pongTimeoutMs);
    }, ServerStore.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pingTimer = null;
    this.pongTimer = null;
  }

  private becameOnline(): void {
    this.online = true;
    this.startHeartbeat();
    this.sink?.setConnection('online');
    // resend anything still pending with the same ids (server dedupes)
    for (const p of this.pending)
      this.send({ t: 'op', clientOpId: p.clientOpId, baseSeq: p.baseSeq, op: p.op });
    this.send({ t: 'presence', ...this.presenceState });
    this.publish();
  }

  private applyRemote(seq: number, op: Op, actor: Actor, clientOpId: string | undefined): void {
    if (!this.confirmed || seq <= this.seq) return;
    this.confirmed = apply(this.confirmed, op);
    this.seq = seq;
    const mineIdx = clientOpId ? this.pending.findIndex((p) => p.clientOpId === clientOpId) : -1;
    if (mineIdx >= 0) {
      // the echo of our own op is its confirmation; the ack that follows only carries notices
      const [p] = this.pending.splice(mineIdx, 1);
      p!.resolve({ ok: true, seq });
    } else if (actor.id !== this.me.id) {
      const byEntity = new Map<string, string[]>();
      for (const f of touchedFields(op)) {
        const [id, field] = f.split('/') as [string, string];
        if (!byEntity.has(id)) byEntity.set(id, []);
        byEntity.get(id)!.push(field);
      }
      for (const [id, fields] of byEntity) this.sink?.remoteTouch(id, fields, actor);
    }
  }

  dispatch(op: Op, opts: DispatchOptions = {}): Promise<DispatchResult> {
    if (!this.online || !this.confirmed)
      return Promise.resolve({ ok: false, error: 'Offline — reconnect to make changes' });
    return new Promise((resolve) => {
      const clientOpId = uid('op');
      const baseSeq = Math.min(opts.baseSeq ?? this.seq, this.seq);
      this.pending.push({ clientOpId, op, baseSeq, resolve });
      this.publish();
      this.send({ t: 'op', clientOpId, baseSeq, op });
    });
  }

  presence(view: string, selectedId?: string | undefined, editingId?: string | undefined): void {
    this.presenceState = { view, selectedId, editingId };
    this.send({ t: 'presence', ...this.presenceState });
  }

  async replace(): Promise<void> {
    throw new Error('A hosted case cannot be replaced wholesale; merge a file instead');
  }

  close(): void {
    this.closed = true;
    window.removeEventListener('offline', this.onBrowserOffline);
    window.removeEventListener('online', this.onBrowserOnline);
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
    this.sink = null;
  }
}
