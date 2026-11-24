import { describe, expect, it } from 'vitest';
import { applyTaskOp, emptyTaskState } from './reducer.js';
import type { TaskOp } from './ops.js';
import type { NewTask, TaskState } from './types.js';
import {
  autoFollowOps,
  DEFAULT_NOTIFY_PREFS,
  leadKind,
  mergeNotifyPrefs,
  notifyRecipients,
  taskHappenings,
  type NotifyPrefs,
} from './notify.js';

let clock = 0;
const at = (actorId: string) => ({
  actorId,
  ts: new Date(Date.UTC(2026, 2, 1) + 1000 * clock++).toISOString(),
});
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
const names = new Map([
  ['ann', 'u_ann'],
  ['bob', 'u_bob'],
]);
const apply = (s: TaskState, actor: string, op: TaskOp) => applyTaskOp(s, op, at(actor));

/** Everyone on defaults unless overridden; everyone can see everything. */
function who(
  prev: TaskState,
  next: TaskState,
  actorId: string,
  prefs: Record<string, NotifyPrefs> = {},
  teams: Record<string, string[]> = {},
) {
  return notifyRecipients(next, taskHappenings(prev, next, names), {
    actorId,
    prefsOf: (u) => prefs[u] ?? DEFAULT_NOTIFY_PREFS,
    teamMembers: (t) => teams[t] ?? [],
    canNotify: () => true,
  });
}

describe('task notifications', () => {
  it('tells new assignees and mentioned people, never the actor', () => {
    const s0 = emptyTaskState();
    const s1 = apply(s0, 'u_lead', {
      type: 'task.add',
      task: nt('t1', { assignees: ['u_ann', 'u_lead'], description: 'cc @bob and @nobody' }),
    });
    const r = who(s0, s1, 'u_lead');
    expect(r).toEqual([
      { userId: 'u_ann', taskIds: ['t1'], kinds: ['assigned'], commentIds: [] },
      { userId: 'u_bob', taskIds: ['t1'], kinds: ['mention'], commentIds: [] },
    ]);
  });

  it('groups a bulk change into one entry per person', () => {
    let s = emptyTaskState();
    for (const id of ['a', 'b', 'c']) s = apply(s, 'u_lead', { type: 'task.add', task: nt(id) });
    const next = apply(s, 'u_lead', {
      type: 'batch',
      ops: [
        { type: 'task.assign', ids: ['a', 'b'], mode: 'set', users: ['u_ann'] },
        { type: 'task.assign', ids: ['c'], mode: 'set', users: ['u_bob'] },
      ],
    });
    const r = who(s, next, 'u_lead');
    expect(r.map((x) => [x.userId, x.taskIds, x.kinds])).toEqual([
      ['u_ann', ['a', 'b'], ['assigned']],
      ['u_bob', ['c'], ['assigned']],
    ]);
  });

  it('follows the preferences grid by relationship', () => {
    let s = apply(emptyTaskState(), 'u_ann', {
      type: 'task.add',
      task: nt('t1', { assignees: ['u_bob'], followers: ['u_fol'] }),
    });
    const status = apply(s, 'u_lead', {
      type: 'task.set',
      id: 't1',
      patch: { statusId: 'st_done' },
    });
    expect(who(s, status, 'u_lead').map((r) => r.userId)).toEqual(['u_bob', 'u_fol', 'u_ann']);

    // Edits reach the assignee and followers but not, by default, the creator.
    const edit = apply(s, 'u_lead', { type: 'task.set', id: 't1', patch: { title: 'New' } });
    expect(who(s, edit, 'u_lead').map((r) => r.userId)).toEqual(['u_bob', 'u_fol']);

    // A follower who turned comments off hears nothing; the assignee still does.
    const quiet = mergeNotifyPrefs(DEFAULT_NOTIFY_PREFS, {
      grid: { comment: { follower: false } },
    });
    const c = apply(s, 'u_lead', {
      type: 'comment.add',
      comment: { id: 'c1', taskId: 't1', body: 'Found it, @ann' },
    });
    const r = who(s, c, 'u_lead', { u_fol: quiet });
    expect(r).toEqual([
      { userId: 'u_bob', taskIds: ['t1'], kinds: ['comment'], commentIds: ['c1'] },
      { userId: 'u_ann', taskIds: ['t1'], kinds: ['mention', 'comment'], commentIds: ['c1'] },
    ]);
    expect(leadKind(r[1]!.kinds)).toBe('mention');

    // Undoing a comment's deletion doesn't announce it again.
    s = apply(c, 'u_lead', { type: 'comment.remove', id: 'c1' });
    const back = apply(s, 'u_lead', { type: 'comment.put', comment: c.comments.c1! });
    expect(who(s, back, 'u_lead')).toEqual([]);
  });

  it('asks the approver and tells the others the decision', () => {
    const s = apply(emptyTaskState(), 'u_ann', {
      type: 'task.add',
      task: nt('t1', { assignees: ['u_ann'] }),
    });
    const asked = apply(s, 'u_ann', { type: 'approval.set', taskId: 't1', approverId: 'u_boss' });
    expect(who(s, asked, 'u_ann')).toEqual([
      { userId: 'u_boss', taskIds: ['t1'], kinds: ['approval_requested'], commentIds: [] },
    ]);
    const decided = apply(asked, 'u_boss', {
      type: 'approval.decide',
      taskId: 't1',
      decision: 'approved',
      comment: '',
    });
    expect(who(asked, decided, 'u_boss').map((r) => [r.userId, r.kinds])).toEqual([
      ['u_ann', ['approval_decided']],
    ]);
  });

  it('tells team members who want queue notices', () => {
    const s0 = emptyTaskState();
    const s1 = apply(s0, 'u_lead', { type: 'task.add', task: nt('t1', { teamId: 'tm_host' }) });
    const keen = mergeNotifyPrefs(DEFAULT_NOTIFY_PREFS, { queue: true });
    expect(
      who(s0, s1, 'u_lead', { u_ann: keen }, { tm_host: ['u_ann', 'u_bob'] }).map((r) => r.userId),
    ).toEqual(['u_ann']);
  });

  it('respects canNotify', () => {
    const s0 = emptyTaskState();
    const s1 = apply(s0, 'u_lead', { type: 'task.add', task: nt('t1', { assignees: ['u_ann'] }) });
    const r = notifyRecipients(s1, taskHappenings(s0, s1, names), {
      actorId: 'u_lead',
      prefsOf: () => DEFAULT_NOTIFY_PREFS,
      teamMembers: () => [],
      canNotify: (u) => u !== 'u_ann',
    });
    expect(r).toEqual([]);
  });

  it('merges stored preferences over the defaults and ignores junk', () => {
    const p = mergeNotifyPrefs(DEFAULT_NOTIFY_PREFS, {
      grid: { status: { follower: false } },
      autoFollow: { commented: false },
    });
    expect(p.grid.status).toEqual({
      assignee: true,
      follower: false,
      creator: true,
      approver: true,
    });
    expect(p.grid.comment.follower).toBe(true);
    expect(p.autoFollow).toEqual({
      created: true,
      assigned: true,
      commented: false,
      approver: true,
    });
    expect(mergeNotifyPrefs(DEFAULT_NOTIFY_PREFS, { grid: { status: 'yes' } })).toEqual(
      DEFAULT_NOTIFY_PREFS,
    );
  });

  it('auto-follows from preferences', () => {
    const s0 = emptyTaskState();
    const op: TaskOp = { type: 'task.add', task: nt('t1', { assignees: ['u_ann', 'u_bob'] }) };
    const s1 = apply(s0, 'u_lead', op);
    const noBob = mergeNotifyPrefs(DEFAULT_NOTIFY_PREFS, { autoFollow: { assigned: false } });
    expect(
      autoFollowOps(s0, s1, op, 'u_lead', (u) => (u === 'u_bob' ? noBob : DEFAULT_NOTIFY_PREFS)),
    ).toEqual([
      { type: 'task.follow', id: 't1', userId: 'u_ann', on: true },
      { type: 'task.follow', id: 't1', userId: 'u_lead', on: true },
    ]);
    const c: TaskOp = { type: 'comment.add', comment: { id: 'c1', taskId: 't1', body: 'hi' } };
    const s2 = apply(s1, 'u_vic', c);
    expect(autoFollowOps(s1, s2, c, 'u_vic', () => DEFAULT_NOTIFY_PREFS)).toEqual([
      { type: 'task.follow', id: 't1', userId: 'u_vic', on: true },
    ]);
  });
});
