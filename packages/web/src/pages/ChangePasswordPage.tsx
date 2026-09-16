import { useState, type FormEvent } from 'react';
import { useSession } from '../store/useSession';
import { useRoute } from '../lib/router';
import { ApiError } from '../lib/api';
import { toast } from '../store/useToasts';

export function ChangePasswordPage() {
  const { mustChangePassword, changePassword } = useSession();
  const navigate = useRoute((s) => s.navigate);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (next !== again) return setError('The two new passwords differ');
    if (next.length < 10) return setError('Use at least 10 characters');
    try {
      await changePassword(mustChangePassword ? undefined : current, next);
      toast('Password changed');
      navigate({ kind: 'cases' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password');
    }
  };
  return (
    <div className="overlay" style={{ alignItems: 'center' }}>
      <form className="modal narrow" onSubmit={(e) => void submit(e)} data-testid="password-form">
        <div className="mhead">
          <h3>{mustChangePassword ? 'Set a new password' : 'Change password'}</h3>
        </div>
        <div className="mbody">
          {mustChangePassword && (
            <p style={{ color: 'var(--am)', marginTop: 0 }}>
              Your password was set by an administrator. Choose your own before continuing.
            </p>
          )}
          {!mustChangePassword && (
            <div className="field">
              <label htmlFor="pCur">Current password</label>
              <input
                id="pCur"
                type="password"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="pNext">New password</label>
            <input
              id="pNext"
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              autoFocus
            />
          </div>
          <div className="field">
            <label htmlFor="pAgain">New password again</label>
            <input
              id="pAgain"
              type="password"
              autoComplete="new-password"
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </div>
          <div className="err">{error}</div>
        </div>
        <div className="mfoot">
          {!mustChangePassword && (
            <button className="btn ghost" type="button" onClick={() => navigate({ kind: 'cases' })}>
              Cancel
            </button>
          )}
          <span className="sp" />
          <button className="btn pri" type="submit">
            Save password
          </button>
        </div>
      </form>
    </div>
  );
}
