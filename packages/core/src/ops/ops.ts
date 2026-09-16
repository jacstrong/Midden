/**
 * The operation vocabulary. Every change to case state, on the server or in the client,
 * is one of these. Patches carry only the keys being changed, which is what makes
 * per-field last-write-wins work when two analysts edit the same entity.
 */
import { z } from 'zod';
import type {
  AttachmentMeta,
  CaseMeta,
  Event,
  EventFields,
  Host,
  HostFields,
  ScanFields,
  ScanMeta,
} from '../domain/types.js';
import {
  AttachmentMetaSchema,
  CasePatchSchema,
  EventPatchSchema,
  EventSchema,
  HostPatchSchema,
  HostSchema,
  LinkSchema,
  ScanMetaSchema,
  ScanPatchSchema,
} from '../domain/schemas.js';

export const MAX_BATCH = 5000;

export type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export type Op =
  | { type: 'noop' }
  | { type: 'case.set'; patch: Patch<CaseMeta> }
  | { type: 'host.add'; host: Host; source?: { scanId: string; ip: string } | undefined }
  | { type: 'host.set'; id: string; patch: Patch<HostFields> }
  | { type: 'host.remove'; id: string }
  | { type: 'event.add'; event: Event }
  | { type: 'event.set'; id: string; patch: Patch<EventFields> }
  | { type: 'event.remove'; id: string }
  | { type: 'scan.add'; scan: ScanMeta }
  | { type: 'scan.set'; id: string; patch: Patch<ScanFields> }
  | { type: 'scan.remove'; id: string }
  | { type: 'link.set'; hostId: string; ip: string }
  | { type: 'link.remove'; hostId: string; ip: string }
  | { type: 'attachment.add'; att: AttachmentMeta }
  | { type: 'attachment.remove'; id: string }
  | { type: 'batch'; ops: Op[] }
  | { type: 'op.revert'; targetSeq: number; inverse: Op };

export type OpType = Op['type'];

const id = z.string().min(1);

export const OpSchema: z.ZodType<Op> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('noop') }),
    z.object({ type: z.literal('case.set'), patch: CasePatchSchema }),
    z.object({
      type: z.literal('host.add'),
      host: HostSchema,
      source: z.object({ scanId: id, ip: z.string().min(1) }).optional(),
    }),
    z.object({ type: z.literal('host.set'), id, patch: HostPatchSchema }),
    z.object({ type: z.literal('host.remove'), id }),
    z.object({ type: z.literal('event.add'), event: EventSchema }),
    z.object({ type: z.literal('event.set'), id, patch: EventPatchSchema }),
    z.object({ type: z.literal('event.remove'), id }),
    z.object({ type: z.literal('scan.add'), scan: ScanMetaSchema }),
    z.object({ type: z.literal('scan.set'), id, patch: ScanPatchSchema }),
    z.object({ type: z.literal('scan.remove'), id }),
    z.object({ type: z.literal('link.set') }).extend(LinkSchema.shape),
    z.object({ type: z.literal('link.remove') }).extend(LinkSchema.shape),
    z.object({ type: z.literal('attachment.add'), att: AttachmentMetaSchema }),
    z.object({ type: z.literal('attachment.remove'), id }),
    z.object({ type: z.literal('batch'), ops: z.array(OpSchema) }),
    z.object({
      type: z.literal('op.revert'),
      targetSeq: z.number().int().positive(),
      inverse: OpSchema,
    }),
  ]),
) as unknown as z.ZodType<Op>;

/** Validate and normalise an untrusted op. Throws ZodError. */
export function parseOp(input: unknown): Op {
  return OpSchema.parse(input);
}

/** Count leaf operations, so batches can be capped and rate-limited. */
export function opSize(op: Op): number {
  if (op.type === 'batch') return op.ops.reduce((n, o) => n + opSize(o), 0);
  if (op.type === 'op.revert') return opSize(op.inverse);
  return 1;
}

/** Entity ids an op touches, for permission checks and conflict tracking. `field` keys are `entityId/field`. */
export function touchedFields(op: Op): string[] {
  switch (op.type) {
    case 'case.set':
      return definedKeys(op.patch).map((k) => `case/${k}`);
    case 'host.set':
      return definedKeys(op.patch).map((k) => `${op.id}/${k}`);
    case 'event.set':
      return definedKeys(op.patch).map((k) => `${op.id}/${k}`);
    case 'scan.set':
      return definedKeys(op.patch).map((k) => `${op.id}/${k}`);
    case 'host.add':
      return [`${op.host.id}/*`];
    case 'event.add':
      return [`${op.event.id}/*`];
    case 'scan.add':
      return [`${op.scan.id}/*`];
    case 'attachment.add':
      return [`${op.att.id}/*`];
    case 'host.remove':
    case 'event.remove':
    case 'scan.remove':
    case 'attachment.remove':
      return [`${op.id}/*`];
    case 'link.set':
    case 'link.remove':
      return [`${op.hostId}/links`];
    case 'batch':
      return op.ops.flatMap(touchedFields);
    case 'op.revert':
      return touchedFields(op.inverse);
    case 'noop':
      return [];
  }
}

export function definedKeys<T extends object>(patch: T): (keyof T & string)[] {
  return (Object.keys(patch) as (keyof T & string)[]).filter((k) => patch[k] !== undefined);
}
