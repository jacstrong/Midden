/**
 * Edit a workflow's statuses: names, the category each counts as, colour, WIP limit and board
 * order. Used for the default workflow (admins), a run's own copy (its team's leads) and a
 * playbook's (stored with the playbook, applied to runs started from it).
 *
 * Removing a status that tasks sit on asks where they go instead, and the save moves them in
 * the same op, so the board never shows a task on a status that no longer exists.
 */
import { useState } from 'react';
import {
  categoryLabel,
  uid,
  workflowIdFor,
  STATUS_CATEGORIES,
  type StatusCategory,
  type TaskOp,
  type TaskState,
  type Workflow,
  type WorkflowStatus,
} from '@midden/core';
import { Modal } from '../components/Modal';
import { CATEGORY_COLOR } from './shared';

export interface WorkflowSave {
  statuses: WorkflowStatus[];
  /** Removed status id → the status its tasks move to. */
  remap: Record<string, string>;
}

/** The op that saves a workflow in the task log and moves tasks off removed statuses. */
export function workflowSaveOp(state: TaskState, wf: Workflow, save: WorkflowSave): TaskOp {
  const ops: TaskOp[] = [{ type: 'workflow.set', workflow: { ...wf, statuses: save.statuses } }];
  for (const t of Object.values(state.tasks)) {
    const to = save.remap[t.statusId];
    if (to && workflowIdFor(state, t.runId) === wf.id)
      ops.push({ type: 'task.set', id: t.id, patch: { statusId: to } });
  }
  return ops.length === 1 ? ops[0]! : { type: 'batch', ops };
}

/** How many tasks sit on each status of a workflow. */
export function statusUse(state: TaskState, wfId: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of Object.values(state.tasks))
    if (workflowIdFor(state, t.runId) === wfId) out.set(t.statusId, (out.get(t.statusId) ?? 0) + 1);
  return out;
}

interface Row extends WorkflowStatus {
  /** Not saved yet, so no task can be on it. */
  fresh?: boolean;
}

export function WorkflowEditor({
  title,
  statuses,
  inUse,
  readOnly,
  note,
  onSave,
  onClose,
}: {
  title: string;
  statuses: WorkflowStatus[];
  /** Tasks on each status; omit for a playbook's workflow, which no task uses yet. */
  inUse?: Map<string, number> | undefined;
  readOnly?: boolean;
  note?: string;
  onSave(s: WorkflowSave): void;
  onClose(): void;
}) {
  const [rows, setRows] = useState<Row[]>(() => statuses.map((s) => ({ ...s })));
  const [remap, setRemap] = useState<Record<string, string>>({});
  const tasksOn = (id: string): number => inUse?.get(id) ?? 0;
  const removed = statuses.filter((s) => !rows.some((r) => r.id === s.id));
  const set = (i: number, patch: Partial<Row>): void =>
    setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const swap = (i: number, j: number): void => {
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setRows(next);
  };
  const add = (): void =>
    setRows([
      ...rows,
      { id: uid('st'), name: '', category: 'in_progress', color: '', wipLimit: null, fresh: true },
    ]);
  const remove = (i: number): void => {
    const r = rows[i]!;
    setRows(rows.filter((_, j) => j !== i));
    if (!r.fresh && tasksOn(r.id)) {
      // Default to another status of the same category, else the first one left.
      const left = rows.filter((_, j) => j !== i);
      const to = left.find((x) => x.category === r.category) ?? left[0];
      if (to) setRemap({ ...remap, [r.id]: to.id });
    }
  };

  const names = rows.map((r) => r.name.trim().toLowerCase());
  const problem = !rows.length
    ? 'A workflow needs at least one status'
    : names.some((n) => !n)
      ? 'Every status needs a name'
      : new Set(names).size !== names.length
        ? 'Two statuses have the same name'
        : !rows.some((r) => r.category === 'done')
          ? 'Add a status that counts as done, so tasks can be finished'
          : removed.some((s) => tasksOn(s.id) && !rows.some((r) => r.id === remap[s.id]))
            ? 'Choose where the tasks on removed statuses go'
            : '';

  const save = (): void => {
    const out: WorkflowStatus[] = rows.map(({ fresh: _fresh, ...r }) => ({
      ...r,
      name: r.name.trim(),
    }));
    const used: Record<string, string> = {};
    for (const s of removed) if (tasksOn(s.id) && remap[s.id]) used[s.id] = remap[s.id]!;
    onSave({ statuses: out, remap: used });
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={
        <>
          <span className={problem ? 'warn' : 'dimmer'}>{problem}</span>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </button>
          {!readOnly && (
            <button className="btn pri" disabled={!!problem} onClick={save} data-testid="wf-save">
              Save workflow
            </button>
          )}
        </>
      }
    >
      {note && <p className="hint">{note}</p>}
      <table className="wftable" data-testid="wf-table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Status</th>
            <th>Counts as</th>
            <th>Colour</th>
            <th title="Work-in-progress limit shown on the board column">WIP limit</th>
            {inUse && <th>Tasks</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id}>
              <td className="wforder">
                <button
                  className="btn sm ghost"
                  aria-label={`Move ${r.name || 'status'} up`}
                  disabled={readOnly || i === 0}
                  onClick={() => swap(i, i - 1)}
                >
                  ↑
                </button>
                <button
                  className="btn sm ghost"
                  aria-label={`Move ${r.name || 'status'} down`}
                  disabled={readOnly || i === rows.length - 1}
                  onClick={() => swap(i, i + 1)}
                >
                  ↓
                </button>
              </td>
              <td>
                <input
                  type="text"
                  aria-label="Status name"
                  value={r.name}
                  maxLength={200}
                  disabled={readOnly}
                  onChange={(e) => set(i, { name: e.target.value })}
                />
              </td>
              <td>
                <select
                  aria-label={`Category for ${r.name || 'status'}`}
                  value={r.category}
                  disabled={readOnly}
                  onChange={(e) => set(i, { category: e.target.value as StatusCategory })}
                >
                  {STATUS_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {categoryLabel(c)}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <div className="wfcolor">
                  <input
                    type="color"
                    aria-label={`Colour for ${r.name || 'status'}`}
                    value={/^#[0-9a-f]{6}$/i.test(r.color) ? r.color : '#888888'}
                    disabled={readOnly}
                    onChange={(e) => set(i, { color: e.target.value })}
                    style={{ opacity: r.color ? 1 : 0.35 }}
                  />
                  {r.color ? (
                    !readOnly && (
                      <button className="btn sm ghost" onClick={() => set(i, { color: '' })}>
                        default
                      </button>
                    )
                  ) : (
                    <span
                      className="stdot"
                      title="Uses its category's colour"
                      style={{ ['--cc' as string]: CATEGORY_COLOR[r.category] }}
                    />
                  )}
                </div>
              </td>
              <td>
                <input
                  type="number"
                  min={1}
                  max={999}
                  aria-label={`WIP limit for ${r.name || 'status'}`}
                  placeholder="none"
                  value={r.wipLimit ?? ''}
                  disabled={readOnly}
                  onChange={(e) => {
                    const n = Math.floor(Number(e.target.value));
                    set(i, { wipLimit: e.target.value && n > 0 ? n : null });
                  }}
                />
              </td>
              {inUse && <td className="dimmer">{tasksOn(r.id)}</td>}
              <td>
                {!readOnly && (
                  <button
                    className="btn sm ghost"
                    aria-label={`Remove ${r.name || 'status'}`}
                    onClick={() => remove(i)}
                  >
                    ✕
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <button className="btn sm" onClick={add}>
          + Status
        </button>
      )}
      {removed.some((s) => tasksOn(s.id)) && (
        <div className="wfremaps">
          <span className="flabel">Tasks on removed statuses</span>
          {removed
            .filter((s) => tasksOn(s.id))
            .map((s) => (
              <label key={s.id} className="inline">
                <span>
                  {tasksOn(s.id)} on <b>{s.name}</b> move to
                </span>
                <select
                  value={remap[s.id] ?? ''}
                  onChange={(e) => setRemap({ ...remap, [s.id]: e.target.value })}
                >
                  <option value="">Choose…</option>
                  {rows
                    .filter((r) => r.name.trim())
                    .map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                </select>
              </label>
            ))}
        </div>
      )}
    </Modal>
  );
}
