/**
 * #/tasks/<view>[/t/<num>]: the view rail, a toolbar to adjust the view, the board or table,
 * and the open task's drawer. Changing the toolbar edits a draft of the view; Save keeps it
 * (your own views, or a team view you lead), Save as makes a new one.
 *
 * `#/tasks/run:<id>` is an unsaved view of one run, which the Playbooks & runs page links to.
 * Picking cards or rows (checkbox, X, or Cmd/Ctrl/Shift-click) opens the bulk bar.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BUILTIN_VIEWS,
  defaultViewConfig,
  filterTasks,
  sortTasks,
  STATUS_CATEGORIES,
  TASK_GROUP_BYS,
  categoryLabel,
  type StatusCategory,
  type Task,
  type TaskFilter,
  type TaskGroupBy,
  type TaskSort,
  type TaskView,
  type TaskViewConfig,
} from '@midden/core';
import { HostedChrome } from '../components/HostedChrome';
import { ConfirmModal, Modal } from '../components/Modal';
import { api, ApiError } from '../lib/api';
import { useRoute } from '../lib/router';
import { toast } from '../store/useToasts';
import { Board } from './Board';
import { BulkBar } from './BulkBar';
import { ExportDialog } from './ExportDialog';
import { ImportWizard } from './ImportWizard';
import { NewTaskHost } from './NewTaskDialog';
import { TaskDrawer } from './TaskDrawer';
import { TaskTable } from './TaskTable';
import { useTasks } from './TaskStore';
import { useNames, useTaskUi, type Names } from './shared';
import { TeamSelect } from './pickers';

const GROUP_LABEL: Record<TaskGroupBy, string> = {
  status: 'Status',
  category: 'Category',
  assignee: 'Assignee',
  team: 'Team',
  priority: 'Priority',
  label: 'Label',
  run: 'Run',
  case: 'Case',
  none: 'Nothing',
};

/** Saved views from the server, reloaded after each change. */
function useSavedViews(): { views: TaskView[]; reload(): void } {
  const [views, setViews] = useState<TaskView[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    api<{ views: TaskView[] }>('GET', '/api/task-views')
      .then((r) => alive && setViews(r.views))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]);
  return { views, reload: useCallback(() => setTick((t) => t + 1), []) };
}

export function TasksPage({ viewId, taskNum }: { viewId: string; taskNum: number | null }) {
  const state = useTasks((s) => s.state);
  const connection = useTasks((s) => s.connection);
  const role = useTasks((s) => s.directory.users.find((u) => u.id === s.me?.id)?.role);
  const names = useNames();
  const navigate = useRoute((s) => s.navigate);
  const openCreate = useTaskUi((s) => s.openCreate);
  const saved = useSavedViews();
  const runId = viewId.startsWith('run:') ? viewId.slice(4) : '';
  const runName = runId ? state?.runs[runId]?.name : undefined;
  const runView = useMemo(
    (): TaskView | null =>
      runName === undefined
        ? null
        : {
            id: viewId,
            name: runName,
            ownerId: '',
            teamId: '',
            builtIn: true,
            config: defaultViewConfig({ filter: { runs: [runId] }, showClosed: true }),
          },
    [viewId, runId, runName],
  );
  const all = useMemo(
    () => [...BUILTIN_VIEWS, ...saved.views, ...(runView ? [runView] : [])],
    [saved.views, runView],
  );
  const view = all.find((v) => v.id === viewId) ?? BUILTIN_VIEWS[0]!;
  const [draft, setDraft] = useState<TaskViewConfig>(view.config);
  const [draftOf, setDraftOf] = useState(view);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [lastPick, setLastPick] = useState('');
  if (draftOf !== view) {
    // a different view (or a reloaded copy of it): start again from what it says
    setDraftOf(view);
    setDraft(view.config);
    if (draftOf.id !== view.id) setPicked(new Set());
  }
  const dirty = JSON.stringify(draft) !== JSON.stringify(view.config);
  const canEdit = role !== undefined && role !== 'viewer';
  const mayWrite =
    !view.builtIn &&
    (names.isAdmin || (view.teamId ? names.ledTeams.has(view.teamId) : view.ownerId === names.me));

  const tasks = useMemo(() => {
    if (!state) return [];
    const ctx = { me: names.me, myTeams: names.myTeams, now: new Date().toISOString() };
    return sortTasks(filterTasks(state, draft, ctx), draft.sort);
  }, [state, draft, names]);

  // Only what's on screen can be acted on, even if something picked has since been filtered out.
  const pickedTasks = useMemo(() => tasks.filter((t) => picked.has(t.id)), [tasks, picked]);
  const pick = useCallback(
    (t: Task, range = false): void => {
      setPicked((prev) => {
        const next = new Set(prev);
        const from = tasks.findIndex((x) => x.id === lastPick);
        const to = tasks.findIndex((x) => x.id === t.id);
        if (range && from >= 0 && to >= 0) {
          for (const x of tasks.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(x.id);
        } else if (next.has(t.id)) next.delete(t.id);
        else next.add(t.id);
        return next;
      });
      setLastPick(t.id);
    },
    [tasks, lastPick],
  );
  useEffect(() => {
    if (!picked.size) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !document.querySelector('.overlay')) setPicked(new Set());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picked.size]);
  const mayImport = names.isAdmin || names.ledTeams.size > 0;
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const viewRun =
    draft.filter.runs?.length === 1
      ? draft.filter.runs[0]
      : tasks.length && tasks.every((t) => t.runId && t.runId === tasks[0]!.runId)
        ? tasks[0]!.runId
        : undefined;

  const setFilter = (f: Partial<TaskFilter>): void =>
    setDraft((d) => ({ ...d, filter: clean({ ...d.filter, ...f }) }));
  const closeTask = useCallback(
    () => navigate({ kind: 'tasks', viewId: view.id, taskNum: null }),
    [navigate, view.id],
  );

  const save = async (): Promise<void> => {
    try {
      await api('PATCH', `/api/task-views/${view.id}`, { config: draft });
      saved.reload();
      toast('View saved');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the view', 'bad');
    }
  };
  const [savingAs, setSavingAs] = useState(false);
  const saveAs = async (name: string, teamId: string): Promise<void> => {
    try {
      const r = await api<{ view: TaskView }>('POST', '/api/task-views', {
        name,
        teamId,
        config: draft,
      });
      setSavingAs(false);
      saved.reload();
      navigate({ kind: 'tasks', viewId: r.view.id, taskNum });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not save the view', 'bad');
    }
  };
  const [deleting, setDeleting] = useState(false);
  const remove = async (): Promise<void> => {
    setDeleting(false);
    try {
      await api('DELETE', `/api/task-views/${view.id}`);
      saved.reload();
      navigate({ kind: 'tasks', viewId: 'mine', taskNum: null });
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not delete the view', 'bad');
    }
  };

  return (
    <HostedChrome title="Tasks">
      <div className="taskpage">
        <ViewRail current={view.id} builtIn={BUILTIN_VIEWS} saved={saved.views} names={names} />
        <section className="taskmain">
          {connection !== 'online' && (
            <div className="banner warn" role="status">
              {state ? 'Reconnecting — changes are paused' : 'Connecting…'}
            </div>
          )}
          <div className="toolbar">
            <h2 className="vtitle">{view.name}</h2>
            {canEdit && (
              <button className="btn pri" onClick={() => openCreate({})} data-testid="task-new">
                + Task
              </button>
            )}
            <input
              type="search"
              placeholder="Search tasks or T-12"
              aria-label="Search tasks"
              value={draft.filter.text ?? ''}
              onChange={(e) => setFilter({ text: e.target.value })}
            />
            <span className="sp" />
            {canEdit && mayImport && (
              <button
                className="btn sm"
                onClick={() => setImporting(true)}
                data-testid="task-import"
              >
                Import…
              </button>
            )}
            <button className="btn sm" onClick={() => setExporting(true)} data-testid="task-export">
              Export…
            </button>
            <div className="seg" role="group" aria-label="Layout">
              {(['board', 'table'] as const).map((l) => (
                <button
                  key={l}
                  className={draft.layout === l ? 'on' : ''}
                  onClick={() => setDraft({ ...draft, layout: l })}
                >
                  {l}
                </button>
              ))}
            </div>
            {dirty && (
              <span className="inline">
                {mayWrite && (
                  <button className="btn sm" onClick={() => void save()}>
                    Save
                  </button>
                )}
                <button className="btn sm" onClick={() => setSavingAs(true)}>
                  Save as…
                </button>
                <button className="btn sm ghost" onClick={() => setDraft(view.config)}>
                  Reset
                </button>
              </span>
            )}
            {!dirty && (
              <button
                className="btn sm ghost"
                onClick={() => setSavingAs(true)}
                title="Save a copy of this view"
              >
                Save as…
              </button>
            )}
            {mayWrite && !dirty && (
              <button className="btn sm ghost" onClick={() => setDeleting(true)}>
                Delete view
              </button>
            )}
          </div>
          <FilterBar draft={draft} setDraft={setDraft} setFilter={setFilter} />
          {state && canEdit && pickedTasks.length > 0 && (
            <BulkBar
              state={state}
              picked={pickedTasks}
              names={names}
              onClear={() => setPicked(new Set())}
            />
          )}
          {!state ? (
            <p className="empty">Loading tasks…</p>
          ) : draft.layout === 'board' ? (
            <Board
              state={state}
              tasks={tasks}
              config={draft}
              names={names}
              canEdit={canEdit}
              selectedNum={taskNum}
              picked={picked}
              onPick={canEdit ? pick : undefined}
            />
          ) : (
            <TaskTable
              state={state}
              tasks={tasks}
              names={names}
              sort={draft.sort}
              onSort={(sort: TaskSort) => setDraft({ ...draft, sort })}
              selectedNum={taskNum}
              picked={picked}
              onPick={canEdit ? pick : undefined}
              onPickAll={
                canEdit
                  ? (on) => setPicked(on ? new Set(tasks.map((t) => t.id)) : new Set())
                  : undefined
              }
            />
          )}
        </section>
        {taskNum !== null && <TaskDrawer num={taskNum} onClose={closeTask} />}
      </div>
      <NewTaskHost />
      {importing && (
        <ImportWizard
          runId={
            viewRun && state?.runs[viewRun] && !state.runs[viewRun]!.closed ? viewRun : undefined
          }
          onClose={() => setImporting(false)}
          onDone={(runId) => {
            setImporting(false);
            navigate({ kind: 'tasks', viewId: `run:${runId}`, taskNum: null });
          }}
        />
      )}
      {exporting && (
        <ExportDialog
          title={`Export “${view.name}”`}
          tasks={tasks}
          runId={viewRun}
          fileBase={view.name}
          onClose={() => setExporting(false)}
        />
      )}
      {deleting && (
        <ConfirmModal
          title="Delete view"
          message={`Delete the view “${view.name}”${view.teamId ? ` for everyone in ${names.team(view.teamId)}` : ''}? The tasks stay.`}
          okLabel="Delete"
          danger
          onOk={() => void remove()}
          onClose={() => setDeleting(false)}
        />
      )}
      {savingAs && (
        <SaveViewDialog
          initial={view.builtIn ? `${view.name} (mine)` : `${view.name} copy`}
          names={names}
          onSave={(n, t) => void saveAs(n, t)}
          onClose={() => setSavingAs(false)}
        />
      )}
    </HostedChrome>
  );
}

/** Drop empty filter values so a draft compares equal to the view it came from. */
function clean(f: TaskFilter): TaskFilter {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f))
    if (v !== undefined && v !== false && v !== '' && !(Array.isArray(v) && !v.length)) out[k] = v;
  return out as TaskFilter;
}

function ViewRail({
  current,
  builtIn,
  saved,
  names,
}: {
  current: string;
  builtIn: TaskView[];
  saved: TaskView[];
  names: Names;
}) {
  const navigate = useRoute((s) => s.navigate);
  const mine = saved.filter((v) => !v.teamId);
  const shared = saved.filter((v) => v.teamId);
  const item = (v: TaskView, sub?: string) => (
    <li key={v.id}>
      <a
        href={`#/tasks/${v.id}`}
        className={v.id === current ? 'on' : ''}
        aria-current={v.id === current ? 'page' : undefined}
        onClick={(e) => {
          e.preventDefault();
          navigate({ kind: 'tasks', viewId: v.id, taskNum: null });
        }}
      >
        {v.name}
        {sub && <span className="dimmer"> · {sub}</span>}
      </a>
    </li>
  );
  return (
    <nav className="viewrail" aria-label="Task views">
      <div className="sbtitle">Views</div>
      <ul>{builtIn.map((v) => item(v))}</ul>
      {mine.length > 0 && (
        <>
          <div className="sbtitle">Mine</div>
          <ul>{mine.map((v) => item(v))}</ul>
        </>
      )}
      {shared.length > 0 && (
        <>
          <div className="sbtitle">Team views</div>
          <ul>{shared.map((v) => item(v, names.team(v.teamId)))}</ul>
        </>
      )}
      <div className="sbtitle">Teams</div>
      <ul>
        <li>
          <a
            href="#/tasks/insights"
            data-testid="nav-insights"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'insights' });
            }}
          >
            Insights
          </a>
        </li>
        <li>
          <a
            href="#/playbooks"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'playbooks' });
            }}
          >
            Playbooks &amp; runs
          </a>
        </li>
        <li>
          <a
            href="#/teams"
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: 'teams' });
            }}
          >
            Teams &amp; members
          </a>
        </li>
      </ul>
    </nav>
  );
}

function FilterBar({
  draft,
  setDraft,
  setFilter,
}: {
  draft: TaskViewConfig;
  setDraft(c: TaskViewConfig): void;
  setFilter(f: Partial<TaskFilter>): void;
}) {
  const f = draft.filter;
  const state = useTasks((s) => s.state);
  const names = useNames();
  const toggle = (
    k: 'mine' | 'unassigned' | 'overdue' | 'following' | 'myTeams' | 'awaitingMyApproval',
    label: string,
  ) => (
    <button
      className={'fchip' + (f[k] ? ' on' : '')}
      aria-pressed={!!f[k]}
      onClick={() => setFilter({ [k]: !f[k] })}
    >
      {label}
    </button>
  );
  const cats = f.categories ?? [];
  const toggleCat = (c: StatusCategory): void =>
    setFilter({ categories: cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c] });
  return (
    <div className="toolbar filterbar">
      <div className="chiprow">
        {toggle('mine', 'Mine')}
        {toggle('myTeams', 'My teams')}
        {toggle('unassigned', 'Unassigned')}
        {toggle('following', 'Following')}
        {toggle('overdue', 'Overdue')}
        {toggle('awaitingMyApproval', 'My approvals')}
      </div>
      <div className="chiprow">
        {STATUS_CATEGORIES.map((c) => (
          <button
            key={c}
            className={'fchip' + (cats.includes(c) ? ' on' : '')}
            aria-pressed={cats.includes(c)}
            onClick={() => toggleCat(c)}
          >
            {categoryLabel(c)}
          </button>
        ))}
      </div>
      <label className="inline">
        <span className="dimmer">Team</span>
        <TeamSelect
          value={f.teams?.[0] ?? ''}
          onChange={(v) => setFilter({ teams: v ? [v] : [] })}
        />
      </label>
      <label className="inline">
        <span className="dimmer">Run</span>
        <select
          value={f.runs?.[0] ?? ''}
          onChange={(e) => setFilter({ runs: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">Any</option>
          {Object.values(state?.runs ?? {}).map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
              {r.closed ? ' (closed)' : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="inline">
        <span className="dimmer">Assignee</span>
        <select
          value={f.assignees?.[0] ?? ''}
          onChange={(e) => setFilter({ assignees: e.target.value ? [e.target.value] : [] })}
        >
          <option value="">Anyone</option>
          {names.assignable.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
            </option>
          ))}
        </select>
      </label>
      <span className="sp" />
      {draft.layout === 'board' && (
        <>
          <label className="inline">
            <span className="dimmer">Columns</span>
            <select
              value={draft.groupBy}
              onChange={(e) => setDraft({ ...draft, groupBy: e.target.value as TaskGroupBy })}
            >
              {TASK_GROUP_BYS.filter((g) => g !== 'none').map((g) => (
                <option key={g} value={g}>
                  {GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <span className="dimmer">Lanes</span>
            <select
              value={draft.swimlanes}
              onChange={(e) => setDraft({ ...draft, swimlanes: e.target.value as TaskGroupBy })}
            >
              {TASK_GROUP_BYS.filter((g) => g !== 'status' && g !== 'category').map((g) => (
                <option key={g} value={g}>
                  {g === 'none' ? 'None' : GROUP_LABEL[g]}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label className="inline">
        <input
          type="checkbox"
          checked={draft.showClosed}
          onChange={(e) => setDraft({ ...draft, showClosed: e.target.checked })}
        />
        <span className="dimmer">Show closed</span>
      </label>
    </div>
  );
}

function SaveViewDialog({
  initial,
  names,
  onSave,
  onClose,
}: {
  initial: string;
  names: Names;
  onSave(name: string, teamId: string): void;
  onClose(): void;
}) {
  const teams = useTasks((s) => s.directory.teams).filter(
    (t) => names.isAdmin || names.ledTeams.has(t.id),
  );
  const [name, setName] = useState(initial);
  const [teamId, setTeamId] = useState('');
  return (
    <Modal
      title="Save view"
      narrow
      onClose={onClose}
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn pri"
            disabled={!name.trim()}
            onClick={() => onSave(name.trim(), teamId)}
          >
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="svName">Name</label>
        <input
          id="svName"
          type="text"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && name.trim() && onSave(name.trim(), teamId)}
        />
      </div>
      <div className="field">
        <label htmlFor="svTeam">Share with</label>
        <select id="svTeam" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          <option value="">Just me</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              Team {t.name}
            </option>
          ))}
        </select>
        {!teams.length && <span className="hint">Team leads can share views with their team.</span>}
      </div>
    </Modal>
  );
}
