import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { apply, applyAll, emptyState, inverse } from './reducer.js';
import { parseOp, opSize, touchedFields, type Op } from './ops.js';
import type { CaseState, Event, Host } from '../domain/types.js';

const host = (id: string, extra: Partial<Host> = {}): Host => ({
  id,
  name: id.toUpperCase(),
  ip: '',
  os: '',
  role: '',
  zone: '',
  crit: 'moderate',
  status: 'unknown',
  owner: '',
  tags: [],
  notes: '',
  ...extra,
});
const event = (id: string, extra: Partial<Event> = {}): Event => ({
  id,
  ts: '2026-07-14T13:00:00.000Z',
  off: 0,
  hostId: '',
  srcHostId: '',
  user: '',
  priv: '',
  indicator: '',
  itype: '',
  activity: '',
  cmd: '',
  tactic: '',
  technique: '',
  source: '',
  link: '',
  conf: 'medium',
  sev: 'medium',
  key: false,
  tags: [],
  evidence: '',
  notes: '',
  ...extra,
});

describe('reducer basics', () => {
  it('adds, patches and removes entities', () => {
    let s = emptyState('2026-01-01T00:00:00.000Z');
    s = apply(s, { type: 'host.add', host: host('h1') });
    s = apply(s, { type: 'event.add', event: event('e1', { hostId: 'h1' }) });
    expect(Object.keys(s.hosts)).toEqual(['h1']);
    s = apply(s, { type: 'host.set', id: 'h1', patch: { status: 'compromised', name: undefined } });
    expect(s.hosts.h1?.status).toBe('compromised');
    expect(s.hosts.h1?.name).toBe('H1');
    s = apply(s, { type: 'host.remove', id: 'h1' });
    expect(s.hosts.h1).toBeUndefined();
    // dangling reference is kept, not cleared
    expect(s.events.e1?.hostId).toBe('h1');
  });

  it('ignores adds for existing ids and sets for missing ids', () => {
    let s = apply(emptyState(), { type: 'host.add', host: host('h1', { name: 'first' }) });
    const s2 = apply(s, { type: 'host.add', host: host('h1', { name: 'second' }) });
    expect(s2).toBe(s);
    s = apply(s, { type: 'event.set', id: 'missing', patch: { user: 'x' } });
    expect(Object.keys(s.events)).toEqual([]);
  });

  it('never lets a patch change the id', () => {
    let s = apply(emptyState(), { type: 'host.add', host: host('h1') });
    s = apply(s, { type: 'host.set', id: 'h1', patch: { id: 'evil' } as never });
    expect(s.hosts.h1?.id).toBe('h1');
  });

  it('applies batches atomically in order and reverts via op.revert', () => {
    const s0 = emptyState();
    const batch: Op = {
      type: 'batch',
      ops: [
        { type: 'host.add', host: host('h1') },
        { type: 'host.set', id: 'h1', patch: { status: 'suspect' } },
        { type: 'link.set', hostId: 'h1', ip: '10.0.0.1' },
      ],
    };
    const s1 = apply(s0, batch);
    expect(s1.hosts.h1?.status).toBe('suspect');
    expect(Object.keys(s1.links)).toEqual(['h1|10.0.0.1']);
    const inv = inverse(s0, batch);
    expect(inv.type).toBe('batch');
    const s2 = apply(s1, { type: 'op.revert', targetSeq: 1, inverse: inv });
    expect(s2).toEqual(s0);
  });

  it('validates ops with the schema and strips unknown keys', () => {
    const op = parseOp({ type: 'host.set', id: 'h1', patch: { status: 'compromised', bogus: 1 } });
    expect(op).toEqual({ type: 'host.set', id: 'h1', patch: { status: 'compromised' } });
    expect(() => parseOp({ type: 'nope' })).toThrow();
    // patches never gain defaulted keys and never coerce bad values
    const p2 = parseOp({ type: 'event.set', id: 'e1', patch: { user: 'x' } });
    expect(p2).toEqual({ type: 'event.set', id: 'e1', patch: { user: 'x' } });
    expect(() => parseOp({ type: 'host.set', id: 'h1', patch: { status: 'bogus' } })).toThrow();
    expect(() => parseOp({ type: 'event.set', id: 'e1', patch: { off: '5' } })).toThrow();
    expect(() => parseOp({ type: 'host.set', id: '', patch: {} })).toThrow();
    expect(
      opSize({
        type: 'batch',
        ops: [{ type: 'noop' }, { type: 'batch', ops: [{ type: 'noop' }] }],
      }),
    ).toBe(2);
    expect(
      touchedFields({ type: 'event.set', id: 'e1', patch: { user: 'a', priv: undefined } }),
    ).toEqual(['e1/user']);
  });
});

/* ---------------- property tests ---------------- */

const ids = ['a', 'b', 'c', 'd'];
const arbId = fc.constantFrom(...ids);
const arbStr = fc.string({ maxLength: 8 });
const arbHost = arbId.chain((id) =>
  fc
    .record({
      name: arbStr,
      ip: arbStr,
      notes: arbStr,
      status: fc.constantFrom('unknown', 'compromised', 'clean'),
    })
    .map((f) => host(id, f as Partial<Host>)),
);
const arbEvent = arbId.chain((id) =>
  fc
    .record({
      hostId: arbId,
      user: arbStr,
      key: fc.boolean(),
      tags: fc.array(arbStr, { maxLength: 3 }),
    })
    .map((f) => event(id, f)),
);
const arbHostPatch = fc.record(
  {
    name: arbStr,
    status: fc.constantFrom('unknown', 'compromised', 'clean'),
    tags: fc.array(arbStr, { maxLength: 2 }),
  },
  { requiredKeys: [] },
);
const arbEventPatch = fc.record(
  { user: arbStr, activity: arbStr, key: fc.boolean(), off: fc.integer({ min: -720, max: 840 }) },
  { requiredKeys: [] },
);

const arbLeafOp: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ type: 'noop' }),
  fc
    .record({ name: arbStr, summary: arbStr }, { requiredKeys: [] })
    .map((patch): Op => ({ type: 'case.set', patch })),
  arbHost.map((h): Op => ({ type: 'host.add', host: h })),
  fc.tuple(arbId, arbHostPatch).map(([id, patch]): Op => ({
    type: 'host.set',
    id,
    patch: patch as Op extends { type: 'host.set' } ? never : never,
  })),
  arbId.map((id): Op => ({ type: 'host.remove', id })),
  arbEvent.map((e): Op => ({ type: 'event.add', event: e })),
  fc.tuple(arbId, arbEventPatch).map(([id, patch]): Op => ({ type: 'event.set', id, patch })),
  arbId.map((id): Op => ({ type: 'event.remove', id })),
  fc
    .tuple(arbId, fc.constantFrom('10.0.0.1', '10.0.0.2'))
    .map(([hostId, ip]): Op => ({ type: 'link.set', hostId, ip })),
  fc
    .tuple(arbId, fc.constantFrom('10.0.0.1', '10.0.0.2'))
    .map(([hostId, ip]): Op => ({ type: 'link.remove', hostId, ip })),
);
const arbOp: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: arbLeafOp },
  {
    weight: 1,
    arbitrary: fc.array(arbLeafOp, { maxLength: 4 }).map((ops): Op => ({ type: 'batch', ops })),
  },
);
const arbState: fc.Arbitrary<CaseState> = fc
  .array(arbOp, { maxLength: 12 })
  .map((ops) => applyAll(emptyState('2026-01-01T00:00:00.000Z'), ops));

describe('reducer properties', () => {
  it('apply then inverse restores the previous state', () => {
    fc.assert(
      fc.property(arbState, arbOp, (s, op) => {
        const after = apply(s, op);
        const back = apply(after, inverse(s, op));
        expect(back).toEqual(s);
      }),
      { numRuns: 1000 },
    );
  });

  it('replay is deterministic and inverse of a revert re-applies', () => {
    fc.assert(
      fc.property(arbState, fc.array(arbOp, { maxLength: 6 }), (s, ops) => {
        expect(applyAll(s, ops)).toEqual(applyAll(s, ops));
        let cur = s;
        for (const op of ops) {
          const inv = inverse(cur, op);
          const next = apply(cur, op);
          const revert: Op = { type: 'op.revert', targetSeq: 1, inverse: inv };
          const reverted = apply(next, revert);
          expect(reverted).toEqual(cur);
          expect(apply(reverted, inverse(next, revert))).toEqual(next);
          cur = next;
        }
      }),
      { numRuns: 300 },
    );
  });

  it('patches to disjoint fields of the same entity commute', () => {
    fc.assert(
      fc.property(arbState, arbId, arbStr, arbStr, (s, id, user, activity) => {
        const a: Op = { type: 'event.set', id, patch: { user } };
        const b: Op = { type: 'event.set', id, patch: { activity } };
        expect(applyAll(s, [a, b])).toEqual(applyAll(s, [b, a]));
      }),
      { numRuns: 300 },
    );
  });

  it('every op passes its own schema after a round-trip through JSON', () => {
    fc.assert(
      fc.property(arbOp, (op) => {
        expect(parseOp(JSON.parse(JSON.stringify(op)))).toBeTruthy();
      }),
      { numRuns: 300 },
    );
  });
});
