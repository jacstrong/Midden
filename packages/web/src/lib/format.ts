import { LANE_COLORS } from '@midden/core';

export function trunc(s: string | null | undefined, n: number): string {
  const v = String(s ?? '');
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
}

export function initials(name: string): string {
  return name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

/** A stable colour for a person, so their avatar looks the same everywhere. */
export function colorFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return LANE_COLORS[h % LANE_COLORS.length]!;
}
