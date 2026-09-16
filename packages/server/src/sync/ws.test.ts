import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import type { ServerMessage } from '@midden/core';
import { addUser, as, login, testApp } from '../test/helpers.js';

class Client {
  readonly msgs: ServerMessage[] = [];
  private waiters: Array<{
    pred: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }> = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMessage;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => {
        if (w.pred(m)) {
          w.resolve(m);
          return false;
        }
        return true;
      });
    });
  }
  send(m: unknown): void {
    this.ws.send(JSON.stringify(m));
  }
  next<T extends ServerMessage['t']>(
    t: T,
    pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeout = 3000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const existing = this.msgs.find(
      (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>),
    );
    if (existing) {
      this.msgs.splice(this.msgs.indexOf(existing), 1);
      return Promise.resolve(existing as Extract<ServerMessage, { t: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${t}`)), timeout);
      this.waiters.push({
        pred: (m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>),
        resolve: (m) => {
          clearTimeout(timer);
          this.msgs.splice(this.msgs.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { t: T }>);
        },
      });
    });
  }
  close(): void {
    this.ws.close();
  }
}

describe('websocket sync', () => {
  let app: FastifyInstance;
  let base: string;
  let ann: string;
  let bob: string;
  let caseId: string;

  const connect = async (cookie: string, origin?: string): Promise<Client> => {
    const headers: Record<string, string> = { cookie };
    if (origin) headers.origin = origin;
    const ws = new WebSocket(`${base.replace('http', 'ws')}/api/ws`, { headers });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) =>
        reject(new Error(`upgrade failed: ${res.statusCode}`)),
      );
    });
    return new Client(ws);
  };

  beforeEach(async () => {
    app = testApp();
    addUser(app, 'ann');
    addUser(app, 'bob');
    addUser(app, 'vic', 'viewer');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
    ann = await login(app, 'ann');
    bob = await login(app, 'bob');
    const res = await app.inject({
      method: 'POST',
      url: '/api/cases',
      ...as(ann),
      payload: { name: 'Live' },
    });
    caseId = res.json().case.id as string;
  });
  afterEach(async () => {
    await app.close();
  });

  it('refuses unauthenticated and cross-origin upgrades', async () => {
    const anon = new WebSocket(`${base.replace('http', 'ws')}/api/ws`);
    const code = await new Promise<number>((resolve) => anon.on('close', (c) => resolve(c)));
    expect(code).toBe(4401);
    const evil = await connect(ann, 'http://evil.example');
    const code2 = await new Promise<number>((resolve) => evil.ws.on('close', (c) => resolve(c)));
    expect(code2).toBe(4403);
  });

  it('delivers a snapshot, broadcasts ops, acks the sender, and shares presence', async () => {
    const a = await connect(ann, base);
    const b = await connect(bob);
    a.send({ t: 'hello', caseId, lastSeq: null });
    b.send({ t: 'hello', caseId, lastSeq: null });
    const snapA = await a.next('snapshot');
    expect(snapA.seq).toBe(1);
    expect(snapA.state.case.name).toBe('Live');
    await b.next('snapshot');
    const pres = await b.next('presence', (m) => m.users.length === 2);
    expect(pres.users.map((u) => u.user.name).sort()).toEqual(['ANN', 'BOB']);

    a.send({
      t: 'op',
      clientOpId: 'c1',
      baseSeq: 1,
      op: { type: 'host.add', host: { id: 'h1', name: 'WKS' } },
    });
    const ack = await a.next('ack');
    expect(ack).toMatchObject({ clientOpId: 'c1', seq: 2 });
    const echo = await a.next('op');
    expect(echo).toMatchObject({ seq: 2, clientOpId: 'c1', actor: { name: 'ANN' } });
    const remote = await b.next('op');
    expect(remote.op).toEqual({
      type: 'host.add',
      host: expect.objectContaining({ id: 'h1', name: 'WKS' }),
    });

    // same-field conflict is reported in the ack
    b.send({
      t: 'op',
      clientOpId: 'c2',
      baseSeq: 2,
      op: { type: 'host.set', id: 'h1', patch: { name: 'BOB-NAME' } },
    });
    await b.next('ack');
    a.send({
      t: 'op',
      clientOpId: 'c3',
      baseSeq: 2,
      op: { type: 'host.set', id: 'h1', patch: { name: 'ANN-NAME' } },
    });
    const ack3 = await a.next('ack', (m) => m.clientOpId === 'c3');
    expect(ack3.overwrote).toEqual([
      { field: 'h1/name', bySeq: 3, byActor: { id: expect.any(String), name: 'BOB' } },
    ]);

    // presence updates
    a.send({ t: 'presence', view: 'timeline', selectedId: 'h1' });
    const p2 = await b.next('presence', (m) => m.users.some((u) => u.view === 'timeline'));
    expect(p2.users.find((u) => u.user.name === 'ANN')).toMatchObject({
      view: 'timeline',
      selectedId: 'h1',
    });

    // rejects
    a.send({
      t: 'op',
      clientOpId: 'c4',
      baseSeq: 4,
      op: { type: 'host.set', id: 'nope', patch: {} },
    });
    expect(await a.next('reject')).toMatchObject({ clientOpId: 'c4', code: 'notfound' });
    a.send('not json');
    expect(await a.next('error')).toMatchObject({ message: 'Malformed message' });

    a.close();
    const p3 = await b.next('presence', (m) => m.users.length === 1);
    expect(p3.users[0]?.user.name).toBe('BOB');
    b.close();
  });

  it('catches up with ops after a reconnect, resends idempotently, and blocks viewers from editing', async () => {
    const a = await connect(ann);
    a.send({ t: 'hello', caseId, lastSeq: null });
    await a.next('snapshot');
    for (let i = 0; i < 3; i++) {
      a.send({
        t: 'op',
        clientOpId: `k${i}`,
        baseSeq: 1 + i,
        op: { type: 'host.add', host: { id: `h${i}`, name: `H${i}` } },
      });
      await a.next('ack');
    }
    a.close();

    const again = await connect(ann);
    again.send({ t: 'hello', caseId, lastSeq: 2 });
    const catchup = await again.next('ops');
    expect(catchup.ops.map((o) => o.seq)).toEqual([3, 4]);
    // resend a pending op with the same clientOpId
    again.send({
      t: 'op',
      clientOpId: 'k2',
      baseSeq: 3,
      op: { type: 'host.add', host: { id: 'h2', name: 'H2' } },
    });
    const ack = await again.next('ack');
    expect(ack.seq).toBe(4);
    again.close();

    const vic = await login(app, 'vic');
    const v = await connect(vic);
    v.send({ t: 'hello', caseId, lastSeq: null });
    await v.next('snapshot');
    v.send({ t: 'op', clientOpId: 'v1', baseSeq: 4, op: { type: 'noop' } });
    expect(await v.next('reject')).toMatchObject({ code: 'readonly' });
    v.close();
  });
});
