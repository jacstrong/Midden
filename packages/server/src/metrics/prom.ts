/**
 * Just enough of the Prometheus text format (version 0.0.4) for Midden's own metrics, written
 * by hand rather than pulling a client library into the SBOM.
 */

export type Labels = Record<string, string>;

const escapeLabel = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const escapeHelp = (v: string): string => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

function labelText(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  if (!keys.length) return '';
  return `{${keys.map((k) => `${k}="${escapeLabel(labels[k]!)}"`).join(',')}}`;
}

function num(v: number): string {
  if (Number.isNaN(v)) return 'NaN';
  if (v === Infinity) return '+Inf';
  if (v === -Infinity) return '-Inf';
  return String(v);
}

export interface Sample {
  /** Appended to the family name, e.g. `_bucket`. */
  suffix?: string;
  labels?: Labels;
  value: number;
}

export type MetricType = 'counter' | 'gauge' | 'histogram' | 'untyped';

/** One metric family: HELP, TYPE and its samples. */
export function family(name: string, help: string, type: MetricType, samples: Sample[]): string {
  const lines = [`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`];
  for (const s of samples)
    lines.push(`${name}${s.suffix ?? ''}${labelText(s.labels ?? {})} ${num(s.value)}`);
  return lines.join('\n') + '\n';
}

const keyOf = (labels: Labels): string => labelText(labels);

/** A counter with labels, kept in memory since the process started. */
export class Counter {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    /** Label sets to show as 0 before anything happens, so rate() works from the start. */
    seed: Labels[] = [],
  ) {
    for (const l of seed) this.values.set(keyOf(l), { labels: l, value: 0 });
  }

  inc(labels: Labels = {}, by = 1): void {
    const k = keyOf(labels);
    const cur = this.values.get(k);
    if (cur) cur.value += by;
    else this.values.set(k, { labels, value: by });
  }

  get(labels: Labels = {}): number {
    return this.values.get(keyOf(labels))?.value ?? 0;
  }

  render(): string {
    const samples = [...this.values.values()].map((v) => ({ labels: v.labels, value: v.value }));
    if (!samples.length) samples.push({ labels: {}, value: 0 });
    return family(this.name, this.help, 'counter', samples);
  }
}

/** A cumulative histogram with labels. */
export class Histogram {
  private readonly values = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[],
  ) {}

  observe(labels: Labels, v: number): void {
    const k = keyOf(labels);
    let cur = this.values.get(k);
    if (!cur) {
      cur = { labels, counts: this.buckets.map(() => 0), sum: 0, count: 0 };
      this.values.set(k, cur);
    }
    for (let i = 0; i < this.buckets.length; i++) if (v <= this.buckets[i]!) cur.counts[i]!++;
    cur.sum += v;
    cur.count++;
  }

  count(labels: Labels = {}): number {
    return this.values.get(keyOf(labels))?.count ?? 0;
  }

  render(): string {
    const samples: Sample[] = [];
    const all = [...this.values.values()];
    if (!all.length) all.push({ labels: {}, counts: this.buckets.map(() => 0), sum: 0, count: 0 });
    for (const v of all) {
      this.buckets.forEach((b, i) =>
        samples.push({
          suffix: '_bucket',
          labels: { ...v.labels, le: num(b) },
          value: v.counts[i]!,
        }),
      );
      samples.push({ suffix: '_bucket', labels: { ...v.labels, le: '+Inf' }, value: v.count });
      samples.push({ suffix: '_sum', labels: v.labels, value: v.sum });
      samples.push({ suffix: '_count', labels: v.labels, value: v.count });
    }
    return family(this.name, this.help, 'histogram', samples);
  }
}
