/**
 * WebSocket room per case. Protocol shapes live in @midden/core (sync/protocol.ts).
 * Auth comes from the session cookie (same-origin upgrade); Origin is checked against the
 * configured public origin, or the request Host when none is configured.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import {
  ClientMessageSchema,
  SNAPSHOT_GAP,
  type Actor,
  type ClientMessage,
  type PresenceEntry,
  type ServerMessage,
} from '@midden/core';
import { caseAccess } from '../auth/permissions.js';
import { newId, nowIso } from '../lib/ids.js';
import type { CaseRuntime } from '../cases/runtime.js';

const presenceByCase = new Map<string, Map<string, PresenceEntry>>();

function originOk(app: FastifyInstance, req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (tests, CLI)
  if (app.cfg.publicOrigin) return origin === app.cfg.publicOrigin;
  const host = req.headers.host;
  return !!host && (origin === `http://${host}` || origin === `https://${host}`);
}

export async function wsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/ws', { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
    const send = (msg: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    if (!req.user) {
      send({ t: 'error', message: 'Sign in required' });
      socket.close(4401, 'unauthorized');
      return;
    }
    if (!originOk(app, req)) {
      send({ t: 'error', message: 'Bad origin' });
      socket.close(4403, 'origin');
      return;
    }
    const user = req.user;
    const actor: Actor = { id: user.id, name: user.displayName };
    const clientId = newId('c');
    let rt: CaseRuntime | null = null;
    let canEdit = false;

    const room = (): Map<string, PresenceEntry> => {
      let m = presenceByCase.get(rt!.caseId);
      if (!m) {
        m = new Map();
        presenceByCase.set(rt!.caseId, m);
      }
      return m;
    };
    const broadcastPresence = (): void => {
      if (!rt) return;
      rt.broadcast({ t: 'presence', users: [...room().values()] });
    };
    const leave = (): void => {
      if (!rt) return;
      rt.clients.delete(clientId);
      room().delete(clientId);
      broadcastPresence();
      rt = null;
    };

    socket.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessageSchema.parse(JSON.parse(String(data)));
      } catch {
        send({ t: 'error', message: 'Malformed message' });
        return;
      }
      switch (msg.t) {
        case 'ping':
          send({ t: 'pong' });
          return;
        case 'hello': {
          leave();
          const row = app.db.get<{ id: string; restricted: number; archived_at: string | null }>(
            'SELECT id, restricted, archived_at FROM cases WHERE id = ?',
            msg.caseId,
          );
          const access = row ? caseAccess(app.db, user, row) : null;
          if (!row || !access?.read) {
            send({ t: 'error', message: 'No such case' });
            return;
          }
          canEdit = access.edit;
          rt = app.runtimes.get(row.id);
          rt.clients.set(clientId, {
            id: clientId,
            user: actor,
            send: (m) => send(m as ServerMessage),
          });
          if (msg.lastSeq === null || rt.seq - msg.lastSeq > SNAPSHOT_GAP || msg.lastSeq > rt.seq) {
            send({ t: 'snapshot', seq: rt.seq, state: rt.state });
          } else {
            send({ t: 'ops', ops: rt.opsAfter(msg.lastSeq) });
          }
          room().set(clientId, { user: actor, view: 'graph', since: nowIso() });
          broadcastPresence();
          return;
        }
        case 'op': {
          if (!rt) {
            send({
              t: 'reject',
              clientOpId: msg.clientOpId,
              code: 'perm',
              message: 'Send hello first',
            });
            return;
          }
          const r = rt.appendOp(actor, msg.op, {
            clientOpId: msg.clientOpId,
            baseSeq: msg.baseSeq,
            canEdit,
          });
          if (!r.ok) {
            send({ t: 'reject', clientOpId: msg.clientOpId, code: r.code, message: r.message });
            return;
          }
          if (!r.duplicate) rt.broadcast({ t: 'op', ...r.broadcast });
          send({
            t: 'ack',
            clientOpId: msg.clientOpId,
            seq: r.seq,
            overwrote: r.overwrote.length ? r.overwrote : undefined,
          });
          return;
        }
        case 'presence': {
          if (!rt) return;
          room().set(clientId, {
            user: actor,
            view: msg.view,
            selectedId: msg.selectedId,
            editingId: msg.editingId,
            since: room().get(clientId)?.since ?? nowIso(),
          });
          broadcastPresence();
          return;
        }
      }
    });
    socket.on('close', leave);
    socket.on('error', leave);
  });
}
