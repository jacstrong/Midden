import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { useRoute } from '../lib/router';
import { useSession } from '../store/useSession';
import { toast } from '../store/useToasts';
import { HostedChrome } from '../components/HostedChrome';
import { ConfirmModal } from '../components/Modal';
import { useTasks } from '../tasks/TaskStore';
import { WebhooksPanel } from '../tasks/WebhooksPanel';

interface Team {
  id: string;
  name: string;
  description: string;
  members: { userId: string; role: 'lead' | 'member'; username: string; displayName: string }[];
}

/** Admins create teams and choose leads; a lead adds and removes their team's members. */
export function TeamsPage() {
  const me = useSession((s) => s.user);
  const users = useTasks((s) => s.directory.users);
  const navigate = useRoute((s) => s.navigate);
  const [teams, setTeams] = useState<Team[]>([]);
  const [tick, setTick] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [deleting, setDeleting] = useState<Team | null>(null);
  const admin = me?.role === 'admin';
  const reload = (): void => setTick((t) => t + 1);
  const led = teams.filter((t) => t.members.some((m) => m.userId === me?.id && m.role === 'lead'));

  useEffect(() => {
    let alive = true;
    api<{ teams: Team[] }>('GET', '/api/teams')
      .then((r) => alive && setTeams(r.teams))
      .catch((err: unknown) =>
        toast(err instanceof ApiError ? err.message : 'Could not load teams', 'bad'),
      );
    return () => {
      alive = false;
    };
  }, [tick]);

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    try {
      await fn();
      if (ok) toast(ok);
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'That didn’t work', 'bad');
    }
  };
  const create = (e: FormEvent): void => {
    e.preventDefault();
    void run(async () => {
      await api('POST', '/api/teams', { name, description });
      setName('');
      setDescription('');
    }, 'Team created');
  };

  return (
    <HostedChrome title="Teams">
      <div className="view on" style={{ padding: 14, maxWidth: 1100 }}>
        <div className="toolbar">
          <button
            className="btn ghost"
            onClick={() => navigate({ kind: 'tasks', viewId: 'queues', taskNum: null })}
          >
            ← Team queues
          </button>
        </div>
        {admin && (
          <form className="fs" onSubmit={create} data-testid="new-team">
            <legend>New team</legend>
            <div className="grid3">
              <div className="field">
                <label htmlFor="tmName">Name</label>
                <input
                  id="tmName"
                  type="text"
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Host analysis"
                />
              </div>
              <div className="field span2">
                <label htmlFor="tmDesc">Description</label>
                <div className="inline">
                  <input
                    id="tmDesc"
                    type="text"
                    value={description}
                    maxLength={500}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What this cell covers"
                  />
                  <button className="btn pri" type="submit" disabled={!name.trim()}>
                    Create
                  </button>
                </div>
              </div>
            </div>
          </form>
        )}
        {!teams.length && (
          <p className="empty">
            {admin ? 'No teams yet. Create one above.' : 'No teams yet. An admin creates them.'}
          </p>
        )}
        <div className="teamgrid">
          {teams.map((t) => {
            const lead = admin || t.members.some((m) => m.userId === me?.id && m.role === 'lead');
            const outside = users.filter(
              (u) => !u.disabled && !t.members.some((m) => m.userId === u.id),
            );
            return (
              <section key={t.id} className="teamcard" data-testid="team">
                <header>
                  <h3>{t.name}</h3>
                  <span className="dimmer">
                    {t.members.length} {t.members.length === 1 ? 'member' : 'members'}
                  </span>
                  <span className="sp" />
                  {admin && (
                    <button className="btn sm ghost" onClick={() => setDeleting(t)}>
                      Delete
                    </button>
                  )}
                </header>
                {t.description && <p className="hint">{t.description}</p>}
                <table className="tbl">
                  <tbody>
                    {t.members.map((m) => (
                      <tr key={m.userId} style={{ cursor: 'default' }}>
                        <td>
                          <b>{m.displayName}</b> <span className="dimmer">{m.username}</span>
                        </td>
                        <td>
                          {admin ? (
                            <select
                              aria-label={`Role of ${m.displayName}`}
                              value={m.role}
                              onChange={(e) =>
                                void run(() =>
                                  api('PUT', `/api/teams/${t.id}/members/${m.userId}`, {
                                    role: e.target.value,
                                  }),
                                )
                              }
                            >
                              <option value="member">member</option>
                              <option value="lead">lead</option>
                            </select>
                          ) : (
                            <span className={m.role === 'lead' ? 'tag' : 'dimmer'}>{m.role}</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {lead && (admin || m.role !== 'lead') && (
                            <button
                              className="btn sm ghost"
                              onClick={() =>
                                void run(() =>
                                  api('DELETE', `/api/teams/${t.id}/members/${m.userId}`),
                                )
                              }
                            >
                              Remove
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {lead && outside.length > 0 && (
                  <div className="inline" style={{ marginTop: 8 }}>
                    <select
                      aria-label={`Add someone to ${t.name}`}
                      value=""
                      onChange={(e) =>
                        e.target.value &&
                        void run(
                          () =>
                            api('PUT', `/api/teams/${t.id}/members/${e.target.value}`, {
                              role: 'member',
                            }),
                          'Member added',
                        )
                      }
                    >
                      <option value="">+ add a member…</option>
                      {outside.map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.displayName} ({u.username})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </section>
            );
          })}
        </div>
        {(admin || led.length > 0) && <WebhooksPanel teams={admin ? teams : led} admin={admin} />}
      </div>
      {deleting && (
        <ConfirmModal
          title="Delete team"
          message={`Delete ${deleting.name}? Its tasks keep the team name as “Deleted team”, and its shared views go with it.`}
          okLabel="Delete team"
          danger
          onOk={() => {
            const t = deleting;
            setDeleting(null);
            void run(() => api('DELETE', `/api/teams/${t.id}`), 'Team deleted');
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </HostedChrome>
  );
}
