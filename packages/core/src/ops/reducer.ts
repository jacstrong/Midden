/**
 * Pure reducer over CaseState. `apply` is the only way state changes anywhere in Midden.
 * `inverse` computes the op that undoes `op` given the state *before* it was applied; the
 * server stores it alongside each logged op so history and revert are O(1).
 *
 * Invariant (property-tested): apply(apply(s, op), inverse(s, op)) deep-equals s.
 *
 * Removing a host or scan does not touch events or links that reference it; references are
 * left dangling and rendered as "(deleted host)". That keeps every inverse total and simple,
 * and means a revert of the removal restores the relationships for free.
 */
import type { CaseState, Link } from '../domain/types.js';
import { linkKey } from '../domain/types.js';
import type { Op } from './ops.js';

export function emptyState(now: string = new Date().toISOString()): CaseState {
  return {
    case: {
      name: '',
      number: '',
      analyst: '',
      classification: '',
      summary: '',
      created: now,
      modified: now,
    },
    hosts: {},
    events: {},
    scans: {},
    links: {},
    attachments: {},
  };
}

function patched<T extends object>(target: T, patch: object): T {
  const out: Record<string, unknown> = { ...(target as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || v === undefined) continue;
    out[k] = v;
  }
  return out as T;
}

/** The previous values of exactly the keys a patch defines. */
function priorOf<P extends object>(target: object, patch: P): P {
  const out: Record<string, unknown> = {};
  const src = target as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'id' || v === undefined) continue;
    out[k] = src[k];
  }
  return out as P;
}

function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec;
  const { [key]: _drop, ...rest } = rec;
  return rest;
}

export function apply(state: CaseState, op: Op): CaseState {
  switch (op.type) {
    case 'noop':
      return state;
    case 'case.set':
      return { ...state, case: patched(state.case, op.patch) };
    case 'host.add':
      if (state.hosts[op.host.id]) return state;
      return { ...state, hosts: { ...state.hosts, [op.host.id]: op.host } };
    case 'host.set': {
      const h = state.hosts[op.id];
      if (!h) return state;
      return { ...state, hosts: { ...state.hosts, [op.id]: patched(h, op.patch) } };
    }
    case 'host.remove':
      if (!state.hosts[op.id]) return state;
      return { ...state, hosts: without(state.hosts, op.id) };
    case 'event.add':
      if (state.events[op.event.id]) return state;
      return { ...state, events: { ...state.events, [op.event.id]: op.event } };
    case 'event.set': {
      const e = state.events[op.id];
      if (!e) return state;
      return { ...state, events: { ...state.events, [op.id]: patched(e, op.patch) } };
    }
    case 'event.remove':
      if (!state.events[op.id]) return state;
      return { ...state, events: without(state.events, op.id) };
    case 'scan.add':
      if (state.scans[op.scan.id]) return state;
      return { ...state, scans: { ...state.scans, [op.scan.id]: op.scan } };
    case 'scan.set': {
      const s = state.scans[op.id];
      if (!s) return state;
      return { ...state, scans: { ...state.scans, [op.id]: patched(s, op.patch) } };
    }
    case 'scan.remove':
      if (!state.scans[op.id]) return state;
      return { ...state, scans: without(state.scans, op.id) };
    case 'link.set': {
      const k = linkKey(op.hostId, op.ip);
      if (state.links[k]) return state;
      const link: Link = { hostId: op.hostId, ip: op.ip };
      return { ...state, links: { ...state.links, [k]: link } };
    }
    case 'link.remove': {
      const k = linkKey(op.hostId, op.ip);
      if (!state.links[k]) return state;
      return { ...state, links: without(state.links, k) };
    }
    case 'attachment.add':
      if (state.attachments[op.att.id]) return state;
      return { ...state, attachments: { ...state.attachments, [op.att.id]: op.att } };
    case 'attachment.set': {
      const a = state.attachments[op.id];
      if (!a) return state;
      return { ...state, attachments: { ...state.attachments, [op.id]: patched(a, op.patch) } };
    }
    case 'attachment.remove':
      if (!state.attachments[op.id]) return state;
      return { ...state, attachments: without(state.attachments, op.id) };
    case 'batch':
      return op.ops.reduce(apply, state);
    case 'op.revert':
      return apply(state, op.inverse);
  }
}

export function applyAll(state: CaseState, ops: Iterable<Op>): CaseState {
  let s = state;
  for (const op of ops) s = apply(s, op);
  return s;
}

const NOOP: Op = { type: 'noop' };

/** The op that undoes `op` when applied to `apply(state, op)`. `state` is the pre-state. */
export function inverse(state: CaseState, op: Op): Op {
  switch (op.type) {
    case 'noop':
      return NOOP;
    case 'case.set':
      return { type: 'case.set', patch: priorOf(state.case, op.patch) };
    case 'host.add':
      return state.hosts[op.host.id] ? NOOP : { type: 'host.remove', id: op.host.id };
    case 'host.set': {
      const h = state.hosts[op.id];
      return h ? { type: 'host.set', id: op.id, patch: priorOf(h, op.patch) } : NOOP;
    }
    case 'host.remove': {
      const h = state.hosts[op.id];
      return h ? { type: 'host.add', host: h } : NOOP;
    }
    case 'event.add':
      return state.events[op.event.id] ? NOOP : { type: 'event.remove', id: op.event.id };
    case 'event.set': {
      const e = state.events[op.id];
      return e ? { type: 'event.set', id: op.id, patch: priorOf(e, op.patch) } : NOOP;
    }
    case 'event.remove': {
      const e = state.events[op.id];
      return e ? { type: 'event.add', event: e } : NOOP;
    }
    case 'scan.add':
      return state.scans[op.scan.id] ? NOOP : { type: 'scan.remove', id: op.scan.id };
    case 'scan.set': {
      const s = state.scans[op.id];
      return s ? { type: 'scan.set', id: op.id, patch: priorOf(s, op.patch) } : NOOP;
    }
    case 'scan.remove': {
      const s = state.scans[op.id];
      return s ? { type: 'scan.add', scan: s } : NOOP;
    }
    case 'link.set':
      return state.links[linkKey(op.hostId, op.ip)]
        ? NOOP
        : { type: 'link.remove', hostId: op.hostId, ip: op.ip };
    case 'link.remove':
      return state.links[linkKey(op.hostId, op.ip)]
        ? { type: 'link.set', hostId: op.hostId, ip: op.ip }
        : NOOP;
    case 'attachment.add':
      return state.attachments[op.att.id] ? NOOP : { type: 'attachment.remove', id: op.att.id };
    case 'attachment.set': {
      const a = state.attachments[op.id];
      return a ? { type: 'attachment.set', id: op.id, patch: priorOf(a, op.patch) } : NOOP;
    }
    case 'attachment.remove': {
      const a = state.attachments[op.id];
      return a ? { type: 'attachment.add', att: a } : NOOP;
    }
    case 'batch': {
      const inverses: Op[] = [];
      let s = state;
      for (const o of op.ops) {
        inverses.push(inverse(s, o));
        s = apply(s, o);
      }
      inverses.reverse();
      return { type: 'batch', ops: inverses };
    }
    case 'op.revert':
      return inverse(state, op.inverse);
  }
}

/** True when applying the op to this state would change nothing. */
export function isEffectivelyNoop(state: CaseState, op: Op): boolean {
  return apply(state, op) === state;
}
