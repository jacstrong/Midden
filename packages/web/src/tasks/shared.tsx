/**
 * Pieces every task screen uses: names from the directory, text with `T-123`, links and
 * @mentions made clickable, op descriptions for history, times in Zulu, and the small UI store
 * (the "new task" dialog and the open drawer).
 */
import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import {
  definedKeys,
  statusOf,
  taskRef,
  tokenizeRefs,
  type NewTask,
  type TaskDirectory,
  type TaskOp,
  type TaskState,
  type ViewNames,
} from '@midden/core';
import { useRoute } from '../lib/router';
import { useTasks } from './TaskStore';

/* ---- names ---- */

export interface Names extends ViewNames {
  username(id: string): string;
  idOfUsername(username: string): string | undefined;
  /** Users who can be given work: not disabled, not viewers. */
  assignable: TaskDirectory['users'];
  /** Everyone not disabled (approvers may be viewers). */
  active: TaskDirectory['users'];
  myTeams: Set<string>;
  ledTeams: Set<string>;
  isAdmin: boolean;
  me: string;
}

export function namesFor(dir: TaskDirectory, me: string): Names {
  const users = new Map(dir.users.map((u) => [u.id, u]));
  const byName = new Map(dir.users.map((u) => [u.username.toLowerCase(), u.id]));
  const teams = new Map(dir.teams.map((t) => [t.id, t]));
  const cases = new Map(dir.cases.map((c) => [c.id, c]));
  const myTeams = new Set<string>();
  const ledTeams = new Set<string>();
  for (const t of dir.teams)
    for (const m of t.members)
      if (m.userId === me) {
        myTeams.add(t.id);
        if (m.role === 'lead') ledTeams.add(t.id);
      }
  return {
    user: (id) => users.get(id)?.displayName ?? (id ? 'Unknown user' : ''),
    username: (id) => users.get(id)?.username ?? id,
    idOfUsername: (u) => byName.get(u.replace(/^@/, '').toLowerCase()),
    team: (id) => teams.get(id)?.name ?? (id ? 'Deleted team' : ''),
    caseName: (id) => {
      const c = cases.get(id);
      return c ? (c.number ? `${c.number} ${c.name}` : c.name) : id ? 'Restricted case' : '';
    },
    assignable: dir.users.filter((u) => !u.disabled && u.role !== 'viewer'),
    active: dir.users.filter((u) => !u.disabled),
    myTeams,
    ledTeams,
    isAdmin: users.get(me)?.role === 'admin',
    me,
  };
}

export function useNames(): Names {
  const dir = useTasks((s) => s.directory);
  const me = useTasks((s) => s.me?.id ?? '');
  return useMemo(() => namesFor(dir, me), [dir, me]);
}

/* ---- links ---- */

/** Open a task's drawer, keeping the board you're on when you're already on one. */
export function openTask(num: number): void {
  const { route, navigate } = useRoute.getState();
  navigate({ kind: 'tasks', viewId: route.kind === 'tasks' ? route.viewId : 'mine', taskNum: num });
}

export function taskHref(num: number): string {
  const r = useRoute.getState().route;
  return `#/tasks/${r.kind === 'tasks' ? r.viewId : 'mine'}/t/${num}`;
}

/** Plain text with `T-123`, links and @mentions made clickable. Never renders HTML. */
export function RefText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => tokenizeRefs(text), [text]);
  const out: ReactNode[] = parts.map((p, i) => {
    switch (p.kind) {
      case 'task':
        return (
          <a
            key={i}
            className="tref"
            href={taskHref(p.num)}
            onClick={(e: MouseEvent) => {
              e.preventDefault();
              openTask(p.num);
            }}
          >
            {p.text}
          </a>
        );
      case 'url':
        return (
          <a key={i} href={p.href} target="_blank" rel="noopener noreferrer nofollow">
            {p.text}
          </a>
        );
      case 'mention':
        return (
          <span key={i} className="mention">
            {p.text}
          </span>
        );
      default:
        return p.text;
    }
  });
  return <span className={'wrap ' + (className ?? '')}>{out}</span>;
}

/* ---- time ---- */

const pad = (n: number): string => String(n).padStart(2, '0');

/** `2026-03-04 14:00Z`, or just the date for an end-of-day due date. */
export function fmtZulu(iso: string, dateOnlyAtEndOfDay = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (dateOnlyAtEndOfDay && d.getUTCHours() === 23 && d.getUTCMinutes() === 59) return date;
  return `${date} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}Z`;
}

export const fmtDue = (iso: string): string => fmtZulu(iso, true);

/** "3m ago", "2h ago", "4d ago"; the full Zulu time past a week. */
export function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return fmtZulu(iso);
}

/** A `<input type="datetime-local">` value, read and written as UTC. */
export const toLocalInput = (iso: string): string => (iso ? iso.slice(0, 16) : '');
export const fromLocalInput = (v: string): string => (v ? new Date(v + 'Z').toISOString() : '');

/* ---- history ---- */

export function describeTaskOp(op: TaskOp, s: TaskState, n: Names): string {
  const people = (ids: string[]): string => ids.map((id) => n.user(id)).join(', ');
  const ref = (id: string): string => {
    const t = s.tasks[id];
    return t ? taskRef(t.num) : 'a task';
  };
  switch (op.type) {
    case 'noop':
      return 'Nothing';
    case 'task.add':
      return `Created "${op.task.title}"`;
    case 'task.set': {
      const p = op.patch;
      const bits: string[] = [];
      if (p.statusId !== undefined) {
        const t = s.tasks[op.id];
        const st = t && statusOf(s, { runId: p.runId ?? t.runId, statusId: p.statusId });
        bits.push(`status → ${st?.name ?? p.statusId}`);
      }
      if (p.priority !== undefined) bits.push(`priority → ${p.priority}`);
      if (p.archived !== undefined) bits.push(p.archived ? 'archived' : 'restored');
      if (p.dueAt !== undefined)
        bits.push(p.dueAt ? `due → ${fmtDue(p.dueAt)}` : 'due date cleared');
      if (p.caseId !== undefined)
        bits.push(p.caseId ? `case → ${n.caseName(p.caseId)}` : 'case unlinked');
      if (p.runId !== undefined)
        bits.push(p.runId ? `run → ${s.runs[p.runId]?.name ?? p.runId}` : 'left its run');
      const rest = definedKeys(p).filter(
        (k) => !['statusId', 'priority', 'archived', 'dueAt', 'caseId', 'runId'].includes(k),
      );
      if (rest.length) bits.push(`edited ${rest.join(', ')}`);
      return bits.join('; ') || 'Edited';
    }
    case 'task.assign': {
      const many = op.ids.length > 1 ? ` on ${op.ids.length} tasks` : '';
      const team =
        op.teamId !== undefined ? (op.teamId ? ` (team ${n.team(op.teamId)})` : ' (no team)') : '';
      if (op.mode === 'set')
        return (
          (op.users.length ? `Assigned to ${people(op.users)}` : 'Unassigned everyone') +
          many +
          team
        );
      if (!op.users.length) return `Moved to team ${n.team(op.teamId ?? '') || 'none'}${many}`;
      return `${op.mode === 'add' ? 'Assigned' : 'Unassigned'} ${people(op.users)}${many}${team}`;
    }
    case 'task.follow':
      return `${n.user(op.userId)} ${op.on ? 'followed' : 'unfollowed'}`;
    case 'checklist.add':
      return `Checklist: added "${op.item.text}"`;
    case 'checklist.set':
      return op.patch.done !== undefined
        ? `Checklist: ${op.patch.done ? 'ticked' : 'unticked'} an item`
        : 'Checklist: edited an item';
    case 'checklist.remove':
      return 'Checklist: removed an item';
    case 'checklist.move':
      return 'Checklist: reordered';
    case 'dep.add':
      return `Now blocked by ${ref(op.blockedById)}`;
    case 'dep.remove':
      return `No longer blocked by ${ref(op.blockedById)}`;
    case 'comment.add':
      return 'Commented';
    case 'comment.edit':
      return 'Edited a comment';
    case 'comment.remove':
      return 'Deleted a comment';
    case 'approval.set':
      return op.approverId
        ? `Approval requested from ${n.user(op.approverId)}`
        : 'Approval removed';
    case 'approval.decide':
      return `${op.decision === 'approved' ? 'Approved' : 'Rejected'}${op.comment ? `: "${op.comment}"` : ''}`;
    case 'run.add':
      return `Started run ${op.run.name}`;
    case 'run.set':
      return `Changed run ${s.runs[op.id]?.name ?? op.id}`;
    case 'workflow.set':
      return `Changed workflow ${op.workflow.name}`;
    case 'workflow.default':
      return 'Changed the default workflow';
    case 'batch': {
      // Follows logged with a change (auto-follow) aren't worth a mention of their own.
      const main = op.ops.some((o) => o.type !== 'task.follow')
        ? op.ops.filter((o) => o.type !== 'task.follow')
        : op.ops;
      return main.length === 1
        ? describeTaskOp(main[0]!, s, n)
        : `${main.length} changes: ` +
            [...new Set(main.map((o) => describeTaskOp(o, s, n)))].slice(0, 3).join('; ') +
            (main.length > 3 ? '…' : '');
    }
    case 'op.revert':
      return `Undid #${op.targetSeq}`;
    default:
      return op.type;
  }
}

/* ---- UI state ---- */

export type TaskPrefill = Partial<
  Pick<NewTask, 'caseId' | 'hostId' | 'eventId' | 'runId' | 'title' | 'statusId'>
> & {
  teamId?: string;
  assignees?: string[];
};

interface TaskUiState {
  creating: TaskPrefill | null;
  openCreate(p?: TaskPrefill): void;
  closeCreate(): void;
}

export const useTaskUi = create<TaskUiState>((set) => ({
  creating: null,
  openCreate: (p = {}) => set({ creating: p }),
  closeCreate: () => set({ creating: null }),
}));

export const PRIORITY_COLOR: Record<string, string> = {
  urgent: 'var(--mg)',
  high: 'var(--am)',
  medium: 'var(--cy)',
  low: 'var(--dimmer)',
};

export const CATEGORY_COLOR: Record<string, string> = {
  backlog: 'var(--dimmer)',
  todo: 'var(--ink)',
  in_progress: 'var(--cy)',
  blocked: 'var(--mg)',
  done: 'var(--gr)',
  cancelled: 'var(--dimmer)',
};
