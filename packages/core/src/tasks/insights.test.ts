import { describe, expect, it } from 'vitest';
import { applyTaskOp, emptyTaskState } from './reducer.js';
import type { TaskOp } from './ops.js';
import type { NewTask, TaskState } from './types.js';
import { computeInsights, weekStart, type TaskTransitionRow } from './insights.js';

const H = 3_600_000;
const T0 = Date.UTC(2026, 2, 2, 9); // Monday 2 March 2026, 09:00 UTC
const iso = (ms: number) => new Date(ms).toISOString();

const nt = (id: string, extra: Partial<NewTask> = {}): NewTask => ({
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

/** Applies ops at given times and records transitions the way the projection does. */
function build(steps: [number, TaskOp][]): { s: TaskState; tr: TaskTransitionRow[] } {
  let s = emptyTaskState();
  const tr: TaskTransitionRow[] = [];
  for (const [ms, op] of steps) {
    const prev = s;
    s = applyTaskOp(s, op, { actorId: 'u_lead', ts: iso(ms) });
    for (const t of Object.values(s.tasks)) {
      const p = prev.tasks[t.id];
      if (!p || p.statusId !== t.statusId) {
        const wf = s.workflows[s.defaultWorkflowId]!;
        tr.push({
          taskId: t.id,
          toCategory: wf.statuses.find((x) => x.id === t.statusId)!.category,
          at: iso(ms),
        });
      }
    }
  }
  return { s, tr };
}

const status = (id: string, statusId: string): TaskOp => ({
  type: 'task.set',
  id,
  patch: { statusId },
});

describe('task insights', () => {
  it('starts weeks on Monday', () => {
    expect(weekStart(new Date(Date.UTC(2026, 2, 8, 23))).toISOString()).toBe(
      '2026-03-02T00:00:00.000Z',
    );
    expect(weekStart(new Date(T0)).toISOString()).toBe('2026-03-02T00:00:00.000Z');
  });

  it('counts open work, queues, people, cycle time and what is stuck', () => {
    const { s, tr } = build([
      [
        T0,
        {
          type: 'run.add',
          run: {
            id: 'r1',
            name: 'Hunt',
            teamId: 'tm_host',
            playbookId: '',
            workflowId: 'wf_default',
            startDate: iso(T0),
          },
        },
      ],
      [T0, { type: 'task.add', task: nt('a', { runId: 'r1', assignees: ['u_ann'] }) }],
      [
        T0,
        {
          type: 'task.add',
          task: nt('b', { runId: 'r1', assignees: ['u_ann', 'u_bob'], dueAt: iso(T0 + 2 * H) }),
        },
      ],
      [T0, { type: 'task.add', task: nt('c', { runId: 'r1', teamId: 'tm_host' }) }],
      [T0, { type: 'task.add', task: nt('d', { statusId: 'st_backlog' }) }],
      [T0 + 1 * H, status('a', 'st_doing')],
      [T0 + 5 * H, status('a', 'st_done')],
      [T0 + 2 * H, status('b', 'st_doing')],
      [T0 + 30 * H, status('b', 'st_blocked')],
      [T0 + 31 * H, { type: 'approval.set', taskId: 'c', approverId: 'u_lead' }],
    ]);
    const tasks = Object.values(s.tasks);
    const now = new Date(T0 + 48 * H);
    const r = computeInsights(s, tasks, tr, {
      now,
      from: new Date(T0 - 7 * 24 * H),
      to: now,
      runId: 'r1',
    });

    expect(r.open).toEqual({
      total: 3,
      byCategory: { backlog: 1, todo: 1, in_progress: 0, blocked: 1, done: 1, cancelled: 0 },
      overdue: 1,
      unassigned: 1,
    });
    expect(r.queues).toEqual([{ teamId: 'tm_host', open: 1, oldestAt: iso(T0) }]);
    expect(r.people).toEqual([
      { userId: 'u_ann', open: 1, inProgress: 0, blocked: 1, overdue: 1 },
      { userId: 'u_bob', open: 1, inProgress: 0, blocked: 1, overdue: 1 },
    ]);
    expect(r.throughput.map((w) => [w.week, w.created, w.done])).toEqual([
      ['2026-02-23', 0, 0],
      ['2026-03-02', 4, 1],
    ]);
    expect(r.cycle).toEqual({ count: 1, medianSec: 4 * 3600, p90Sec: 4 * 3600 });
    expect(r.lead).toEqual({ count: 1, medianSec: 5 * 3600, p90Sec: 5 * 3600 });
    // c has waited since creation, b since it was blocked; d is backlog and left out.
    expect(r.stuck.map((x) => [x.id, x.category])).toEqual([
      ['c', 'todo'],
      ['b', 'blocked'],
    ]);
    expect(r.approvals).toEqual([
      { id: 'c', num: 3, title: 'Task c', approverId: 'u_lead', since: iso(T0 + 31 * H) },
    ]);
    expect(r.burndown).toEqual({
      runId: 'r1',
      points: [
        { date: '2026-03-02', total: 3, open: 2 },
        { date: '2026-03-03', total: 3, open: 2 },
        { date: '2026-03-04', total: 3, open: 2 },
      ],
    });
  });

  it('leaves archived tasks out of open counts and skips cycle time without a start', () => {
    const { s, tr } = build([
      [T0, { type: 'task.add', task: nt('a') }],
      [T0, { type: 'task.add', task: nt('b') }],
      [T0 + H, status('a', 'st_done')],
      [T0 + H, { type: 'task.set', id: 'b', patch: { archived: true } }],
    ]);
    const now = new Date(T0 + 2 * H);
    const r = computeInsights(s, Object.values(s.tasks), tr, {
      now,
      from: new Date(T0 - H),
      to: now,
    });
    expect(r.open.total).toBe(0);
    expect(r.cycle.count).toBe(0);
    expect(r.lead).toEqual({ count: 1, medianSec: 3600, p90Sec: 3600 });
    expect(r.burndown).toBeNull();
  });
});
