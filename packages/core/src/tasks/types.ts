/**
 * Task management domain. Tasks live outside cases, in one global op log, so a team can run
 * the same playbook across hunts and link individual tasks to a case, host or event.
 *
 * Fields a client may never set directly (number, creation, status and completion times,
 * approval decisions) are "system" fields: the reducer derives them from the context the
 * server logs with each op (who and when). Inverses carry their prior values explicitly.
 */

/** Fixed categories every workflow status maps onto, so metrics and "open?" logic never break. */
export type StatusCategory = 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export const STATUS_CATEGORIES: readonly StatusCategory[] = [
  'backlog',
  'todo',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
];
/** Categories that count as finished for "open task" logic. */
export const CLOSED_CATEGORIES: readonly StatusCategory[] = ['done', 'cancelled'];

export type TaskPriority = 'urgent' | 'high' | 'medium' | 'low';
export const TASK_PRIORITIES: readonly TaskPriority[] = ['urgent', 'high', 'medium', 'low'];

export interface WorkflowStatus {
  /** Stable within a workflow; a run's copy of a workflow keeps the ids, so tasks move cleanly. */
  id: string;
  name: string;
  category: StatusCategory;
  /** CSS colour token or hex; empty means "use the category's colour". */
  color: string;
  /** Soft limit shown on a board column; null for none. */
  wipLimit: number | null;
}

export interface Workflow {
  id: string;
  name: string;
  /** In board order. */
  statuses: WorkflowStatus[];
}

export interface ChecklistItem {
  id: string;
  text: string;
  done: boolean;
  /** System: who ticked it and when; empty while not done. */
  doneBy: string;
  doneAt: string;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected';

/** Risk acceptance: one named Midden user must decide, in person. */
export interface Approval {
  approverId: string;
  state: ApprovalState;
  comment: string;
  requestedBy: string;
  requestedAt: string;
  decidedBy: string;
  decidedAt: string;
}

export interface Task {
  id: string;
  /** System: human number, shown as T-<num>. */
  num: number;
  title: string;
  /** Plain text; links, T-refs and @mentions are rendered as links. */
  description: string;
  statusId: string;
  priority: TaskPriority;
  /** The run (playbook instance) this task belongs to; empty for ad-hoc tasks. */
  runId: string;
  /** Owning team; a task with a team and no assignees is in that team's queue. */
  teamId: string;
  /** User ids. */
  assignees: string[];
  /** User ids who explicitly follow the task. */
  followers: string[];
  labels: string[];
  /** ISO-8601 UTC, or empty. */
  dueAt: string;
  /** Optional links into a case. A restricted case hides the task from non-members. */
  caseId: string;
  hostId: string;
  eventId: string;
  /** Task ids this task waits on. */
  blockedBy: string[];
  checklist: ChecklistItem[];
  approval: Approval | null;
  archived: boolean;
  /** System fields. */
  createdBy: string;
  createdAt: string;
  /** When the task last changed status (or was created). */
  statusAt: string;
  /** When it last entered a done/cancelled category; empty while open. */
  doneAt: string;
}

/** What a client supplies to create a task; the reducer fills in the system fields. */
export type NewTask = Omit<
  Task,
  | 'num'
  | 'assignees'
  | 'teamId'
  | 'followers'
  | 'blockedBy'
  | 'checklist'
  | 'approval'
  | 'archived'
  | 'createdBy'
  | 'createdAt'
  | 'statusAt'
  | 'doneAt'
> & {
  /**
   * Set by the server as it logs the op, so every client numbers the task the same way even
   * when it can't see other tasks created in the same batch. A client's value is overwritten.
   */
  num?: number | undefined;
  assignees?: string[] | undefined;
  teamId?: string | undefined;
  followers?: string[] | undefined;
  blockedBy?: string[] | undefined;
  checklist?: { id: string; text: string }[] | undefined;
};

/** Fields `task.set` may patch. Assignment, deps, checklist and approval have their own ops. */
export type TaskEditable = Pick<
  Task,
  | 'title'
  | 'description'
  | 'statusId'
  | 'priority'
  | 'runId'
  | 'labels'
  | 'dueAt'
  | 'caseId'
  | 'hostId'
  | 'eventId'
  | 'archived'
>;
export const TASK_EDITABLE_KEYS: readonly (keyof TaskEditable)[] = [
  'title',
  'description',
  'statusId',
  'priority',
  'runId',
  'labels',
  'dueAt',
  'caseId',
  'hostId',
  'eventId',
  'archived',
];

/** System fields a status change touches; carried explicitly by inverses. */
export interface TaskSys {
  statusAt: string;
  doneAt: string;
}

export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  /** Empty once deleted; the original stays in the op log. */
  body: string;
  createdAt: string;
  editedAt: string;
  deletedAt: string;
}

/** A playbook instance: one hunt's copy of the work. */
export interface TaskRun {
  id: string;
  name: string;
  teamId: string;
  playbookId: string;
  workflowId: string;
  /** ISO-8601 UTC; relative due dates in a playbook count from here. */
  startDate: string;
  closed: boolean;
  /** System. */
  closedAt: string;
  createdBy: string;
  createdAt: string;
}
export type NewTaskRun = Omit<TaskRun, 'closed' | 'closedAt' | 'createdBy' | 'createdAt'>;
export type TaskRunEditable = Pick<
  TaskRun,
  'name' | 'teamId' | 'workflowId' | 'startDate' | 'closed'
>;

export interface TaskState {
  tasks: Record<string, Task>;
  comments: Record<string, TaskComment>;
  runs: Record<string, TaskRun>;
  workflows: Record<string, Workflow>;
  /** Workflow used by tasks with no run, and copied for new runs unless a playbook says otherwise. */
  defaultWorkflowId: string;
  /** System: the next task number. */
  nextNum: number;
}

/** Who and when, as logged by the server with each op. The reducer's only source of time. */
export interface TaskCtx {
  actorId: string;
  ts: string;
}

export const taskRef = (num: number): string => `T-${num}`;
