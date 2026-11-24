/**
 * Saved task views. Everyone keeps personal views; a lead (or an admin) can share one with a
 * team, and every member then sees it. Built-in views live in core and are never stored.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskViewConfigSchema, type TaskView, type TaskViewConfig } from '@midden/core';
import { requireUser } from '../app.js';
import type { User } from '../auth/sessions.js';
import { forbidden, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { getTeam, ledTeamIds, memberTeamIds } from '../teams/teams.js';

export const CreateTaskView = z.object({
  name: z.string().trim().min(1).max(80),
  teamId: z.string().max(64).default(''),
  config: TaskViewConfigSchema,
});
export const PatchTaskView = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  teamId: z.string().max(64).optional(),
  config: TaskViewConfigSchema.optional(),
});

interface Row {
  id: string;
  owner_id: string;
  team_id: string | null;
  name: string;
  config: string;
}

const toView = (r: Row): TaskView => ({
  id: r.id,
  name: r.name,
  ownerId: r.owner_id,
  teamId: r.team_id ?? '',
  builtIn: false,
  config: JSON.parse(r.config) as TaskViewConfig,
});

export async function taskViewRoutes(app: FastifyInstance): Promise<void> {
  const mayShareWith = (user: User, teamId: string): boolean =>
    !teamId || user.role === 'admin' || ledTeamIds(app.db, user.id).has(teamId);

  const mayChange = (user: User, r: Row): boolean =>
    user.role === 'admin' ||
    (r.team_id ? ledTeamIds(app.db, user.id).has(r.team_id) : r.owner_id === user.id);

  const load = (id: string): Row => {
    const r = app.db.get<Row>('SELECT * FROM task_views WHERE id = ?', id);
    if (!r) throw notFound('No such view');
    return r;
  };

  app.get('/api/task-views', async (req) => {
    const user = requireUser(req);
    const teams = [...memberTeamIds(app.db, user.id)];
    const rows = app.db.all<Row>(
      `SELECT * FROM task_views
        WHERE (team_id IS NULL AND owner_id = ?)
           OR team_id IN (${teams.map(() => '?').join(',') || "''"})
        ORDER BY name COLLATE NOCASE`,
      user.id,
      ...teams,
    );
    return { views: rows.map(toView) };
  });

  app.post('/api/task-views', async (req, reply) => {
    const user = requireUser(req);
    const b = CreateTaskView.parse(req.body);
    if (b.teamId && !getTeam(app.db, b.teamId)) throw notFound('No such team');
    if (!mayShareWith(user, b.teamId))
      throw forbidden('Only a lead of that team can share a view with it');
    const id = newId('tv');
    const now = nowIso();
    app.db.run(
      'INSERT INTO task_views (id, owner_id, team_id, name, config, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      id,
      user.id,
      b.teamId || null,
      b.name,
      JSON.stringify(b.config),
      now,
      now,
    );
    reply.status(201);
    return { view: toView(load(id)) };
  });

  app.patch<{ Params: { id: string } }>('/api/task-views/:id', async (req) => {
    const user = requireUser(req);
    const r = load(req.params.id);
    if (!mayChange(user, r)) throw forbidden('You can’t change this view');
    const b = PatchTaskView.parse(req.body);
    if (b.teamId !== undefined && b.teamId !== (r.team_id ?? '')) {
      if (b.teamId && !getTeam(app.db, b.teamId)) throw notFound('No such team');
      if (!mayShareWith(user, b.teamId))
        throw forbidden('Only a lead of that team can share a view with it');
    }
    app.db.run(
      'UPDATE task_views SET name = ?, team_id = ?, config = ?, updated_at = ? WHERE id = ?',
      b.name ?? r.name,
      b.teamId === undefined ? r.team_id : b.teamId || null,
      b.config ? JSON.stringify(b.config) : r.config,
      nowIso(),
      r.id,
    );
    return { view: toView(load(r.id)) };
  });

  app.delete<{ Params: { id: string } }>('/api/task-views/:id', async (req) => {
    const user = requireUser(req);
    const r = load(req.params.id);
    if (!mayChange(user, r)) throw forbidden('You can’t delete this view');
    app.db.run('DELETE FROM task_views WHERE id = ?', r.id);
    return { ok: true };
  });
}
