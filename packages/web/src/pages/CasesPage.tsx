import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type CaseSummary } from '../lib/api';
import { useRoute } from '../lib/router';
import { useSession } from '../store/useSession';
import { toast } from '../store/useToasts';
import { HostedChrome } from '../components/HostedChrome';

export function CasesPage() {
  const navigate = useRoute((s) => s.navigate);
  const route = useRoute((s) => s.route);
  const user = useSession((s) => s.user);
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  const [archived, setArchived] = useState(false);
  const [name, setName] = useState('');
  const [number, setNumber] = useState('');
  const [error, setError] = useState('');

  const [tick, setTick] = useState(0);
  const load = (): void => setTick((t) => t + 1);
  useEffect(() => {
    let alive = true;
    api<{ cases: CaseSummary[] }>('GET', `/api/cases?archived=${archived ? 1 : 0}`)
      .then((r) => alive && setCases(r.cases))
      .catch((err: unknown) =>
        toast(err instanceof ApiError ? err.message : 'Could not load cases', 'bad'),
      );
    return () => {
      alive = false;
    };
  }, [archived, tick, route]);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ case: CaseSummary }>('POST', '/api/cases', { name, number });
      navigate({ kind: 'case', caseId: r.case.id, view: 'graph' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create case');
    }
  };

  const toggleArchive = async (c: CaseSummary): Promise<void> => {
    await api('PATCH', `/api/cases/${c.id}`, { archived: !c.archivedAt });
    toast(c.archivedAt ? 'Case restored' : 'Case archived');
    load();
  };

  return (
    <HostedChrome title="Cases">
      <div className="view on" style={{ padding: 14 }}>
        <div className="toolbar">
          <div className="seg">
            <button className={archived ? '' : 'on'} onClick={() => setArchived(false)}>
              Active
            </button>
            <button className={archived ? 'on' : ''} onClick={() => setArchived(true)}>
              Archived
            </button>
          </div>
          <span className="sp" />
          <span style={{ color: 'var(--dim)', fontSize: 10, letterSpacing: '.14em' }}>
            {cases ? `${cases.length} CASES` : 'LOADING'}
          </span>
          <button className="btn ghost" onClick={load} data-testid="refresh-cases">
            Refresh
          </button>
        </div>
        {user?.role !== 'viewer' && !archived && (
          <form
            className="fs"
            onSubmit={(e) => void create(e)}
            style={{ marginBottom: 16 }}
            data-testid="new-case"
          >
            <legend>New investigation</legend>
            <div className="grid3">
              <div className="field span2">
                <label htmlFor="ncName">Name</label>
                <input
                  id="ncName"
                  type="text"
                  value={name}
                  placeholder="Operation Glasshouse"
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="ncNumber">Case number</label>
                <div className="inline">
                  <input
                    id="ncNumber"
                    type="text"
                    value={number}
                    placeholder="IR-2026-0142"
                    onChange={(e) => setNumber(e.target.value)}
                  />
                  <button className="btn pri" type="submit" disabled={!name.trim()}>
                    Create
                  </button>
                </div>
              </div>
            </div>
            <div className="err">{error}</div>
          </form>
        )}
        {cases && cases.length === 0 && (
          <div className="empty">
            <b>{archived ? 'No archived cases' : 'No cases yet'}</b>
            <p>
              {archived
                ? 'Archived cases appear here.'
                : 'Create the first investigation above, or ask an analyst to add you to one.'}
            </p>
          </div>
        )}
        {cases && cases.length > 0 && (
          <table className="tbl">
            <thead>
              <tr>
                <th>Case</th>
                <th>Number</th>
                <th>Hosts</th>
                <th>Events</th>
                <th>Access</th>
                <th>Last change</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => navigate({ kind: 'case', caseId: c.id, view: 'graph' })}
                  data-testid="case-row"
                >
                  <td>
                    <b>{c.name}</b>
                    {c.restricted && (
                      <span className="tag" style={{ marginLeft: 6, color: 'var(--am)' }}>
                        restricted
                      </span>
                    )}
                  </td>
                  <td style={{ color: 'var(--am)' }}>{c.number || '—'}</td>
                  <td>{c.hosts}</td>
                  <td>{c.events}</td>
                  <td>{c.access.role ?? '—'}</td>
                  <td className="ts">{c.modifiedAt.replace('T', ' ').slice(0, 19)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {c.access.manage && (
                      <button
                        className="btn sm ghost"
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleArchive(c);
                        }}
                      >
                        {c.archivedAt ? 'Restore' : 'Archive'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </HostedChrome>
  );
}
