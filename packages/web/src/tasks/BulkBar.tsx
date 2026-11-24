/**
 * Actions on the tasks picked on a board or table. Each builds one op (usually a batch), so a
 * bulk change undoes in one step from any task's history.
 *
 * Changing who is assigned on more than one task is for team leads (within their teams) and
 * admins; the server holds that rule, and the bar only offers people and teams the lead may
 * use, so a refusal is rare. Everything else is open to any analyst.
 */
import { useMemo, useState } from 'react';
import {
  categoryLabel,
  distribute,
  distributeOps,
  followOps,
  labelOps,
  moveToRunOp,
  openLoad,
  patchOps,
  setStatusOps,
  taskRef,
  workflowIdFor,
  DISTRIBUTE_MODES,
  STATUS_CATEGORIES,
  TASK_PRIORITIES,
  type DistributeMode,
  type StatusCategory,
  type Task,
  type TaskOp,
  type TaskPriority,
  type TaskState,
} from '@midden/core';
import { ConfirmModal, Modal } from '../components/Modal';
import { toast } from '../store/useToasts';
import { ExportDialog } from './ExportDialog';
import { LabelInput, PeoplePicker } from './pickers';
import { useTasks } from './TaskStore';
import { fromLocalInput, type Names } from './shared';

type Dialog = 'assign' | 'distribute' | 'labels' | 'due' | 'export' | 'archive' | null;

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** People and teams a lead may hand bulk work to: their teams' members, or anyone for admins. */
export function bulkScope(names: Names, dirTeams: { id: string; members: { userId: string }[] }[]) {
  if (names.isAdmin) return { people: names.assignable, teamIds: dirTeams.map((t) => t.id) };
  const led = dirTeams.filter((t) => names.ledTeams.has(t.id));
  const members = new Set(led.flatMap((t) => t.members.map((m) => m.userId)));
  return {
    people: names.assignable.filter((u) => members.has(u.id)),
    teamIds: led.map((t) => t.id),
  };
}

export function BulkBar({
  state,
  picked,
  names,
  onClear,
}: {
  state: TaskState;
  picked: Task[];
  names: Names;
  onClear(): void;
}) {
  const dispatch = useTasks((s) => s.dispatch);
  const dir = useTasks((s) => s.directory);
  const [dialog, setDialog] = useState<Dialog>(null);
  const n = picked.length;
  const mayAssign = n === 1 || names.isAdmin || names.ledTeams.size > 0;

  const apply = async (op: TaskOp | null, done: string, after?: () => void): Promise<void> => {
    if (!op) {
      toast('Nothing to change');
      return;
    }
    const r = await dispatch(op);
    if (r.ok) {
      toast(done);
      after?.();
    } else if (r.error?.startsWith('Offline')) toast(r.error, 'bad'); // other refusals toast already
  };

  // One workflow across the selection: offer its statuses. Several: offer categories.
  const workflows = new Set(picked.map((t) => workflowIdFor(state, t.runId)));
  const wf = workflows.size === 1 ? state.workflows[[...workflows][0]!] : undefined;
  const setStatus = (v: string): void => {
    if (!v) return;
    const to = v.startsWith('cat:') ? { category: v.slice(4) as StatusCategory } : { statusId: v };
    const { op, skipped, awaitingApproval: gated } = setStatusOps(state, picked, to);
    const label = v.startsWith('cat:')
      ? categoryLabel(v.slice(4) as StatusCategory)
      : (wf?.statuses.find((s) => s.id === v)?.name ?? v);
    void apply(
      op,
      `Moved ${plural(n - skipped.length - gated.length, 'task')} to ${label}` +
        (skipped.length ? `; ${skipped.length} have no such status` : '') +
        (gated.length
          ? `; ${gated.map((t) => taskRef(t.num)).join(', ')} still need${gated.length === 1 ? 's' : ''} approval`
          : ''),
    );
  };

  const allFollowed = picked.every((t) => t.followers.includes(names.me));
  const archived = picked.every((t) => t.archived);
  const oneRun = new Set(picked.map((t) => t.runId)).size === 1 ? picked[0]?.runId : undefined;

  return (
    <>
      <div className="bulkbar" role="region" aria-label="Bulk actions" data-testid="bulk-bar">
        <strong>{plural(n, 'task')} selected</strong>
        {mayAssign && (
          <button className="btn sm" onClick={() => setDialog('assign')}>
            Assign…
          </button>
        )}
        {mayAssign && n > 1 && (
          <button
            className="btn sm"
            onClick={() => setDialog('distribute')}
            data-testid="bulk-distribute"
          >
            Distribute…
          </button>
        )}
        <select aria-label="Set status" value="" onChange={(e) => setStatus(e.target.value)}>
          <option value="">Status…</option>
          {wf
            ? wf.statuses.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))
            : STATUS_CATEGORIES.map((c) => (
                <option key={c} value={`cat:${c}`}>
                  {categoryLabel(c)}
                </option>
              ))}
        </select>
        <select
          aria-label="Set priority"
          value=""
          onChange={(e) =>
            e.target.value &&
            void apply(
              patchOps(picked, { priority: e.target.value as TaskPriority }),
              `Priority set to ${e.target.value}`,
            )
          }
        >
          <option value="">Priority…</option>
          {TASK_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <button className="btn sm" onClick={() => setDialog('labels')}>
          Labels…
        </button>
        <button className="btn sm" onClick={() => setDialog('due')}>
          Due…
        </button>
        <select
          aria-label="Link to case"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const caseId = v === '-' ? '' : v;
            void apply(
              patchOps(picked, { caseId }),
              caseId ? `Linked to ${names.caseName(caseId)}` : 'Unlinked from their cases',
            );
          }}
        >
          <option value="">Case…</option>
          <option value="-">No case</option>
          {dir.cases.map((c) => (
            <option key={c.id} value={c.id}>
              {c.number ? `${c.number} · ` : ''}
              {c.name}
              {c.restricted ? ' 🔒' : ''}
            </option>
          ))}
        </select>
        <select
          aria-label="Move to run"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            const runId = v === '-' ? '' : v;
            const ops = picked.flatMap((t) => {
              const o = moveToRunOp(state, t, runId);
              return o ? [o] : [];
            });
            void apply(
              ops.length === 0 ? null : ops.length === 1 ? ops[0]! : { type: 'batch', ops },
              runId
                ? `Moved to ${state.runs[runId]?.name ?? 'the run'}`
                : 'Taken out of their runs',
            );
          }}
        >
          <option value="">Run…</option>
          <option value="-">No run</option>
          {Object.values(state.runs)
            .filter((r) => !r.closed)
            .map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
        </select>
        <button
          className="btn sm"
          onClick={() =>
            void apply(
              followOps(picked, [names.me], !allFollowed),
              allFollowed ? 'Stopped following' : 'Following',
            )
          }
        >
          {allFollowed ? 'Unfollow' : 'Follow'}
        </button>
        <button
          className="btn sm"
          onClick={() =>
            archived
              ? void apply(patchOps(picked, { archived: false }), 'Restored')
              : setDialog('archive')
          }
        >
          {archived ? 'Unarchive' : 'Archive'}
        </button>
        <button className="btn sm" onClick={() => setDialog('export')}>
          Export…
        </button>
        <span className="sp" />
        <button className="btn sm ghost" onClick={onClear} title="Esc">
          Clear selection
        </button>
      </div>

      {dialog === 'assign' && (
        <AssignDialog
          picked={picked}
          names={names}
          onClose={() => setDialog(null)}
          onApply={(op, msg) => void apply(op, msg, () => setDialog(null))}
        />
      )}
      {dialog === 'distribute' && (
        <DistributeDialog
          state={state}
          picked={picked}
          names={names}
          onClose={() => setDialog(null)}
          onApply={(op, msg) => void apply(op, msg, () => setDialog(null))}
        />
      )}
      {dialog === 'labels' && (
        <LabelsDialog
          picked={picked}
          onClose={() => setDialog(null)}
          onApply={(op, msg) => void apply(op, msg, () => setDialog(null))}
        />
      )}
      {dialog === 'due' && (
        <DueDialog
          picked={picked}
          onClose={() => setDialog(null)}
          onApply={(op, msg) => void apply(op, msg, () => setDialog(null))}
        />
      )}
      {dialog === 'archive' && (
        <ConfirmModal
          title="Archive tasks"
          message={`Archive ${plural(n, 'task')}? They leave the boards but stay in All tasks and exports, and you can undo it from their history.`}
          okLabel="Archive"
          onOk={() => {
            setDialog(null);
            void apply(
              patchOps(picked, { archived: true }),
              `Archived ${plural(n, 'task')}`,
              onClear,
            );
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'export' && (
        <ExportDialog
          title={`Export ${plural(n, 'task')}`}
          tasks={picked}
          runId={oneRun || undefined}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}

type ApplyFn = (op: TaskOp | null, msg: string) => void;

function AssignDialog({
  picked,
  names,
  onClose,
  onApply,
}: {
  picked: Task[];
  names: Names;
  onClose(): void;
  onApply: ApplyFn;
}) {
  const dirTeams = useTasks((s) => s.directory.teams);
  const bulk = picked.length > 1;
  const scope = useMemo(() => bulkScope(names, dirTeams), [names, dirTeams]);
  const pickNames: Names = bulk ? { ...names, assignable: scope.people } : names;
  const [mode, setMode] = useState<'add' | 'remove' | 'set'>('add');
  const [people, setPeople] = useState<string[]>([]);
  const [team, setTeam] = useState<string>('keep');
  const teams = dirTeams.filter((t) => !bulk || scope.teamIds.includes(t.id));
  const removable = names.assignable.filter((u) => picked.some((t) => t.assignees.includes(u.id)));
  const ready = people.length > 0 || mode === 'set' || team !== 'keep';
  const go = (): void => {
    const teamId = team === 'keep' ? undefined : team;
    const what =
      mode === 'remove'
        ? `Removed ${people.map(names.user).join(', ')}`
        : mode === 'set'
          ? people.length
            ? `Assigned to ${people.map(names.user).join(', ')}`
            : 'Unassigned'
          : people.length
            ? `Added ${people.map(names.user).join(', ')}`
            : 'Team changed';
    onApply(
      {
        type: 'task.assign',
        ids: picked.map((t) => t.id),
        mode,
        users: people,
        ...(teamId !== undefined ? { teamId } : {}),
      },
      what,
    );
  };
  return (
    <Modal
      title={`Assign ${plural(picked.length, 'task')}`}
      narrow
      onClose={onClose}
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" disabled={!ready} onClick={go}>
            Apply
          </button>
        </>
      }
    >
      <div className="field">
        <span className="flabel">What to do</span>
        <div className="seg" role="radiogroup" aria-label="Assign mode">
          {(
            [
              ['add', 'Add people'],
              ['remove', 'Remove people'],
              ['set', 'Replace assignees'],
            ] as const
          ).map(([m, l]) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? 'on' : ''}
              onClick={() => setMode(m)}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label htmlFor="bulkPeople">People</label>
        <PeoplePicker
          id="bulkPeople"
          value={people}
          names={mode === 'remove' ? { ...names, assignable: removable } : pickNames}
          onAdd={(u) => setPeople([...people, u])}
          onRemove={(u) => setPeople(people.filter((x) => x !== u))}
        />
        {mode === 'set' && !people.length && (
          <span className="hint">With nobody picked, the tasks go back to their team’s queue.</span>
        )}
        {bulk && !names.isAdmin && (
          <span className="hint">Leads can hand bulk work to members of the teams they lead.</span>
        )}
      </div>
      <div className="field">
        <label htmlFor="bulkTeam">Team queue</label>
        <select id="bulkTeam" value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="keep">Keep each task’s team</option>
          {(names.isAdmin || !bulk) && <option value="">No team</option>}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
    </Modal>
  );
}

function DistributeDialog({
  state,
  picked,
  names,
  onClose,
  onApply,
}: {
  state: TaskState;
  picked: Task[];
  names: Names;
  onClose(): void;
  onApply: ApplyFn;
}) {
  const dirTeams = useTasks((s) => s.directory.teams);
  const scope = useMemo(() => bulkScope(names, dirTeams), [names, dirTeams]);
  // Start with everyone on the selection's team, when it has one team the user may hand out.
  const teamIds = new Set(picked.map((t) => t.teamId));
  const only = teamIds.size === 1 ? [...teamIds][0]! : '';
  const [people, setPeople] = useState<string[]>(() => {
    const t = dirTeams.find((x) => x.id === only);
    if (!t || !scope.teamIds.includes(t.id)) return [];
    const ok = new Set(scope.people.map((u) => u.id));
    return t.members.map((m) => m.userId).filter((u) => ok.has(u));
  });
  const [mode, setMode] = useState<DistributeMode>('balanced');
  const [team, setTeam] = useState<string>('keep');
  const deal = useMemo(
    () => distribute(state, picked, people, mode),
    [state, picked, people, mode],
  );
  const load = useMemo(
    () => openLoad(state, people, new Set(picked.map((t) => t.id))),
    [state, people, picked],
  );
  const teams = dirTeams.filter((t) => scope.teamIds.includes(t.id));
  return (
    <Modal
      title={`Distribute ${plural(picked.length, 'task')}`}
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
            disabled={!people.length}
            data-testid="distribute-apply"
            onClick={() =>
              onApply(
                distributeOps(state, picked, people, mode, team === 'keep' ? undefined : team),
                `Distributed ${plural(picked.length, 'task')} across ${plural(people.length, 'person')}`.replace(
                  'persons',
                  'people',
                ),
              )
            }
          >
            Distribute
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="distPeople">Between</label>
        <PeoplePicker
          id="distPeople"
          value={people}
          names={{ ...names, assignable: scope.people }}
          onAdd={(u) => setPeople([...people, u])}
          onRemove={(u) => setPeople(people.filter((x) => x !== u))}
        />
      </div>
      <div className="field">
        <span className="flabel">How</span>
        <div className="seg" role="radiogroup" aria-label="Distribution">
          {DISTRIBUTE_MODES.map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? 'on' : ''}
              onClick={() => setMode(m)}
            >
              {m === 'balanced' ? 'Balance open work' : 'Round-robin'}
            </button>
          ))}
        </div>
        <span className="hint">
          {mode === 'balanced'
            ? 'Highest priority first, each to whoever has the least open work, counting what they already have.'
            : 'Highest priority first, one each in turn.'}{' '}
          Each task ends up with just the one person.
        </span>
      </div>
      <div className="field">
        <label htmlFor="distTeam">Team queue</label>
        <select id="distTeam" value={team} onChange={(e) => setTeam(e.target.value)}>
          <option value="keep">Keep each task’s team</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {people.length > 0 && (
        <table className="dealt" data-testid="distribute-preview">
          <thead>
            <tr>
              <th>Person</th>
              <th>Gets</th>
              <th>Already has open</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p}>
                <td>{names.user(p)}</td>
                <td>{deal.get(p)?.length ?? 0}</td>
                <td className="dimmer">{load.get(p) ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

function LabelsDialog({
  picked,
  onClose,
  onApply,
}: {
  picked: Task[];
  onClose(): void;
  onApply: ApplyFn;
}) {
  const [add, setAdd] = useState<string[]>([]);
  const [remove, setRemove] = useState<string[]>([]);
  const present = [...new Set(picked.flatMap((t) => t.labels))].sort();
  return (
    <Modal
      title={`Labels on ${plural(picked.length, 'task')}`}
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
            disabled={!add.length && !remove.length}
            onClick={() => onApply(labelOps(picked, add, remove), 'Labels updated')}
          >
            Apply
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="bulkAddLabel">Add</label>
        <LabelInput id="bulkAddLabel" value={add} onChange={setAdd} />
      </div>
      {present.length > 0 && (
        <div className="field">
          <span className="flabel">Remove</span>
          <div className="chiprow">
            {present.map((l) => (
              <button
                key={l}
                className={'fchip' + (remove.includes(l) ? ' on' : '')}
                aria-pressed={remove.includes(l)}
                onClick={() =>
                  setRemove(remove.includes(l) ? remove.filter((x) => x !== l) : [...remove, l])
                }
              >
                {l}
              </button>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function DueDialog({
  picked,
  onClose,
  onApply,
}: {
  picked: Task[];
  onClose(): void;
  onApply: ApplyFn;
}) {
  const [value, setValue] = useState('');
  return (
    <Modal
      title={`Due date for ${plural(picked.length, 'task')}`}
      narrow
      onClose={onClose}
      foot={
        <>
          <button
            className="btn ghost"
            onClick={() => onApply(patchOps(picked, { dueAt: '' }), 'Due dates cleared')}
          >
            Clear due dates
          </button>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn pri"
            disabled={!value}
            onClick={() =>
              onApply(patchOps(picked, { dueAt: fromLocalInput(value) }), 'Due dates set')
            }
          >
            Set
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="bulkDue">Due (UTC)</label>
        <input
          id="bulkDue"
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </div>
    </Modal>
  );
}
