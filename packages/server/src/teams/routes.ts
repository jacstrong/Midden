import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import { findUserById } from '../auth/sessions.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { newId, nowIso } from '../lib/ids.js';
import { getTeam, listTeams, memberRole } from './teams.js';

export const CreateTeam = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(''),
});
export const PatchTeam = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
});
export const TeamMemberBody = z.object({ role: z.enum(['lead', 'member']) });

/**
 * Admins create teams and choose leads. A lead manages their own team's members, but cannot
 * appoint or remove a lead.
 */
export async function teamRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/teams', async (req) => {
    requireUser(req);
    return { teams: listTeams(app.db) };
  });

  app.post('/api/teams', async (req, reply) => {
    const user = requireUser(req);
    if (user.role !== 'admin') throw forbidden('Only an admin can create a team');
    const body = CreateTeam.parse(req.body);
    if (app.db.get('SELECT 1 FROM teams WHERE name = ?', body.name))
      throw conflict('A team with that name already exists');
    const id = newId('tm');
    app.db.run(
      'INSERT INTO teams (id, name, description, created_at) VALUES (?,?,?,?)',
      id,
      body.name,
      body.description,
      nowIso(),
    );
    app.tasks.directoryChanged();
    reply.status(201);
    return { team: getTeam(app.db, id) };
  });

  app.patch<{ Params: { id: string } }>('/api/teams/:id', async (req) => {
    const user = requireUser(req);
    if (user.role !== 'admin') throw forbidden('Only an admin can change a team');
    if (!getTeam(app.db, req.params.id)) throw notFound('No such team');
    const body = PatchTeam.parse(req.body);
    if (body.name !== undefined) {
      const clash = app.db.get<{ id: string }>('SELECT id FROM teams WHERE name = ?', body.name);
      if (clash && clash.id !== req.params.id)
        throw conflict('A team with that name already exists');
      app.db.run('UPDATE teams SET name = ? WHERE id = ?', body.name, req.params.id);
    }
    if (body.description !== undefined)
      app.db.run('UPDATE teams SET description = ? WHERE id = ?', body.description, req.params.id);
    app.tasks.directoryChanged();
    return { team: getTeam(app.db, req.params.id) };
  });

  app.delete<{ Params: { id: string } }>('/api/teams/:id', async (req) => {
    const user = requireUser(req);
    if (user.role !== 'admin') throw forbidden('Only an admin can delete a team');
    if (!getTeam(app.db, req.params.id)) throw notFound('No such team');
    // Tasks keep the team id and show it as a deleted team, like a deleted host on an event.
    app.db.run('DELETE FROM teams WHERE id = ?', req.params.id);
    app.tasks.directoryChanged();
    return { ok: true };
  });

  app.put<{ Params: { id: string; userId: string } }>(
    '/api/teams/:id/members/:userId',
    async (req) => {
      const user = requireUser(req);
      const { role } = TeamMemberBody.parse(req.body);
      if (!getTeam(app.db, req.params.id)) throw notFound('No such team');
      const target = findUserById(app.db, req.params.userId);
      if (!target) throw notFound('No such user');
      if (user.role !== 'admin') {
        if (memberRole(app.db, req.params.id, user.id) !== 'lead')
          throw forbidden('Only an admin or a lead of this team can change its members');
        if (role === 'lead' || memberRole(app.db, req.params.id, target.id) === 'lead')
          throw forbidden('Only an admin can appoint or change a lead');
      }
      app.db.run(
        'INSERT INTO team_members (team_id, user_id, role) VALUES (?,?,?) ON CONFLICT DO UPDATE SET role = excluded.role',
        req.params.id,
        target.id,
        role,
      );
      app.tasks.directoryChanged();
      return { team: getTeam(app.db, req.params.id) };
    },
  );

  app.delete<{ Params: { id: string; userId: string } }>(
    '/api/teams/:id/members/:userId',
    async (req) => {
      const user = requireUser(req);
      if (!getTeam(app.db, req.params.id)) throw notFound('No such team');
      const current = memberRole(app.db, req.params.id, req.params.userId);
      if (!current) throw notFound('That user is not on this team');
      if (user.role !== 'admin') {
        if (memberRole(app.db, req.params.id, user.id) !== 'lead')
          throw forbidden('Only an admin or a lead of this team can change its members');
        if (current === 'lead') throw forbidden('Only an admin can remove a lead');
      }
      app.db.run(
        'DELETE FROM team_members WHERE team_id = ? AND user_id = ?',
        req.params.id,
        req.params.userId,
      );
      app.tasks.directoryChanged();
      return { team: getTeam(app.db, req.params.id) };
    },
  );
}
