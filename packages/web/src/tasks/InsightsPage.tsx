/**
 * #/tasks/insights: open work, who carries it, throughput, cycle time, what is stuck and a run's
 * burndown. Everything is counted on the server over the tasks you can see.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  categoryLabel,
  statusOf,
  weekStart,
  type StatusCategory,
  type TaskInsights,
} from '@midden/core';
import { HostedChrome } from '../components/HostedChrome';
import { api, ApiError } from '../lib/api';
import { useRoute } from '../lib/router';
import { useTasks } from './TaskStore';
import { fmtZulu, taskHref, openTask, useNames } from './shared';

const DAY = 86_400_000;
const WINDOWS = [4, 12, 26, 52] as const;
const OPEN_CATEGORIES: StatusCategory[] = ['backlog', 'todo', 'in_progress', 'blocked'];

/** "40m", "5h", "2.5d". */
export function fmtDuration(sec: number | null): string {
  if (sec === null) return '–';
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))}m`;
  if (sec < 48 * 3600) return `${Math.round(sec / 3600)}h`;
  const d = sec / 86400;
  return `${d < 10 ? Math.round(d * 10) / 10 : Math.round(d)}d`;
}

const shortDate = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

export function InsightsPage() {
  const navigate = useRoute((s) => s.navigate);
  const teams = useTasks((s) => s.directory.teams);
  const state = useTasks((s) => s.state);
  const [team, setTeam] = useState('');
  const [run, setRun] = useState('');
  const [weeks, setWeeks] = useState<(typeof WINDOWS)[number]>(12);
  const [data, setData] = useState<TaskInsights | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  // Recount a moment after tasks change, so the page keeps up without a request per keystroke.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => setTick((n) => n + 1), 1500);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    let alive = true;
    const from = weekStart(new Date(Date.now() - (weeks - 1) * 7 * DAY))
      .toISOString()
      .slice(0, 10);
    const q = new URLSearchParams({ from });
    if (team) q.set('team', team);
    if (run) q.set('run', run);
    api<{ insights: TaskInsights }>('GET', `/api/tasks/insights?${q}`)
      .then((r) => {
        if (!alive) return;
        setData(r.insights);
        setError('');
      })
      .catch(
        (err: unknown) =>
          alive && setError(err instanceof ApiError ? err.message : 'Could not load insights'),
      );
    return () => {
      alive = false;
    };
  }, [team, run, weeks, tick]);

  const runs = useMemo(
    () => Object.values(state?.runs ?? {}).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state?.runs],
  );

  return (
    <HostedChrome title="Insights">
      <div className="view on insights" data-testid="insights">
        <div className="toolbar">
          <a
            href="#/tasks/mine"
            className="btn sm ghost"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'tasks', viewId: 'mine', taskNum: null });
            }}
          >
            ← Tasks
          </a>
          <label>
            Team{' '}
            <select
              value={team}
              onChange={(e) => setTeam(e.target.value)}
              data-testid="insights-team"
            >
              <option value="">Everything I can see</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Run{' '}
            <select value={run} onChange={(e) => setRun(e.target.value)} data-testid="insights-run">
              <option value="">All runs</option>
              {runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.closed ? ' (closed)' : ''}
                </option>
              ))}
            </select>
          </label>
          <div className="seg" role="group" aria-label="Window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                className={w === weeks ? 'on' : ''}
                aria-pressed={w === weeks}
                onClick={() => setWeeks(w)}
              >
                {w} wk
              </button>
            ))}
          </div>
          <span className="sp" />
          {data && <span className="dimmer">Counted {fmtZulu(data.now)}</span>}
        </div>
        {error && <p className="hint bad">{error}</p>}
        {!data ? !error && <p className="hint">Counting…</p> : <Body data={data} weeks={weeks} />}
      </div>
    </HostedChrome>
  );
}

function Body({ data, weeks }: { data: TaskInsights; weeks: number }) {
  const names = useNames();
  const state = useTasks((s) => s.state);
  const queued = data.queues.reduce((n, q) => n + q.open, 0);
  const statusName = (runId: string, statusId: string): string =>
    (state && statusOf(state, { runId, statusId })?.name) || statusId;
  const runOf = (id: string): string => state?.tasks[id]?.runId ?? '';
  return (
    <>
      <div className="istats">
        <Stat label="Open" value={data.open.total} />
        <Stat label="Overdue" value={data.open.overdue} warn={data.open.overdue > 0} />
        <Stat label="In progress" value={data.open.byCategory.in_progress} />
        <Stat label="Blocked" value={data.open.byCategory.blocked} />
        <Stat label="In team queues" value={queued} />
        <Stat label="Unassigned" value={data.open.unassigned} />
        <Stat
          label="Cycle time"
          value={fmtDuration(data.cycle.medianSec)}
          sub={
            data.cycle.count
              ? `median · p90 ${fmtDuration(data.cycle.p90Sec)} · ${data.cycle.count} tasks`
              : 'nothing finished yet'
          }
        />
        <Stat
          label="Lead time"
          value={fmtDuration(data.lead.medianSec)}
          sub={
            data.lead.count
              ? `median · p90 ${fmtDuration(data.lead.p90Sec)}`
              : 'nothing finished yet'
          }
        />
      </div>

      <div className="igrid">
        <Card
          title="Open work by status"
          table={
            <SimpleTable
              head={['Status', 'Tasks']}
              rows={OPEN_CATEGORIES.map((c) => [categoryLabel(c), data.open.byCategory[c]])}
            />
          }
        >
          <CategoryBars counts={data.open.byCategory} />
        </Card>
        <Card
          title={`Throughput, last ${weeks} weeks`}
          legend={[
            ['var(--viz-1)', 'Done'],
            ['var(--viz-2)', 'Created'],
          ]}
          table={
            <SimpleTable
              head={['Week of', 'Done', 'Created']}
              rows={data.throughput.map((w) => [shortDate(w.week), w.done, w.created])}
            />
          }
        >
          <Throughput weeks={data.throughput} />
        </Card>
        {data.burndown && (
          <Card
            title={`Burndown: ${state?.runs[data.burndown.runId]?.name ?? 'run'}`}
            legend={[
              ['var(--viz-1)', 'Open'],
              ['var(--dimmer)', 'All tasks in the run', true],
            ]}
            table={
              <SimpleTable
                head={['Day', 'Open', 'All']}
                rows={data.burndown.points.map((p) => [shortDate(p.date), p.open, p.total])}
              />
            }
            wide
          >
            <Burndown points={data.burndown.points} />
          </Card>
        )}
        <Card title="Open work per person">
          {data.people.length === 0 ? (
            <p className="hint">No one has open work.</p>
          ) : (
            <table className="tbl itable">
              <thead>
                <tr>
                  <th>Person</th>
                  <th className="num">Open</th>
                  <th className="num">In progress</th>
                  <th className="num">Blocked</th>
                  <th className="num">Overdue</th>
                </tr>
              </thead>
              <tbody>
                {data.people.map((p) => (
                  <tr key={p.userId}>
                    <td>{names.user(p.userId)}</td>
                    <td className="num">
                      <span className="ibar">
                        <i style={{ width: `${(p.open / data.people[0]!.open) * 100}%` }} />
                      </span>
                      {p.open}
                    </td>
                    <td className="num">{p.inProgress}</td>
                    <td className="num">{p.blocked}</td>
                    <td className={`num${p.overdue ? ' late' : ''}`}>
                      {p.overdue ? `⚠ ${p.overdue}` : 0}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Team queues">
          {data.queues.length === 0 ? (
            <p className="hint">No queue has anything waiting.</p>
          ) : (
            <table className="tbl itable">
              <thead>
                <tr>
                  <th>Team</th>
                  <th className="num">Waiting</th>
                  <th>Oldest since</th>
                </tr>
              </thead>
              <tbody>
                {data.queues.map((q) => (
                  <tr key={q.teamId}>
                    <td>{names.team(q.teamId)}</td>
                    <td className="num">{q.open}</td>
                    <td>{fmtAge(q.oldestAt, data.now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Longest in one status" wide>
          {data.stuck.length === 0 ? (
            <p className="hint">Nothing open outside the backlog.</p>
          ) : (
            <table className="tbl itable" data-testid="insights-stuck">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>For</th>
                  <th>Assignees</th>
                </tr>
              </thead>
              <tbody>
                {data.stuck.map((t) => (
                  <tr key={t.id} onClick={() => openTask(t.num)} style={{ cursor: 'pointer' }}>
                    <td>
                      <TaskLink num={t.num} title={t.title} />
                    </td>
                    <td>{statusName(runOf(t.id), t.statusId)}</td>
                    <td>{fmtAge(t.since, data.now)}</td>
                    <td>{t.assignees.map((u) => names.user(u)).join(', ') || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Approvals waiting" wide>
          {data.approvals.length === 0 ? (
            <p className="hint">No task is waiting on an approver.</p>
          ) : (
            <table className="tbl itable">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Approver</th>
                  <th>Waiting</th>
                </tr>
              </thead>
              <tbody>
                {data.approvals.map((t) => (
                  <tr key={t.id} onClick={() => openTask(t.num)} style={{ cursor: 'pointer' }}>
                    <td>
                      <TaskLink num={t.num} title={t.title} />
                    </td>
                    <td>{names.user(t.approverId)}</td>
                    <td>{fmtAge(t.since, data.now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}

const fmtAge = (iso: string, now: string): string =>
  fmtDuration(Math.max(0, (Date.parse(now) - Date.parse(iso)) / 1000));

function TaskLink({ num, title }: { num: number; title: string }) {
  return (
    <a
      href={taskHref(num)}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openTask(num);
      }}
    >
      <b className="ref">T-{num}</b> {title}
    </a>
  );
}

function Stat({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: number | string;
  sub?: string;
  warn?: boolean;
}) {
  return (
    <div className={`stat${warn ? ' warn' : ''}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

function Card({
  title,
  legend,
  table,
  wide,
  children,
}: {
  title: string;
  legend?: [color: string, label: string, dashed?: boolean][];
  table?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  return (
    <section className={`icard${wide ? ' wide' : ''}`}>
      <header>
        <h3>{title}</h3>
        {legend && !asTable && (
          <ul className="ilegend">
            {legend.map(([c, l, dashed]) => (
              <li key={l}>
                <i
                  className={dashed ? 'dash' : ''}
                  style={{ background: dashed ? undefined : c, borderColor: c }}
                />
                {l}
              </li>
            ))}
          </ul>
        )}
        <span className="sp" />
        {table && (
          <button
            className="btn sm ghost"
            aria-pressed={asTable}
            onClick={() => setAsTable(!asTable)}
          >
            {asTable ? 'Chart' : 'Table'}
          </button>
        )}
      </header>
      {asTable ? table : children}
    </section>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <table className="tbl itable">
      <thead>
        <tr>
          {head.map((h, i) => (
            <th key={h} className={i ? 'num' : ''}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={j ? 'num' : ''}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Horizontal bars, one per open category, each labelled with its count. */
function CategoryBars({ counts }: { counts: Record<StatusCategory, number> }) {
  const max = Math.max(1, ...OPEN_CATEGORIES.map((c) => counts[c]));
  const W = 560;
  const label = 96;
  const row = 30;
  const bar = 16;
  const span = W - label - 40;
  return (
    <svg
      viewBox={`0 0 ${W} ${OPEN_CATEGORIES.length * row + 4}`}
      className="ichart"
      role="img"
      aria-label={OPEN_CATEGORIES.map((c) => `${categoryLabel(c)} ${counts[c]}`).join(', ')}
    >
      {OPEN_CATEGORIES.map((c, i) => {
        const y = i * row + (row - bar) / 2;
        const w = (counts[c] / max) * span;
        return (
          <g key={c}>
            <text
              x={label - 10}
              y={y + bar / 2}
              className="ilabel"
              textAnchor="end"
              dominantBaseline="central"
            >
              {categoryLabel(c)}
            </text>
            {w > 0 && <path d={barRight(label, y, w, bar)} fill="var(--viz-1)" />}
            <text x={label + w + 6} y={y + bar / 2} className="ivalue" dominantBaseline="central">
              {counts[c]}
            </text>
          </g>
        );
      })}
      <line x1={label} x2={label} y1={0} y2={OPEN_CATEGORIES.length * row} className="iaxis" />
    </svg>
  );
}

/** A bar growing right from x, square at the baseline and rounded 4px at its end. */
function barRight(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w, h / 2);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

/** A column growing up from the baseline, rounded 4px at its top. */
function barUp(x: number, base: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  return `M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + w - r}Q${x + w},${base - h} ${x + w},${base - h + r}V${base}Z`;
}

/** Place a tooltip over a point, keeping it inside the chart near either edge. */
function tipAt(f: number): { left: string; transform: string } {
  const shift = f > 0.75 ? '-100%' : f < 0.25 ? '0%' : '-50%';
  return { left: `${f * 100}%`, transform: `translateX(${shift})` };
}

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * step >= v) return m * step;
  return 10 * step;
}

function Gridlines({
  max,
  x0,
  x1,
  top,
  base,
}: {
  max: number;
  x0: number;
  x1: number;
  top: number;
  base: number;
}) {
  return (
    <>
      {[0, 0.5, 1].map((f) => {
        const y = base - f * (base - top);
        return (
          <g key={f}>
            <line x1={x0} x2={x1} y1={y} y2={y} className={f === 0 ? 'iaxis' : 'igrid'} />
            <text x={x0 - 6} y={y} className="itick" textAnchor="end" dominantBaseline="central">
              {Math.round(max * f)}
            </text>
          </g>
        );
      })}
    </>
  );
}

/** Paired columns per week: done and created. */
function Throughput({ weeks }: { weeks: TaskInsights['throughput'] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const H = 200;
  const x0 = 32;
  const top = 10;
  const base = H - 24;
  const max = niceMax(Math.max(1, ...weeks.map((w) => Math.max(w.done, w.created))));
  const band = (W - x0) / Math.max(1, weeks.length);
  const bw = Math.min(24, (band - 8) / 2);
  const every = Math.ceil(weeks.length / 8);
  const h = (v: number): number => (v / max) * (base - top);
  const hw = hover === null ? null : weeks[hover];
  return (
    <div className="ichartwrap" onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="ichart"
        role="img"
        aria-label={`Tasks done and created per week. ${weeks.reduce((n, w) => n + w.done, 0)} done in all.`}
      >
        <Gridlines max={max} x0={x0} x1={W} top={top} base={base} />
        {weeks.map((w, i) => {
          const cx = x0 + band * i + band / 2;
          return (
            <g key={w.week}>
              {hover === i && (
                <rect
                  x={x0 + band * i}
                  y={top}
                  width={band}
                  height={base - top}
                  className="ihover"
                />
              )}
              {w.done > 0 && (
                <path d={barUp(cx - bw - 1, base, bw, h(w.done))} fill="var(--viz-1)" />
              )}
              {w.created > 0 && (
                <path d={barUp(cx + 1, base, bw, h(w.created))} fill="var(--viz-2)" />
              )}
              {i % every === 0 && (
                <text x={cx} y={base + 15} className="itick" textAnchor="middle">
                  {shortDate(w.week)}
                </text>
              )}
              <rect
                x={x0 + band * i}
                y={top}
                width={band}
                height={base - top + 20}
                fill="transparent"
                onMouseEnter={() => setHover(i)}
              />
            </g>
          );
        })}
      </svg>
      {hw && hover !== null && (
        <div className="itip" style={tipAt((x0 + band * hover + band / 2) / W)}>
          <b>Week of {shortDate(hw.week)}</b>
          <span>
            <i style={{ background: 'var(--viz-1)' }} />
            {hw.done} done
          </span>
          <span>
            <i style={{ background: 'var(--viz-2)' }} />
            {hw.created} created
          </span>
        </div>
      )}
    </div>
  );
}

/** Open tasks in a run per day, against everything in it. */
function Burndown({ points }: { points: { date: string; total: number; open: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length === 0) return <p className="hint">This run has no tasks yet.</p>;
  const W = 1000;
  const H = 220;
  const x0 = 32;
  const top = 10;
  const base = H - 24;
  const max = niceMax(Math.max(1, ...points.map((p) => p.total)));
  const step = points.length > 1 ? (W - x0 - 10) / (points.length - 1) : 0;
  const x = (i: number): number => x0 + (points.length > 1 ? step * i : (W - x0) / 2);
  const y = (v: number): number => base - (v / max) * (base - top);
  const line = (k: 'open' | 'total'): string =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p[k])}`).join('');
  const every = Math.ceil(points.length / 10);
  const hp = hover === null ? null : points[hover];
  const last = points.length - 1;
  return (
    <div
      className="ichartwrap"
      onMouseLeave={() => setHover(null)}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const px = ((e.clientX - r.left) / r.width) * W;
        setHover(Math.max(0, Math.min(last, Math.round(step ? (px - x0) / step : 0))));
      }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="ichart"
        role="img"
        aria-label={`Burndown: ${points[last]!.open} of ${points[last]!.total} tasks still open on ${shortDate(points[last]!.date)}.`}
      >
        <Gridlines max={max} x0={x0} x1={W} top={top} base={base} />
        {points.map(
          (p, i) =>
            i % every === 0 && (
              <text key={p.date} x={x(i)} y={base + 15} className="itick" textAnchor="middle">
                {shortDate(p.date)}
              </text>
            ),
        )}
        <path d={line('total')} className="itotal" />
        <path d={line('open')} className="iline" />
        {hp && hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={top} y2={base} className="icross" />
            <circle cx={x(hover)} cy={y(hp.open)} r={4} className="idot" />
          </>
        )}
        <circle cx={x(last)} cy={y(points[last]!.open)} r={4} className="idot" />
        <text x={x(last) - 8} y={y(points[last]!.open) - 10} className="ivalue" textAnchor="end">
          {points[last]!.open} open
        </text>
      </svg>
      {points.length === 1 && <p className="hint">The line starts from the run’s second day.</p>}
      {hp && hover !== null && (
        <div className="itip" style={tipAt(x(hover) / W)}>
          <b>{shortDate(hp.date)}</b>
          <span>
            <i style={{ background: 'var(--viz-1)' }} />
            {hp.open} open
          </span>
          <span>
            <i className="dash" />
            {hp.total} in the run
          </span>
        </div>
      )}
    </div>
  );
}
