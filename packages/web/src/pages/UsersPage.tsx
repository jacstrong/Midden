import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type SessionUser } from '../lib/api';
import { useSession } from '../store/useSession';
import { toast } from '../store/useToasts';
import { HostedChrome } from '../components/HostedChrome';

export function UsersPage() {
  const me = useSession((s) => s.user);
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<SessionUser['role']>('analyst');
  const [temp, setTemp] = useState<{ username: string; password: string } | null>(null);
  const [error, setError] = useState('');

  const [tick, setTick] = useState(0);
  const load = (): void => setTick((t) => t + 1);
  useEffect(() => {
    let alive = true;
    api<{ users: SessionUser[] }>('GET', '/api/users')
      .then((r) => alive && setUsers(r.users))
      .catch((err: unknown) =>
        toast(err instanceof ApiError ? err.message : 'Could not load users', 'bad'),
      );
    return () => {
      alive = false;
    };
  }, [tick]);

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ user: SessionUser; temporaryPassword?: string }>('POST', '/api/users', {
        username,
        displayName,
        role,
      });
      setTemp({ username: r.user.username, password: r.temporaryPassword ?? '' });
      setUsername('');
      setDisplayName('');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create user');
    }
  };
  const patch = async (u: SessionUser, body: object, msg: string): Promise<void> => {
    try {
      await api('PATCH', `/api/users/${u.id}`, body);
      toast(msg);
      load();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Update failed', 'bad');
    }
  };
  const reset = async (u: SessionUser): Promise<void> => {
    const pw = crypto
      .getRandomValues(new Uint8Array(9))
      .reduce((s, b) => s + b.toString(36).padStart(2, '0'), '')
      .slice(0, 14);
    await patch(u, { password: pw }, 'Password reset');
    setTemp({ username: u.username, password: pw });
  };

  return (
    <HostedChrome title="Users">
      <div className="view on" style={{ padding: 14 }}>
        <form className="fs" onSubmit={(e) => void create(e)} data-testid="new-user">
          <legend>Add user</legend>
          <div className="grid3">
            <div className="field">
              <label htmlFor="nuName">Username</label>
              <input
                id="nuName"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nuDisplay">Display name</label>
              <input
                id="nuDisplay"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="nuRole">Role</label>
              <div className="inline">
                <select
                  id="nuRole"
                  value={role}
                  onChange={(e) => setRole(e.target.value as SessionUser['role'])}
                >
                  <option value="analyst">analyst</option>
                  <option value="viewer">viewer</option>
                  <option value="admin">admin</option>
                </select>
                <button className="btn pri" type="submit" disabled={!username.trim()}>
                  Add
                </button>
              </div>
            </div>
          </div>
          <div className="err">{error}</div>
        </form>
        {temp && (
          <div
            className="banner warn"
            style={{ margin: '0 0 14px', textTransform: 'none', letterSpacing: 0, fontSize: 12 }}
            data-testid="temp-password"
          >
            One-time password for <b>{temp.username}</b>: <code>{temp.password}</code> — they must
            change it at first sign-in.{' '}
            <button className="btn sm ghost" onClick={() => setTemp(null)}>
              dismiss
            </button>
          </div>
        )}
        <table className="tbl">
          <thead>
            <tr>
              <th>Username</th>
              <th>Display name</th>
              <th>Role</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ cursor: 'default' }} data-testid="user-row">
                <td>
                  <b>{u.username}</b>
                  {u.id === me?.id && (
                    <span className="tag" style={{ marginLeft: 6 }}>
                      you
                    </span>
                  )}
                </td>
                <td>{u.displayName}</td>
                <td>
                  <select
                    value={u.role}
                    disabled={u.id === me?.id}
                    onChange={(e) => void patch(u, { role: e.target.value }, 'Role updated')}
                  >
                    <option value="admin">admin</option>
                    <option value="analyst">analyst</option>
                    <option value="viewer">viewer</option>
                  </select>
                </td>
                <td style={{ color: u.disabled ? 'var(--rd)' : 'var(--gr)' }}>
                  {u.disabled
                    ? 'disabled'
                    : u.mustChangePassword
                      ? 'must change password'
                      : 'active'}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {u.id !== me?.id && (
                    <>
                      <button
                        className="btn sm ghost"
                        onClick={() =>
                          void patch(
                            u,
                            { disabled: !u.disabled },
                            u.disabled ? 'User enabled' : 'User disabled',
                          )
                        }
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>{' '}
                      <button className="btn sm ghost" onClick={() => void reset(u)}>
                        Reset password
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </HostedChrome>
  );
}
