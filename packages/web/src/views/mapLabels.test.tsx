import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { labelTier, MapLabels, maxZoom, onScreen, pxPerUnit } from './mapLabels';

const vb = { x: -500, y: -250, w: 1000, h: 500 };

describe('screen scale', () => {
  it('measures pixels per map unit through the meet fit and the zoom', () => {
    // a 2000x500 screen fits the 1000x500 scene by height: 1px per unit, then zoomed
    expect(pxPerUnit(vb, { w: 2000, h: 500 }, { k: 1, x: 0, y: 0 })).toBe(1);
    expect(pxPerUnit(vb, { w: 500, h: 500 }, { k: 3, x: 0, y: 0 })).toBe(1.5);
  });

  it('includes the margins meet adds in what is on screen', () => {
    expect(onScreen(vb, { w: 2000, h: 500 }, { k: 1, x: 0, y: 0 })).toEqual({
      x: -1000,
      y: -250,
      w: 2000,
      h: 500,
    });
    // zoomed 2x about the origin: the middle quarter
    expect(onScreen(vb, { w: 1000, h: 500 }, { k: 2, x: 0, y: 0 })).toEqual({
      x: -250,
      y: -125,
      w: 500,
      h: 250,
    });
  });

  it('lets a huge map zoom far enough to read its hosts', () => {
    expect(maxZoom(vb, { w: 1000, h: 500 })).toBe(9);
    const huge = { x: 0, y: 0, w: 13000, h: 13000 };
    const k = maxZoom(huge, { w: 1100, h: 700 });
    expect(pxPerUnit(huge, { w: 1100, h: 700 }, { k, x: 0, y: 0 })).toBeCloseTo(4);
  });

  it('picks a label tier from the on-screen spacing', () => {
    expect(labelTier(10, [40, 90])).toBe(0);
    expect(labelTier(40, [40, 90])).toBe(1);
    expect(labelTier(120, [40, 90])).toBe(2);
  });
});

describe('MapLabels', () => {
  const labels = [
    { id: 'a', x: 0, y: 0, r: 10, name: '10.0.0.1', detail: 'dc01' },
    { id: 'b', x: 5000, y: 0, r: 10, name: '10.0.0.2' },
  ];

  it('draws only labels in view, at a constant screen size', () => {
    const { container } = render(
      <svg>
        <MapLabels labels={labels} ppu={2} view={{ x: -100, y: -100, w: 200, h: 200 }} />
      </svg>,
    );
    const texts = container.querySelectorAll('[data-testid=map-label]');
    expect(texts).toHaveLength(1);
    expect(texts[0]!.textContent).toBe('10.0.0.1dc01');
    // 11px on screen at 2px per unit is 5.5 units
    expect(texts[0]!.getAttribute('font-size')).toBe('5.5');
  });
});
