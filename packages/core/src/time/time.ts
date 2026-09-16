/**
 * Timestamp handling, ported unchanged from the prototype.
 *
 * Events store `ts` as an ISO-8601 UTC instant and `off` as the source-system timezone offset
 * in minutes east of UTC, so a timestamp can always be re-rendered the way the analyst saw it
 * in the source system.
 */

export type OffsetChoice = number | 'local';

export const TZ_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['local', 'Local (this browser)'],
  ['0', 'UTC ±00:00'],
  ['-720', 'UTC −12:00'],
  ['-660', 'UTC −11:00'],
  ['-600', 'UTC −10:00'],
  ['-540', 'UTC −09:00'],
  ['-480', 'UTC −08:00 PST'],
  ['-420', 'UTC −07:00 MST/PDT'],
  ['-360', 'UTC −06:00 CST/MDT'],
  ['-300', 'UTC −05:00 EST/CDT'],
  ['-240', 'UTC −04:00 EDT'],
  ['-210', 'UTC −03:30'],
  ['-180', 'UTC −03:00'],
  ['-120', 'UTC −02:00'],
  ['-60', 'UTC −01:00'],
  ['60', 'UTC +01:00 CET'],
  ['120', 'UTC +02:00 CEST'],
  ['180', 'UTC +03:00'],
  ['210', 'UTC +03:30'],
  ['240', 'UTC +04:00'],
  ['270', 'UTC +04:30'],
  ['300', 'UTC +05:00'],
  ['330', 'UTC +05:30 IST'],
  ['345', 'UTC +05:45'],
  ['360', 'UTC +06:00'],
  ['420', 'UTC +07:00'],
  ['480', 'UTC +08:00'],
  ['540', 'UTC +09:00 JST'],
  ['570', 'UTC +09:30'],
  ['600', 'UTC +10:00'],
  ['660', 'UTC +11:00'],
  ['720', 'UTC +12:00'],
  ['780', 'UTC +13:00'],
];

export function pad(n: number | string, w = 2): string {
  let s = String(n);
  while (s.length < w) s = '0' + s;
  return s;
}

/** Minutes east of UTC for the running environment at the given instant. */
export function browserOffset(ms?: number | null): number {
  return -new Date(ms == null ? Date.now() : ms).getTimezoneOffset();
}

/**
 * Parse a human-entered timestamp into an ISO UTC string, or null.
 * Accepts ISO-8601, `YYYY-MM-DD HH:MM:SS[.fff]`, US `M/D/YYYY h:mm[:ss] [AM|PM]`, and epoch
 * seconds or milliseconds. An explicit zone in the string wins over `offMin`.
 */
export function parseTimestamp(
  raw: string | null | undefined,
  offMin: OffsetChoice,
): string | null {
  if (!raw) return null;
  const s = String(raw)
    .trim()
    .replace(/\s*\(.*\)$/, '')
    .replace(/^"|"$/g, '');
  if (!s) return null;
  if (/^\d{13}$/.test(s)) return new Date(+s).toISOString();
  if (/^\d{10}$/.test(s)) return new Date(+s * 1000).toISOString();
  // An explicit zone (after a time of day, so a trailing "-2026" year is not mistaken for one)
  if (/\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const iso = s
      .replace(/^(\d{4}-\d{2}-\d{2})[ T]+/, '$1T')
      .replace(/\s+(Z|[+-]\d{2}:?\d{2})$/i, '$1')
      .replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
    const t = Date.parse(iso);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  let m: (string | undefined)[] | null = s.match(
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:[.,](\d{1,6}))?)?$/,
  );
  if (!m) {
    const u = s.match(
      /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ ,T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(AM|PM)?$/i,
    );
    if (u) {
      let h = +(u[4] ?? 0);
      if (u[7]) {
        const ap = u[7].toUpperCase();
        if (ap === 'PM' && h < 12) h += 12;
        if (ap === 'AM' && h === 12) h = 0;
      }
      m = [undefined, u[3], u[1], u[2], String(h), u[5] ?? '0', u[6] ?? '0', '0'];
    }
  }
  if (!m) return null;
  const ms = Date.UTC(
    +(m[1] ?? 0),
    +(m[2] ?? 1) - 1,
    +(m[3] ?? 1),
    +(m[4] ?? 0),
    +(m[5] ?? 0),
    +(m[6] ?? 0),
    +((m[7] ?? '0') + '00').slice(0, 3),
  );
  if (Number.isNaN(ms)) return null;
  const off = offMin === 'local' ? browserOffset(ms) : +offMin || 0;
  return new Date(ms - off * 60000).toISOString();
}

export function offsetLabel(min: number | null | undefined): string {
  if (min === 0 || min == null) return 'UTC';
  const s = min < 0 ? '−' : '+';
  const a = Math.abs(min);
  return 'UTC' + s + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
}

export interface DateTimeParts {
  date: string;
  time: string;
}

/** Split an epoch into date and time strings as seen at the given offset. */
export function fmtParts(epoch: number, offMin: number): DateTimeParts {
  const d = new Date(epoch + offMin * 60000);
  return {
    date: d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()),
    time: pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ':' + pad(d.getUTCSeconds()),
  };
}

export function toEpoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

export function humanSpan(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return '—';
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return d + 'd ' + (h % 24) + 'h';
  if (h > 0) return h + 'h ' + (m % 60) + 'm';
  if (m > 0) return m + 'm';
  return Math.round(ms / 1000) + 's';
}

/** Compact UTC stamp for filenames: `2026-07-14T130241`. */
export function fileStamp(now: number = Date.now()): string {
  const p = fmtParts(now, 0);
  return p.date + 'T' + p.time.replace(/:/g, '');
}
