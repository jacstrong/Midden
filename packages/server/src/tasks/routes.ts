/**
 * The parts of task management that are not case content: who can be assigned, who follows
 * what, and each person's notices. Tasks themselves are created and changed with ordinary ops
 * through `/api/cases/:id/ops`, so they share the history, revert and live updates.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../app.js';
import { caseAccess, type CaseRow } from '../auth/permissions.js';
import { findUserById, rowToUser } from '../auth/sessions.js';
import { accessOrThrow } from '../cases/routes.js';
import { notFound } from '../lib/errors.js';
import { nowIso } from '../lib/ids.js';
import { toNotification, type NotificationRow } from './notifications.js';

export const NotificationsQuery = z.object({
  unread: z.enum(['1']).optional().meta({ description: 'Set to 1 for unread notices only.' }),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z
    .string()
    .optional()
    .meta({ description: 'Only notices created before this time, for the next page.' }),
});

export const MarkRead = z
  .object({
    ids: z.array(z.string().min(1)).max(500).optional(),
    all: z.boolean().optional(),
  })
  .refine((b) => b.all || b.ids?.length, { message: 'Pass ids, or all: true' });

export interface Person {
  id: string;
  username: string;
  displayName: string;
  canEdit: boolean;
}

export async function taskRoutes(app: FastifyInstance): Promise<void> {
  /** Everyone who can read the case: the people a task can be assigned to. */
  app.get<{ Params: { id: string } }>('/api/cases/:id/people', async (req) => {
    const { row } = accessOrThrow(app, req, req.params.id, 'read');
    const people: Person[] = [];
    for (const r of app.db.all<Parameters<typeof rowToUser>[0]>(
      'SELECT * FROM users WHERE disabled = 0 ORDER BY display_name COLLATE NOCASE',
    )) {
      const u = rowToUser(r);
      const access = caseAccess(app.db, u, row);
      if (access.read)
        people.push({
          id: u.id,
          username: u.username,
          displayName: u.displayName,
          canEdit: access.edit,
        });
    }
    return { people };
  });

  app.get<{ Params: { id: string } }>('/api/cases/:id/follows', async (req) => {
    const { row } = accessOrThrow(app, req, req.params.id, 'read');
    const follows = app.db
      .all<{ task_id: string; user_id: string }>(
        'SELECT task_id, user_id FROM task_follows WHERE case_id = ? ORDER BY created_at',
        row.id,
      )
      .map((r) => ({ taskId: r.task_id, userId: r.user_id }));
    return { follows };
  });

  // Following needs only read access: a viewer watching the hunt can follow a task too.
  app.put<{ Params: { id: string; taskId: string } }>(
    '/api/cases/:id/tasks/:taskId/follow',
    async (req) => {
      const { user, row } = accessOrThrow(app, req, req.params.id, 'read');
      if (!app.runtimes.get(row.id).state.tasks[req.params.taskId]) throw notFound('No such task');
      app.db.run(
        'INSERT OR IGNORE INTO task_follows (case_id, task_id, user_id, created_at) VALUES (?,?,?,?)',
        row.id,
        req.params.taskId,
        user.id,
        nowIso(),
      );
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string; taskId: string } }>(
    '/api/cases/:id/tasks/:taskId/follow',
    async (req) => {
      const { user, row } = accessOrThrow(app, req, req.params.id, 'read');
      app.db.run(
        'DELETE FROM task_follows WHERE case_id = ? AND task_id = ? AND user_id = ?',
        row.id,
        req.params.taskId,
        user.id,
      );
      return { ok: true };
    },
  );

  app.get<{ Querystring: Record<string, string> }>('/api/notifications', async (req) => {
    const user = requireUser(req);
    const q = NotificationsQuery.parse(req.query);
    const readable = readableCases(app, user.id);
    const rows = app.db
      .all<NotificationRow>(
        `SELECT n.*, c.name AS case_name FROM notifications n JOIN cases c ON c.id = n.case_id
         WHERE n.user_id = ? ${q.unread ? 'AND n.read_at IS NULL' : ''} ${q.before ? 'AND n.created_at < ?' : ''}
         ORDER BY n.created_at DESC, n.id DESC LIMIT ?`,
        // Notices from a case this person can no longer read are skipped; that is rare, so
        // reading a little past the page is enough to fill it.
        ...[user.id, ...(q.before ? [q.before] : []), q.limit * 2],
      )
      .filter((r) => readable(r.case_id))
      .slice(0, q.limit);
    return { notifications: rows.map(toNotification), unread: unreadCount(app, user.id, readable) };
  });

  app.post('/api/notifications/read', async (req) => {
    const user = requireUser(req);
    const body = MarkRead.parse(req.body);
    const ts = nowIso();
    if (body.all)
      app.db.run(
        'UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL',
        ts,
        user.id,
      );
    else
      app.db.transaction(() => {
        for (const id of body.ids ?? [])
          app.db.run(
            'UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL',
            ts,
            id,
            user.id,
          );
      });
    return { ok: true, unread: unreadCount(app, user.id, readableCases(app, user.id)) };
  });
}

/** Whether this person may still read each case, memoised for one request. */
function readableCases(app: FastifyInstance, userId: string): (caseId: string) => boolean {
  const user = findUserById(app.db, userId);
  const memo = new Map<string, boolean>();
  return (caseId) => {
    let ok = memo.get(caseId);
    if (ok === undefined) {
      const row = app.db.get<CaseRow>(
        'SELECT id, restricted, archived_at FROM cases WHERE id = ?',
        caseId,
      );
      ok = !!user && !!row && caseAccess(app.db, user, row).read;
      memo.set(caseId, ok);
    }
    return ok;
  };
}

function unreadCount(
  app: FastifyInstance,
  userId: string,
  readable: (caseId: string) => boolean,
): number {
  let n = 0;
  for (const r of app.db.all<{ case_id: string; n: number }>(
    'SELECT case_id, COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL GROUP BY case_id',
    userId,
  ))
    if (readable(r.case_id)) n += Number(r.n);
  return n;
}
