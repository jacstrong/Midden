/**
 * Export tasks as CSV in the import format. Relative due dates (offsets from the run's start)
 * make the file a playbook for the next hunt; absolute ones keep a record of this one.
 */
import { useState } from 'react';
import type { Task } from '@midden/core';
import { Modal } from '../components/Modal';
import { toast } from '../store/useToasts';
import { csvName, downloadCsv, tasksCsv } from './csvExport';
import { useTasks } from './TaskStore';

export function ExportDialog({
  title,
  tasks,
  runId,
  fileBase,
  onClose,
}: {
  title: string;
  tasks: Task[];
  /** When every task is in one run, due dates can be written relative to its start. */
  runId?: string | undefined;
  fileBase?: string | undefined;
  onClose(): void;
}) {
  const state = useTasks((s) => s.state);
  const dir = useTasks((s) => s.directory);
  const run = runId && state ? state.runs[runId] : undefined;
  const [relative, setRelative] = useState(false);
  const [comments, setComments] = useState(false);
  const [stateCols, setStateCols] = useState(true);
  const go = (): void => {
    if (!state) return;
    const csv = tasksCsv(state, dir, tasks, {
      relativeToRun: relative ? run?.id : undefined,
      comments,
      stateColumns: stateCols,
    });
    downloadCsv(csvName(fileBase ?? run?.name ?? 'tasks'), csv);
    toast(`Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'}`);
    onClose();
  };
  return (
    <Modal
      title={title}
      narrow
      onClose={onClose}
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn pri" onClick={go} disabled={!tasks.length} data-testid="export-go">
            Download CSV
          </button>
        </>
      }
    >
      <p className="hint">
        The file uses the import format, so it can be imported again later. Tasks you can’t see are
        never included.
      </p>
      <div className="field">
        <span className="flabel">Due dates</span>
        <label className="ck">
          <input
            type="radio"
            name="exDue"
            checked={!relative}
            onChange={() => setRelative(false)}
          />
          As dates (UTC)
        </label>
        <label className="ck">
          <input
            type="radio"
            name="exDue"
            checked={relative}
            disabled={!run}
            onChange={() => setRelative(true)}
          />
          As offsets from the run’s start, like <code>+2d</code>
        </label>
        {!run && <span className="hint">Offsets need every task to be in one run.</span>}
      </div>
      <div className="field">
        <label className="ck">
          <input
            type="checkbox"
            checked={stateCols}
            onChange={(e) => setStateCols(e.target.checked)}
          />
          Include the record columns (T-number, created, completed, approval)
        </label>
        <label className="ck">
          <input
            type="checkbox"
            checked={comments}
            onChange={(e) => setComments(e.target.checked)}
          />
          Include comments
        </label>
      </div>
    </Modal>
  );
}
