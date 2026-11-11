import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bulkEditOp,
  planTaskImport,
  readTaskTemplate,
  TASK_PRIORITY,
  TASK_STATUS,
  taskTemplateCsv,
  TaskTemplateError,
  type BulkEdit,
  type ListMode,
  type TaskPriority,
  type TaskStatus,
  type TemplateTask,
} from '@midden/core';
import { Modal } from '../components/Modal';
import { Field } from '../components/fields';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { usePeople } from '../store/usePeople';
import { useTaskBoard } from '../store/useTaskBoard';
import { toast } from '../store/useToasts';
import { api, type CaseSummary } from '../lib/api';
import { downloadText } from '../lib/download';
import { trunc } from '../lib/format';
import { ChipPicker, hostOptions, localInputToIso, usePeopleOptions } from './taskUi';
import { copyTasksToCase, currentActor, userResolver } from './taskActions';

function ModeSeg({ value, onChange }: { value: ListMode; onChange: (m: ListMode) => void }) {
  const modes: Array<[ListMode, string]> = [
    ['add', 'Add'],
    ['remove', 'Remove'],
    ['replace', 'Replace with'],
  ];
  return (
    <div className="seg" role="group">
      {modes.map(([m, label]) => (
        <button
          key={m}
          type="button"
          className={value === m ? 'on' : ''}
          aria-pressed={value === m}
          onClick={() => onChange(m)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Change several tasks at once. Every field starts as "leave alone". */
export function TaskBulkDialog({ ids }: { ids: string[] }) {
  const state = useCaseStore((s) => s.state);
  const dispatch = useCaseStore((s) => s.dispatch);
  const closeModal = useUiStore((s) => s.closeModal);
  const people = usePeopleOptions();
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [priority, setPriority] = useState<TaskPriority | ''>('');
  const [assignMode, setAssignMode] = useState<ListMode>('add');
  const [assignees, setAssignees] = useState<string[]>([]);
  const [hostMode, setHostMode] = useState<ListMode>('add');
  const [hosts, setHosts] = useState<string[]>([]);
  const [addTags, setAddTags] = useState('');
  const [removeTags, setRemoveTags] = useState('');
  const [due, setDue] = useState<'keep' | 'set' | 'clear'>('keep');
  const [dueValue, setDueValue] = useState('');
  const n = ids.filter((id) => state.tasks[id]).length;
  const split = (s: string): string[] =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);

  const apply = async (): Promise<void> => {
    const edit: BulkEdit = {
      status: status || undefined,
      priority: priority || undefined,
      assignees:
        assignees.length || assignMode === 'replace'
          ? { mode: assignMode, values: assignees }
          : undefined,
      hostIds:
        hosts.length || hostMode === 'replace' ? { mode: hostMode, values: hosts } : undefined,
      due: due === 'keep' ? undefined : due === 'clear' ? '' : localInputToIso(dueValue),
    };
    let op = bulkEditOp(state, ids, edit);
    // Tags can be added and removed in one go, so they are a second pass over the result.
    if (addTags.trim() || removeTags.trim()) {
      const ops = op.type === 'batch' ? [...op.ops] : [op];
      const byId = new Map<string, Record<string, unknown>>();
      for (const o of ops)
        if (o.type === 'task.set') byId.set(o.id, o.patch as Record<string, unknown>);
      for (const id of ids) {
        const t = state.tasks[id];
        if (!t) continue;
        const next = [...new Set([...t.tags, ...split(addTags)])].filter(
          (x) => !split(removeTags).includes(x),
        );
        if (next.join('\n') === t.tags.join('\n')) continue;
        const patch = byId.get(id);
        if (patch) patch.tags = next;
        else ops.push({ type: 'task.set', id, patch: { tags: next } });
      }
      op = { type: 'batch', ops };
    }
    if (op.type === 'batch' && !op.ops.length) {
      toast('Nothing to change');
      return;
    }
    const r = await dispatch(op);
    if (!r.ok) return;
    const changed = op.type === 'batch' ? op.ops.length : 1;
    toast(`Updated ${changed} task${changed === 1 ? '' : 's'}`);
    closeModal();
  };

  return (
    <Modal
      title={`Edit ${n} task${n === 1 ? '' : 's'}`}
      onClose={closeModal}
      foot={
        <>
          <span className="dimmer" style={{ fontSize: 10 }}>
            One change in the history; one revert undoes it.
          </span>
          <span className="sp" />
          <button className="btn ghost" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn pri" onClick={() => void apply()} data-testid="bulk-apply">
            Apply to {n}
          </button>
        </>
      }
    >
      <div className="grid3">
        <Field label="Status" htmlFor="bStatus">
          <select
            id="bStatus"
            value={status}
            onChange={(e) => setStatus(e.target.value as TaskStatus | '')}
          >
            <option value="">Leave as is</option>
            {TASK_STATUS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" htmlFor="bPriority">
          <select
            id="bPriority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as TaskPriority | '')}
          >
            <option value="">Leave as is</option>
            {TASK_PRIORITY.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due" htmlFor="bDue">
          <select id="bDue" value={due} onChange={(e) => setDue(e.target.value as typeof due)}>
            <option value="keep">Leave as is</option>
            <option value="set">Set to…</option>
            <option value="clear">Clear</option>
          </select>
          {due === 'set' && (
            <input
              type="datetime-local"
              aria-label="Due date"
              value={dueValue}
              onChange={(e) => setDueValue(e.target.value)}
            />
          )}
        </Field>
        <div className="field span3">
          <label htmlFor="bAssign">Assignees</label>
          <ModeSeg value={assignMode} onChange={setAssignMode} />
          <ChipPicker
            id="bAssign"
            value={assignees}
            options={people.options}
            free={people.free}
            onChange={setAssignees}
            placeholder={people.free ? 'Type a name, then Enter' : 'Choose people…'}
            testId="bulk-assignees"
          />
          <div className="hint">
            {assignMode === 'replace' && !assignees.length
              ? 'Replacing with nobody unassigns every selected task.'
              : 'Everyone added or removed is told.'}
          </div>
        </div>
        <div className="field span3">
          <label htmlFor="bHosts">Hosts</label>
          <ModeSeg value={hostMode} onChange={setHostMode} />
          <ChipPicker
            id="bHosts"
            value={hosts}
            options={hostOptions(state)}
            onChange={setHosts}
            placeholder="Choose hosts…"
          />
        </div>
        <Field label="Add tags" htmlFor="bTagsAdd" span={2}>
          <input
            id="bTagsAdd"
            type="text"
            value={addTags}
            placeholder="shift-2, priority-sweep"
            onChange={(e) => setAddTags(e.target.value)}
          />
        </Field>
        <Field label="Remove tags" htmlFor="bTagsRemove">
          <input
            id="bTagsRemove"
            type="text"
            value={removeTags}
            onChange={(e) => setRemoveTags(e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}

const SAMPLE: TemplateTask[] = [
  {
    title: 'Sweep domain controllers for DCSync',
    description: 'Look for replication requests from anything that is not a DC.',
    status: 'todo',
    priority: 'high',
    assignees: [],
    hosts: [],
    technique: 'T1003.006',
    tags: ['ad'],
    due: '',
    checklist: ['Pull 4662 events', 'Check for DRSUAPI from non-DC hosts'],
  },
];

/** Load a task list from a .json or .csv file, with a preview of what will land where. */
export function TaskImportDialog() {
  const state = useCaseStore((s) => s.state);
  const dispatch = useCaseStore((s) => s.dispatch);
  const multiUser = useCaseStore((s) => s.capabilities.multiUser);
  const closeModal = useUiStore((s) => s.closeModal);
  const people = usePeople((s) => s.people);
  const peopleOpts = usePeopleOptions();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [tasks, setTasks] = useState<TemplateTask[] | null>(null);
  const [dropped, setDropped] = useState<Array<{ index: number; reason: string }>>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<TaskStatus | ''>('');
  const [also, setAlso] = useState<string[]>([]);

  const read = async (file: File): Promise<void> => {
    setFileName(file.name);
    setError('');
    try {
      const r = readTaskTemplate(await file.text());
      setTasks(r.tasks);
      setDropped(r.dropped);
    } catch (err) {
      setTasks(null);
      setError(err instanceof TaskTemplateError ? err.message : 'That file could not be read');
    }
  };

  const plan = useMemo(
    () =>
      tasks
        ? planTaskImport(state, tasks, {
            actor: currentActor(),
            resolveUser: userResolver(people, multiUser),
            status: status || undefined,
            assignAlso: also,
          })
        : null,
    [tasks, state, people, multiUser, status, also],
  );

  const run = async (): Promise<void> => {
    if (!plan || !plan.ids.length) return;
    const r = await dispatch(plan.op);
    if (!r.ok) return;
    toast(`Imported ${plan.ids.length} task${plan.ids.length === 1 ? '' : 's'}`);
    useTaskBoard.getState().selectOnly(plan.ids);
    closeModal();
  };

  return (
    <Modal
      title="Import tasks"
      onClose={closeModal}
      foot={
        <>
          <button
            className="btn ghost sm"
            onClick={() =>
              downloadText(
                'midden-tasks-template.csv',
                taskTemplateCsv(SAMPLE),
                'text/csv;charset=utf-8',
              )
            }
          >
            Download a sample .csv
          </button>
          <span className="sp" />
          <button className="btn ghost" onClick={closeModal}>
            Cancel
          </button>
          <button
            className="btn pri"
            disabled={!plan?.ids.length}
            onClick={() => void run()}
            data-testid="task-import-run"
          >
            {plan?.ids.length ? `Import ${plan.ids.length}` : 'Import'}
          </button>
        </>
      }
    >
      <p className="dimmer" style={{ marginTop: 0, lineHeight: 1.6 }}>
        A task list exported from Midden (.json), or a spreadsheet saved as .csv with a <b>title</b>{' '}
        column and any of: description, status, priority, assignees, hosts, technique, tags, due,
        checklist. Separate several people, hosts or steps with <code>;</code>. People are matched
        by username, hosts by name or address.
      </p>
      <div className="filepick">
        <button
          className="btn"
          onClick={() => input.current?.click()}
          data-testid="task-import-pick"
        >
          Choose file…
        </button>
        <span className="filename">{fileName || 'No file chosen'}</span>
        <input
          ref={input}
          type="file"
          accept=".json,.csv,application/json,text/csv"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void read(f);
          }}
          data-testid="task-import-file"
        />
      </div>
      {error && <div className="err">{error}</div>}
      {tasks && (
        <>
          <div className="grid2" style={{ marginTop: 12 }}>
            <Field label="Put them in" htmlFor="iStatus">
              <select
                id="iStatus"
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus | '')}
              >
                <option value="">The column each task names</option>
                {TASK_STATUS.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Also assign every task to" htmlFor="iAlso">
              <ChipPicker
                id="iAlso"
                value={also}
                options={peopleOpts.options}
                free={peopleOpts.free}
                onChange={setAlso}
                placeholder="Nobody extra"
              />
            </Field>
          </div>
          <div className="importpreview" data-testid="task-import-preview">
            <b>{tasks.length}</b> task{tasks.length === 1 ? '' : 's'} found
            {dropped.length > 0 && (
              <span className="warnline">
                {' '}
                · {dropped.length} row{dropped.length === 1 ? '' : 's'} skipped (
                {trunc(dropped.map((d) => `#${d.index + 1} ${d.reason}`).join('; '), 140)})
              </span>
            )}
            <ul>
              {tasks.slice(0, 8).map((t, i) => (
                <li key={i}>
                  {trunc(t.title, 90)}
                  {t.assignees.length > 0 && (
                    <span className="dimmer"> · {t.assignees.join(', ')}</span>
                  )}
                </li>
              ))}
              {tasks.length > 8 && <li className="dimmer">…and {tasks.length - 8} more</li>}
            </ul>
            {plan && plan.unresolvedUsers.length > 0 && (
              <div className="warnline" data-testid="task-import-unresolved-users">
                No one here matches {plan.unresolvedUsers.join(', ')}; those tasks come in without
                them.
              </div>
            )}
            {plan && plan.unresolvedHosts.length > 0 && (
              <div className="warnline">
                No host matches {trunc(plan.unresolvedHosts.join(', '), 200)}; add them as hosts
                first, or link them afterwards.
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}

/** Copy tasks into another case the person can edit. */
export function TaskCopyDialog({ ids }: { ids: string[] }) {
  const closeModal = useUiStore((s) => s.closeModal);
  const here = useCaseStore((s) => s.caseId);
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<{ cases: CaseSummary[] }>('GET', '/api/cases')
      .then((r) => setCases(r.cases.filter((c) => c.access.edit && c.id !== here)))
      .catch(() => setCases([]));
  }, [here]);
  const run = async (): Promise<void> => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await copyTasksToCase(ids, target);
      const misses = [
        r.unresolvedUsers.length ? `${r.unresolvedUsers.length} people` : '',
        r.unresolvedHosts.length ? `${r.unresolvedHosts.length} hosts` : '',
      ].filter(Boolean);
      toast(
        `Copied ${r.created} task${r.created === 1 ? '' : 's'}` +
          (misses.length ? `; ${misses.join(' and ')} had no match there` : ''),
        misses.length ? 'warn' : 'info',
      );
      closeModal();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Copy failed', 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Copy ${ids.length} task${ids.length === 1 ? '' : 's'} to another case`}
      onClose={closeModal}
      narrow
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={closeModal}>
            Cancel
          </button>
          <button
            className="btn pri"
            disabled={!target || busy}
            onClick={() => void run()}
            data-testid="task-copy-run"
          >
            Copy
          </button>
        </>
      }
    >
      <p className="dimmer" style={{ marginTop: 0, lineHeight: 1.6 }}>
        The copies start fresh: unticked checklists, no outcome, no comments. People are matched by
        username and hosts by name or address in the other case; linked events stay behind.
      </p>
      <Field label="Case" htmlFor="cTarget">
        <select id="cTarget" value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">
            {cases === null
              ? 'Loading…'
              : cases.length
                ? 'Choose a case…'
                : 'No other case you can edit'}
          </option>
          {(cases ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.number ? `${c.number} · ` : ''}
              {c.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}
