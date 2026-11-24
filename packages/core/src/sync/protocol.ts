/**
 * WebSocket protocol between the web client (ServerStore) and the server. Shared so both
 * sides compile against the same shapes. Ops themselves are validated with OpSchema.
 */
import { z } from 'zod';
import type { CaseState } from '../domain/types.js';
import { OpSchema, type Op } from '../ops/ops.js';
import type { TaskOp } from '../tasks/ops.js';
import type { NotificationView } from '../tasks/notify.js';
import type { Task, TaskComment, TaskState } from '../tasks/types.js';

export interface Actor {
  id: string;
  name: string;
}

/** A logged op as broadcast to every client in the case room. */
export interface Broadcast {
  seq: number;
  op: Op;
  actor: Actor;
  /** ISO-8601 UTC. */
  ts: string;
  /** Present when this op originated from a client, so the sender can settle its pending list. */
  clientOpId?: string | undefined;
}

/** A logged task op, as broadcast on the task channel. */
export interface TaskBroadcast {
  seq: number;
  op: TaskOp;
  actor: Actor;
  /** ISO-8601 UTC; also the time the reducer used for system fields. */
  ts: string;
  clientOpId?: string | undefined;
}

export interface Overwrite {
  field: string;
  bySeq: number;
  byActor: Actor;
}

export type RejectCode = 'schema' | 'perm' | 'notfound' | 'too_large' | 'conflict' | 'readonly';

export interface PresenceEntry {
  user: Actor;
  view: string;
  selectedId?: string | undefined;
  editingId?: string | undefined;
  since: string;
}

export type ScanProgressStatus = 'parsing' | 'ready' | 'failed';

/**
 * Who and what the task UI can refer to: sent with every task snapshot, and again whenever
 * teams, users or case access change. `cases` lists only cases the viewer can read.
 */
export interface TaskDirectory {
  users: {
    id: string;
    username: string;
    displayName: string;
    role: 'admin' | 'analyst' | 'viewer';
    disabled: boolean;
  }[];
  teams: {
    id: string;
    name: string;
    description: string;
    members: { userId: string; role: 'lead' | 'member' }[];
  }[];
  cases: { id: string; name: string; number: string; restricted: boolean }[];
}

export type ClientMessage =
  | { t: 'hello'; caseId: string; lastSeq: number | null }
  | { t: 'op'; clientOpId: string; baseSeq: number; op: Op }
  | { t: 'presence'; view: string; selectedId?: string | undefined; editingId?: string | undefined }
  /** Leave the case room but keep the socket (it also carries tasks). */
  | { t: 'leave' }
  /** Join the task channel; the server answers with a snapshot of what this user may see. */
  | { t: 'tasks.hello' }
  | { t: 'tasks.op'; clientOpId: string; baseSeq: number; op: unknown }
  | { t: 'ping' };

export type ServerMessage =
  | { t: 'snapshot'; seq: number; state: CaseState }
  | { t: 'ops'; ops: Broadcast[] }
  | ({ t: 'op' } & Broadcast)
  | { t: 'ack'; clientOpId: string; seq: number; overwrote?: Overwrite[] | undefined }
  | { t: 'reject'; clientOpId: string; code: RejectCode; message: string }
  | { t: 'presence'; users: PresenceEntry[] }
  | {
      t: 'scan';
      scanId: string;
      status: ScanProgressStatus;
      hosts?: number | undefined;
      error?: string | undefined;
    }
  | { t: 'tasks.snapshot'; seq: number; state: TaskState; directory: TaskDirectory }
  /**
   * A task op as this client may see it: leaves about tasks it can't see are removed (a noop
   * if nothing is left). `show` carries tasks that just became visible to it, whole; `hide`
   * names tasks it should forget (moved into a restricted case, archived, run closed).
   */
  | ({
      t: 'tasks.op';
      show?: { tasks: Task[]; comments: TaskComment[] } | undefined;
      hide?: string[] | undefined;
    } & TaskBroadcast)
  | { t: 'tasks.ack'; clientOpId: string; seq: number; overwrote?: Overwrite[] | undefined }
  | { t: 'tasks.reject'; clientOpId: string; code: RejectCode; message: string }
  /**
   * The signed-in person's inbox changed: a new or updated notification, or some were read
   * (in another tab, say). `unread` is the count to show on the bell.
   */
  | {
      t: 'notify';
      unread: number;
      notification?: NotificationView | undefined;
      read?: string[] | 'all' | undefined;
    }
  | { t: 'pong' }
  | { t: 'error'; message: string };

export const ClientMessageSchema: z.ZodType<ClientMessage> = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('hello'),
    caseId: z.string().min(1),
    lastSeq: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    t: z.literal('op'),
    clientOpId: z.string().min(1).max(64),
    baseSeq: z.number().int().nonnegative(),
    op: OpSchema,
  }),
  z.object({
    t: z.literal('presence'),
    view: z.string().max(64),
    selectedId: z.string().max(64).optional(),
    editingId: z.string().max(64).optional(),
  }),
  z.object({ t: z.literal('leave') }),
  z.object({ t: z.literal('tasks.hello') }),
  // The op itself is validated by the task runtime, which reports problems as a reject.
  z.object({
    t: z.literal('tasks.op'),
    clientOpId: z.string().min(1).max(64),
    baseSeq: z.number().int().nonnegative(),
    op: z.unknown(),
  }),
  z.object({ t: z.literal('ping') }),
]) as unknown as z.ZodType<ClientMessage>;

/** Gap above which the server sends a full snapshot instead of a catch-up op list. */
export const SNAPSHOT_GAP = 500;
