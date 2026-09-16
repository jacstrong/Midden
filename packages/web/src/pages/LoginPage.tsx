import { useEffect, useState, type FormEvent } from 'react';
import { useSession } from '../store/useSession';
import { api, ApiError } from '../lib/api';

export function LoginPage() {
  const login = useSession((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<{ enabled: boolean; issuer: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ enabled: boolean; issuer: string | null }>('GET', '/api/auth/oidc/enabled')
      .then((r) => alive && setSso(r))
      .catch(() => alive && setSso({ enabled: false, issuer: null }));
    return () => {
      alive = false;
    };
  }, []);
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" style={{ alignItems: 'center' }}>
      <form className="modal narrow" onSubmit={(e) => void submit(e)} data-testid="login">
        <div className="mhead">
          <div className="brand">
            <i className="dot" />
            <b>MIDDEN</b>
            <span>Sign in</span>
          </div>
        </div>
        <div className="mbody">
          <div className="field">
            <label htmlFor="lUser">Username</label>
            <input
              id="lUser"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="lPass">Password</label>
            <input
              id="lPass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="err" data-testid="login-error">
            {error}
          </div>
        </div>
        <div className="mfoot">
          {sso?.enabled && (
            <a
              className="btn"
              href={`/api/auth/oidc/start?next=${encodeURIComponent(location.hash || '#/cases')}`}
              title={sso.issuer ?? undefined}
              data-testid="sso-login"
            >
              Sign in with SSO
            </a>
          )}
          <span className="sp" />
          <button className="btn pri" type="submit" disabled={busy || !username || !password}>
            Sign in
          </button>
        </div>
      </form>
    </div>
  );
}
