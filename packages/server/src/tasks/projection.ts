/**
 * Materialize task state into tables for listing, per-task history and insights. The op log
 * is the source of truth; `rebuildTaskProjections` replays a state from scratch and is the
 * oracle the tests compare `projectTaskOp` against.
 */
import {
  categoryOf,
  flattenTaskOp,
  taskIdsOf,
  type Task,
  type TaskOp,
  type TaskState,
} from '@midden/core';
import type { Db } from '../db/db.js';

/** Leaf ops that can change many tasks' categories at once. */
const BROAD = new Set<TaskOp['type']>([
  'run.add',
  'run.set',
  'run.put',
  'run.drop',
  'workflow.set',
  'workflow.drop',
  'workflow.default',
]);

/** Task ids an op touches, resolving comments through either state. */
export function opTaskIds(op: TaskOp, prev: TaskState, next: TaskState): string[] {
  return taskIdsOf(op, (cid) => next.comments[cid]?.taskId ?? prev.comments[cid]?.taskId);
}

/** Tasks whose row may have changed: those the op names, or every task for a broad op. */
export function changedTaskIds(op: TaskOp, prev: TaskState, next: TaskState): Set<string> {
  const ids = new Set(opTaskIds(op, prev, next));
  if (flattenTaskOp(op).some((l) => BROAD.has(l.type)))
    for (const id of Object.keys(next.tasks)) ids.add(id);
  return ids;
}

export function projectTaskOp(
  db: Db,
  op: TaskOp,
  prev: TaskState,
  next: TaskState,
  meta: { seq: number; ts: string; actorId: string },
): void {
  const leaves = flattenTaskOp(op);
  const ids = changedTaskIds(op, prev, next);

  for (const id of ids) {
    const t = next.tasks[id];
    const p = prev.tasks[id];
    if (!t) {
      if (p) db.run('DELETE FROM tasks WHERE id = ?', id);
      continue;
    }
    const cat = categoryOf(next, t);
    const prevCat = p ? categoryOf(prev, p) : '';
    if (p === t && prevCat === cat) continue;
    upsertTask(db, next, t, meta.ts);
    if (!p || p.statusId !== t.statusId || prevCat !== cat)
      db.run(
        'INSERT INTO task_transitions (task_id, seq, from_status, to_status, from_category, to_category, actor_id, at) VALUES (?,?,?,?,?,?,?,?)',
        id,
        meta.seq,
        p?.statusId ?? '',
        t.statusId,
        prevCat,
        cat,
        meta.actorId,
        meta.ts,
      );
  }

  const commentIds = new Set<string>();
  const runIds = new Set<string>();
  for (const l of leaves) {
    if (l.type === 'comment.add' || l.type === 'comment.put') commentIds.add(l.comment.id);
    if (l.type === 'comment.edit' || l.type === 'comment.remove' || l.type === 'comment.drop')
      commentIds.add(l.id);
    if (l.type === 'run.add' || l.type === 'run.put') runIds.add(l.run.id);
    if (l.type === 'run.set' || l.type === 'run.drop') runIds.add(l.id);
  }
  for (const id of commentIds) {
    const c = next.comments[id];
    if (!c) db.run('DELETE FROM task_comments WHERE id = ?', id);
    else
      db.run(
        `INSERT INTO task_comments (id, task_id, author_id, body, created_at, edited_at, deleted_at)
         VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, edited_at = excluded.edited_at, deleted_at = excluded.deleted_at`,
        c.id,
        c.taskId,
        c.authorId,
        c.body,
        c.createdAt,
        c.editedAt,
        c.deletedAt,
      );
  }
  for (const id of runIds) {
    const r = next.runs[id];
    if (!r) db.run('DELETE FROM task_runs WHERE id = ?', id);
    else
      db.run(
        `INSERT OR REPLACE INTO task_runs (id, name, team_id, playbook_id, workflow_id, start_date, closed, closed_at, created_by, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        r.id,
        r.name,
        r.teamId,
        r.playbookId,
        r.workflowId,
        r.startDate,
        r.closed ? 1 : 0,
        r.closedAt,
        r.createdBy,
        r.createdAt,
      );
  }
}

function upsertTask(db: Db, state: TaskState, t: Task, updatedAt: string): void {
  db.run(
    `INSERT INTO tasks (id, num, title, status_id, category, priority, run_id, team_id, case_id, due_at,
                        approver_id, approval_state, archived, created_by, created_at, updated_at, status_at, done_at, data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, status_id = excluded.status_id, category = excluded.category,
       priority = excluded.priority, run_id = excluded.run_id, team_id = excluded.team_id,
       case_id = excluded.case_id, due_at = excluded.due_at, approver_id = excluded.approver_id,
       approval_state = excluded.approval_state, archived = excluded.archived,
       updated_at = excluded.updated_at, status_at = excluded.status_at, done_at = excluded.done_at,
       data = excluded.data`,
    t.id,
    t.num,
    t.title,
    t.statusId,
    categoryOf(state, t),
    t.priority,
    t.runId,
    t.teamId,
    t.caseId,
    t.dueAt,
    t.approval?.approverId ?? '',
    t.approval?.state ?? '',
    t.archived ? 1 : 0,
    t.createdBy,
    t.createdAt,
    updatedAt,
    t.statusAt,
    t.doneAt,
    JSON.stringify(t),
  );
  db.run('DELETE FROM task_assignees WHERE task_id = ?', t.id);
  for (const u of t.assignees)
    db.run('INSERT INTO task_assignees (task_id, user_id) VALUES (?,?)', t.id, u);
  db.run('DELETE FROM task_followers WHERE task_id = ?', t.id);
  for (const u of t.followers)
    db.run('INSERT INTO task_followers (task_id, user_id) VALUES (?,?)', t.id, u);
  db.run('DELETE FROM task_deps WHERE task_id = ?', t.id);
  for (const b of t.blockedBy)
    db.run('INSERT INTO task_deps (task_id, blocked_by_id) VALUES (?,?)', t.id, b);
}

/** Replace every projection (except transitions, which are history) from a state. */
export function rebuildTaskProjections(db: Db, state: TaskState, now: string): void {
  db.transaction(() => {
    db.exec('DELETE FROM tasks; DELETE FROM task_comments; DELETE FROM task_runs;');
    for (const t of Object.values(state.tasks)) upsertTask(db, state, t, now);
    projectTaskOp(
      db,
      {
        type: 'batch',
        ops: [
          ...Object.values(state.comments).map((comment) => ({
            type: 'comment.put' as const,
            comment,
          })),
          ...Object.values(state.runs).map((run) => ({ type: 'run.put' as const, run })),
        ],
      },
      { ...state, tasks: {} },
      { ...state, tasks: {} },
      { seq: 0, ts: now, actorId: '' },
    );
  });
}
