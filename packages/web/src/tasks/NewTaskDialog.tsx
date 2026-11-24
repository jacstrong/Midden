import { useState } from 'react';
import {
  firstStatusIn,
  uid,
  workflowIdFor,
  TASK_PRIORITIES,
  type NewTask,
  type TaskOp,
  type TaskPriority,
} from '@midden/core';
import { Modal } from '../components/Modal';
import { useTasks } from './TaskStore';
import { fromLocalInput, openTask, useNames, useTaskUi, type TaskPrefill } from './shared';
import {
  CaseSelect,
  LabelInput,
  PeoplePicker,
  RunSelect,
  StatusSelect,
  TeamSelect,
} from './pickers';

/** Mounted wherever tasks can be created (task pages, case shell); opens from `useTaskUi`. */
export function NewTaskHost() {
  const creating = useTaskUi((s) => s.creating);
  const close = useTaskUi((s) => s.closeCreate);
  const ready = useTasks((s) => !!s.state);
  if (!creating || !ready) return null;
  return <NewTaskDialog prefill={creating} onClose={close} />;
}

function NewTaskDialog({ prefill, onClose }: { prefill: TaskPrefill; onClose: () => void }) {
  const state = useTasks((s) => s.state)!;
  const dispatch = useTasks((s) => s.dispatch);
  const names = useNames();
  const [title, setTitle] = useState(prefill.title ?? '');
  const [description, setDescription] = useState('');
  const [runId, setRunId] = useState(prefill.runId ?? '');
  const wf = state.workflows[workflowIdFor(state, runId)];
  const [statusId, setStatusId] = useState(
    prefill.statusId ?? (wf && (firstStatusIn(wf, 'todo') ?? wf.statuses[0])?.id) ?? '',
  );
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [teamId, setTeamId] = useState(prefill.teamId ?? '');
  const [assignees, setAssignees] = useState<string[]>(prefill.assignees ?? []);
  const [caseId, setCaseId] = useState(prefill.caseId ?? '');
  const [due, setDue] = useState('');
  const [labels, setLabels] = useState<string[]>([]);
  const [approverId, setApproverId] = useState('');
  const [busy, setBusy] = useState(false);

  const changeRun = (r: string): void => {
    setRunId(r);
    const next = state.workflows[workflowIdFor(state, r)];
    if (next && !next.statuses.some((s) => s.id === statusId))
      setStatusId((firstStatusIn(next, 'todo') ?? next.statuses[0])?.id ?? '');
  };

  const create = async (another: boolean): Promise<void> => {
    if (!title.trim()) return;
    setBusy(true);
    const id = uid('tk');
    const task: NewTask = {
      id,
      title: title.trim(),
      description,
      statusId,
      priority,
      runId,
      labels,
      dueAt: fromLocalInput(due),
      caseId,
      hostId: prefill.hostId ?? '',
      eventId: prefill.eventId ?? '',
      assignees,
      teamId,
    };
    const ops: TaskOp[] = [{ type: 'task.add', task }];
    if (approverId) ops.push({ type: 'approval.set', taskId: id, approverId });
    const r = await dispatch(ops.length === 1 ? ops[0]! : { type: 'batch', ops });
    setBusy(false);
    if (!r.ok) return;
    if (another) {
      setTitle('');
      setDescription('');
      return;
    }
    onClose();
    const made = useTasks.getState().state?.tasks[id];
    if (made && !prefill.caseId) openTask(made.num);
  };

  return (
    <Modal
      title="New task"
      onClose={onClose}
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || !title.trim()}
            onClick={() => void create(true)}
          >
            Create &amp; add another
          </button>
          <button
            className="btn pri"
            disabled={busy || !title.trim()}
            onClick={() => void create(false)}
            data-testid="task-create"
          >
            Create task
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void create(false);
        }}
      >
        <div className="field">
          <label htmlFor="ntTitle">Title</label>
          <input
            id="ntTitle"
            type="text"
            value={title}
            maxLength={300}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Sweep DNS logs for beaconing"
          />
        </div>
        <div className="field">
          <label htmlFor="ntDesc">Description</label>
          <textarea
            id="ntDesc"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Plain text. T-12 links a task; @username mentions someone."
          />
        </div>
        <div className="grid3">
          <div className="field">
            <label htmlFor="ntRun">Run</label>
            <RunSelect id="ntRun" value={runId} onChange={changeRun} state={state} />
          </div>
          <div className="field">
            <label htmlFor="ntStatus">Status</label>
            <StatusSelect id="ntStatus" value={statusId} onChange={setStatusId} workflow={wf} />
          </div>
          <div className="field">
            <label htmlFor="ntPri">Priority</label>
            <select
              id="ntPri"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ntTeam">Team queue</label>
            <TeamSelect id="ntTeam" value={teamId} onChange={setTeamId} />
          </div>
          <div className="field span2">
            <label htmlFor="ntWho">Assignees</label>
            <PeoplePicker
              id="ntWho"
              names={names}
              value={assignees}
              onAdd={(u) => setAssignees([...assignees, u])}
              onRemove={(u) => setAssignees(assignees.filter((x) => x !== u))}
            />
          </div>
          <div className="field">
            <label htmlFor="ntDue">Due (UTC)</label>
            <input
              id="ntDue"
              type="datetime-local"
              value={due}
              onChange={(e) => setDue(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ntCase">Case</label>
            <CaseSelect id="ntCase" value={caseId} onChange={setCaseId} />
          </div>
          <div className="field">
            <label htmlFor="ntApprover">Approver</label>
            <select
              id="ntApprover"
              value={approverId}
              onChange={(e) => setApproverId(e.target.value)}
            >
              <option value="">None</option>
              {names.active.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
            </select>
          </div>
          <div className="field span3">
            <label htmlFor="ntLabels">Labels</label>
            <LabelInput id="ntLabels" value={labels} onChange={setLabels} />
          </div>
        </div>
        {(prefill.hostId || prefill.eventId) && (
          <p className="hint">
            Linked to the {prefill.eventId ? 'event' : 'host'} you started from.
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
