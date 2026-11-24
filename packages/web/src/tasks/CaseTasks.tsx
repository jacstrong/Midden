/** The case sidebar's task list: tasks linked to this case, and a button to add one. Hosted only. */
import { useMemo } from 'react';
import { categoryOf, sortTasks, statusOf, taskRef } from '@midden/core';
import { useRoute } from '../lib/router';
import { useCaseStore } from '../store/useCaseStore';
import { useTasks } from './TaskStore';
import { CATEGORY_COLOR, openTask, useTaskUi } from './shared';

export function CaseTasks() {
  const route = useRoute((s) => s.route);
  const live = useTasks((s) => !!s.store);
  const state = useTasks((s) => s.state);
  const canEdit = useCaseStore((s) => s.access.edit);
  const openCreate = useTaskUi((s) => s.openCreate);
  const caseId = route.kind === 'case' ? route.caseId : '';
  const tasks = useMemo(
    () =>
      state && caseId
        ? sortTasks(
            Object.values(state.tasks).filter((t) => t.caseId === caseId && !t.archived),
            'priority',
          )
        : [],
    [state, caseId],
  );
  if (!live || !caseId) return null;
  const open = tasks.filter((t) => {
    const c = categoryOf(state!, t);
    return c !== 'done' && c !== 'cancelled';
  });
  const shown = [...open, ...tasks.filter((t) => !open.includes(t))].slice(0, 12);
  return (
    <div data-testid="case-tasks">
      <div className="sbtitle">
        Tasks{' '}
        <span className="dimmer">
          {open.length}/{tasks.length}
        </span>
      </div>
      <ul className="casetasks">
        {shown.map((t) => {
          const st = statusOf(state!, t);
          const cat = categoryOf(state!, t);
          return (
            <li key={t.id} className={cat === 'done' || cat === 'cancelled' ? 'closed' : ''}>
              <a
                href={`#/tasks/t/${t.num}`}
                onClick={(e) => {
                  e.preventDefault();
                  openTask(t.num);
                }}
              >
                <span
                  className="stdot"
                  style={{ ['--cc' as string]: st?.color || CATEGORY_COLOR[cat] }}
                  title={st?.name}
                />
                <span className="tid">{taskRef(t.num)}</span> {t.title}
              </a>
            </li>
          );
        })}
      </ul>
      <div className="inline">
        {canEdit && (
          <button
            className="btn sm"
            onClick={() => openCreate({ caseId })}
            data-testid="case-task-new"
          >
            + Task
          </button>
        )}
        {tasks.length > shown.length && (
          <button
            className="btn sm ghost"
            onClick={() =>
              useRoute.getState().navigate({ kind: 'tasks', viewId: 'all', taskNum: null })
            }
          >
            All {tasks.length}
          </button>
        )}
      </div>
    </div>
  );
}

/** A "Create task" button for the host and event editors; renders nothing outside hosted mode. */
export function CreateTaskButton({
  hostId,
  eventId,
  title,
}: {
  hostId?: string;
  eventId?: string;
  title: string;
}) {
  const live = useTasks((s) => !!s.store);
  const route = useRoute((s) => s.route);
  const openCreate = useTaskUi((s) => s.openCreate);
  if (!live || route.kind !== 'case') return null;
  return (
    <button
      className="btn sm ghost"
      title="Create a task about this, linked to the case"
      onClick={() =>
        openCreate({
          caseId: route.caseId,
          title,
          ...(hostId ? { hostId } : {}),
          ...(eventId ? { eventId } : {}),
        })
      }
      data-testid="create-task-from"
    >
      + Task
    </button>
  );
}
