/**
 * The kanban board. Columns come from `groupTasks`; dropping a card asks `dropOp` what the move
 * means (a status, an assignee, a label…), so every grouping drags the same way. Swimlanes
 * split the board into rows by a second field, and a drop across lanes changes both.
 *
 * Keyboard: Tab to a card, Enter opens it, Shift+←/→ moves it a column, Shift+↑/↓ a lane, and
 * X picks it for a bulk action (as does Cmd/Ctrl/Shift-click, or its checkbox).
 */
import { useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  categoryOf,
  dropOp,
  effectiveGroupBy,
  groupTasks,
  isOverdue,
  keysOf,
  openBlockers,
  taskRef,
  type Task,
  type TaskDirectory,
  type TaskGroup,
  type TaskGroupBy,
  type TaskOp,
  type TaskState,
  type TaskViewConfig,
} from '@midden/core';
import { Avatar } from './pickers';
import { useTasks } from './TaskStore';
import { CATEGORY_COLOR, fmtDue, openTask, PRIORITY_COLOR, useTaskUi, type Names } from './shared';

const DRAG_TYPE = 'application/x-midden-task';

interface Props {
  state: TaskState;
  tasks: Task[];
  config: TaskViewConfig;
  names: Names;
  canEdit: boolean;
  selectedNum: number | null;
  /** Tasks picked for a bulk action; with `onPick`, cards get a checkbox. */
  picked?: ReadonlySet<string> | undefined;
  onPick?: ((t: Task) => void) | undefined;
}

export function Board({
  state,
  tasks,
  config,
  names,
  canEdit,
  selectedNum,
  picked,
  onPick,
}: Props) {
  const dispatch = useTasks((s) => s.dispatch);
  const openCreate = useTaskUi((s) => s.openCreate);
  const g = effectiveGroupBy(state, tasks, config.groupBy);
  const lanesBy = config.swimlanes === config.groupBy ? 'none' : config.swimlanes;
  const runFilter = config.filter.runs;
  const dirTeams = useTasks((s) => s.directory.teams);
  const keepEmpty = useMemo(
    () => emptyColumns(state, g, config, names, dirTeams),
    [state, g, config, names, dirTeams],
  );
  const columns = useMemo(
    () => groupTasks(state, tasks, g, names, { runFilter, keepEmpty }),
    [state, tasks, g, names, runFilter, keepEmpty],
  );
  const lanes: TaskGroup[] = useMemo(
    () =>
      lanesBy === 'none'
        ? [{ key: '', label: '', tasks }]
        : groupTasks(state, tasks, lanesBy, names).filter((l) => l.tasks.length),
    [state, tasks, lanesBy, names],
  );
  const [over, setOver] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const now = new Date().toISOString();
  const live = useRef<HTMLDivElement>(null);

  const move = async (t: Task, from: [string, string], to: [string, string]): Promise<void> => {
    const ops: TaskOp[] = [];
    const a = dropOp(state, t, g, from[0], to[0]);
    if (a) ops.push(a);
    if (lanesBy !== 'none') {
      const b = dropOp(state, t, lanesBy, from[1], to[1]);
      if (b) ops.push(b);
    }
    if (!ops.length) return;
    const r = await dispatch(ops.length === 1 ? ops[0]! : { type: 'batch', ops });
    if (r.ok) {
      const col = columns.find((c) => c.key === to[0])?.label ?? to[0];
      setSaid(`${taskRef(t.num)} moved to ${col}`);
    }
  };

  const onDrop = (e: DragEvent, col: string, lane: string): void => {
    e.preventDefault();
    setOver(null);
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    const {
      id,
      col: fromCol,
      lane: fromLane,
    } = JSON.parse(raw) as { id: string; col: string; lane: string };
    const t = state.tasks[id];
    if (t) void move(t, [fromCol, fromLane], [col, lane]);
  };

  const onKey = (e: KeyboardEvent, t: Task, ci: number, li: number): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      openTask(t.num);
      return;
    }
    if (e.key === 'x' && onPick && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      onPick(t);
      return;
    }
    if (!e.shiftKey || !canEdit) return;
    const dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    const dl = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!dc && !dl) return;
    e.preventDefault();
    const nc = columns[ci + dc];
    const nl = lanes[li + dl];
    if (!nc || !nl) return;
    void move(t, [columns[ci]!.key, lanes[li]!.key], [nc.key, nl.key]).then(() => {
      // keep focus on the card in its new place
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(
            `[data-card="${t.id}"][data-col="${nc.key}"][data-lane="${nl.key}"]`,
          )
          ?.focus(),
      );
    });
  };

  const inCell = (laneKey: string, colKey: string, laneTasks: Task[]): Task[] =>
    laneTasks.filter(
      (t) =>
        keysOf(state, t, g).includes(colKey) &&
        (lanesBy === 'none' || keysOf(state, t, lanesBy).includes(laneKey)),
    );

  return (
    <div
      className="board"
      data-testid="task-board"
      style={{ ['--cols' as string]: columns.length }}
    >
      <div className="sr-only" aria-live="polite" ref={live}>
        {said}
      </div>
      <div className="bhead">
        {columns.map((c) => {
          const n = c.tasks.length;
          const overLimit = !!c.wipLimit && n > c.wipLimit;
          return (
            <div
              key={c.key}
              className={'bcolhead' + (overLimit ? ' over' : '')}
              style={{
                ['--cc' as string]:
                  c.color || (c.category ? CATEGORY_COLOR[c.category] : 'var(--line2)'),
              }}
            >
              <span className="bname">{c.label}</span>
              <span
                className="bcount"
                title={c.wipLimit ? `Work-in-progress limit ${c.wipLimit}` : undefined}
              >
                {n}
                {c.wipLimit ? ` / ${c.wipLimit}` : ''}
              </span>
              {canEdit && g === 'status' && (
                <button
                  className="btn sm ghost"
                  title={`New task in ${c.label}`}
                  aria-label={`New task in ${c.label}`}
                  onClick={() =>
                    openCreate({
                      statusId: c.key,
                      runId: runFilter?.length === 1 ? runFilter[0]! : '',
                    })
                  }
                >
                  +
                </button>
              )}
            </div>
          );
        })}
      </div>
      {lanes.map((lane, li) => (
        <section key={lane.key || '_'} className="blane" aria-label={lane.label || 'Tasks'}>
          {lanesBy !== 'none' && (
            <h4 className="blanehead">
              {lane.label} <span className="dimmer">{lane.tasks.length}</span>
            </h4>
          )}
          <div className="brow">
            {columns.map((c, ci) => {
              const cell = inCell(lane.key, c.key, lane.tasks);
              const id = `${lane.key}|${c.key}`;
              return (
                <div
                  key={c.key}
                  className={'bcol' + (over === id ? ' drop' : '')}
                  onDragOver={(e) => {
                    if (!canEdit || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (over !== id) setOver(id);
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                  }}
                  onDrop={(e) => onDrop(e, c.key, lane.key)}
                  data-testid="board-col"
                  data-col={c.key}
                >
                  {cell.map((t) => (
                    <Card
                      key={t.id}
                      t={t}
                      state={state}
                      config={config}
                      names={names}
                      now={now}
                      draggable={canEdit}
                      selected={t.num === selectedNum}
                      picked={picked?.has(t.id) ?? false}
                      onPick={onPick}
                      col={c.key}
                      lane={lane.key}
                      onKeyDown={(e) => onKey(e, t, ci, li)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        </section>
      ))}
      {!tasks.length && <p className="empty">No tasks here yet.</p>}
    </div>
  );
}

/**
 * Columns to show even when empty, so there's somewhere to drop a card: the people a board is
 * about (a team's members, or everyone who can be assigned), every team, every open run.
 */
function emptyColumns(
  state: TaskState,
  g: TaskGroupBy,
  config: TaskViewConfig,
  names: Names,
  teams: TaskDirectory['teams'],
): string[] {
  const f = config.filter;
  switch (g) {
    case 'assignee': {
      if (f.assignees?.length) return f.assignees;
      if (f.mine) return [names.me];
      const teamIds = f.teams?.length ? new Set(f.teams) : f.myTeams ? names.myTeams : null;
      const ok = new Set(names.assignable.map((u) => u.id));
      if (!teamIds) return [...ok];
      return teams
        .filter((t) => teamIds.has(t.id))
        .flatMap((t) => t.members.map((m) => m.userId))
        .filter((u) => ok.has(u));
    }
    case 'team':
      return f.teams?.length ? f.teams : f.myTeams ? [...names.myTeams] : teams.map((t) => t.id);
    case 'run':
      return f.runs?.length
        ? f.runs
        : Object.values(state.runs)
            .filter((r) => !r.closed)
            .map((r) => r.id);
    default:
      return [];
  }
}

function Card({
  t,
  state,
  config,
  names,
  now,
  draggable,
  selected,
  picked,
  onPick,
  col,
  lane,
  onKeyDown,
}: {
  t: Task;
  state: TaskState;
  config: TaskViewConfig;
  names: Names;
  now: string;
  draggable: boolean;
  selected: boolean;
  picked: boolean;
  onPick: ((t: Task) => void) | undefined;
  col: string;
  lane: string;
  onKeyDown(e: KeyboardEvent): void;
}) {
  const f = new Set(config.fields);
  const blockers = f.has('blocked') ? openBlockers(state, t) : [];
  const done = t.checklist.filter((c) => c.done).length;
  const cat = categoryOf(state, t);
  const overdue = isOverdue(state, t, now);
  return (
    <article
      className={
        'tcard' +
        (selected ? ' sel' : '') +
        (picked ? ' picked' : '') +
        (cat === 'done' || cat === 'cancelled' ? ' closed' : '')
      }
      style={{ ['--pc' as string]: PRIORITY_COLOR[t.priority] }}
      tabIndex={0}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ id: t.id, col, lane }));
        e.dataTransfer.setData('text/plain', taskRef(t.num));
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={(e) => {
        // Cmd/Ctrl/Shift-click picks the card for a bulk action instead of opening it.
        if (onPick && (e.metaKey || e.ctrlKey || e.shiftKey)) onPick(t);
        else openTask(t.num);
      }}
      onKeyDown={onKeyDown}
      aria-label={`${taskRef(t.num)} ${t.title}`}
      data-card={t.id}
      data-col={col}
      data-lane={lane}
      data-testid="task-card"
    >
      <div className="tchead">
        {onPick && (
          <input
            type="checkbox"
            className="tpick"
            checked={picked}
            aria-label={`Select ${taskRef(t.num)}`}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onPick(t)}
          />
        )}
        <span className="tid">{taskRef(t.num)}</span>
        {f.has('priority') && t.priority !== 'medium' && <span className="tpri">{t.priority}</span>}
        {f.has('approval') && t.approval && (
          <span
            className={'tappr ' + t.approval.state}
            title={`Approval: ${names.user(t.approval.approverId)}`}
          >
            {t.approval.state === 'pending'
              ? '◷ approval'
              : t.approval.state === 'approved'
                ? '✓ approved'
                : '✕ rejected'}
          </span>
        )}
      </div>
      <div className="tctitle">{t.title}</div>
      {blockers.length > 0 && (
        <div className="tcblock">
          ⛔ waiting on {blockers.map((b) => taskRef(b.num)).join(', ')}
        </div>
      )}
      <div className="tcmeta">
        {f.has('assignees') &&
          (t.assignees.length ? (
            <span className="avs">
              {t.assignees.slice(0, 4).map((u) => (
                <Avatar key={u} id={u} names={names} />
              ))}
              {t.assignees.length > 4 && <span className="dimmer">+{t.assignees.length - 4}</span>}
            </span>
          ) : (
            <span className="dimmer">unassigned</span>
          ))}
        {f.has('team') && t.teamId && <span className="tag">{names.team(t.teamId)}</span>}
        {f.has('due') && t.dueAt && (
          <span className={'tdue' + (overdue ? ' late' : '')}>{fmtDue(t.dueAt)}</span>
        )}
        {f.has('checklist') && t.checklist.length > 0 && (
          <span className={'tcheck' + (done === t.checklist.length ? ' all' : '')}>
            ☑ {done}/{t.checklist.length}
          </span>
        )}
        {f.has('case') && t.caseId && <span className="tag">{names.caseName(t.caseId)}</span>}
        {f.has('run') && t.runId && <span className="tag">{state.runs[t.runId]?.name}</span>}
        {f.has('labels') &&
          t.labels.map((l) => (
            <span key={l} className="tag lbl">
              {l}
            </span>
          ))}
      </div>
    </article>
  );
}
