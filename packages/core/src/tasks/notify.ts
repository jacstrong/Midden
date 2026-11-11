/**
 * Who hears about a change to a task, and what they are told. Pure: the server supplies the
 * followers and decides who may still read the case; this decides what each person is owed.
 *
 * People on a task (its assignees) and people following it hear about every change to it except
 * their own. Someone just assigned or unassigned is told that, rather than a list of fields.
 * One op that touches many tasks, such as a bulk assign or an import, becomes one notice per
 * person, so a lead loading forty tasks does not bury an analyst in forty notices.
 */
import type { CaseState, Task, TaskComment, TaskStatus } from '../domain/types.js';
import type { Op } from '../ops/ops.js';
import { byId } from '../domain/reference.js';
import { TASK_STATUS } from './tasks.js';

export type TaskNoticeKind =
  'assigned' | 'unassigned' | 'status' | 'updated' | 'commented' | 'deleted' | 'summary';

export interface TaskNotice {
  recipient: string;
  /** The task, or the first of several for a summary. */
  taskId: string;
  kind: TaskNoticeKind;
  /** Plain text, without the actor's name: "assigned you to “Sweep the DCs”". */
  text: string;
}

/** Ids of every task an op touches, plus tasks that gained a comment. */
function touched(op: Op, out: Set<string> = new Set(), comments: Set<string> = new Set()) {
  switch (op.type) {
    case 'task.add':
      out.add(op.task.id);
      break;
    case 'task.set':
    case 'task.remove':
      out.add(op.id);
      break;
    case 'comment.add':
      comments.add(op.comment.id);
      break;
    case 'batch':
      for (const o of op.ops) touched(o, out, comments);
      break;
    case 'op.revert':
      touched(op.inverse, out, comments);
      break;
    default:
      break;
  }
  return { tasks: out, comments };
}

const STATUS = byId(TASK_STATUS);
const FIELD_LABEL: Record<string, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  hostIds: 'hosts',
  eventIds: 'events',
  technique: 'technique',
  tags: 'tags',
  due: 'due date',
  checklist: 'checklist',
  outcome: 'outcome',
};

const quote = (t: Pick<Task, 'title'>): string =>
  `“${t.title.length > 80 ? t.title.slice(0, 79) + '…' : t.title || 'Untitled task'}”`;

const changedFields = (a: Task, b: Task): string[] =>
  Object.keys(FIELD_LABEL).filter(
    (k) => JSON.stringify(a[k as keyof Task]) !== JSON.stringify(b[k as keyof Task]),
  );

export interface NoticeInput {
  prev: CaseState;
  op: Op;
  next: CaseState;
  actorId: string;
  /** Followers of a task, as stored by the server. */
  followers(taskId: string): Iterable<string>;
}

export function taskNotices({ prev, op, next, actorId, followers }: NoticeInput): TaskNotice[] {
  const { tasks, comments } = touched(op);
  const notices: TaskNotice[] = [];
  const push = (recipients: Iterable<string>, n: Omit<TaskNotice, 'recipient'>): void => {
    for (const r of new Set(recipients)) if (r !== actorId) notices.push({ ...n, recipient: r });
  };
  const audience = (t: Task): string[] => [...t.assignees, ...followers(t.id)];

  for (const id of tasks) {
    const before = prev.tasks[id];
    const after = next.tasks[id];
    if (!before && !after) continue;
    if (before && !after) {
      push(audience(before), { taskId: id, kind: 'deleted', text: `deleted ${quote(before)}` });
      continue;
    }
    const t = after!;
    const was = new Set(before?.assignees ?? []);
    const now = new Set(t.assignees);
    const added = t.assignees.filter((a) => !was.has(a));
    const removed = [...was].filter((a) => !now.has(a));
    push(added, { taskId: id, kind: 'assigned', text: `assigned you to ${quote(t)}` });
    push(removed, { taskId: id, kind: 'unassigned', text: `removed you from ${quote(t)}` });
    if (!before) continue; // a new task only concerns the people put on it
    const told = new Set([...added, ...removed]);
    const rest = audience(t).filter((r) => !told.has(r));
    if (before.status !== t.status) {
      const label = STATUS[t.status as TaskStatus]?.label ?? t.status;
      push(rest, { taskId: id, kind: 'status', text: `moved ${quote(t)} to ${label}` });
      continue;
    }
    const fields = changedFields(before, t).map((k) => FIELD_LABEL[k]!);
    if (fields.length)
      push(rest, {
        taskId: id,
        kind: 'updated',
        text: `updated the ${fields.join(', ')} of ${quote(t)}`,
      });
  }

  for (const cid of comments) {
    const c: TaskComment | undefined = next.comments[cid];
    if (!c || prev.comments[cid]) continue;
    const t = next.tasks[c.taskId];
    if (!t) continue;
    const snippet = c.text.length > 140 ? c.text.slice(0, 139) + '…' : c.text;
    push(audience(t), {
      taskId: t.id,
      kind: 'commented',
      text: `commented on ${quote(t)}: ${snippet}`,
    });
  }

  return collapse(notices);
}

/** More than this many notices for one person from one op become a single summary. */
export const NOTICE_COLLAPSE_AT = 3;

function collapse(notices: TaskNotice[]): TaskNotice[] {
  const byRecipient = new Map<string, TaskNotice[]>();
  for (const n of notices) {
    const list = byRecipient.get(n.recipient) ?? [];
    list.push(n);
    byRecipient.set(n.recipient, list);
  }
  const out: TaskNotice[] = [];
  for (const [recipient, list] of byRecipient) {
    if (list.length <= NOTICE_COLLAPSE_AT) {
      out.push(...list);
      continue;
    }
    const assigned = list.filter((n) => n.kind === 'assigned').length;
    const others = list.length - assigned;
    const parts: string[] = [];
    if (assigned) parts.push(`assigned you ${assigned} task${assigned === 1 ? '' : 's'}`);
    if (others) parts.push(`changed ${others} task${others === 1 ? '' : 's'} you are on`);
    out.push({ recipient, taskId: list[0]!.taskId, kind: 'summary', text: parts.join(' and ') });
  }
  return out;
}
