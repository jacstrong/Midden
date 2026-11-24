import { describe, expect, it } from 'vitest';
import { applyTaskOp, checkTaskOp, emptyTaskState } from './reducer.js';
import type { TaskOp } from './ops.js';
import type { NewTask, TaskState, Workflow } from './types.js';
import {
  BUILTIN_VIEWS,
  TaskViewConfigSchema,
  dropOp,
  filterTasks,
  groupTasks,
  sortTasks,
  type ViewContext,
} from './views.js';

const T0 = '2026-03-01T00:00:00.000Z';
const ctxOp = { actorId: 'u_ann', ts: T0 };
const newTask = (id: string, extra: Partial<NewTask> = {}): NewTask => ({
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
const run = (s: TaskState, ops: TaskOp[]): TaskState =>
  ops.reduce((acc, op) => {
    const bad = checkTaskOp(acc, op, ctxOp);
    if (bad) throw new Error(bad);
    return applyTaskOp(acc, op, ctxOp);
  }, s);

const names = {
  user: (id: string) => ({ u_ann: 'Ann', u_bob: 'Bob' })[id] ?? id,
  team: (id: string) => ({ tm_host: 'Host' })[id] ?? id,
  caseName: (id: string) => id,
};
const view: ViewContext = { me: 'u_ann', myTeams: new Set(['tm_host']), now: T0 };

const triage: Workflow = {
  id: 'wf_triage',
  name: 'Triage',
  statuses: [
    { id: 'tr_new', name: 'New', category: 'todo', color: '', wipLimit: null },
    { id: 'tr_look', name: 'Looking', category: 'in_progress', color: '', wipLimit: 2 },
    { id: 'tr_ok', name: 'Closed', category: 'done', color: '', wipLimit: null },
  ],
};

function world(): TaskState {
  return run(emptyTaskState(), [
    {
      type: 'task.add',
      task: newTask('a', { priority: 'low', dueAt: '2026-02-01T00:00:00.000Z' }),
    },
    { type: 'task.add', task: newTask('b', { priority: 'urgent', labels: ['dns'] }) },
    { type: 'task.add', task: newTask('c', { statusId: 'st_done' }) },
    { type: 'task.assign', ids: ['a', 'b'], mode: 'add', users: ['u_ann'], teamId: 'tm_host' },
    { type: 'task.assign', ids: ['b'], mode: 'add', users: ['u_bob'] },
    { type: 'workflow.set', workflow: triage },
    {
      type: 'run.add',
      run: {
        id: 'r1',
        name: 'Hunt 1',
        teamId: 'tm_host',
        workflowId: 'wf_triage',
        playbookId: '',
        startDate: '',
      },
    },
  ]);
}

describe('task views', () => {
  it('filters the way the built-in views promise', () => {
    const s = world();
    const ids = (f: object, showClosed = true) =>
      filterTasks(s, { filter: f, showClosed }, view)
        .map((t) => t.id)
        .sort();
    expect(ids({ mine: true })).toEqual(['a', 'b']);
    expect(ids({ myTeams: true })).toEqual(['a', 'b']);
    expect(ids({ unassigned: true })).toEqual(['c']);
    expect(ids({}, false)).toEqual(['a', 'b']);
    expect(ids({ overdue: true })).toEqual(['a']);
    expect(ids({ text: 't-2' })).toEqual(['b']);
    expect(ids({ labels: ['dns'] })).toEqual(['b']);
    expect(ids({ categories: ['done'] })).toEqual(['c']);
    for (const v of BUILTIN_VIEWS)
      expect(TaskViewConfigSchema.safeParse(v.config).success).toBe(true);
  });

  it('sorts by priority, then due date, then number', () => {
    const s = world();
    expect(sortTasks(Object.values(s.tasks), 'priority').map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(sortTasks(Object.values(s.tasks), 'due').map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('groups by status, falling back to categories across workflows', () => {
    let s = world();
    const cols = groupTasks(s, Object.values(s.tasks), 'status', names);
    expect(cols.map((c) => c.label)).toEqual([
      'Backlog',
      'To do',
      'In progress',
      'Blocked',
      'Done',
      'Cancelled',
    ]);
    expect(cols.find((c) => c.key === 'st_todo')!.tasks).toHaveLength(2);

    s = run(s, [{ type: 'task.add', task: newTask('d', { runId: 'r1', statusId: 'tr_look' }) }]);
    const mixed = groupTasks(s, Object.values(s.tasks), 'status', names);
    expect(mixed.map((c) => c.key)).toEqual(['backlog', 'todo', 'in_progress', 'blocked', 'done']);
    expect(mixed.find((c) => c.key === 'in_progress')!.tasks.map((t) => t.id)).toEqual(['d']);

    const one = groupTasks(s, [s.tasks.d!], 'status', names);
    expect(one.map((c) => [c.label, c.wipLimit])).toEqual([
      ['New', undefined],
      ['Looking', 2],
      ['Closed', undefined],
    ]);
  });

  it('groups by assignee with the queue first, a shared task in each column', () => {
    const s = world();
    const cols = groupTasks(s, Object.values(s.tasks), 'assignee', names);
    expect(cols.map((c) => [c.label, c.tasks.map((t) => t.id)])).toEqual([
      ['Unassigned', ['c']],
      ['Ann', ['a', 'b']],
      ['Bob', ['b']],
    ]);
  });

  it('turns a drop into the op that moves the card', () => {
    let s = world();
    const b = s.tasks.b!;
    const apply = (op: TaskOp | null) => {
      expect(op).not.toBeNull();
      s = run(s, [op!]);
    };
    apply(dropOp(s, b, 'status', 'st_todo', 'st_doing'));
    expect(s.tasks.b!.statusId).toBe('st_doing');
    apply(dropOp(s, s.tasks.b!, 'category', 'in_progress', 'blocked'));
    expect(s.tasks.b!.statusId).toBe('st_blocked');
    apply(dropOp(s, s.tasks.b!, 'assignee', 'u_bob', 'u_cy'));
    expect(s.tasks.b!.assignees).toEqual(['u_ann', 'u_cy']);
    apply(dropOp(s, s.tasks.b!, 'assignee', 'u_ann', ''));
    expect(s.tasks.b!.assignees).toEqual([]);
    apply(dropOp(s, s.tasks.b!, 'label', 'dns', 'proxy'));
    expect(s.tasks.b!.labels).toEqual(['proxy']);
    apply(dropOp(s, s.tasks.b!, 'priority', 'urgent', 'low'));
    expect(s.tasks.b!.priority).toBe('low');
    apply(dropOp(s, s.tasks.b!, 'team', 'tm_host', ''));
    expect(s.tasks.b!.teamId).toBe('');

    // into a run with another workflow: the status follows the category
    apply(dropOp(s, s.tasks.a!, 'run', '', 'r1'));
    expect(s.tasks.a).toMatchObject({ runId: 'r1', statusId: 'tr_new' });
    expect(dropOp(s, s.tasks.a!, 'status', 'tr_new', 'st_doing')).toBeNull();
    expect(dropOp(s, s.tasks.a!, 'status', 'tr_new', 'tr_new')).toBeNull();
  });
});
