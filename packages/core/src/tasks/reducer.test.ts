import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  applyTaskOp,
  categoryOf,
  checkTaskOp,
  emptyTaskState,
  inverseTaskOp,
  openBlockers,
} from './reducer.js';
import {
  isClientSafeTaskOp,
  parseTaskOp,
  taskIdsOf,
  taskOpSize,
  taskTouchedFields,
  type TaskOp,
} from './ops.js';
import type { NewTask, TaskCtx, TaskState } from './types.js';

const c = (actorId: string, ts: string): TaskCtx => ({ actorId, ts });
const T0 = c('u_alice', '2026-11-23T10:00:00.000Z');
const T1 = c('u_bob', '2026-11-23T11:00:00.000Z');
const T2 = c('u_carol', '2026-11-23T12:00:00.000Z');

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

function run(s: TaskState, ops: TaskOp[], ctx = T0): TaskState {
  for (const op of ops) {
    const err = checkTaskOp(s, op, ctx);
    if (err) throw new Error(err);
    s = applyTaskOp(s, op, ctx);
  }
  return s;
}

describe('task reducer', () => {
  it('numbers tasks and fills system fields from the context', () => {
    const s = run(emptyTaskState(), [
      { type: 'task.add', task: newTask('t1') },
      { type: 'task.add', task: newTask('t2', { statusId: 'st_done' }) },
    ]);
    expect(s.tasks.t1).toMatchObject({
      num: 1,
      createdBy: 'u_alice',
      createdAt: T0.ts,
      doneAt: '',
    });
    expect(s.tasks.t2).toMatchObject({ num: 2, doneAt: T0.ts });
    expect(s.nextNum).toBe(3);
  });

  it('tracks status and done times across status changes', () => {
    let s = run(emptyTaskState(), [{ type: 'task.add', task: newTask('t1') }]);
    s = run(s, [{ type: 'task.set', id: 't1', patch: { statusId: 'st_doing' } }], T1);
    expect(s.tasks.t1).toMatchObject({ statusAt: T1.ts, doneAt: '' });
    s = run(s, [{ type: 'task.set', id: 't1', patch: { statusId: 'st_done' } }], T2);
    expect(s.tasks.t1).toMatchObject({ statusAt: T2.ts, doneAt: T2.ts });
    // done → cancelled keeps the original completion time
    s = run(s, [{ type: 'task.set', id: 't1', patch: { statusId: 'st_cancelled' } }], T0);
    expect(s.tasks.t1?.doneAt).toBe(T2.ts);
    // a title edit leaves both alone
    s = run(s, [{ type: 'task.set', id: 't1', patch: { title: 'Renamed' } }], T1);
    expect(s.tasks.t1).toMatchObject({ statusAt: T0.ts, doneAt: T2.ts });
  });

  it('assigns one or many tasks, and moves them between teams', () => {
    let s = run(emptyTaskState(), [
      { type: 'task.add', task: newTask('t1') },
      { type: 'task.add', task: newTask('t2', { assignees: ['u_bob'] }) },
    ]);
    s = run(s, [
      {
        type: 'task.assign',
        ids: ['t1', 't2'],
        mode: 'add',
        users: ['u_carol'],
        teamId: 'tm_host',
      },
    ]);
    expect(s.tasks.t1).toMatchObject({ assignees: ['u_carol'], teamId: 'tm_host' });
    expect(s.tasks.t2?.assignees).toEqual(['u_bob', 'u_carol']);
    s = run(s, [{ type: 'task.assign', ids: ['t2'], mode: 'remove', users: ['u_bob'] }]);
    expect(s.tasks.t2).toMatchObject({ assignees: ['u_carol'], teamId: 'tm_host' });
    expect(taskOpSize({ type: 'task.assign', ids: ['a', 'b', 'c'], mode: 'set', users: [] })).toBe(
      3,
    );
  });

  it('records who ticked a checklist item', () => {
    let s = run(emptyTaskState(), [
      { type: 'task.add', task: newTask('t1', { checklist: [{ id: 'c1', text: 'Export' }] }) },
    ]);
    s = run(s, [{ type: 'checklist.set', taskId: 't1', itemId: 'c1', patch: { done: true } }], T1);
    expect(s.tasks.t1?.checklist[0]).toMatchObject({ done: true, doneBy: 'u_bob', doneAt: T1.ts });
    s = run(s, [{ type: 'checklist.set', taskId: 't1', itemId: 'c1', patch: { done: false } }], T2);
    expect(s.tasks.t1?.checklist[0]).toMatchObject({ done: false, doneBy: '', doneAt: '' });
  });

  it('soft-deletes comments and keeps their place', () => {
    let s = run(emptyTaskState(), [
      { type: 'task.add', task: newTask('t1') },
      { type: 'comment.add', comment: { id: 'cm1', taskId: 't1', body: 'First' } },
    ]);
    expect(s.comments.cm1).toMatchObject({ authorId: 'u_alice', body: 'First', createdAt: T0.ts });
    s = run(s, [{ type: 'comment.edit', id: 'cm1', body: 'Edited' }], T1);
    expect(s.comments.cm1).toMatchObject({ body: 'Edited', editedAt: T1.ts });
    s = run(s, [{ type: 'comment.remove', id: 'cm1' }], T2);
    expect(s.comments.cm1).toMatchObject({ body: '', deletedAt: T2.ts });
    expect(checkTaskOp(s, { type: 'comment.edit', id: 'cm1', body: 'x' }, T0)).toMatch(/deleted/);
  });

  it('refuses dependency cycles and self-dependencies', () => {
    const s = run(emptyTaskState(), [
      { type: 'task.add', task: newTask('a') },
      { type: 'task.add', task: newTask('b', { blockedBy: ['a'] }) },
      { type: 'task.add', task: newTask('c') },
      { type: 'dep.add', taskId: 'c', blockedById: 'b' },
    ]);
    expect(checkTaskOp(s, { type: 'dep.add', taskId: 'a', blockedById: 'c' }, T0)).toMatch(/cycle/);
    expect(checkTaskOp(s, { type: 'dep.add', taskId: 'a', blockedById: 'a' }, T0)).toMatch(
      /itself/,
    );
    expect(openBlockers(s, s.tasks.c!).map((t) => t.id)).toEqual(['b']);
  });

  it('blocks done until the approver approves, and lets cancel through', () => {
    let s = run(emptyTaskState(), [
      { type: 'task.add', task: newTask('t1') },
      { type: 'approval.set', taskId: 't1', approverId: 'u_carol' },
    ]);
    expect(s.tasks.t1?.approval).toMatchObject({ state: 'pending', requestedBy: 'u_alice' });
    const done: TaskOp = { type: 'task.set', id: 't1', patch: { statusId: 'st_done' } };
    expect(checkTaskOp(s, done, T0)).toMatch(/needs approval/);
    expect(
      checkTaskOp(s, { type: 'task.set', id: 't1', patch: { statusId: 'st_cancelled' } }, T0),
    ).toBeNull();
    s = run(
      s,
      [{ type: 'approval.decide', taskId: 't1', decision: 'rejected', comment: 'No' }],
      T2,
    );
    expect(checkTaskOp(s, done, T0)).toMatch(/rejected/);
    s = run(
      s,
      [{ type: 'approval.decide', taskId: 't1', decision: 'approved', comment: 'Accept' }],
      T2,
    );
    expect(s.tasks.t1?.approval).toMatchObject({
      state: 'approved',
      decidedBy: 'u_carol',
      comment: 'Accept',
    });
    expect(checkTaskOp(s, done, T0)).toBeNull();
    // changing the approver resets the decision
    s = run(s, [{ type: 'approval.set', taskId: 't1', approverId: 'u_bob' }]);
    expect(s.tasks.t1?.approval?.state).toBe('pending');
  });

  it('keeps every task on a status its workflow has', () => {
    const wf = {
      id: 'wf_hunt',
      name: 'Hunt',
      statuses: [
        { id: 'st_todo', name: 'Queued', category: 'todo' as const, color: '', wipLimit: null },
        {
          id: 'st_triage',
          name: 'Triage',
          category: 'in_progress' as const,
          color: '',
          wipLimit: 3,
        },
        { id: 'st_done', name: 'Closed', category: 'done' as const, color: '', wipLimit: null },
      ],
    };
    let s = run(emptyTaskState(), [
      { type: 'workflow.set', workflow: wf },
      {
        type: 'run.add',
        run: {
          id: 'r1',
          name: 'Acme',
          teamId: '',
          playbookId: '',
          workflowId: 'wf_hunt',
          startDate: T0.ts,
        },
      },
      { type: 'task.add', task: newTask('t1', { runId: 'r1' }) },
    ]);
    expect(
      checkTaskOp(s, { type: 'task.set', id: 't1', patch: { statusId: 'st_doing' } }, T0),
    ).toMatch(/not in workflow "Hunt"/);
    s = run(s, [{ type: 'task.set', id: 't1', patch: { statusId: 'st_triage' } }]);
    expect(categoryOf(s, s.tasks.t1!)).toBe('in_progress');
    // dropping a status still in use is refused, but a batch that remaps first is fine
    const smaller = { ...wf, statuses: wf.statuses.filter((x) => x.id !== 'st_triage') };
    expect(checkTaskOp(s, { type: 'workflow.set', workflow: smaller }, T0)).toMatch(/st_triage/);
    expect(
      checkTaskOp(
        s,
        {
          type: 'batch',
          ops: [
            { type: 'workflow.set', workflow: smaller },
            { type: 'task.set', id: 't1', patch: { statusId: 'st_todo' } },
          ],
        },
        T0,
      ),
    ).toBeNull();
  });

  it('closes runs with a time and reopens them', () => {
    let s = run(emptyTaskState(), [
      {
        type: 'run.add',
        run: {
          id: 'r1',
          name: 'Acme',
          teamId: 'tm',
          playbookId: '',
          workflowId: 'wf_default',
          startDate: T0.ts,
        },
      },
    ]);
    s = run(s, [{ type: 'run.set', id: 'r1', patch: { closed: true } }], T1);
    expect(s.runs.r1).toMatchObject({ closed: true, closedAt: T1.ts, createdBy: 'u_alice' });
    s = run(s, [{ type: 'run.set', id: 'r1', patch: { closed: false } }], T2);
    expect(s.runs.r1?.closedAt).toBe('');
  });
});

describe('task ops', () => {
  it('refuses internal ops and sys payloads from clients', () => {
    expect(isClientSafeTaskOp({ type: 'task.set', id: 't', patch: { title: 'x' } })).toBe(true);
    expect(
      isClientSafeTaskOp({
        type: 'task.set',
        id: 't',
        patch: {},
        sys: { statusAt: '', doneAt: '' },
      }),
    ).toBe(false);
    expect(isClientSafeTaskOp({ type: 'task.drop', id: 't', nextNum: 1 })).toBe(false);
    expect(isClientSafeTaskOp({ type: 'batch', ops: [{ type: 'comment.drop', id: 'c' }] })).toBe(
      false,
    );
    expect(isClientSafeTaskOp({ type: 'op.revert', targetSeq: 1, inverse: { type: 'noop' } })).toBe(
      false,
    );
  });

  it('validates input strictly', () => {
    expect(() => parseTaskOp({ type: 'task.set', id: 't', patch: { num: 9 } })).toThrow();
    expect(() => parseTaskOp({ type: 'task.set', id: 't', patch: { title: '' } })).toThrow();
    expect(() =>
      parseTaskOp({
        type: 'task.add',
        task: { id: 't', title: 'x', statusId: 's', priority: 'meh' },
      }),
    ).toThrow();
    const add = parseTaskOp({
      type: 'task.add',
      task: { id: 't', title: ' Pull logs ', statusId: 's' },
    });
    expect(add).toMatchObject({ task: { title: 'Pull logs', priority: 'medium', labels: [] } });
  });

  it('reports touched fields and task ids', () => {
    expect(
      taskTouchedFields({ type: 'task.set', id: 't1', patch: { title: 'a', dueAt: undefined } }),
    ).toEqual(['t1/title']);
    const ids = taskIdsOf(
      {
        type: 'batch',
        ops: [
          { type: 'task.assign', ids: ['a', 'b'], mode: 'add', users: ['u'] },
          { type: 'comment.edit', id: 'cm', body: 'x' },
        ],
      },
      (id) => (id === 'cm' ? 'c' : undefined),
    );
    expect(ids.sort()).toEqual(['a', 'b', 'c']);
  });
});

// ---- inverse property ------------------------------------------------------------------------

const TASKS = ['t1', 't2', 't3', 't4'];
const USERS = ['u_a', 'u_b', 'u_c'];
const COMMENTS = ['cm1', 'cm2', 'cm3'];
const ITEMS = ['ci1', 'ci2', 'ci3'];
const STATUSES = ['st_backlog', 'st_todo', 'st_doing', 'st_done', 'st_cancelled'];

function seeded(): TaskState {
  return run(emptyTaskState(), [
    {
      type: 'run.add',
      run: {
        id: 'r1',
        name: 'Run',
        teamId: '',
        playbookId: '',
        workflowId: 'wf_default',
        startDate: T0.ts,
      },
    },
    {
      type: 'task.add',
      task: newTask('t1', {
        checklist: [
          { id: 'ci1', text: 'one' },
          { id: 'ci2', text: 'two' },
        ],
      }),
    },
    {
      type: 'task.add',
      task: newTask('t2', { runId: 'r1', assignees: ['u_a'], followers: ['u_b'] }),
    },
    { type: 'task.add', task: newTask('t3', { blockedBy: ['t1'] }) },
    { type: 'comment.add', comment: { id: 'cm1', taskId: 't1', body: 'hello' } },
    { type: 'approval.set', taskId: 't2', approverId: 'u_c' },
  ]);
}

const pick = <T>(xs: T[]): fc.Arbitrary<T> => fc.constantFrom(...xs);
const users = fc.subarray(USERS);

const arbLeaf: fc.Arbitrary<TaskOp> = fc.oneof(
  pick(['t4', 't5', 't1']).map((id): TaskOp => ({
    type: 'task.add',
    task: newTask(id, { statusId: 'st_todo' }),
  })),
  fc
    .record({
      id: pick(TASKS),
      title: fc.option(fc.constantFrom('Alpha', 'Beta', 'Gamma'), { nil: undefined }),
      statusId: fc.option(pick(STATUSES), { nil: undefined }),
      runId: fc.option(pick(['', 'r1']), { nil: undefined }),
      labels: fc.option(fc.subarray(['x', 'y']), { nil: undefined }),
    })
    .map(({ id, ...patch }): TaskOp => ({ type: 'task.set', id, patch })),
  fc
    .record({
      ids: fc.subarray(TASKS, { minLength: 1 }),
      mode: pick(['add', 'remove', 'set'] as const),
      users,
      teamId: fc.option(pick(['', 'tm1']), { nil: undefined }),
    })
    .map((r): TaskOp => ({ type: 'task.assign', ...r })),
  fc
    .record({ id: pick(TASKS), userId: pick(USERS), on: fc.boolean() })
    .map((r): TaskOp => ({ type: 'task.follow', ...r })),
  fc
    .record({
      taskId: pick(TASKS),
      id: pick(ITEMS),
      index: fc.option(fc.nat(3), { nil: undefined }),
    })
    .map((r): TaskOp => ({
      type: 'checklist.add',
      taskId: r.taskId,
      item: { id: r.id, text: 'item' },
      index: r.index,
    })),
  fc
    .record({
      taskId: pick(TASKS),
      itemId: pick(ITEMS),
      done: fc.option(fc.boolean(), { nil: undefined }),
    })
    .map((r): TaskOp => ({
      type: 'checklist.set',
      taskId: r.taskId,
      itemId: r.itemId,
      patch: { done: r.done },
    })),
  fc
    .record({ taskId: pick(TASKS), itemId: pick(ITEMS) })
    .map((r): TaskOp => ({ type: 'checklist.remove', ...r })),
  fc
    .record({ taskId: pick(TASKS), itemId: pick(ITEMS), index: fc.nat(3) })
    .map((r): TaskOp => ({ type: 'checklist.move', ...r })),
  fc
    .record({ taskId: pick(TASKS), blockedById: pick(TASKS), add: fc.boolean() })
    .map((r): TaskOp => ({
      type: r.add ? 'dep.add' : 'dep.remove',
      taskId: r.taskId,
      blockedById: r.blockedById,
    })),
  fc.record({ id: pick(COMMENTS), taskId: pick(TASKS) }).map((r): TaskOp => ({
    type: 'comment.add',
    comment: { id: r.id, taskId: r.taskId, body: 'hi' },
  })),
  pick(COMMENTS).map((id): TaskOp => ({ type: 'comment.edit', id, body: 'edited' })),
  pick(COMMENTS).map((id): TaskOp => ({ type: 'comment.remove', id })),
  fc
    .record({ taskId: pick(TASKS), approverId: pick(['', ...USERS]) })
    .map((r): TaskOp => ({ type: 'approval.set', ...r })),
  fc
    .record({ taskId: pick(TASKS), decision: pick(['approved', 'rejected'] as const) })
    .map((r): TaskOp => ({ type: 'approval.decide', ...r, comment: 'ok' })),
  fc
    .record({
      id: pick(['r1', 'r2']),
      closed: fc.option(fc.boolean(), { nil: undefined }),
      name: fc.option(pick(['A', 'B']), { nil: undefined }),
    })
    .map((r): TaskOp => ({ type: 'run.set', id: r.id, patch: { closed: r.closed, name: r.name } })),
  pick(['r2', 'r1']).map((id): TaskOp => ({
    type: 'run.add',
    run: {
      id,
      name: 'New',
      teamId: '',
      playbookId: '',
      workflowId: 'wf_default',
      startDate: T1.ts,
    },
  })),
);
const arbOp: fc.Arbitrary<TaskOp> = fc.oneof(
  { weight: 4, arbitrary: arbLeaf },
  {
    weight: 1,
    arbitrary: fc.array(arbLeaf, { maxLength: 5 }).map((ops): TaskOp => ({ type: 'batch', ops })),
  },
);

describe('task inverse property', () => {
  it('undoes any op exactly, whatever context either side ran with', () => {
    fc.assert(
      fc.property(fc.array(arbOp, { maxLength: 6 }), arbOp, (prefix, op) => {
        let s = seeded();
        for (const p of prefix) s = applyTaskOp(s, p, T1);
        const inv = inverseTaskOp(s, op);
        const after = applyTaskOp(s, op, T2);
        expect(applyTaskOp(after, inv, T0)).toEqual(s);
        // and undoing the undo (a revert of a revert) restores the post-state
        const redo = inverseTaskOp(after, inv);
        expect(applyTaskOp(applyTaskOp(after, inv, T0), redo, T1)).toEqual(after);
      }),
      { numRuns: 500 },
    );
  });

  it('round-trips ops through the schema', () => {
    fc.assert(
      fc.property(arbOp, (op) => {
        const json = JSON.parse(JSON.stringify(op)) as unknown;
        expect(parseTaskOp(json)).toEqual(JSON.parse(JSON.stringify(op)));
      }),
      { numRuns: 300 },
    );
  });
});
