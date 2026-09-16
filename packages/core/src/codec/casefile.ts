/**
 * Case-file codec. Reads `midden.case.v1` (the prototype's format) and `midden.case.v2`,
 * writes v2. The v2 file is a strict superset of v1: `case`, `hosts` and `events` keep the
 * exact v1 shapes, so a v2 file still opens in the old prototype (which ignores `schema`).
 */
import { z } from 'zod';
import type { AttachmentMeta, CaseState, Event, Host, Link, ScanMeta } from '../domain/types.js';
import { linkKey } from '../domain/types.js';
import {
  AttachmentMetaSchema,
  CaseMetaSchema,
  EventSchema,
  HostSchema,
  LinkSchema,
  ScanMetaSchema,
} from '../domain/schemas.js';
import { uid } from '../domain/ids.js';
import { emptyState } from '../ops/reducer.js';
import type { Op } from '../ops/ops.js';
import { CASE_SCHEMA_V1, CASE_SCHEMA_V2 } from '../schema/versions.js';
import { toEpoch } from '../time/time.js';
import type { ScanHost } from '../nmap/types.js';
import { ScanHostSchema } from '../nmap/schemas.js';

export class CaseFileError extends Error {
  override name = 'CaseFileError';
}

export interface ScanFileEntry extends ScanMeta {
  /** Parsed terrain, embedded so the standalone build can carry it. Absent in server exports by default. */
  hosts?: ScanHost[] | undefined;
}

export interface AttachmentFileEntry extends AttachmentMeta {
  /** Base64 payload, only for small attachments in standalone exports. */
  data?: string | undefined;
}

export interface CaseFileV2 {
  schema: typeof CASE_SCHEMA_V2;
  generator: string;
  exported: string;
  case: CaseState['case'];
  hosts: Host[];
  events: Event[];
  scans: ScanFileEntry[];
  links: Link[];
  attachments: AttachmentFileEntry[];
}

export interface ImportReport {
  version: 1 | 2;
  hosts: number;
  events: number;
  scans: number;
  links: number;
  attachments: number;
  remapped: Array<{ kind: 'host' | 'event' | 'scan' | 'attachment'; from: string; to: string }>;
  dropped: Array<{ kind: string; index: number; reason: string }>;
}

export interface ParsedCaseFile {
  state: CaseState;
  terrain: Record<string, ScanHost[]>;
  attachmentData: Record<string, string>;
  report: ImportReport;
}

const Envelope = z.object({
  schema: z.string().optional(),
  case: z.unknown().optional(),
  hosts: z.array(z.unknown()),
  events: z.array(z.unknown()),
  scans: z.array(z.unknown()).optional(),
  links: z.array(z.unknown()).optional(),
  attachments: z.array(z.unknown()).optional(),
});

const ScanEntrySchema = ScanMetaSchema.extend({ hosts: z.array(ScanHostSchema).optional() });
const AttachmentEntrySchema = AttachmentMetaSchema.extend({ data: z.string().optional() });

function firstIssue(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'invalid';
}

/** Parse JSON (already decoded) into case state. Throws CaseFileError when it is not a case file. */
export function readCaseFile(
  input: unknown,
  now: string = new Date().toISOString(),
): ParsedCaseFile {
  const env = Envelope.safeParse(input);
  if (!env.success)
    throw new CaseFileError('No case data found — expected hosts and events arrays');
  const d = env.data;
  const version: 1 | 2 = d.schema === CASE_SCHEMA_V2 ? 2 : 1;
  if (d.schema && d.schema !== CASE_SCHEMA_V1 && d.schema !== CASE_SCHEMA_V2)
    throw new CaseFileError(`Unsupported case file schema "${d.schema}"`);

  const report: ImportReport = {
    version,
    hosts: 0,
    events: 0,
    scans: 0,
    links: 0,
    attachments: 0,
    remapped: [],
    dropped: [],
  };
  const state = emptyState(now);
  const caseMeta = CaseMetaSchema.safeParse(d.case ?? {});
  state.case = caseMeta.success ? caseMeta.data : state.case;
  if (!state.case.created) state.case.created = now;
  if (!state.case.modified) state.case.modified = state.case.created;

  const hostIdMap = new Map<string, string>();
  d.hosts.forEach((raw, index) => {
    const obj = typeof raw === 'object' && raw ? { ...(raw as Record<string, unknown>) } : null;
    if (!obj) return void report.dropped.push({ kind: 'host', index, reason: 'not an object' });
    const original = typeof obj.id === 'string' && obj.id ? obj.id : '';
    if (!original || state.hosts[original]) {
      const fresh = uid('h');
      if (original) {
        report.remapped.push({ kind: 'host', from: original, to: fresh });
        hostIdMap.set(original, hostIdMap.get(original) ?? original);
      }
      obj.id = fresh;
    }
    if (typeof obj.name !== 'string' || !obj.name) obj.name = 'UNNAMED';
    const parsed = HostSchema.safeParse(obj);
    if (!parsed.success)
      return void report.dropped.push({ kind: 'host', index, reason: firstIssue(parsed.error) });
    state.hosts[parsed.data.id] = parsed.data;
    report.hosts++;
  });

  d.events.forEach((raw, index) => {
    const obj = typeof raw === 'object' && raw ? { ...(raw as Record<string, unknown>) } : null;
    if (!obj) return void report.dropped.push({ kind: 'event', index, reason: 'not an object' });
    delete obj.ep;
    const original = typeof obj.id === 'string' && obj.id ? obj.id : '';
    if (!original || state.events[original]) {
      const fresh = uid('ev');
      if (original) report.remapped.push({ kind: 'event', from: original, to: fresh });
      obj.id = fresh;
    }
    const parsed = EventSchema.safeParse(obj);
    if (!parsed.success)
      return void report.dropped.push({ kind: 'event', index, reason: firstIssue(parsed.error) });
    const ev = parsed.data;
    if (ev.ts && Number.isNaN(Date.parse(ev.ts)))
      return void report.dropped.push({
        kind: 'event',
        index,
        reason: `unparseable timestamp "${ev.ts}"`,
      });
    state.events[ev.id] = ev;
    report.events++;
  });

  const terrain: Record<string, ScanHost[]> = {};
  (d.scans ?? []).forEach((raw, index) => {
    const parsed = ScanEntrySchema.safeParse(raw);
    if (!parsed.success)
      return void report.dropped.push({ kind: 'scan', index, reason: firstIssue(parsed.error) });
    const { hosts, ...meta } = parsed.data;
    let id = meta.id;
    if (state.scans[id]) {
      const fresh = uid('scan');
      report.remapped.push({ kind: 'scan', from: id, to: fresh });
      id = fresh;
    }
    state.scans[id] = { ...meta, id };
    if (hosts) terrain[id] = hosts;
    report.scans++;
  });

  (d.links ?? []).forEach((raw, index) => {
    const parsed = LinkSchema.safeParse(raw);
    if (!parsed.success)
      return void report.dropped.push({ kind: 'link', index, reason: firstIssue(parsed.error) });
    state.links[linkKey(parsed.data.hostId, parsed.data.ip)] = parsed.data;
    report.links++;
  });

  const attachmentData: Record<string, string> = {};
  (d.attachments ?? []).forEach((raw, index) => {
    const parsed = AttachmentEntrySchema.safeParse(raw);
    if (!parsed.success)
      return void report.dropped.push({
        kind: 'attachment',
        index,
        reason: firstIssue(parsed.error),
      });
    const { data, ...meta } = parsed.data;
    let id = meta.id;
    if (state.attachments[id]) {
      const fresh = uid('att');
      report.remapped.push({ kind: 'attachment', from: id, to: fresh });
      id = fresh;
    }
    state.attachments[id] = { ...meta, id };
    if (data) attachmentData[id] = data;
    report.attachments++;
  });

  return { state, terrain, attachmentData, report };
}

/** Events in timeline order: by instant, then id for stability. */
export function sortedEvents(state: CaseState): Event[] {
  return Object.values(state.events).sort(
    (a, b) => toEpoch(a.ts) - toEpoch(b.ts) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export interface WriteOptions {
  generator?: string | undefined;
  now?: string | undefined;
  /** Terrain to embed per scan id (standalone exports). */
  terrain?: Record<string, ScanHost[]> | undefined;
  /** Base64 payloads per attachment id (standalone exports, small files only). */
  attachmentData?: Record<string, string> | undefined;
}

export function writeCaseFile(state: CaseState, opts: WriteOptions = {}): CaseFileV2 {
  const now = opts.now ?? new Date().toISOString();
  return {
    schema: CASE_SCHEMA_V2,
    generator: opts.generator ?? 'MIDDEN',
    exported: now,
    case: { ...state.case, modified: state.case.modified || now },
    hosts: Object.values(state.hosts),
    events: sortedEvents(state),
    scans: Object.values(state.scans).map((s) => {
      const hosts = opts.terrain?.[s.id];
      return hosts ? { ...s, hosts } : { ...s };
    }),
    links: Object.values(state.links),
    attachments: Object.values(state.attachments).map((a) => {
      const data = opts.attachmentData?.[a.id];
      return data ? { ...a, data } : { ...a };
    }),
  };
}

/**
 * Ops that merge an imported case into the current one: everything with an unknown id is
 * added, everything already present is left alone (the prototype's merge semantics).
 */
export function mergeOps(current: CaseState, incoming: CaseState): Op {
  const ops: Op[] = [];
  for (const h of Object.values(incoming.hosts))
    if (!current.hosts[h.id]) ops.push({ type: 'host.add', host: h });
  for (const e of Object.values(incoming.events))
    if (!current.events[e.id]) ops.push({ type: 'event.add', event: e });
  for (const s of Object.values(incoming.scans))
    if (!current.scans[s.id]) ops.push({ type: 'scan.add', scan: s });
  for (const l of Object.values(incoming.links))
    if (!current.links[linkKey(l.hostId, l.ip)])
      ops.push({ type: 'link.set', hostId: l.hostId, ip: l.ip });
  for (const a of Object.values(incoming.attachments))
    if (!current.attachments[a.id]) ops.push({ type: 'attachment.add', att: a });
  return { type: 'batch', ops };
}
