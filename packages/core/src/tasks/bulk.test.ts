import { describe, expect, it } from 'vitest';
import { applyTaskOp, checkTaskOp, emptyTaskState } from './reducer.js';
import type { TaskOp } from './ops.js';
import type { NewTask, TaskState, Workflow } from './types.js';
import {
  distribute,
  distributeOps,
  followOps,
  labelOps,
  openLoad,
  patchOps,
  setStatusOps,
} from './bulk.js';

const T0 = '2026-03-01T00:00:00.000Z';
const ctx = { actorId: 'u_lead', ts: T0 };
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
const run = (s: TaskState, ops: (TaskOp | null)[]): TaskState =>
  ops.reduce((acc, op) => {
    expect(op).not.toBeNull();
    const bad = checkTaskOp(acc, op!, ctx);
    if (bad) throw new Error(bad);
    return applyTaskOp(acc, op!, ctx);
  }, s);

const triage: Workflow = {
  id: 'wf_triage',
  name: 'Triage',
  statuses: [
    { id: 'tr_new', name: 'New', category: 'todo', color: '', wipLimit: null },
    { id: 'tr_ok', name: 'Closed', category: 'done', color: '', wipLimit: null },
  ],
};

function world(): TaskState {
  return run(emptyTaskState(), [
    { type: 'task.add', task: nt('u1', { priority: 'urgent' }) },
    { type: 'task.add', task: nt('h1', { priority: 'high' }) },
    { type: 'task.add', task: nt('h2', { priority: 'high' }) },
    { type: 'task.add', task: nt('m1') },
    { type: 'task.add', task: nt('l1', { priority: 'low' }) },
    // Ann already carries two open tasks and one finished one.
    { type: 'task.add', task: nt('x1', { assignees: ['ann'] }) },
    { type: 'task.add', task: nt('x2', { assignees: ['ann'] }) },
    { type: 'task.add', task: nt('x3', { assignees: ['ann'], statusId: 'st_done' }) },
    { type: 'workflow.set', workflow: triage },
    {
      type: 'run.add',
      run: {
        id: 'r1',
        name: 'R',
        teamId: '',
        workflowId: 'wf_triage',
        playbookId: '',
        startDate: T0,
      },
    },
    { type: 'task.add', task: nt('r', { runId: 'r1', statusId: 'tr_new', labels: ['dns'] }) },
  ]);
}
const pick = (s: TaskState, ...ids: string[]) => ids.map((id) => s.tasks[id]!);

describe('bulk actions', () => {
  it('deals round-robin in priority order', () => {
    const s = world();
    const out = distribute(s, pick(s, 'l1', 'm1', 'h2', 'h1', 'u1'), ['ann', 'bob'], 'round_robin');
    expect(Object.fromEntries(out)).toEqual({ ann: ['u1', 'h2', 'l1'], bob: ['h1', 'm1'] });
  });

  it('balances against the open work people already have', () => {
    const s = world();
    expect(Object.fromEntries(openLoad(s, ['ann', 'bob']))).toEqual({ ann: 2, bob: 0 });
    const out = distribute(
      s,
      pick(s, 'u1', 'h1', 'h2', 'm1', 'l1'),
      ['ann', 'bob', 'cy'],
      'balanced',
    );
    // bob and cy catch up to ann's two before ann gets more
    expect(Object.fromEntries(out)).toEqual({ ann: ['l1'], bob: ['u1', 'h2'], cy: ['h1', 'm1'] });
  });

  it('breaks ties by who has been dealt fewer, so the first name listed gets no extra', () => {
    const s = world();
    // ann has 2 open, bob 0: bob takes two to catch up, then they alternate.
    const out = distribute(s, pick(s, 'u1', 'h1', 'h2', 'm1', 'l1'), ['ann', 'bob'], 'balanced');
    expect(Object.fromEntries(out)).toEqual({ ann: ['h2', 'l1'], bob: ['u1', 'h1', 'm1'] });
    const even = distribute(s, pick(s, 'u1', 'h1', 'h2', 'm1'), ['cy', 'dee'], 'balanced');
    expect(Object.fromEntries(even)).toEqual({ cy: ['u1', 'h2'], dee: ['h1', 'm1'] });
  });

  it('builds one assign per person that replaces assignees and applies cleanly', () => {
    let s = world();
    const op = distributeOps(s, pick(s, 'u1', 'x1'), ['bob', 'cy'], 'round_robin', 'tm_host');
    expect(op).toEqual({
      type: 'batch',
      ops: [
        { type: 'task.assign', ids: ['u1'], mode: 'set', users: ['bob'], teamId: 'tm_host' },
        { type: 'task.assign', ids: ['x1'], mode: 'set', users: ['cy'], teamId: 'tm_host' },
      ],
    });
    s = run(s, [op]);
    expect(s.tasks.x1!.assignees).toEqual(['cy']);
    expect(distributeOps(s, [], ['bob'], 'balanced')).toBeNull();
    expect(distributeOps(s, pick(s, 'u1'), [], 'balanced')).toBeNull();
  });

  it('sets status by category across workflows, and by id within one', () => {
    let s = world();
    const both = pick(s, 'm1', 'r');
    const done = setStatusOps(s, both, { category: 'done' });
    expect(done.skipped).toEqual([]);
    s = run(s, [done.op]);
    expect([s.tasks.m1!.statusId, s.tasks.r!.statusId]).toEqual(['st_done', 'tr_ok']);

    const byId = setStatusOps(s, pick(s, 'm1', 'r'), { statusId: 'st_doing' });
    expect(byId.skipped.map((t) => t.id)).toEqual(['r']);
    const blocked = setStatusOps(s, pick(s, 'r'), { category: 'blocked' });
    expect(blocked).toEqual({ op: null, skipped: [s.tasks.r], awaitingApproval: [] });

    // A task waiting on its approver stays put rather than sinking the batch.
    s = run(s, [{ type: 'approval.set', taskId: 'h1', approverId: 'ann' }]);
    const gated = setStatusOps(s, pick(s, 'h1', 'h2'), { category: 'done' });
    expect(gated.awaitingApproval.map((t) => t.id)).toEqual(['h1']);
    s = run(s, [gated.op]);
    expect([s.tasks.h1!.statusId, s.tasks.h2!.statusId]).toEqual(['st_todo', 'st_done']);
  });

  it('patches, labels and follows only where something changes', () => {
    let s = world();
    expect(patchOps(pick(s, 'm1', 'l1'), { priority: 'low' })).toEqual({
      type: 'task.set',
      id: 'm1',
      patch: { priority: 'low' },
    });
    s = run(s, [labelOps(pick(s, 'm1', 'r'), ['DNS', 'proxy'])]);
    expect(s.tasks.r!.labels).toEqual(['dns', 'proxy']);
    expect(s.tasks.m1!.labels).toEqual(['DNS', 'proxy']);
    s = run(s, [labelOps(pick(s, 'm1', 'r'), [], ['dns'])]);
    expect(s.tasks.r!.labels).toEqual(['proxy']);
    s = run(s, [followOps(pick(s, 'm1', 'r'), ['ann'], true)]);
    expect(followOps(pick(s, 'm1', 'r'), ['ann'], true)).toBeNull();
    expect(s.tasks.r!.followers).toEqual(['ann']);
  });
});
