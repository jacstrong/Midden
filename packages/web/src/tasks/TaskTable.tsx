/** The task table: one row per task, virtualized so a few thousand rows stay smooth. */
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  categoryOf,
  isOverdue,
  openBlockers,
  statusOf,
  taskRef,
  type Task,
  type TaskSort,
  type TaskState,
} from '@midden/core';
import { CATEGORY_COLOR, fmtAgo, fmtDue, openTask, PRIORITY_COLOR, type Names } from './shared';

const COLS: { key: string; label: string; sort?: TaskSort; width: string }[] = [
  { key: 'pick', label: '', width: '28px' },
  { key: 'ref', label: 'Task', sort: 'num', width: '70px' },
  { key: 'title', label: 'Title', sort: 'title', width: 'minmax(220px, 3fr)' },
  { key: 'status', label: 'Status', width: '120px' },
  { key: 'priority', label: 'Priority', sort: 'priority', width: '80px' },
  { key: 'assignees', label: 'Assignees', width: 'minmax(120px, 1.3fr)' },
  { key: 'team', label: 'Team', width: '110px' },
  { key: 'due', label: 'Due (UTC)', sort: 'due', width: '130px' },
  { key: 'case', label: 'Case', width: 'minmax(100px, 1fr)' },
  { key: 'updated', label: 'Moved', sort: 'updated', width: '80px' },
];
const GRID = COLS.map((c) => c.width).join(' ');

export function TaskTable({
  state,
  tasks,
  names,
  sort,
  onSort,
  selectedNum,
  picked,
  onPick,
  onPickAll,
}: {
  state: TaskState;
  tasks: Task[];
  names: Names;
  sort: TaskSort;
  onSort(s: TaskSort): void;
  selectedNum: number | null;
  /** Tasks picked for a bulk action; with `onPick`, rows get a checkbox. */
  picked?: ReadonlySet<string> | undefined;
  onPick?: ((t: Task, range: boolean) => void) | undefined;
  onPickAll?: ((on: boolean) => void) | undefined;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 34,
    overscan: 16,
    getItemKey: (i) => tasks[i]!.id,
  });
  const now = new Date().toISOString();
  return (
    <div
      className="ttable"
      ref={scroller}
      role="table"
      aria-rowcount={tasks.length}
      data-testid="task-table"
    >
      <div className="trow thead" role="row" style={{ gridTemplateColumns: GRID }}>
        {COLS.map((c) => (
          <div
            key={c.key}
            role="columnheader"
            aria-sort={c.sort && c.sort === sort ? 'ascending' : undefined}
          >
            {c.key === 'pick' ? (
              onPickAll && (
                <input
                  type="checkbox"
                  aria-label="Select all"
                  checked={tasks.length > 0 && tasks.every((t) => picked?.has(t.id))}
                  ref={(el) => {
                    if (el)
                      el.indeterminate =
                        tasks.some((t) => picked?.has(t.id)) &&
                        !tasks.every((t) => picked?.has(t.id));
                  }}
                  onChange={(e) => onPickAll(e.target.checked)}
                />
              )
            ) : c.sort ? (
              <button
                className={'thsort' + (c.sort === sort ? ' on' : '')}
                onClick={() => onSort(c.sort!)}
              >
                {c.label}
                {c.sort === sort ? ' ▾' : ''}
              </button>
            ) : (
              c.label
            )}
          </div>
        ))}
      </div>
      <div style={{ height: v.getTotalSize(), position: 'relative' }} role="rowgroup">
        {v.getVirtualItems().map((vi) => {
          const t = tasks[vi.index]!;
          const st = statusOf(state, t);
          const cat = categoryOf(state, t);
          const blocked = openBlockers(state, t).length > 0;
          return (
            <div
              key={vi.key}
              role="row"
              tabIndex={0}
              aria-rowindex={vi.index + 1}
              className={
                'trow' +
                (t.num === selectedNum ? ' sel' : '') +
                (picked?.has(t.id) ? ' picked' : '')
              }
              style={{ gridTemplateColumns: GRID, transform: `translateY(${vi.start}px)` }}
              onClick={(e) => {
                if (onPick && (e.metaKey || e.ctrlKey || e.shiftKey)) onPick(t, e.shiftKey);
                else openTask(t.num);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') openTask(t.num);
                else if (e.key === 'x' && onPick) {
                  e.preventDefault();
                  onPick(t, false);
                }
              }}
              data-testid="task-row"
            >
              <div role="cell">
                {onPick && (
                  <input
                    type="checkbox"
                    aria-label={`Select ${taskRef(t.num)}`}
                    checked={picked?.has(t.id) ?? false}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPick(t, e.shiftKey);
                    }}
                    onChange={() => {}}
                  />
                )}
              </div>
              <div role="cell" className="tid">
                {taskRef(t.num)}
              </div>
              <div role="cell" className="ttitle">
                {blocked && <span title="Waiting on another task">⛔ </span>}
                {t.title}
                {t.approval?.state === 'pending' && <span className="tappr pending"> ◷</span>}
                {t.labels.map((l) => (
                  <span key={l} className="tag lbl">
                    {l}
                  </span>
                ))}
              </div>
              <div role="cell">
                <span
                  className="stdot"
                  style={{ ['--cc' as string]: st?.color || CATEGORY_COLOR[cat] }}
                />
                {st?.name ?? '—'}
              </div>
              <div role="cell" style={{ color: PRIORITY_COLOR[t.priority] }}>
                {t.priority}
              </div>
              <div role="cell" className="ell">
                {t.assignees.length ? (
                  t.assignees.map((u) => names.user(u)).join(', ')
                ) : (
                  <span className="dimmer">—</span>
                )}
              </div>
              <div role="cell" className="ell">
                {names.team(t.teamId)}
              </div>
              <div role="cell" className={isOverdue(state, t, now) ? 'tdue late' : ''}>
                {fmtDue(t.dueAt)}
              </div>
              <div role="cell" className="ell">
                {names.caseName(t.caseId)}
              </div>
              <div role="cell" className="dimmer" title={t.statusAt}>
                {fmtAgo(t.statusAt)}
              </div>
            </div>
          );
        })}
      </div>
      {!tasks.length && <p className="empty">No tasks match.</p>}
    </div>
  );
}
