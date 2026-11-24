/**
 * Import tasks from a playbook or a CSV file, into a new run or an existing one. The server
 * previews every change (`?preview=1`) with the same checks the real import runs, so what the
 * table shows is what gets created; status names the run's workflow lacks can be added here.
 * The import is one op: undoing it from history takes the whole run back out.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  categoryLabel,
  MAX_PLAYBOOK_BYTES,
  STATUS_CATEGORIES,
  type ImportIssue,
  type StatusCategory,
} from '@midden/core';
import { Modal } from '../components/Modal';
import { api, ApiError } from '../lib/api';
import { toast } from '../store/useToasts';
import { useTasks } from './TaskStore';
import { fmtDue, fromLocalInput, toLocalInput, useNames, CATEGORY_COLOR } from './shared';

export interface PlaybookSummary {
  id: string;
  name: string;
  description: string;
  teamId: string;
  statuses: { id: string; name: string; category: StatusCategory }[] | null;
  version: number;
  rows: number;
  updatedAt: string;
}

interface PreviewTask {
  line: number;
  key: string;
  title: string;
  status: string;
  category: StatusCategory;
  priority: string;
  assignees: string[];
  team: string;
  labels: string[];
  dueAt: string;
  blockedBy: string[];
  checklist: number;
  approver: string;
  case: string;
}
interface Preview {
  ok: boolean;
  issues: ImportIssue[];
  unknownStatuses: string[];
  workflow: { name: string; statuses: { name: string; category: StatusCategory }[] };
  tasks: PreviewTask[];
}

/** Playbooks from the server; a lead sees them all but can only start runs for their teams. */
export function usePlaybooks(tick = 0): PlaybookSummary[] | null {
  const [list, setList] = useState<PlaybookSummary[] | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ playbooks: PlaybookSummary[] }>('GET', '/api/playbooks')
      .then((r) => alive && setList(r.playbooks))
      .catch(() => alive && setList([]));
    return () => {
      alive = false;
    };
  }, [tick]);
  return list;
}

export function ImportWizard({
  runId: initialRun,
  playbookId: initialPlaybook,
  onClose,
  onDone,
}: {
  runId?: string | undefined;
  playbookId?: string | undefined;
  onClose(): void;
  onDone(runId: string): void;
}) {
  const state = useTasks((s) => s.state);
  const teams = useTasks((s) => s.directory.teams);
  const names = useNames();
  const playbooks = usePlaybooks();
  const myTeams = teams.filter((t) => names.isAdmin || names.ledTeams.has(t.id));

  const [source, setSource] = useState<'playbook' | 'file'>(initialRun ? 'file' : 'playbook');
  const [playbookId, setPlaybookId] = useState(initialPlaybook ?? '');
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [target, setTarget] = useState<'new' | 'existing'>(initialRun ? 'existing' : 'new');
  const [runId, setRunId] = useState(initialRun ?? '');
  const [runName, setRunName] = useState('');
  const [teamId, setTeamId] = useState(myTeams.length === 1 ? myTeams[0]!.id : '');
  const [start, setStart] = useState(() => toLocalInput(new Date().toISOString()));
  const [adds, setAdds] = useState<Record<string, StatusCategory>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const pb = playbooks?.find((p) => p.id === playbookId);
  // A new run takes the playbook's name and team until the user types their own.
  const [namedFor, setNamedFor] = useState('');
  if (pb && namedFor !== pb.id) {
    setNamedFor(pb.id);
    // A name typed while this loaded wins over the suggestion.
    setRunName((n) => n || `${pb.name} ${new Date().toISOString().slice(0, 10)}`);
    if (pb.teamId && myTeams.some((t) => t.id === pb.teamId)) setTeamId(pb.teamId);
  }
  const openRuns = Object.values(state?.runs ?? {}).filter(
    (r) => !r.closed && (names.isAdmin || (r.teamId && names.ledTeams.has(r.teamId))),
  );

  const body = useMemo(() => {
    const src = source === 'playbook' ? (playbookId ? { playbookId } : null) : csv ? { csv } : null;
    const into =
      target === 'existing'
        ? runId
          ? { runId }
          : null
        : runName.trim()
          ? { run: { name: runName.trim(), teamId, startDate: fromLocalInput(start) } }
          : null;
    if (!src || !into) return null;
    return {
      ...src,
      ...into,
      addStatuses: Object.entries(adds).map(([name, category]) => ({ name, category })),
    };
  }, [source, playbookId, csv, target, runId, runName, teamId, start, adds]);

  // Preview whenever the choices settle.
  const key = JSON.stringify(body);
  useEffect(() => {
    if (!body) return;
    let alive = true;
    const t = setTimeout(() => {
      api<Preview>('POST', '/api/tasks/import?preview=1', body)
        .then((p) => {
          if (!alive) return;
          setPreview(p);
          setProblem('');
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setPreview(null);
          setProblem(err instanceof ApiError ? err.message : 'Could not check the import');
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` stands for `body`
  }, [key]);

  const readFile = async (f: File | undefined): Promise<void> => {
    if (!f) return;
    if (f.size > MAX_PLAYBOOK_BYTES) {
      toast('That file is larger than 2 MB', 'bad');
      return;
    }
    setFileName(f.name);
    setCsv(await f.text());
    setRunName((n) => n || f.name.replace(/\.csv$/i, ''));
  };

  const create = async (): Promise<void> => {
    if (!body) return;
    setBusy(true);
    try {
      const r = await api<{ run: { id: string; name: string }; created: number }>(
        'POST',
        '/api/tasks/import',
        body,
      );
      toast(`Imported ${r.created} task${r.created === 1 ? '' : 's'} into ${r.run.name}`);
      onDone(r.run.id);
    } catch (err) {
      setProblem(err instanceof ApiError ? err.message : 'The import failed');
    } finally {
      setBusy(false);
    }
  };

  const errors = preview?.issues.filter((i) => i.severity === 'error') ?? [];
  const warnings = preview?.issues.filter((i) => i.severity === 'warning') ?? [];
  const shown = body && preview ? preview : null;
  // Once chosen, a status is in the previewed workflow; keep it listed so the choice can be undone.
  const statusNames = [...new Set([...(shown?.unknownStatuses ?? []), ...Object.keys(adds)])];

  return (
    <Modal
      title="Import tasks"
      onClose={onClose}
      foot={
        <>
          <span className="dimmer">
            {shown
              ? `${shown.tasks.length} task${shown.tasks.length === 1 ? '' : 's'}` +
                (errors.length ? ` · ${errors.length} to fix` : '')
              : ''}
          </span>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn pri"
            disabled={!shown?.ok || busy}
            onClick={() => void create()}
            data-testid="import-go"
          >
            {target === 'new' ? 'Start run' : 'Add tasks'}
          </button>
        </>
      }
    >
      <div className="impgrid">
        <div className="field">
          <span className="flabel">From</span>
          <div className="seg" role="radiogroup" aria-label="Import from">
            <button
              role="radio"
              aria-checked={source === 'playbook'}
              className={source === 'playbook' ? 'on' : ''}
              onClick={() => setSource('playbook')}
            >
              A playbook
            </button>
            <button
              role="radio"
              aria-checked={source === 'file'}
              className={source === 'file' ? 'on' : ''}
              onClick={() => setSource('file')}
            >
              A CSV file
            </button>
          </div>
          {source === 'playbook' ? (
            <select
              aria-label="Playbook"
              value={playbookId}
              onChange={(e) => setPlaybookId(e.target.value)}
              data-testid="import-playbook"
            >
              <option value="">Choose a playbook…</option>
              {(playbooks ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.rows} tasks{p.teamId ? ` · ${names.team(p.teamId)}` : ''}
                </option>
              ))}
            </select>
          ) : (
            <>
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file"
                onChange={(e) => void readFile(e.target.files?.[0])}
                data-testid="import-file"
              />
              {fileName && <span className="hint">{fileName}</span>}
              <span className="hint">
                Columns: key, title, description, status, priority, assignees, team, labels, due,
                blocked_by, checklist, approver, case. Only title is required.
              </span>
            </>
          )}
          {source === 'playbook' && playbooks?.length === 0 && (
            <span className="hint">
              No playbooks yet. Save one on the Playbooks &amp; runs page.
            </span>
          )}
        </div>

        <div className="field">
          <span className="flabel">Into</span>
          <div className="seg" role="radiogroup" aria-label="Import into">
            <button
              role="radio"
              aria-checked={target === 'new'}
              className={target === 'new' ? 'on' : ''}
              onClick={() => setTarget('new')}
            >
              A new run
            </button>
            <button
              role="radio"
              aria-checked={target === 'existing'}
              className={target === 'existing' ? 'on' : ''}
              onClick={() => setTarget('existing')}
              disabled={!openRuns.length}
            >
              An open run
            </button>
          </div>
          {target === 'new' ? (
            <div className="impnew">
              <label>
                <span className="dimmer">Name</span>
                <input
                  type="text"
                  value={runName}
                  maxLength={200}
                  onChange={(e) => setRunName(e.target.value)}
                  data-testid="import-run-name"
                />
              </label>
              <label>
                <span className="dimmer">Team</span>
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)}>
                  {names.isAdmin && <option value="">No team</option>}
                  {!names.isAdmin && !teamId && <option value="">Choose…</option>}
                  {myTeams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span className="dimmer">Starts (UTC)</span>
                <input
                  type="datetime-local"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
            </div>
          ) : (
            <select aria-label="Run" value={runId} onChange={(e) => setRunId(e.target.value)}>
              <option value="">Choose a run…</option>
              {openRuns.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <span className="hint">Due dates like +2d count from the run’s start.</span>
        </div>
      </div>

      {problem && (
        <div className="banner bad" role="alert">
          {problem}
        </div>
      )}

      {shown && statusNames.length > 0 && (
        <div className="impstatuses">
          <strong>Statuses not in “{shown.workflow.name}”</strong>
          {statusNames.map((n) => (
            <label key={n} className="inline">
              <span>
                Add <b>{n}</b> as
              </span>
              <select
                aria-label={`Category for status ${n}`}
                value={adds[n] ?? ''}
                onChange={(e) => {
                  const next = { ...adds };
                  if (e.target.value) next[n] = e.target.value as StatusCategory;
                  else delete next[n];
                  setAdds(next);
                }}
              >
                <option value="">Don’t add</option>
                {STATUS_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {categoryLabel(c)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}

      {shown && (errors.length > 0 || warnings.length > 0) && (
        <ul className="impissues" data-testid="import-issues">
          {[...errors, ...warnings].map((i, n) => (
            <li key={n} className={i.severity}>
              {i.line ? <span className="dimmer">Line {i.line}: </span> : null}
              {i.message}
            </li>
          ))}
        </ul>
      )}

      {shown && shown.tasks.length > 0 && (
        <div className="imptable" data-testid="import-preview">
          <table>
            <thead>
              <tr>
                <th>Line</th>
                <th>Title</th>
                <th>Status</th>
                <th>Priority</th>
                <th>Assignees</th>
                <th>Due (UTC)</th>
                <th>Blocked by</th>
                <th>Checklist</th>
                <th>Approver</th>
              </tr>
            </thead>
            <tbody>
              {shown.tasks.map((t) => {
                const bad = errors.some((e) => e.line === t.line);
                return (
                  <tr key={t.key} className={bad ? 'bad' : ''}>
                    <td className="dimmer">{t.line}</td>
                    <td>
                      {t.title}
                      {t.labels.map((l) => (
                        <span key={l} className="tag lbl">
                          {l}
                        </span>
                      ))}
                    </td>
                    <td>
                      <span
                        className="stdot"
                        style={{ ['--cc' as string]: CATEGORY_COLOR[t.category] }}
                      />
                      {t.status}
                    </td>
                    <td>{t.priority}</td>
                    <td>
                      {t.assignees.join(', ') || (
                        <span className="dimmer">{t.team ? `${t.team} queue` : '—'}</span>
                      )}
                    </td>
                    <td>{t.dueAt ? fmtDue(t.dueAt) : '—'}</td>
                    <td>{t.blockedBy.join(', ')}</td>
                    <td>{t.checklist || ''}</td>
                    <td>{t.approver}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!body && <p className="hint">Choose what to import and where it goes.</p>}
    </Modal>
  );
}
