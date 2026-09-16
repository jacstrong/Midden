/**
 * WebSocket protocol between the web client (ServerStore) and the server. Shared so both
 * sides compile against the same shapes. Ops themselves are validated with OpSchema.
 */
import { z } from 'zod';
import type { CaseState } from '../domain/types.js';
import { OpSchema, type Op } from '../ops/ops.js';

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

export type ClientMessage =
  | { t: 'hello'; caseId: string; lastSeq: number | null }
  | { t: 'op'; clientOpId: string; baseSeq: number; op: Op }
  | { t: 'presence'; view: string; selectedId?: string | undefined; editingId?: string | undefined }
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
  z.object({ t: z.literal('ping') }),
]) as unknown as z.ZodType<ClientMessage>;

/** Gap above which the server sends a full snapshot instead of a catch-up op list. */
export const SNAPSHOT_GAP = 500;
