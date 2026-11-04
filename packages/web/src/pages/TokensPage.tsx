import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { toast } from '../store/useToasts';
import { HostedChrome } from '../components/HostedChrome';

interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scope: 'read' | 'write';
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

const when = (iso: string | null, none: string): string =>
  iso ? new Date(iso).toLocaleString() : none;

export function TokensPage() {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<ApiToken['scope']>('read');
  const [days, setDays] = useState('90');
  const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState('');

  const [tick, setTick] = useState(0);
  const load = (): void => setTick((t) => t + 1);
  useEffect(() => {
    let alive = true;
    api<{ tokens: ApiToken[] }>('GET', '/api/tokens')
      .then((r) => alive && setTokens(r.tokens))
      .catch((err: unknown) =>
        toast(err instanceof ApiError ? err.message : 'Could not load tokens', 'bad'),
      );
    return () => {
      alive = false;
    };
  }, [tick]);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ token: string; record: ApiToken }>('POST', '/api/tokens', {
        name,
        scope,
        ...(days ? { expiresInDays: Number(days) } : {}),
      });
      setFresh({ name: r.record.name, token: r.token });
      setName('');
      setScope('read');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the token');
    }
  };
  const revoke = async (t: ApiToken): Promise<void> => {
    try {
      await api('DELETE', `/api/tokens/${t.id}`);
      toast(`Revoked ${t.name}`);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not revoke the token', 'bad');
    }
  };

  return (
    <HostedChrome title="API tokens">
      <div className="view on" style={{ padding: 14 }}>
        <p style={{ marginTop: 0, maxWidth: '70ch' }}>
          Tokens let scripts and AI agents act as you, through the API or MCP. A token can never do
          more than you can. Anything it changes shows in the case history under its name.
        </p>
        <form className="fs" onSubmit={(e) => void create(e)} data-testid="new-token">
          <legend>New token</legend>
          <div className="grid3">
            <div className="field">
              <label htmlFor="ntName">Name</label>
              <input
                id="ntName"
                type="text"
                placeholder="triage-agent"
                value={name}
                maxLength={80}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="ntScope">Access</label>
              <select
                id="ntScope"
                value={scope}
                onChange={(e) => setScope(e.target.value as ApiToken['scope'])}
              >
                <option value="read">read only</option>
                <option value="write">read and write</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="ntDays">Expires</label>
              <div className="inline">
                <select id="ntDays" value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="30">in 30 days</option>
                  <option value="90">in 90 days</option>
                  <option value="365">in a year</option>
                  <option value="">never</option>
                </select>
                <button className="btn pri" type="submit" disabled={!name.trim()}>
                  Create
                </button>
              </div>
            </div>
          </div>
          {scope === 'write' && (
            <p style={{ margin: '8px 0 0', maxWidth: '70ch' }} data-testid="write-warning">
              Scan results and evidence contain text an attacker can influence. An agent with write
              access could be steered by what it reads, so give it write access only if you will
              review what it does.
            </p>
          )}
          <div className="err">{error}</div>
        </form>
        {fresh && (
          <div
            className="banner warn"
            style={{ margin: '0 0 14px', textTransform: 'none', letterSpacing: 0, fontSize: 12 }}
            data-testid="fresh-token"
          >
            Copy <b>{fresh.name}</b> now, it will not be shown again: <code>{fresh.token}</code>{' '}
            <button className="btn sm ghost" onClick={() => setFresh(null)}>
              dismiss
            </button>
          </div>
        )}
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Token</th>
              <th>Access</th>
              <th>Created</th>
              <th>Last used</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={{ cursor: 'default' }} data-testid="token-row">
                <td>
                  <b>{t.name}</b>
                </td>
                <td>
                  <code>{t.prefix}…</code>
                </td>
                <td>{t.scope === 'write' ? 'read and write' : 'read only'}</td>
                <td>{when(t.createdAt, '')}</td>
                <td>{when(t.lastUsedAt, 'never')}</td>
                <td>{when(t.expiresAt, 'never')}</td>
                <td>
                  <button className="btn sm ghost" onClick={() => void revoke(t)}>
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </HostedChrome>
  );
}
