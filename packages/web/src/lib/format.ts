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
