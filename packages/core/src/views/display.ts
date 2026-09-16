/** Timestamp display under the user's chosen timezone mode. Pure; the UI passes `tz`. */
import type { Event } from '../domain/types.js';
import { browserOffset, fmtParts, offsetLabel, toEpoch } from '../time/time.js';

export type TzMode = 'utc' | 'local' | 'source';

export function evOffset(ev: Pick<Event, 'ts' | 'off'>, tz: TzMode): number {
  if (tz === 'utc') return 0;
  if (tz === 'local') return browserOffset(toEpoch(ev.ts));
  return +ev.off || 0;
}

export function fmtTs(ev: Pick<Event, 'ts' | 'off'>, tz: TzMode, withZone = false): string {
  const off = evOffset(ev, tz);
  const p = fmtParts(toEpoch(ev.ts), off);
  return p.date + ' ' + p.time + (withZone ? ' ' + offsetLabel(off) : '');
}

export function fmtDate(ev: Pick<Event, 'ts' | 'off'>, tz: TzMode): string {
  return fmtParts(toEpoch(ev.ts), evOffset(ev, tz)).date;
}

export function fmtTime(ev: Pick<Event, 'ts' | 'off'>, tz: TzMode): string {
  return fmtParts(toEpoch(ev.ts), evOffset(ev, tz)).time;
}

/** Value for the timestamp input box: the event's own source-zone wall time. */
export function isoInput(ev: Pick<Event, 'ts' | 'off'>): string {
  const p = fmtParts(toEpoch(ev.ts), +ev.off || 0);
  return p.date + ' ' + p.time;
}

export function tzLabel(tz: TzMode): string {
  return tz === 'utc' ? 'UTC' : tz === 'local' ? 'LOCAL TIME' : 'SOURCE TIME';
}
