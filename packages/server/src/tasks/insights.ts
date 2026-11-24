/**
 * `GET /api/tasks/insights`: counts for leads over the tasks the viewer can see. A task linked
 * to a restricted case the viewer cannot read is left out of every number, not just the lists.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  computeInsights,
  weekStart,
  type StatusCategory,
  type Task,
  type TaskInsights,
  type TaskState,
  type TaskTransitionRow,
} from '@midden/core';
import { requireUser } from '../app.js';
import type { Db } from '../db/db.js';
import { badRequest } from '../lib/errors.js';
import { membersOf } from '../teams/teams.js';
import { canSeeTask, viewerFor, type TaskViewer } from './visibility.js';

const DAY = 86_400_000;
/** The default window: this week and the eleven before it. */
export const INSIGHTS_DEFAULT_WEEKS = 12;
export const INSIGHTS_MAX_DAYS = 731;

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/, 'Use a date like 2026-03-01')
  .optional();

export const InsightsQuery = z.object({
  team: z.string().max(64).optional().meta({
    description:
      'A team id: tasks in its queue, in its runs, or assigned to its members. Leave out for everything you can see.',
  }),
  run: z.string().max(64).optional().meta({ description: 'One run; adds its burndown.' }),
  from: dateParam.meta({
    description: `Start of the window for throughput, cycle and lead time. Defaults to ${INSIGHTS_DEFAULT_WEEKS} weeks ago (a Monday).`,
  }),
  to: dateParam.meta({ description: 'End of the window (exclusive). Defaults to now.' }),
});

export type InsightsQueryInput = z.infer<typeof InsightsQuery>;

/** Tasks the viewer can see that the team and run filters keep. */
export function insightTasks(
  db: Db,
  state: TaskState,
  v: TaskViewer,
  q: Pick<InsightsQueryInput, 'team' | 'run'>,
): Task[] {
  const members = q.team ? membersOf(db, [q.team]) : null;
  return Object.values(state.tasks).filter((t) => {
    if (!canSeeTask(v, t)) return false;
    if (q.run && t.runId !== q.run) return false;
    if (q.team && members)
      return (
        t.teamId === q.team ||
        (!!t.runId && state.runs[t.runId]?.teamId === q.team) ||
        t.assignees.some((u) => members.has(u))
      );
    return true;
  });
}

/** Status changes of these tasks, read in chunks to stay under SQLite's parameter limit. */
export function transitionsOf(db: Db, ids: string[]): TaskTransitionRow[] {
  const out: TaskTransitionRow[] = [];
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    for (const r of db.all<{ task_id: string; to_category: StatusCategory; at: string }>(
      `SELECT task_id, to_category, at FROM task_transitions WHERE task_id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk,
    ))
      out.push({ taskId: r.task_id, toCategory: r.to_category, at: r.at });
  }
  return out;
}

export function insightsFor(
  db: Db,
  state: TaskState,
  v: TaskViewer,
  q: InsightsQueryInput,
  now = new Date(),
): TaskInsights {
  // The window's end is exclusive, so the default takes in anything done this millisecond.
  const to = q.to ? new Date(q.to) : new Date(now.getTime() + 1);
  const from = q.from
    ? new Date(q.from)
    : weekStart(new Date(now.getTime() - (INSIGHTS_DEFAULT_WEEKS - 1) * 7 * DAY));
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime()))
    throw badRequest('That is not a date');
  if (from >= to) throw badRequest('`from` must be before `to`');
  if (to.getTime() - from.getTime() > INSIGHTS_MAX_DAYS * DAY)
    throw badRequest('Ask for two years or less at a time');
  if (q.run && !state.runs[q.run]) throw badRequest('No such run');

  const tasks = insightTasks(db, state, v, q);
  // Cycle time needs the history of tasks finished in the window; a burndown needs the run's.
  const fromIso = from.toISOString();
  const need = tasks
    .filter((t) => (q.run && t.runId === q.run) || (t.doneAt && t.doneAt >= fromIso))
    .map((t) => t.id);
  return computeInsights(state, tasks, transitionsOf(db, need), {
    now,
    from,
    to,
    ...(q.run ? { runId: q.run } : {}),
  });
}

export async function insightsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tasks/insights', async (req) => {
    const user = requireUser(req);
    const q = InsightsQuery.parse(req.query);
    return { insights: insightsFor(app.db, app.tasks.state, viewerFor(app.db, user), q) };
  });
}
