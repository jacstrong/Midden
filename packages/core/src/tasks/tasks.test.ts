import { describe, expect, it } from 'vitest';
import { apply, emptyState, inverse, normalizeState } from '../ops/reducer.js';
import type { Op } from '../ops/ops.js';
import type { CaseState, Host, Task } from '../domain/types.js';
import { readCaseFile, writeCaseFile } from '../codec/casefile.js';
import {
  blankTask,
  bulkEditOp,
  duplicateTasksOp,
  filterTasks,
  isOverdue,
  moveTaskOp,
  rankBetween,
  removeTasksOp,
  tasksByStatus,
} from './tasks.js';
import {
  parseCsv,
  planTaskImport,
  readTaskTemplate,
  taskTemplateCsv,
  TaskTemplateError,
  writeTaskTemplate,
} from './template.js';
import { taskNotices } from './notify.js';

const NOW = '2026-07-15T09:00:00.000Z';
const lead = { id: 'u_lead', name: 'Lead' };

const host = (id: string, name: string, ip: string): Host => ({
  id,
  name,
  ip,
  os: '',
  role: '',
  zone: '',
  crit: 'moderate',
  status: 'unknown',
  owner: '',
  tags: [],
  notes: '',
});

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  ...blankTask(lead, NOW),
  id,
  title: id,
  ...extra,
});

function board(...tasks: Task[]): CaseState {
  let s = emptyState(NOW);
  s = apply(s, { type: 'host.add', host: host('h_dc', 'DC01', '10.0.0.10') });
  s = apply(s, { type: 'host.add', host: host('h_fs', 'FS01', '10.0.0.20, 10.9.0.20') });
  for (const t of tasks) s = apply(s, { type: 'task.add', task: t });
  return s;
}

const roundTrips = (s: CaseState, op: Op): void => {
  expect(apply(apply(s, op), inverse(s, op))).toEqual(s);
};

describe('the board', () => {
  it('groups tasks by column in rank order', () => {
    const s = board(
      task('b', { rank: 2 }),
      task('a', { rank: 1 }),
      task('c', { status: 'done', rank: 0 }),
    );
    const cols = tasksByStatus(Object.values(s.tasks));
    expect(cols.todo.map((t) => t.id)).toEqual(['a', 'b']);
    expect(cols.done.map((t) => t.id)).toEqual(['c']);
    expect(cols.backlog).toEqual([]);
  });

  it('finds a rank between neighbours, or past either end', () => {
    expect(rankBetween(undefined, undefined)).toBe(0);
    expect(rankBetween(1, 2)).toBe(1.5);
    expect(rankBetween(undefined, 4)).toBe(3);
    expect(rankBetween(4, undefined)).toBe(5);
  });

  it('moves a card into a column above another, stamping completion on done', () => {
    const s = board(
      task('a', { rank: 0 }),
      task('b', { rank: 1, status: 'done', completedAt: NOW }),
      task('c', { rank: 2, status: 'done', completedAt: NOW }),
    );
    const op = moveTaskOp(s, 'a', 'done', 'c', '2026-07-15T10:00:00.000Z')!;
    const next = apply(s, op);
    expect(tasksByStatus(Object.values(next.tasks)).done.map((t) => t.id)).toEqual(['b', 'a', 'c']);
    expect(next.tasks.a?.completedAt).toBe('2026-07-15T10:00:00.000Z');
    roundTrips(s, op);

    const back = apply(next, moveTaskOp(next, 'a', 'todo', null)!);
    expect(back.tasks.a?.status).toBe('todo');
    expect(back.tasks.a?.completedAt).toBe('');
  });

  it('does nothing when a card is dropped where it already is', () => {
    const s = board(task('a', { rank: 0 }), task('b', { rank: 1 }));
    expect(moveTaskOp(s, 'a', 'todo', 'b')).toBeNull();
    expect(moveTaskOp(s, 'b', 'todo', null)).toBeNull();
    expect(moveTaskOp(s, 'missing', 'todo', null)).toBeNull();
  });

  it('filters to mine, unassigned, followed, and by text across names and hosts', () => {
    const s = board(
      task('a', { assignees: ['u_ann'], title: 'Sweep DCs', hostIds: ['h_dc'] }),
      task('b', { assignees: [], title: 'Image server', priority: 'urgent' }),
      task('c', { assignees: ['u_bob'], title: 'Proxy review' }),
    );
    const ids = (f: Parameters<typeof filterTasks>[1]): string[] =>
      filterTasks(s, f)
        .map((t) => t.id)
        .sort();
    expect(ids({ scope: 'all' })).toEqual(['a', 'b', 'c']);
    expect(ids({ scope: 'mine', me: 'u_ann' })).toEqual(['a']);
    expect(ids({ scope: 'mine', me: null })).toEqual([]);
    expect(ids({ scope: 'unassigned' })).toEqual(['b']);
    expect(ids({ scope: 'following', me: 'u_ann', following: new Set(['c']) })).toEqual(['a', 'c']);
    expect(ids({ scope: 'all', query: 'dc01' })).toEqual(['a']);
    expect(ids({ scope: 'all', query: 'bob', names: (id) => id.replace('u_', '') })).toEqual(['c']);
    expect(ids({ scope: 'all', priority: 'urgent' })).toEqual(['b']);
    expect(ids({ scope: 'all', hostId: 'h_dc' })).toEqual(['a']);
  });

  it('knows when a task is overdue', () => {
    const now = Date.parse(NOW);
    expect(isOverdue({ due: '2026-07-15T08:00:00Z', status: 'doing' }, now)).toBe(true);
    expect(isOverdue({ due: '2026-07-15T08:00:00Z', status: 'done' }, now)).toBe(false);
    expect(isOverdue({ due: '', status: 'doing' }, now)).toBe(false);
    expect(isOverdue({ due: '2026-07-16T08:00:00Z', status: 'doing' }, now)).toBe(false);
  });
});

describe('bulk actions', () => {
  const s = board(
    task('a', { assignees: ['u_ann'], tags: ['dc'] }),
    task('b', { assignees: ['u_bob'] }),
    task('c', { status: 'done', completedAt: NOW }),
  );

  it('adds, removes and replaces assignees across tasks in one batch', () => {
    const add = bulkEditOp(s, ['a', 'b'], { assignees: { mode: 'add', values: ['u_cy'] } });
    const after = apply(s, add);
    expect(after.tasks.a?.assignees).toEqual(['u_ann', 'u_cy']);
    expect(after.tasks.b?.assignees).toEqual(['u_bob', 'u_cy']);
    roundTrips(s, add);

    const remove = apply(
      s,
      bulkEditOp(s, ['a', 'b'], { assignees: { mode: 'remove', values: ['u_ann'] } }),
    );
    expect(remove.tasks.a?.assignees).toEqual([]);
    expect(remove.tasks.b?.assignees).toEqual(['u_bob']);

    const replace = apply(
      s,
      bulkEditOp(s, ['a', 'b'], { assignees: { mode: 'replace', values: ['u_dee'] } }),
    );
    expect(replace.tasks.a?.assignees).toEqual(['u_dee']);
  });

  it('only patches tasks and fields that change', () => {
    const op = bulkEditOp(s, ['a', 'b', 'c', 'gone'], { status: 'done', priority: 'normal' });
    expect(op.type === 'batch' && op.ops.map((o) => (o as { id: string }).id)).toEqual(['a', 'b']);
    const after = apply(s, op);
    expect(after.tasks.a?.completedAt).toBeTruthy();
    expect(after.tasks.c?.completedAt).toBe(NOW);
  });

  it('removes tasks together with their comments, and a revert brings both back', () => {
    const withComment = apply(s, {
      type: 'comment.add',
      comment: {
        id: 'cm1',
        taskId: 'a',
        authorId: 'u_ann',
        authorName: 'Ann',
        ts: NOW,
        text: 'hi',
      },
    });
    const op = removeTasksOp(withComment, ['a']);
    const after = apply(withComment, op);
    expect(after.tasks.a).toBeUndefined();
    expect(after.comments.cm1).toBeUndefined();
    roundTrips(withComment, op);
  });

  it('duplicates as fresh work: new ids, unticked checklist, no result', () => {
    const src = board(
      task('a', {
        status: 'done',
        outcome: 'nothing',
        completedAt: NOW,
        checklist: [{ id: 'k1', text: 'Pull logs', done: true }],
      }),
    );
    const { op, ids } = duplicateTasksOp(src, ['a'], { id: 'u_bob', name: 'Bob' }, NOW);
    const after = apply(src, op);
    const copy = after.tasks[ids[0]!]!;
    expect(copy.id).not.toBe('a');
    expect(copy.title).toBe('a (copy)');
    expect(copy.status).toBe('todo');
    expect(copy.outcome).toBe('');
    expect(copy.checklist).toHaveLength(1);
    expect(copy.checklist[0]!.done).toBe(false);
    expect(copy.checklist[0]!.id).not.toBe('k1');
    expect(copy.createdBy).toBe('u_bob');
  });
});

describe('task templates', () => {
  const s = board(
    task('a', {
      title: 'Sweep DCs, then file servers',
      assignees: ['u_ann'],
      hostIds: ['h_dc', 'h_gone'],
      tags: ['ad'],
      checklist: [{ id: 'k1', text: 'Pull 4662 events', done: true }],
      description: 'Line one\nLine "two"',
      priority: 'high',
    }),
  );
  const names = { user: (id: string) => id.replace('u_', '') };

  it('writes people by username and hosts by name, dropping hosts that no longer exist', () => {
    const file = writeTaskTemplate(s, ['a'], names, { now: NOW });
    expect(file.schema).toBe('midden.tasks.v1');
    expect(file.tasks[0]).toMatchObject({
      assignees: ['ann'],
      hosts: ['DC01'],
      checklist: ['Pull 4662 events'],
    });
  });

  it('round-trips through JSON and CSV, including commas, quotes and newlines', () => {
    const file = writeTaskTemplate(s, ['a'], names, { now: NOW });
    expect(readTaskTemplate(JSON.stringify(file)).tasks).toEqual(file.tasks);
    const csv = taskTemplateCsv(file.tasks);
    expect(readTaskTemplate(csv).tasks).toEqual(file.tasks);
  });

  it('reads a spreadsheet with loose column names and words for statuses', () => {
    const csv = [
      'Task,Assigned to,Host,Status,Priority,Steps',
      'Check VPN logs,ann; bob,10.9.0.20,In progress,P1,Pull logs; Diff against baseline',
      ',nobody,,,,',
      'Second,,,closed,medium,',
    ].join('\n');
    const r = readTaskTemplate(csv);
    expect(r.tasks).toHaveLength(2);
    expect(r.dropped).toHaveLength(1);
    expect(r.tasks[0]).toMatchObject({
      title: 'Check VPN logs',
      assignees: ['ann', 'bob'],
      hosts: ['10.9.0.20'],
      status: 'doing',
      priority: 'urgent',
      checklist: ['Pull logs', 'Diff against baseline'],
    });
    expect(r.tasks[1]).toMatchObject({ status: 'done', priority: 'normal' });
  });

  it('reads a bare array, and the tasks of a whole case file', () => {
    expect(readTaskTemplate('[{"title":"x"}]').tasks).toHaveLength(1);
    const caseFile = writeCaseFile(s);
    expect(readTaskTemplate(JSON.stringify(caseFile)).tasks[0]?.checklist).toEqual([
      'Pull 4662 events',
    ]);
  });

  it('refuses things that are not task lists', () => {
    expect(() => readTaskTemplate('')).toThrow(TaskTemplateError);
    expect(() => readTaskTemplate('{"hosts":[]}')).toThrow(/tasks/);
    expect(() => readTaskTemplate('{nope')).toThrow(/JSON/);
    expect(() => readTaskTemplate('name\nx')).not.toThrow();
    expect(() => readTaskTemplate('who,what\nx,y')).toThrow(/title/);
  });

  it('plans an import that resolves names and reports what it could not place', () => {
    const tpl = readTaskTemplate(
      'title,assignees,hosts\nOne,ann; zed,dc01; 10.9.0.20; NOPE\nTwo,,\n',
    ).tasks;
    const plan = planTaskImport(s, tpl, {
      actor: lead,
      now: NOW,
      resolveUser: (ref) => (ref === 'ann' ? 'u_ann' : null),
      assignAlso: ['u_lead'],
    });
    const after = apply(s, plan.op);
    const [one, two] = plan.ids.map((id) => after.tasks[id]!);
    expect(one!.assignees.sort()).toEqual(['u_ann', 'u_lead']);
    expect(one!.hostIds).toEqual(['h_dc', 'h_fs']);
    expect(two!.assignees).toEqual(['u_lead']);
    expect(plan.unresolvedUsers).toEqual(['zed']);
    expect(plan.unresolvedHosts).toEqual(['NOPE']);
    // placed below what is already in the column, in file order
    expect(one!.rank).toBeGreaterThan(s.tasks.a!.rank);
    expect(two!.rank).toBeGreaterThan(one!.rank);
  });

  it('parses quoted CSV fields', () => {
    expect(parseCsv('a,"b,c","d ""e"""\r\n"multi\nline",x,\n')).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['multi\nline', 'x', ''],
    ]);
  });
});

describe('notices', () => {
  const s = board(task('a', { title: 'Sweep DCs', assignees: ['u_ann'] }));
  const notices = (op: Op, actorId = 'u_lead', followers: Record<string, string[]> = {}) =>
    taskNotices({
      prev: s,
      op,
      next: apply(s, op),
      actorId,
      followers: (id) => followers[id] ?? [],
    });

  it('tells new and removed assignees, and nobody else, about an assignment', () => {
    const n = notices({ type: 'task.set', id: 'a', patch: { assignees: ['u_bob'] } });
    expect(n.map((x) => [x.recipient, x.kind])).toEqual([
      ['u_bob', 'assigned'],
      ['u_ann', 'unassigned'],
    ]);
  });

  it('tells assignees and followers about a status change, but not the person who made it', () => {
    const n = notices({ type: 'task.set', id: 'a', patch: { status: 'done' } }, 'u_ann', {
      a: ['u_lead', 'u_ann'],
    });
    expect(n).toEqual([
      { recipient: 'u_lead', taskId: 'a', kind: 'status', text: 'moved “Sweep DCs” to Done' },
    ]);
  });

  it('names the fields that changed, and stays quiet about rank-only moves', () => {
    expect(
      notices({ type: 'task.set', id: 'a', patch: { priority: 'high', due: NOW } })[0]?.text,
    ).toBe('updated the priority, due date of “Sweep DCs”');
    expect(notices({ type: 'task.set', id: 'a', patch: { rank: 5 } })).toEqual([]);
  });

  it('notifies about comments and deletions', () => {
    const c = notices(
      {
        type: 'comment.add',
        comment: {
          id: 'c1',
          taskId: 'a',
          authorId: 'u_bob',
          authorName: 'Bob',
          ts: NOW,
          text: 'DC02 clean',
        },
      },
      'u_bob',
    );
    expect(c[0]).toMatchObject({ recipient: 'u_ann', kind: 'commented' });
    expect(c[0]!.text).toContain('DC02 clean');
    expect(notices({ type: 'task.remove', id: 'a' })[0]).toMatchObject({ kind: 'deleted' });
  });

  it('only tells the people put on a brand new task', () => {
    const t = task('n', { assignees: ['u_cy'] });
    expect(notices({ type: 'task.add', task: t }).map((x) => x.recipient)).toEqual(['u_cy']);
  });

  it('collapses a bulk change into one notice per person', () => {
    const ops: Op[] = Array.from({ length: 5 }, (_, i) => ({
      type: 'task.add',
      task: task(`t${i}`, { assignees: ['u_bob'] }),
    }));
    const n = notices({ type: 'batch', ops });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({
      recipient: 'u_bob',
      kind: 'summary',
      text: 'assigned you 5 tasks',
    });
  });

  it('follows a revert like any other change', () => {
    const op: Op = { type: 'task.set', id: 'a', patch: { status: 'doing' } };
    const next = apply(s, op);
    const n = taskNotices({
      prev: next,
      op: { type: 'op.revert', targetSeq: 1, inverse: inverse(s, op) },
      next: s,
      actorId: 'u_lead',
      followers: () => [],
    });
    expect(n[0]).toMatchObject({ recipient: 'u_ann', kind: 'status' });
  });
});

describe('stored states from before tasks', () => {
  it('fills in missing collections', () => {
    const old = { ...emptyState(NOW) } as Partial<CaseState>;
    delete old.tasks;
    delete old.comments;
    const s = normalizeState(old);
    expect(s.tasks).toEqual({});
    expect(s.comments).toEqual({});
    expect(apply(s, { type: 'task.add', task: task('a') }).tasks.a).toBeTruthy();
  });

  it('round-trips comments through a case file', () => {
    let s = board(task('a'));
    s = apply(s, {
      type: 'comment.add',
      comment: { id: 'c1', taskId: 'a', authorId: 'u', authorName: 'U', ts: NOW, text: 'x' },
    });
    const back = readCaseFile(JSON.parse(JSON.stringify(writeCaseFile(s))));
    expect(back.state.comments).toEqual(s.comments);
    expect(back.report.tasks).toBe(1);
    expect(back.report.comments).toBe(1);
  });
});
