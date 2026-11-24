/**
 * Who may send which task op. `checkTaskOp` in core decides whether the data allows an op;
 * this decides whether the person does.
 *
 * - Viewers read. The one thing they may do is decide an approval they were named for, since
 *   the person accepting a risk (a mission owner, say) often has no reason to edit anything.
 * - Analysts create, edit, comment, claim and assign a single task to anyone.
 * - Changing who is assigned on more than one task at once (a bulk assign, an import) takes a
 *   lead: every affected task must end up in a team they lead (or none), and everyone newly
 *   assigned must be on a team they lead. Admins may do it anywhere.
 * - Starting or changing a run takes a lead of its team; the default workflow takes an admin.
 * - Only the named approver decides, and only from a browser session, so an agent holding
 *   someone's token can never accept a risk for them.
 * - Nobody can touch, or link to, a task or case they can't see.
 */
import {
  applyTaskOp,
  flattenTaskOp,
  taskIdsOf,
  type RejectCode,
  type Task,
  type TaskCtx,
  type TaskOp,
  type TaskState,
} from '@midden/core';
import type { Db } from '../db/db.js';
import { findUserById, type User } from '../auth/sessions.js';
import { ledTeamIds, membersOf, teamIdSet } from '../teams/teams.js';
import { canSeeCase, canSeeTask, viewerFor, type TaskViewer } from './visibility.js';

export interface Refusal {
  code: RejectCode;
  message: string;
}

export interface PermissionInput {
  db: Db;
  user: User;
  /** The op came in on an API token rather than a browser session. */
  viaToken: boolean;
  state: TaskState;
  op: TaskOp;
  ctx: TaskCtx;
}

const refuse = (code: RejectCode, message: string): Refusal => ({ code, message });

export function checkTaskPermission(i: PermissionInput): Refusal | null {
  const { db, user, state, op } = i;
  const leaves = flattenTaskOp(op);
  const isAdmin = user.role === 'admin';

  if (
    user.role === 'viewer' &&
    !leaves.every((l) => l.type === 'approval.decide' || l.type === 'noop')
  )
    return refuse('readonly', 'Viewers cannot change tasks');

  const me = viewerFor(db, user);
  const users = new Map<string, User | null>();
  const userById = (id: string): User | null => {
    if (!users.has(id)) users.set(id, findUserById(db, id));
    return users.get(id)!;
  };
  const viewers = new Map<string, TaskViewer>();
  const viewerOf = (u: User): TaskViewer => {
    if (u.id === user.id) return me;
    if (!viewers.has(u.id)) viewers.set(u.id, viewerFor(db, u));
    return viewers.get(u.id)!;
  };
  let teams: Set<string> | null = null;
  const teamExists = (id: string): boolean => (teams ??= teamIdSet(db)).has(id);
  let led: Set<string> | null = null;
  const leads = (): Set<string> => (led ??= ledTeamIds(db, user.id));

  /** A person who can be assigned, named as follower or approver, on this task. */
  const checkPerson = (id: string, task: Pick<Task, 'caseId'>, what: string): Refusal | null => {
    const u = userById(id);
    if (!u) return refuse('notfound', `No such user ${id}`);
    if (u.disabled) return refuse('perm', `${u.displayName} is disabled and cannot be ${what}`);
    if (!canSeeTask(viewerOf(u), task))
      return refuse('perm', `${u.displayName} cannot see this task's case, so cannot be ${what}`);
    return null;
  };

  let s = state;
  for (const leaf of leaves) {
    for (const id of taskIdsOf(leaf, (cid) => s.comments[cid]?.taskId)) {
      const t = s.tasks[id];
      if (t && !canSeeTask(me, t)) return refuse('notfound', `Task ${id} does not exist`);
    }
    let r: Refusal | null = null;
    switch (leaf.type) {
      case 'task.add': {
        const n = leaf.task;
        if (n.caseId && !canSeeCase(me, n.caseId)) return refuse('notfound', 'No such case');
        if (n.teamId && !teamExists(n.teamId))
          return refuse('notfound', `No such team ${n.teamId}`);
        for (const u of n.assignees ?? []) r ??= checkPerson(u, n, 'assigned');
        for (const u of n.followers ?? []) r ??= checkPerson(u, n, 'a follower');
        break;
      }
      case 'task.set':
        if (leaf.patch.caseId && !canSeeCase(me, leaf.patch.caseId))
          return refuse('notfound', 'No such case');
        if (leaf.patch.caseId) {
          // Moving a task into a restricted case must not leave it with people who can't see it.
          const t = s.tasks[leaf.id];
          const moved = { caseId: leaf.patch.caseId };
          for (const u of t?.assignees ?? []) r ??= checkPerson(u, moved, 'assigned');
          if (t?.approval) r ??= checkPerson(t.approval.approverId, moved, 'its approver');
        }
        break;
      case 'task.assign':
        if (leaf.teamId && !teamExists(leaf.teamId))
          return refuse('notfound', `No such team ${leaf.teamId}`);
        if (leaf.mode !== 'remove')
          for (const id of leaf.ids) {
            const t = s.tasks[id];
            if (t) for (const u of leaf.users) r ??= checkPerson(u, t, 'assigned');
          }
        break;
      case 'task.follow':
        if (leaf.on && leaf.userId !== user.id) {
          const t = s.tasks[leaf.id];
          if (t) r = checkPerson(leaf.userId, t, 'a follower');
        }
        break;
      case 'comment.edit': {
        const c = s.comments[leaf.id];
        if (c && c.authorId !== user.id)
          return refuse('perm', 'You can only edit your own comments');
        break;
      }
      case 'comment.remove': {
        const c = s.comments[leaf.id];
        if (c && c.authorId !== user.id && !isAdmin)
          return refuse('perm', 'You can only delete your own comments');
        break;
      }
      case 'approval.set':
        if (leaf.approverId) {
          const t = s.tasks[leaf.taskId];
          if (t) r = checkPerson(leaf.approverId, t, 'its approver');
        }
        break;
      case 'approval.decide': {
        const a = s.tasks[leaf.taskId]?.approval;
        if (a && a.approverId !== user.id) {
          const name = userById(a.approverId)?.displayName ?? 'the named approver';
          return refuse('perm', `Only ${name} can decide this approval`);
        }
        if (i.viaToken)
          return refuse('perm', 'Approvals need a signed-in browser session, not an API token');
        break;
      }
      case 'approval.put': {
        // Undo can bring a decision back (reverting the revert of an approval). That is the
        // same as deciding, so it takes the same person and the same browser session.
        const a = leaf.approval;
        const current = s.tasks[leaf.taskId]?.approval;
        if (
          a &&
          a.state !== 'pending' &&
          (current?.state !== a.state || current.decidedAt !== a.decidedAt)
        ) {
          if (a.approverId !== user.id) {
            const name = userById(a.approverId)?.displayName ?? 'the named approver';
            return refuse('perm', `Only ${name} can restore this approval decision`);
          }
          if (i.viaToken)
            return refuse('perm', 'Approvals need a signed-in browser session, not an API token');
        }
        break;
      }
      case 'run.add':
        if (!isAdmin && !(leaf.run.teamId && leads().has(leaf.run.teamId)))
          return refuse('perm', "Only an admin or a lead of the run's team can start a run");
        if (leaf.run.teamId && !teamExists(leaf.run.teamId))
          return refuse('notfound', `No such team ${leaf.run.teamId}`);
        break;
      case 'run.set': {
        const run = s.runs[leaf.id];
        if (!run || isAdmin) break;
        const next = leaf.patch.teamId ?? run.teamId;
        if (!run.teamId || !leads().has(run.teamId) || !next || !leads().has(next))
          return refuse('perm', "Only an admin or a lead of the run's team can change a run");
        break;
      }
      case 'workflow.set': {
        if (isAdmin) break;
        if (leaf.workflow.id === s.defaultWorkflowId)
          return refuse('perm', 'Only an admin can change the default workflow');
        const using = Object.values(s.runs).filter((x) => x.workflowId === leaf.workflow.id);
        const ok =
          using.length === 0
            ? leads().size > 0
            : using.every((x) => x.teamId && leads().has(x.teamId));
        if (!ok)
          return refuse(
            'perm',
            "Only an admin or a lead of the run's team can change its workflow",
          );
        break;
      }
      case 'workflow.default':
        if (!isAdmin) return refuse('perm', 'Only an admin can change the default workflow');
        break;
      default:
        break;
    }
    if (r) return r;
    s = applyTaskOp(s, leaf, i.ctx);
  }

  return checkBulkAssignment(i, state, s, leaves, isAdmin, leads, userById);
}

/** Tasks whose assignees or team this op changes, compared before and after. */
function assignmentChanges(before: TaskState, after: TaskState, leaves: TaskOp[]): string[] {
  const ids = new Set<string>();
  for (const l of leaves) {
    if (l.type === 'task.assign') for (const id of l.ids) ids.add(id);
    if (l.type === 'task.add' && ((l.task.assignees?.length ?? 0) > 0 || l.task.teamId))
      ids.add(l.task.id);
  }
  return [...ids].filter((id) => {
    const a = before.tasks[id];
    const b = after.tasks[id];
    if (!b) return false;
    if (!a) return b.assignees.length > 0 || !!b.teamId;
    return a.teamId !== b.teamId || a.assignees.join('\u0000') !== b.assignees.join('\u0000');
  });
}

function checkBulkAssignment(
  i: PermissionInput,
  before: TaskState,
  after: TaskState,
  leaves: TaskOp[],
  isAdmin: boolean,
  leads: () => Set<string>,
  userById: (id: string) => User | null,
): Refusal | null {
  const changed = assignmentChanges(before, after, leaves);
  if (changed.length <= 1 || isAdmin) return null;
  const led = leads();
  if (led.size === 0)
    return refuse('perm', 'Assigning more than one task at a time is for team leads and admins');
  const members = membersOf(i.db, led);
  for (const id of changed) {
    const b = after.tasks[id]!;
    if (b.teamId && !led.has(b.teamId))
      return refuse('perm', `T-${b.num} would be in a team you don't lead`);
    const prior = new Set(before.tasks[id]?.assignees ?? []);
    for (const u of b.assignees)
      if (!prior.has(u) && !members.has(u))
        return refuse(
          'perm',
          `${userById(u)?.displayName ?? u} isn't on a team you lead, so can't be bulk-assigned`,
        );
  }
  return null;
}
