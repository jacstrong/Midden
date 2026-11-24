/**
 * #/playbooks: the playbooks a team runs at the start of each hunt, the runs started from them,
 * and the default workflow.
 *
 * - Leads keep their teams' playbooks; admins keep all of them, including ones for every team.
 * - A run can be opened as a board, added to, exported, saved as the next playbook, given its
 *   own statuses, and closed (closed runs leave the live boards but stay in exports).
 */
import { useEffect, useState } from 'react';
import {
  STATUS_CATEGORIES,
  categoryLabel,
  type StatusCategory,
  type TaskRun,
  type WorkflowStatus,
} from '@midden/core';
import { HostedChrome } from '../components/HostedChrome';
import { ConfirmModal, Modal } from '../components/Modal';
import { api, ApiError } from '../lib/api';
import { useRoute } from '../lib/router';
import { toast } from '../store/useToasts';
import { csvName, downloadCsv } from '../tasks/csvExport';
import { ImportWizard, usePlaybooks, type PlaybookSummary } from '../tasks/ImportWizard';
import { useTasks } from '../tasks/TaskStore';
import { CATEGORY_COLOR, fmtZulu, useNames } from '../tasks/shared';
import { statusUse, workflowSaveOp, WorkflowEditor } from '../tasks/WorkflowEditor';

interface RunRow extends TaskRun {
  counts: Record<StatusCategory, number>;
  total: number;
}

type Editing =
  | { kind: 'playbook'; playbook: PlaybookSummary | null }
  | { kind: 'pbWorkflow'; playbook: PlaybookSummary }
  | { kind: 'runWorkflow'; run: RunRow }
  | { kind: 'defaultWorkflow' }
  | { kind: 'saveRun'; run: RunRow }
  | { kind: 'deletePlaybook'; playbook: PlaybookSummary }
  | { kind: 'closeRun'; run: RunRow }
  | { kind: 'import'; playbookId?: string; runId?: string }
  | null;

const err = (e: unknown, fallback: string): string =>
  e instanceof ApiError ? e.message : fallback;

export function PlaybooksPage() {
  const names = useNames();
  const state = useTasks((s) => s.state);
  const seq = useTasks((s) => s.seq);
  const dispatch = useTasks((s) => s.dispatch);
  const navigate = useRoute((s) => s.navigate);
  const [tick, setTick] = useState(0);
  const reload = (): void => setTick((t) => t + 1);
  const playbooks = usePlaybooks(tick);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [showClosed, setShowClosed] = useState(false);

  // Runs come from the server so closed ones (not in the live state) show too; refresh as
  // the task log moves.
  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api<{ runs: RunRow[] }>('GET', '/api/task-runs')
        .then((r) => alive && setRuns(r.runs))
        .catch(() => alive && setRuns([]));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [seq, tick]);

  const leads = (teamId: string): boolean =>
    names.isAdmin || (!!teamId && names.ledTeams.has(teamId));
  const mayStart = names.isAdmin || names.ledTeams.size > 0;
  const defaultWf = state?.workflows[state.defaultWorkflowId];
  const shownRuns = (runs ?? []).filter((r) => showClosed || !r.closed);

  const downloadPlaybook = async (p: PlaybookSummary): Promise<void> => {
    try {
      const r = await api<{ playbook: { csv: string } }>('GET', `/api/playbooks/${p.id}`);
      downloadCsv(csvName(p.name), r.playbook.csv);
    } catch (e) {
      toast(err(e, 'Could not download the playbook'), 'bad');
    }
  };
  const setRunClosed = async (run: RunRow, closed: boolean): Promise<void> => {
    try {
      await api('PATCH', `/api/task-runs/${run.id}`, { closed });
      toast(closed ? `Closed ${run.name}` : `Reopened ${run.name}`);
      reload();
    } catch (e) {
      toast(err(e, 'Could not change the run'), 'bad');
    }
  };

  return (
    <HostedChrome title="Playbooks & runs">
      <div className="view on pbpage" style={{ padding: 14, maxWidth: 1200 }}>
        <div className="toolbar">
          <button
            className="btn ghost"
            onClick={() => navigate({ kind: 'tasks', viewId: 'queues', taskNum: null })}
          >
            ← Tasks
          </button>
          <span className="sp" />
          {mayStart && (
            <button className="btn" onClick={() => setEditing({ kind: 'import' })}>
              Import CSV…
            </button>
          )}
          {mayStart && (
            <button
              className="btn pri"
              onClick={() => setEditing({ kind: 'playbook', playbook: null })}
              data-testid="pb-new"
            >
              + Playbook
            </button>
          )}
        </div>

        <h2>Playbooks</h2>
        {playbooks === null ? (
          <p className="hint">Loading…</p>
        ) : playbooks.length === 0 ? (
          <p className="hint">
            No playbooks yet. A playbook is the task list a team runs at the start of each hunt,
            kept as a CSV.{' '}
            {mayStart ? 'Add one, or save a finished run as one.' : 'Team leads add them.'}
          </p>
        ) : (
          <table className="tbl pbtable" data-testid="pb-table">
            <thead>
              <tr>
                <th>Playbook</th>
                <th>Team</th>
                <th>Tasks</th>
                <th>Workflow</th>
                <th>Version</th>
                <th>Updated (UTC)</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {playbooks.map((p) => {
                const own = leads(p.teamId) || (!p.teamId && names.isAdmin);
                return (
                  <tr key={p.id} data-testid="pb-row">
                    <td>
                      <b>{p.name}</b>
                      {p.description && <div className="hint">{p.description}</div>}
                    </td>
                    <td>
                      {p.teamId ? names.team(p.teamId) : <span className="dimmer">Every team</span>}
                    </td>
                    <td>{p.rows}</td>
                    <td>
                      {p.statuses ? (
                        <StatusStrip statuses={p.statuses} />
                      ) : (
                        <span className="dimmer">Default</span>
                      )}
                    </td>
                    <td>v{p.version}</td>
                    <td className="dimmer">{fmtZulu(p.updatedAt)}</td>
                    <td className="acts">
                      {mayStart && (p.teamId ? leads(p.teamId) : true) && (
                        <button
                          className="btn sm pri"
                          onClick={() => setEditing({ kind: 'import', playbookId: p.id })}
                        >
                          Start run
                        </button>
                      )}
                      <button className="btn sm" onClick={() => void downloadPlaybook(p)}>
                        CSV
                      </button>
                      {own && (
                        <>
                          <button
                            className="btn sm"
                            onClick={() => setEditing({ kind: 'playbook', playbook: p })}
                          >
                            Edit
                          </button>
                          <button
                            className="btn sm"
                            onClick={() => setEditing({ kind: 'pbWorkflow', playbook: p })}
                          >
                            Workflow
                          </button>
                          <button
                            className="btn sm ghost"
                            onClick={() => setEditing({ kind: 'deletePlaybook', playbook: p })}
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <div className="toolbar" style={{ marginTop: 18 }}>
          <h2 style={{ margin: 0 }}>Runs</h2>
          <span className="sp" />
          <label className="ck">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
            />
            <span className="dimmer">Show closed runs</span>
          </label>
        </div>
        {runs === null ? (
          <p className="hint">Loading…</p>
        ) : shownRuns.length === 0 ? (
          <p className="hint">
            No {showClosed ? '' : 'open '}runs. Start one from a playbook or a CSV.
          </p>
        ) : (
          <table className="tbl runtable" data-testid="run-table">
            <thead>
              <tr>
                <th>Run</th>
                <th>Team</th>
                <th>Started (UTC)</th>
                <th>Progress</th>
                <th>From</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shownRuns.map((r) => {
                const own = leads(r.teamId);
                const finished = r.counts.done + r.counts.cancelled;
                return (
                  <tr key={r.id} className={r.closed ? 'closed' : ''} data-testid="run-row">
                    <td>
                      <a
                        href={`#/tasks/run:${r.id}`}
                        onClick={(e) => {
                          if (r.closed) {
                            e.preventDefault();
                            toast('Reopen the run to see it on a board; its CSV is still here.');
                          }
                        }}
                      >
                        <b>{r.name}</b>
                      </a>
                      {r.closed && <span className="tag">closed</span>}
                    </td>
                    <td>{r.teamId ? names.team(r.teamId) : '—'}</td>
                    <td className="dimmer">{fmtZulu(r.startDate)}</td>
                    <td>
                      <Progress counts={r.counts} total={r.total} />
                      <span className="dimmer">
                        {finished}/{r.total}
                      </span>
                    </td>
                    <td className="dimmer">
                      {r.playbookId
                        ? (playbooks?.find((p) => p.id === r.playbookId)?.name ??
                          'a deleted playbook')
                        : 'CSV / by hand'}
                    </td>
                    <td className="acts">
                      {own && !r.closed && (
                        <button
                          className="btn sm"
                          onClick={() => setEditing({ kind: 'import', runId: r.id })}
                        >
                          Add tasks
                        </button>
                      )}
                      <a
                        className="btn sm"
                        href={`/api/tasks/export?run=${encodeURIComponent(r.id)}&archived=include`}
                        download
                      >
                        CSV
                      </a>
                      {own && (
                        <>
                          <button
                            className="btn sm"
                            onClick={() => setEditing({ kind: 'saveRun', run: r })}
                          >
                            Save as playbook
                          </button>
                          <button
                            className="btn sm"
                            disabled={!state?.workflows[r.workflowId]}
                            onClick={() => setEditing({ kind: 'runWorkflow', run: r })}
                          >
                            Workflow
                          </button>
                          {r.closed ? (
                            <button
                              className="btn sm ghost"
                              onClick={() => void setRunClosed(r, false)}
                            >
                              Reopen
                            </button>
                          ) : (
                            <button
                              className="btn sm ghost"
                              onClick={() => setEditing({ kind: 'closeRun', run: r })}
                            >
                              Close
                            </button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        <h2 style={{ marginTop: 18 }}>Default workflow</h2>
        <p className="hint">
          Tasks outside runs use it, and new runs start with a copy of it unless their playbook has
          its own.
        </p>
        {defaultWf && (
          <div className="inline">
            <StatusStrip statuses={defaultWf.statuses} />
            <button
              className="btn sm"
              onClick={() => setEditing({ kind: 'defaultWorkflow' })}
              data-testid="wf-default-edit"
            >
              {names.isAdmin ? 'Edit' : 'View'}
            </button>
          </div>
        )}
      </div>

      {editing?.kind === 'import' && (
        <ImportWizard
          playbookId={editing.playbookId}
          runId={editing.runId}
          onClose={() => setEditing(null)}
          onDone={(runId) => {
            setEditing(null);
            navigate({ kind: 'tasks', viewId: `run:${runId}`, taskNum: null });
          }}
        />
      )}
      {editing?.kind === 'playbook' && (
        <PlaybookDialog
          playbook={editing.playbook}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {editing?.kind === 'pbWorkflow' && defaultWf && (
        <WorkflowEditor
          title={`Workflow for “${editing.playbook.name}”`}
          statuses={(editing.playbook.statuses as WorkflowStatus[] | null) ?? defaultWf.statuses}
          note={
            editing.playbook.statuses
              ? 'Runs started from this playbook get a copy of these statuses. Runs already started keep theirs.'
              : 'This playbook uses the default workflow. Saving gives it its own copy, which runs started from it will use.'
          }
          onClose={() => setEditing(null)}
          onSave={({ statuses }) => {
            void api('PATCH', `/api/playbooks/${editing.playbook.id}`, { statuses })
              .then(() => {
                toast('Playbook workflow saved');
                setEditing(null);
                reload();
              })
              .catch((e: unknown) => toast(err(e, 'Could not save the workflow'), 'bad'));
          }}
        />
      )}
      {(editing?.kind === 'runWorkflow' || editing?.kind === 'defaultWorkflow') &&
        state &&
        (() => {
          const wf =
            editing.kind === 'runWorkflow'
              ? state.workflows[editing.run.workflowId]
              : state.workflows[state.defaultWorkflowId];
          if (!wf) return null;
          const readOnly = editing.kind === 'defaultWorkflow' && !names.isAdmin;
          return (
            <WorkflowEditor
              title={
                editing.kind === 'runWorkflow'
                  ? `Workflow for ${editing.run.name}`
                  : 'Default workflow'
              }
              statuses={wf.statuses}
              inUse={statusUse(state, wf.id)}
              readOnly={readOnly}
              note={
                editing.kind === 'runWorkflow'
                  ? 'Only this run uses these statuses.'
                  : 'Changes apply to tasks outside runs and to runs started from now on.'
              }
              onClose={() => setEditing(null)}
              onSave={(save) => {
                void dispatch(workflowSaveOp(state, wf, save)).then((r) => {
                  if (r.ok) {
                    toast('Workflow saved');
                    setEditing(null);
                  } else if (r.error?.startsWith('Offline')) toast(r.error, 'bad');
                });
              }}
            />
          );
        })()}
      {editing?.kind === 'saveRun' && (
        <SaveRunDialog
          run={editing.run}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {editing?.kind === 'deletePlaybook' && (
        <ConfirmModal
          title="Delete playbook"
          message={`Delete “${editing.playbook.name}”? Runs started from it keep their tasks. Download its CSV first if you may want it again.`}
          okLabel="Delete"
          danger
          onClose={() => setEditing(null)}
          onOk={() => {
            const p = editing.playbook;
            setEditing(null);
            void api('DELETE', `/api/playbooks/${p.id}`)
              .then(() => {
                toast(`Deleted ${p.name}`);
                reload();
              })
              .catch((e: unknown) => toast(err(e, 'Could not delete the playbook'), 'bad'));
          }}
        />
      )}
      {editing?.kind === 'closeRun' && (
        <ConfirmModal
          title="Close run"
          message={`Close “${editing.run.name}”? Its tasks leave the boards but stay in exports and history, and you can reopen it.`}
          okLabel="Close run"
          onClose={() => setEditing(null)}
          onOk={() => {
            const r = editing.run;
            setEditing(null);
            void setRunClosed(r, true);
          }}
        />
      )}
    </HostedChrome>
  );
}

function StatusStrip({
  statuses,
}: {
  statuses: { id: string; name: string; category: StatusCategory; color?: string }[];
}) {
  return (
    <span className="ststrip">
      {statuses.map((s) => (
        <span key={s.id} className="stchip" title={categoryLabel(s.category)}>
          <span
            className="stdot"
            style={{ ['--cc' as string]: s.color || CATEGORY_COLOR[s.category] }}
          />
          {s.name}
        </span>
      ))}
    </span>
  );
}

function Progress({ counts, total }: { counts: Record<StatusCategory, number>; total: number }) {
  return (
    <span
      className="runbar"
      role="img"
      aria-label={STATUS_CATEGORIES.map((c) => `${counts[c]} ${categoryLabel(c)}`).join(', ')}
    >
      {total > 0 &&
        STATUS_CATEGORIES.filter((c) => counts[c]).map((c) => (
          <span
            key={c}
            style={{ flexGrow: counts[c], background: CATEGORY_COLOR[c] }}
            title={`${counts[c]} ${categoryLabel(c)}`}
          />
        ))}
    </span>
  );
}

function PlaybookDialog({
  playbook,
  onClose,
  onSaved,
}: {
  playbook: PlaybookSummary | null;
  onClose(): void;
  onSaved(): void;
}) {
  const names = useNames();
  const teams = useTasks((s) => s.directory.teams).filter(
    (t) => names.isAdmin || names.ledTeams.has(t.id),
  );
  const [name, setName] = useState(playbook?.name ?? '');
  const [description, setDescription] = useState(playbook?.description ?? '');
  const [teamId, setTeamId] = useState(
    playbook?.teamId ?? (teams.length === 1 ? teams[0]!.id : ''),
  );
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = name.trim() && (playbook || csv) && (teamId || names.isAdmin);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        description,
        teamId,
        ...(csv !== null ? { csv } : {}),
      };
      if (playbook) await api('PATCH', `/api/playbooks/${playbook.id}`, body);
      else await api('POST', '/api/playbooks', body);
      toast(playbook ? 'Playbook saved' : 'Playbook added');
      onSaved();
    } catch (e) {
      toast(err(e, 'Could not save the playbook'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={playbook ? `Edit ${playbook.name}` : 'New playbook'}
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
            disabled={!ready || busy}
            onClick={() => void save()}
            data-testid="pb-save"
          >
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="pbName">Name</label>
        <input
          id="pbName"
          type="text"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="pbTeam">Team</label>
        <select id="pbTeam" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          {names.isAdmin && <option value="">Every team</option>}
          {!names.isAdmin && !teamId && <option value="">Choose…</option>}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="pbDesc">Description</label>
        <textarea
          id="pbDesc"
          rows={2}
          value={description}
          maxLength={2000}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="pbFile">{playbook ? 'Replace the CSV' : 'CSV'}</label>
        <input
          id="pbFile"
          type="file"
          accept=".csv,text/csv"
          data-testid="pb-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setFileName(f.name);
            void f.text().then((t) => {
              setCsv(t);
              if (!name.trim()) setName(f.name.replace(/\.csv$/i, ''));
            });
          }}
        />
        {fileName && <span className="hint">{fileName}</span>}
        <span className="hint">
          The import format: key, title, description, status, priority, assignees, team, labels, due
          (a date, or +1d from the run’s start), blocked_by, checklist, approver, case.
        </span>
      </div>
    </Modal>
  );
}

function SaveRunDialog({
  run,
  onClose,
  onSaved,
}: {
  run: RunRow;
  onClose(): void;
  onSaved(): void;
}) {
  const names = useNames();
  const teams = useTasks((s) => s.directory.teams).filter(
    (t) => names.isAdmin || names.ledTeams.has(t.id),
  );
  const [name, setName] = useState(run.name);
  const [teamId, setTeamId] = useState(run.teamId);
  const [keepAssignees, setKeepAssignees] = useState(false);
  const [keepStatus, setKeepStatus] = useState(false);
  const save = async (): Promise<void> => {
    try {
      const r = await api<{ playbook: { name: string }; skipped: number }>(
        'POST',
        `/api/task-runs/${run.id}/playbook`,
        { name: name.trim(), teamId, keepAssignees, keepStatus },
      );
      toast(
        `Saved playbook ${r.playbook.name}` +
          (r.skipped
            ? ` (${r.skipped} task${r.skipped === 1 ? '' : 's'} in restricted cases left out)`
            : ''),
      );
      onSaved();
    } catch (e) {
      toast(err(e, 'Could not save the playbook'), 'bad');
    }
  };
  return (
    <Modal
      title={`Save ${run.name} as a playbook`}
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
            onClick={() => void save()}
            data-testid="saverun-go"
          >
            Save playbook
          </button>
        </>
      }
    >
      <p className="hint">
        Due dates become offsets from the run’s start, and the run’s statuses become the playbook’s
        workflow. Case links are dropped, and tasks linked to a restricted case are left out, since
        the whole team can read a playbook.
      </p>
      <div className="field">
        <label htmlFor="srName">Name</label>
        <input
          id="srName"
          type="text"
          value={name}
          maxLength={200}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="srTeam">Team</label>
        <select id="srTeam" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
          {names.isAdmin && <option value="">Every team</option>}
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      <label className="ck">
        <input
          type="checkbox"
          checked={keepAssignees}
          onChange={(e) => setKeepAssignees(e.target.checked)}
        />
        Keep who each task is assigned to
      </label>
      <label className="ck">
        <input
          type="checkbox"
          checked={keepStatus}
          onChange={(e) => setKeepStatus(e.target.checked)}
        />
        Keep statuses and ticked checklist items (otherwise everything starts at To do)
      </label>
    </Modal>
  );
}
