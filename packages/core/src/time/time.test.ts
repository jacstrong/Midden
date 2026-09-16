import { describe, expect, it } from 'vitest';
import { fmtParts, humanSpan, offsetLabel, parseTimestamp, pad, fileStamp } from './time.js';

describe('parseTimestamp', () => {
  const cases: Array<[string, number | 'local', string | null]> = [
    ['2026-07-14 13:02:41', 0, '2026-07-14T13:02:41.000Z'],
    ['2026-07-14T13:02:41', 0, '2026-07-14T13:02:41.000Z'],
    ['2026-07-14 13:02', 0, '2026-07-14T13:02:00.000Z'],
    ['2026-07-14', 0, '2026-07-14T00:00:00.000Z'],
    ['2026/07/14 13:02:41.123456', 0, '2026-07-14T13:02:41.123Z'],
    ['2026-07-14 13:02:41', -300, '2026-07-14T18:02:41.000Z'],
    ['2026-07-14 13:02:41', 120, '2026-07-14T11:02:41.000Z'],
    ['2026-07-14T13:02:41Z', -300, '2026-07-14T13:02:41.000Z'],
    ['2026-07-14T13:02:41+02:00', 0, '2026-07-14T11:02:41.000Z'],
    ['2026-07-14 13:02:41 -0500', 0, '2026-07-14T18:02:41.000Z'],
    ['7/14/2026 1:02:41 PM', 0, '2026-07-14T13:02:41.000Z'],
    ['7/14/2026 12:15 AM', 0, '2026-07-14T00:15:00.000Z'],
    ['07-14-2026', 0, '2026-07-14T00:00:00.000Z'],
    ['1752498161', 0, '2025-07-14T13:02:41.000Z'],
    ['1752498161000', 0, '2025-07-14T13:02:41.000Z'],
    ['"2026-07-14 13:02:41"', 0, '2026-07-14T13:02:41.000Z'],
    ['2026-07-14 13:02:41 (source clock)', 0, '2026-07-14T13:02:41.000Z'],
    ['not a date', 0, null],
    ['', 0, null],
  ];
  it.each(cases)('parses %s at offset %s', (raw, off, expected) => {
    expect(parseTimestamp(raw, off)).toBe(expected);
  });
});

describe('formatting', () => {
  it('renders parts at an offset', () => {
    const ep = Date.parse('2026-07-14T13:02:41Z');
    expect(fmtParts(ep, 0)).toEqual({ date: '2026-07-14', time: '13:02:41' });
    expect(fmtParts(ep, -300)).toEqual({ date: '2026-07-14', time: '08:02:41' });
    expect(fmtParts(ep, 330)).toEqual({ date: '2026-07-14', time: '18:32:41' });
  });
  it('labels offsets', () => {
    expect(offsetLabel(0)).toBe('UTC');
    expect(offsetLabel(null)).toBe('UTC');
    expect(offsetLabel(-300)).toBe('UTC−05:00');
    expect(offsetLabel(330)).toBe('UTC+05:30');
  });
  it('humanises spans', () => {
    expect(humanSpan(-1)).toBe('—');
    expect(humanSpan(30_000)).toBe('30s');
    expect(humanSpan(5 * 60_000)).toBe('5m');
    expect(humanSpan(3 * 3_600_000 + 7 * 60_000)).toBe('3h 7m');
    expect(humanSpan(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h');
  });
  it('pads and stamps', () => {
    expect(pad(7)).toBe('07');
    expect(pad(7, 3)).toBe('007');
    expect(fileStamp(Date.parse('2026-07-14T13:02:41Z'))).toBe('2026-07-14T130241');
  });
});
