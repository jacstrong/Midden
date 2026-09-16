import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { mergeOps, readCaseFile, writeCaseFile, type Op } from '@midden/core';
import { requireUser } from '../app.js';
import { caseAccess, type CaseAccess, type CaseRole, type CaseRow } from '../auth/permissions.js';
import { findUserById, type User } from '../auth/sessions.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { csvEscape } from '@midden/core';

const CreateCase = z.object({
  name: z.string().trim().min(1).max(200),
  number: z.string().trim().max(64).default(''),
  analyst: z.string().trim().max(120).default(''),
  classification: z.string().trim().max(120).default(''),
  summary: z.string().max(20_000).default(''),
  restricted: z.boolean().optional(),
});
const PatchCase = z.object({
  archived: z.boolean().optional(),
  restricted: z.boolean().optional(),
});
const SubmitOp = z.object({
  op: z.unknown(),
  clientOpId: z.string().min(1).max(64).optional(),
  baseSeq: z.number().int().nonnegative().optional(),
});
const MemberRole = z.object({ role: z.enum(['owner', 'editor', 'viewer']) });
const Revert = z.object({ seq: z.number().int().positive() });
const ImportBody = z.object({ file: z.unknown() });

interface FullCaseRow extends CaseRow {
  name: string;
  number: string;
  analyst: string;
  classification: string;
  summary: string;
  created_at: string;
  modified_at: string;
  created_by: string | null;
  seq: number;
}

export interface CaseSummary {
  id: string;
  name: string;
  number: string;
  analyst: string;
  classification: string;
  createdAt: string;
  modifiedAt: string;
  archivedAt: string | null;
  restricted: boolean;
  seq: number;
  hosts: number;
  events: number;
  access: CaseAccess;
}

function loadCase(app: FastifyInstance, id: string): FullCaseRow {
  const c = app.db.get<FullCaseRow>('SELECT * FROM cases WHERE id = ?', id);
  if (!c) throw notFound('No such case');
  return c;
}

function summary(app: FastifyInstance, c: FullCaseRow, user: User): CaseSummary {
  const n = (sql: string): number => Number(app.db.get<{ n: number }>(sql, c.id)?.n ?? 0);
  return {
    id: c.id,
    name: c.name,
    number: c.number,
    analyst: c.analyst,
    classification: c.classification,
    createdAt: c.created_at,
    modifiedAt: c.modified_at,
    archivedAt: c.archived_at,
    restricted: !!c.restricted,
    seq: Number(c.seq),
    hosts: n('SELECT COUNT(*) AS n FROM hosts WHERE case_id = ? AND deleted_at IS NULL'),
    events: n('SELECT COUNT(*) AS n FROM events WHERE case_id = ? AND deleted_at IS NULL'),
    access: caseAccess(app.db, user, c),
  };
}

export function accessOrThrow(
  app: FastifyInstance,
  req: FastifyRequest,
  caseId: string,
  need: 'read' | 'edit' | 'manage',
): { user: User; row: FullCaseRow; access: CaseAccess } {
  const user = requireUser(req);
  const row = loadCase(app, caseId);
  const access = caseAccess(app.db, user, row);
  if (!access.read) throw notFound('No such case');
  if (need === 'edit' && !access.edit)
    throw forbidden(
      row.archived_at ? 'This case is archived' : 'You do not have edit access to this case',
    );
  if (need === 'manage' && !access.manage)
    throw forbidden('Only the case owner or an admin can do that');
  return { user, row, access };
}

export async function caseRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { archived?: string } }>('/api/cases', async (req) => {
    const user = requireUser(req);
    const archived = req.query.archived === '1';
    const rows = app.db.all<FullCaseRow>(
      `SELECT * FROM cases WHERE archived_at IS ${archived ? 'NOT NULL' : 'NULL'} ORDER BY modified_at DESC`,
    );
    return { cases: rows.map((c) => summary(app, c, user)).filter((s) => s.access.read) };
  });

  app.post('/api/cases', async (req, reply) => {
    const user = requireUser(req);
    if (user.role === 'viewer') throw forbidden('Viewers cannot create cases');
    const body = CreateCase.parse(req.body);
    const id = newId('case');
    const ts = nowIso();
    const restricted = body.restricted ?? !app.cfg.openCases;
    app.db.transaction(() => {
      app.db.run(
        'INSERT INTO cases (id, name, number, analyst, classification, summary, created_at, modified_at, created_by, restricted, seq) VALUES (?,?,?,?,?,?,?,?,?,?,0)',
        id,
        body.name,
        body.number,
        body.analyst,
        body.classification,
        body.summary,
        ts,
        ts,
        user.id,
        restricted ? 1 : 0,
      );
      app.db.run(
        'INSERT INTO case_members (case_id, user_id, role) VALUES (?,?,?)',
        id,
        user.id,
        'owner',
      );
    });
    // The first op records the metadata so a rebuild from the log reproduces it.
    const rt = app.runtimes.get(id);
    const meta: Op = {
      type: 'case.set',
      patch: {
        name: body.name,
        number: body.number,
        analyst: body.analyst,
        classification: body.classification,
        summary: body.summary,
        created: ts,
        modified: ts,
      },
    };
    rt.appendOp({ id: user.id, name: user.displayName }, meta, { canEdit: true });
    reply.status(201);
    return { case: summary(app, loadCase(app, id), user) };
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id', async (req) => {
    const { user, row } = accessOrThrow(app, req, req.params.id, 'read');
    const members = app.db
      .all<{ user_id: string; role: CaseRole }>(
        'SELECT user_id, role FROM case_members WHERE case_id = ?',
        row.id,
      )
      .map((m) => ({
        userId: m.user_id,
        role: m.role,
        displayName: findUserById(app.db, m.user_id)?.displayName ?? m.user_id,
        username: findUserById(app.db, m.user_id)?.username ?? '',
      }));
    return { case: summary(app, row, user), members };
  });

  app.patch<{ Params: { id: string } }>('/api/cases/:id', async (req) => {
    const { user, row } = accessOrThrow(app, req, req.params.id, 'manage');
    const body = PatchCase.parse(req.body);
    if (body.archived !== undefined)
      app.db.run(
        'UPDATE cases SET archived_at = ? WHERE id = ?',
        body.archived ? nowIso() : null,
        row.id,
      );
    if (body.restricted !== undefined)
      app.db.run('UPDATE cases SET restricted = ? WHERE id = ?', body.restricted ? 1 : 0, row.id);
    return { case: summary(app, loadCase(app, row.id), user) };
  });

  app.delete<{ Params: { id: string } }>('/api/cases/:id', async (req) => {
    const user = requireUser(req);
    if (user.role !== 'admin') throw forbidden('Admin only');
    loadCase(app, req.params.id);
    app.runtimes.drop(req.params.id);
    app.db.run('DELETE FROM cases WHERE id = ?', req.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id/state', async (req) => {
    accessOrThrow(app, req, req.params.id, 'read');
    const rt = app.runtimes.get(req.params.id);
    return { seq: rt.seq, state: rt.state };
  });

  app.post<{ Params: { id: string } }>('/api/cases/:id/ops', async (req) => {
    const { user, access } = accessOrThrow(app, req, req.params.id, 'read');
    const body = SubmitOp.parse(req.body);
    const rt = app.runtimes.get(req.params.id);
    const r = rt.appendOp({ id: user.id, name: user.displayName }, body.op, {
      clientOpId: body.clientOpId,
      baseSeq: body.baseSeq,
      canEdit: access.edit,
    });
    if (!r.ok)
      throw new HttpError(
        r.code === 'notfound' ? 404 : r.code === 'schema' || r.code === 'too_large' ? 400 : 403,
        r.message,
        r.code,
      );
    if (!r.duplicate) rt.broadcast({ t: 'op', ...r.broadcast });
    return { seq: r.seq, overwrote: r.overwrote, duplicate: r.duplicate };
  });

  app.get<{
    Params: { id: string };
    Querystring: { after?: string; limit?: string; format?: string; before?: string };
  }>('/api/cases/:id/ops', async (req, reply) => {
    const { row } = accessOrThrow(app, req, req.params.id, 'read');
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 200) || 200));
    const after = Number(req.query.after ?? 0) || 0;
    const before = req.query.before !== undefined ? Number(req.query.before) : null;
    const rows =
      before !== null
        ? app.db
            .all<OpRow>(
              'SELECT o.*, u.display_name FROM ops o LEFT JOIN users u ON u.id = o.actor_id WHERE o.case_id = ? AND o.seq < ? ORDER BY o.seq DESC LIMIT ?',
              row.id,
              before,
              limit,
            )
            .reverse()
        : app.db.all<OpRow>(
            'SELECT o.*, u.display_name FROM ops o LEFT JOIN users u ON u.id = o.actor_id WHERE o.case_id = ? AND o.seq > ? ORDER BY o.seq LIMIT ?',
            row.id,
            after,
            limit,
          );
    const items = rows.map((r) => ({
      seq: Number(r.seq),
      ts: r.ts,
      actor: { id: r.actor_id, name: r.display_name ?? r.actor_id },
      type: r.type,
      op: JSON.parse(r.payload) as Op,
      inverse: r.inverse ? (JSON.parse(r.inverse) as Op) : null,
      clientOpId: r.client_op_id,
      baseSeq: r.base_seq,
    }));
    if (req.query.format === 'csv') {
      const lines = ['seq,timestamp_utc,actor_id,actor,type,payload,inverse'];
      for (const i of items)
        lines.push(
          [
            i.seq,
            i.ts,
            i.actor.id,
            i.actor.name,
            i.type,
            JSON.stringify(i.op),
            i.inverse ? JSON.stringify(i.inverse) : '',
          ]
            .map(csvEscape)
            .join(','),
        );
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${row.id}-ops.csv"`)
        .send(lines.join('\r\n'));
    }
    return { ops: items, seq: Number(row.seq) };
  });

  app.post<{ Params: { id: string } }>('/api/cases/:id/revert', async (req) => {
    const { user, access } = accessOrThrow(app, req, req.params.id, 'edit');
    const { seq } = Revert.parse(req.body);
    const target = app.db.get<{ inverse: string | null; type: string }>(
      'SELECT inverse, type FROM ops WHERE case_id = ? AND seq = ?',
      req.params.id,
      seq,
    );
    if (!target) throw notFound('No such op');
    if (!target.inverse) throw badRequest('This op has no recorded inverse');
    const rt = app.runtimes.get(req.params.id);
    const op: Op = { type: 'op.revert', targetSeq: seq, inverse: JSON.parse(target.inverse) as Op };
    const r = rt.appendOp({ id: user.id, name: user.displayName }, op, { canEdit: access.edit });
    if (!r.ok) throw new HttpError(400, r.message, r.code);
    rt.broadcast({ t: 'op', ...r.broadcast });
    return { seq: r.seq };
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id/export', async (req, reply) => {
    const { row } = accessOrThrow(app, req, req.params.id, 'read');
    const rt = app.runtimes.get(row.id);
    const file = writeCaseFile(rt.state, { generator: 'MIDDEN server' });
    return reply.header('content-disposition', `attachment; filename="${row.id}.json"`).send(file);
  });

  app.post<{ Params: { id: string } }>('/api/cases/:id/import', async (req) => {
    const { user, access } = accessOrThrow(app, req, req.params.id, 'edit');
    const { file } = ImportBody.parse(req.body);
    const parsed = readCaseFile(file);
    const rt = app.runtimes.get(req.params.id);
    const op = mergeOps(rt.state, parsed.state);
    const r = rt.appendOp({ id: user.id, name: user.displayName }, op, { canEdit: access.edit });
    if (!r.ok) throw new HttpError(400, r.message, r.code);
    rt.broadcast({ t: 'op', ...r.broadcast });
    return { seq: r.seq, report: parsed.report };
  });

  /* ---- membership ---- */

  app.put<{ Params: { id: string; userId: string } }>(
    '/api/cases/:id/members/:userId',
    async (req) => {
      const { row } = accessOrThrow(app, req, req.params.id, 'manage');
      const { role } = MemberRole.parse(req.body);
      if (!findUserById(app.db, req.params.userId)) throw notFound('No such user');
      app.db.run(
        'INSERT INTO case_members (case_id, user_id, role) VALUES (?,?,?) ON CONFLICT DO UPDATE SET role = excluded.role',
        row.id,
        req.params.userId,
        role,
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/cases/:id/members/:userId',
    async (req) => {
      const { row } = accessOrThrow(app, req, req.params.id, 'manage');
      const owners = Number(
        app.db.get<{ n: number }>(
          'SELECT COUNT(*) AS n FROM case_members WHERE case_id = ? AND role = ?',
          row.id,
          'owner',
        )?.n ?? 0,
      );
      const target = app.db.get<{ role: CaseRole }>(
        'SELECT role FROM case_members WHERE case_id = ? AND user_id = ?',
        row.id,
        req.params.userId,
      );
      if (target?.role === 'owner' && owners <= 1)
        throw badRequest('A case needs at least one owner');
      app.db.run(
        'DELETE FROM case_members WHERE case_id = ? AND user_id = ?',
        row.id,
        req.params.userId,
      );
      return { ok: true };
    },
  );
}

interface OpRow {
  seq: number;
  ts: string;
  actor_id: string;
  display_name: string | null;
  type: string;
  payload: string;
  inverse: string | null;
  client_op_id: string | null;
  base_seq: number | null;
}
