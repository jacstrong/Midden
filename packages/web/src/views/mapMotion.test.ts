import { describe, expect, it } from 'vitest';
import { blend, visibleBox, type Frame } from './mapMotion';

const frame = (pos: Record<string, [number, number]>, scope: unknown = 'a'): Frame => ({
  pos: new Map(Object.entries(pos).map(([id, [x, y]]) => [id, { x, y }])),
  bounds: { x: 0, y: 0, w: 100, h: 100 },
  scope,
});

describe('blend', () => {
  const parents = new Map([
    ['host', 'hub'],
    ['hub', 'root'],
  ]);

  it('starts where the nodes were and ends where the layout puts them', () => {
    const from = frame({ root: [0, 0], hub: [10, 0] });
    const to = {
      ...frame({ root: [0, 0], hub: [50, 0] }),
      bounds: { x: -50, y: -50, w: 200, h: 200 },
    };
    expect(blend(from, to, 0, parents).pos.get('hub')).toEqual({ x: 10, y: 0 });
    expect(blend(from, to, 1, parents).pos.get('hub')).toEqual({ x: 50, y: 0 });
    expect(blend(from, to, 1, parents).bounds).toEqual(to.bounds);
    const mid = blend(from, to, 0.5, parents);
    expect(mid.pos.get('hub')!.x).toBeCloseTo(30);
    expect(mid.bounds.w).toBeCloseTo(150);
  });

  it('grows new nodes out of their nearest drawn ancestor and drops removed ones', () => {
    const from = frame({ root: [0, 0], hub: [10, 0], gone: [5, 5] });
    const to = frame({ root: [0, 0], hub: [10, 0], host: [30, 40] });
    const start = blend(from, to, 0, parents);
    expect(start.pos.get('host')).toEqual({ x: 10, y: 0 });
    expect(start.pos.has('gone')).toBe(false);
    // a host whose hub is also new starts at the root
    const fresh = blend(frame({ root: [0, 0] }), to, 0, parents);
    expect(fresh.pos.get('host')).toEqual({ x: 0, y: 0 });
  });
});

describe('visibleBox', () => {
  it('folds pan and zoom back into a plain viewBox', () => {
    const b = { x: 0, y: 0, w: 100, h: 50 };
    expect(visibleBox(b, { k: 1, x: 0, y: 0 })).toEqual(b);
    // zoomed 2x about the centre: the middle half of the scene is on screen
    expect(visibleBox(b, { k: 2, x: -50, y: -25 })).toEqual({ x: 25, y: 12.5, w: 50, h: 25 });
  });
});
