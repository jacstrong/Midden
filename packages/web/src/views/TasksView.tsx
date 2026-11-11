import { useEffect, useMemo, useState, type DragEvent, type MouseEvent } from 'react';
import {
  bulkEditOp,
  checklistProgress,
  commentsFor,
  filterTasks,
  isOverdue,
  moveTaskOp,
  TASK_PRIORITY,
  TASK_STATUS,
  tasksByStatus,
  techLabel,
  type Task,
  type TaskPriority,
  type TaskScope,
  type TaskStatus,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useTaskBoard } from '../store/useTaskBoard';
import { useMyFollows, usePersonName } from '../store/usePeople';
import { useRoute } from '../lib/router';
import { trunc } from '../lib/format';
import { toast } from '../store/useToasts';
import { EmptyState } from './EmptyState';
import { Avatars, fmtDue, PriorityBadge, STATUS_BY_ID } from '../tasks/taskUi';
import { deleteTasks, duplicateTasks, exportTasks } from '../tasks/taskActions';

interface DropAt {
  status: TaskStatus;
  /** Card the drop lands above; null for the bottom of the column. */
  beforeId: string | null;
}

export function TasksView() {
  const state = useCaseStore((s) => s.state);
  const access = useCaseStore((s) => s.access);
  const me = useCaseStore((s) => s.me);
  const multiUser = useCaseStore((s) => s.capabilities.multiUser);
  const dispatch = useCaseStore((s) => s.dispatch);
  const tz = useUiStore((s) => s.tz);
  const openModal = useUiStore((s) => s.openModal);
  const board = useTaskBoard();
  const names = usePersonName();
  const following = useMyFollows();
  const route = useRoute((s) => s.route);
  const navigate = useRoute((s) => s.navigate);
  const [drag, setDrag] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const [q, setQ] = useState(board.query);

  useEffect(() => {
    const t = setTimeout(() => board.setQuery(q), 150);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  // A link to one task (from a notice, or pasted) opens it once the case has loaded.
  const deepTask = route.kind === 'case' ? route.taskId : undefined;
  useEffect(() => {
    if (!deepTask || route.kind !== 'case') return;
    if (!state.tasks[deepTask]) return;
    openModal({ kind: 'task', id: deepTask });
    navigate({ kind: 'case', caseId: route.caseId, view: 'tasks' });
  }, [deepTask, state.tasks]); // eslint-disable-line react-hooks/exhaustive-deps

  const canEdit = access.edit;
  const canManage = access.manage && canEdit;
  const visible = useMemo(
    () =>
      filterTasks(state, {
        scope: board.scope,
        me: me?.id,
        following,
        query: board.query,
        priority: board.priority,
        hostId: board.hostId,
        names,
      }),
    // `following` and `names` are rebuilt each render; their inputs are what matter.
    [state, board.scope, board.query, board.priority, board.hostId, me, following.size], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const columns = tasksByStatus(visible);
  const order = TASK_STATUS.flatMap((s) => columns[s.id].map((t) => t.id));
  const selected = new Set(board.selected.filter((id) => state.tasks[id]));
  const total = Object.keys(state.tasks).length;

  if (!total) {
    return (
      <EmptyState
        title="No tasks yet"
        body="Plan the hunt as cards: who is sweeping which hosts, what is blocked, what is done. Link tasks to hosts and events, assign people, and everyone on a task hears when it changes."
      >
        {canEdit && (
          <button
            className="btn pri"
            onClick={() => openModal({ kind: 'task', id: null })}
            data-testid="task-add-empty"
          >
            Add task
          </button>
        )}
        {canManage && (
          <button className="btn" onClick={() => openModal({ kind: 'task-import' })}>
            Import a task list
          </button>
        )}
      </EmptyState>
    );
  }

  const onCardClick = (e: MouseEvent, t: Task): void => {
    if (canManage && e.shiftKey && board.anchor) {
      const a = order.indexOf(board.anchor);
      const b = order.indexOf(t.id);
      if (a >= 0 && b >= 0) {
        board.addToSelection(order.slice(Math.min(a, b), Math.max(a, b) + 1));
        return;
      }
    }
    if (canManage && (e.metaKey || e.ctrlKey || selected.size)) {
      board.toggle(t.id);
      return;
    }
    board.setAnchor(t.id);
    openModal({ kind: 'task', id: t.id });
  };

  const drop = async (at: DropAt): Promise<void> => {
    const id = drag;
    setDrag(null);
    setDropAt(null);
    if (!id) return;
    if (selected.has(id) && selected.size > 1) {
      const r = await dispatch(bulkEditOp(state, [...selected], { status: at.status }));
      if (r.ok) toast(`Moved ${selected.size} tasks to ${STATUS_BY_ID[at.status].label}`);
      return;
    }
    const op = moveTaskOp(state, id, at.status, at.beforeId);
    if (op) await dispatch(op);
  };

  const overCard = (e: DragEvent, status: TaskStatus, list: Task[], i: number): void => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const upper = e.clientY < r.top + r.height / 2;
    const beforeId = upper ? list[i]!.id : (list[i + 1]?.id ?? null);
    if (dropAt?.status !== status || dropAt.beforeId !== beforeId) setDropAt({ status, beforeId });
  };

  const scopes: Array<[TaskScope, string]> = multiUser
    ? [
        ['all', 'Everyone'],
        ['mine', 'Mine'],
        ['following', 'Following'],
        ['unassigned', 'Unassigned'],
      ]
    : [
        ['all', 'Everyone'],
        ['unassigned', 'Unassigned'],
      ];
  const filtering = board.scope !== 'all' || !!board.query || !!board.priority || !!board.hostId;
  const pickIds = selected.size ? [...selected] : visible.map((t) => t.id);

  return (
    <>
      <div className="toolbar tasktools">
        {canEdit && (
          <button
            className="btn pri"
            onClick={() => openModal({ kind: 'task', id: null })}
            data-testid="task-add"
          >
            + Task
          </button>
        )}
        <div className="seg" role="group" aria-label="Whose tasks">
          {scopes.map(([id, label]) => (
            <button
              key={id}
              className={board.scope === id ? 'on' : ''}
              onClick={() => board.setScope(id)}
              aria-pressed={board.scope === id}
              data-testid={`task-scope-${id}`}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="tasksearch"
          placeholder="Find a task, person or host"
          aria-label="Find tasks"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="task-search"
        />
        <select
          aria-label="Priority"
          value={board.priority}
          onChange={(e) => board.setPriority(e.target.value as TaskPriority | '')}
        >
          <option value="">Any priority</option>
          {TASK_PRIORITY.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Host"
          value={board.hostId}
          onChange={(e) => board.setHostId(e.target.value)}
        >
          <option value="">Any host</option>
          {Object.values(state.hosts)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
        </select>
        {filtering && (
          <button
            className="btn ghost sm"
            onClick={() => {
              board.setScope('all');
              board.setPriority('');
              board.setHostId('');
              setQ('');
            }}
          >
            Clear
          </button>
        )}
        <span className="sp" />
        <span className="dimmer" style={{ fontSize: 10, letterSpacing: '.1em' }}>
          {visible.length === total ? `${total} TASKS` : `${visible.length} OF ${total} SHOWN`}
        </span>
        {canManage && (
          <>
            <button
              className="btn"
              onClick={() => board.addToSelection(visible.map((t) => t.id))}
              title="Select every task shown"
              data-testid="task-select-all"
            >
              Select shown
            </button>
            <button
              className="btn"
              onClick={() => openModal({ kind: 'task-import' })}
              data-testid="task-import"
            >
              Import
            </button>
            <ExportButton ids={pickIds} label={selected.size ? 'Export selected' : 'Export'} />
          </>
        )}
      </div>

      {canManage && selected.size > 0 && (
        <div className="bulkbar" role="region" aria-label="Bulk actions" data-testid="task-bulkbar">
          <b>{selected.size} selected</b>
          <select
            aria-label="Move selected to"
            value=""
            onChange={(e) => {
              const status = e.target.value as TaskStatus;
              if (!status) return;
              void dispatch(bulkEditOp(state, [...selected], { status })).then(
                (r) => r.ok && toast(`Moved ${selected.size} to ${STATUS_BY_ID[status].label}`),
              );
            }}
            data-testid="bulk-move"
          >
            <option value="">Move to…</option>
            {TASK_STATUS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={() => openModal({ kind: 'task-bulk', ids: [...selected] })}
            data-testid="bulk-edit"
          >
            Assign / edit…
          </button>
          <button
            className="btn"
            onClick={() => void duplicateTasks([...selected])}
            data-testid="bulk-duplicate"
          >
            Duplicate
          </button>
          {multiUser && (
            <button
              className="btn"
              onClick={() => openModal({ kind: 'task-copy', ids: [...selected] })}
              data-testid="bulk-copy"
            >
              Copy to case…
            </button>
          )}
          <button
            className="btn mag"
            onClick={() => deleteTasks([...selected])}
            data-testid="bulk-delete"
          >
            Delete
          </button>
          <span className="sp" />
          <button className="btn ghost" onClick={() => board.clearSelection()}>
            Clear selection
          </button>
        </div>
      )}

      <div className="board" data-testid="task-board">
        {TASK_STATUS.map((col) => {
          const list = columns[col.id];
          const allOn = list.length > 0 && list.every((t) => selected.has(t.id));
          return (
            <section
              key={col.id}
              className={'bcol' + (dropAt?.status === col.id ? ' over' : '')}
              aria-label={col.label}
              data-testid={`task-col-${col.id}`}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (dropAt?.status !== col.id || dropAt.beforeId !== null)
                  setDropAt({ status: col.id, beforeId: null });
              }}
              onDragLeave={(e) => {
                if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null))
                  setDropAt((d) => (d?.status === col.id ? null : d));
              }}
              onDrop={(e) => {
                e.preventDefault();
                void drop(dropAt ?? { status: col.id, beforeId: null });
              }}
            >
              <header style={{ borderTopColor: col.color }}>
                {canManage && (
                  <input
                    type="checkbox"
                    aria-label={`Select all in ${col.label}`}
                    checked={allOn}
                    disabled={!list.length}
                    onChange={() =>
                      allOn
                        ? board.selectOnly(
                            board.selected.filter((id) => !list.some((t) => t.id === id)),
                          )
                        : board.addToSelection(list.map((t) => t.id))
                    }
                  />
                )}
                <span style={{ color: col.color }}>{col.label}</span>
                <span className="n">{list.length}</span>
                <span className="sp" />
                {canEdit && (
                  <button
                    className="btn ghost sm"
                    title={`Add a task to ${col.label}`}
                    aria-label={`Add a task to ${col.label}`}
                    onClick={() => openModal({ kind: 'task', id: null, draft: { status: col.id } })}
                  >
                    +
                  </button>
                )}
              </header>
              <div className="bcards">
                {list.map((t, i) => (
                  <div key={t.id}>
                    {dropAt?.status === col.id && dropAt.beforeId === t.id && drag !== t.id && (
                      <div className="dropline" />
                    )}
                    <TaskCard
                      task={t}
                      tz={tz}
                      selected={selected.has(t.id)}
                      selectable={canManage}
                      following={following.has(t.id)}
                      mine={!!me && t.assignees.includes(me.id)}
                      draggable={canEdit}
                      dragging={drag === t.id}
                      onClick={(e) => onCardClick(e, t)}
                      onToggle={() => board.toggle(t.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/plain', t.id);
                        setDrag(t.id);
                      }}
                      onDragEnd={() => {
                        setDrag(null);
                        setDropAt(null);
                      }}
                      onDragOver={(e) => overCard(e, col.id, list, i)}
                    />
                  </div>
                ))}
                {dropAt?.status === col.id && dropAt.beforeId === null && drag && (
                  <div className="dropline" />
                )}
                {!list.length && (
                  <div className="bempty">{drag ? 'Drop here' : 'Nothing here'}</div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}

function ExportButton({ ids, label }: { ids: string[]; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="menuwrap">
      <button
        className="btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        disabled={!ids.length}
        data-testid="task-export"
      >
        {label} ▾
      </button>
      {open && (
        <span className="menu" onMouseLeave={() => setOpen(false)}>
          <button
            onClick={() => {
              setOpen(false);
              exportTasks(ids, 'json');
            }}
            data-testid="task-export-json"
          >
            Task list (.json)
          </button>
          <button
            onClick={() => {
              setOpen(false);
              exportTasks(ids, 'csv');
            }}
            data-testid="task-export-csv"
          >
            Spreadsheet (.csv)
          </button>
        </span>
      )}
    </span>
  );
}

function TaskCard({
  task: t,
  tz,
  selected,
  selectable,
  following,
  mine,
  draggable,
  dragging,
  onClick,
  onToggle,
  onDragStart,
  onDragEnd,
  onDragOver,
}: {
  task: Task;
  tz: ReturnType<typeof useUiStore.getState>['tz'];
  selected: boolean;
  selectable: boolean;
  following: boolean;
  mine: boolean;
  draggable: boolean;
  dragging: boolean;
  onClick: (e: MouseEvent) => void;
  onToggle: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent) => void;
}) {
  const state = useCaseStore((s) => s.state);
  const comments = commentsFor(state, t.id).length;
  const progress = checklistProgress(t);
  const overdue = isOverdue(t);
  const hosts = t.hostIds.map((h) => state.hosts[h]?.name ?? '(deleted host)');
  return (
    <article
      className={
        'tcard' + (selected ? ' sel' : '') + (dragging ? ' dragging' : '') + (mine ? ' mine' : '')
      }
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onClick(e as unknown as MouseEvent);
        if (e.key === ' ' && selectable) {
          e.preventDefault();
          onToggle();
        }
      }}
      tabIndex={0}
      aria-label={t.title || 'Untitled task'}
      aria-selected={selectable ? selected : undefined}
      data-testid="task-card"
      data-task-id={t.id}
    >
      <div className="tchead">
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            aria-label={`Select ${t.title}`}
            onClick={(e) => e.stopPropagation()}
            onChange={onToggle}
          />
        )}
        <h4>{t.title || 'Untitled task'}</h4>
      </div>
      <div className="tcmeta">
        <PriorityBadge p={t.priority} />
        {t.technique && (
          <span className="tid" title={techLabel(t)}>
            {t.technique}
          </span>
        )}
        {t.tags.map((g) => (
          <span key={g} className="tag">
            {g}
          </span>
        ))}
      </div>
      {hosts.length > 0 && (
        <div className="tchosts" title={hosts.join(', ')}>
          {trunc(hosts.join(' · '), 70)}
        </div>
      )}
      {t.status === 'done' && t.outcome && <div className="tcoutcome">{trunc(t.outcome, 120)}</div>}
      <div className="tcfoot">
        <Avatars ids={t.assignees} />
        <span className="sp" />
        {t.due && (
          <span className={'due' + (overdue ? ' late' : '')} title={overdue ? 'Overdue' : 'Due'}>
            {overdue ? 'late ' : 'due '}
            {fmtDue(t.due, tz)}
          </span>
        )}
        {progress.total > 0 && (
          <span
            className={'tck' + (progress.done === progress.total ? ' full' : '')}
            title="Checklist"
          >
            ☑ {progress.done}/{progress.total}
          </span>
        )}
        {comments > 0 && <span title="Comments">✎ {comments}</span>}
        {following && <span title="You follow this task">◉</span>}
      </div>
    </article>
  );
}
