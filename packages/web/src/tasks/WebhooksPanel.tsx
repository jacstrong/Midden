/**
 * Chat webhooks (Rocket.Chat incoming format) for task changes: a team's leads manage that
 * team's; admins also manage ones that hear about every task. The URL is a secret, so once
 * saved only its host and last few characters are shown, and editing keeps it unless a new one
 * is typed.
 */
import { useEffect, useState } from 'react';
import { WEBHOOK_EVENT_LABELS, WEBHOOK_EVENTS, type WebhookEvent } from '@midden/core';
import { api, ApiError } from '../lib/api';
import { Modal, ConfirmModal } from '../components/Modal';
import { toast } from '../store/useToasts';
import { fmtAgo } from './shared';

interface Delivery {
  id: string;
  event: string;
  status: 'pending' | 'ok' | 'failed';
  attempts: number;
  nextAttemptAt: string | null;
  lastStatus: number | null;
  lastError: string;
  createdAt: string;
  deliveredAt: string | null;
  payload: { text?: string };
}

interface Webhook {
  id: string;
  teamId: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  last: Delivery | null;
}

const DEFAULT_EVENTS: WebhookEvent[] = [
  'created',
  'done',
  'comment',
  'approval_requested',
  'overdue',
];

const statusLabel = (d: Delivery): string =>
  d.status === 'ok'
    ? `Delivered ${fmtAgo(d.deliveredAt ?? d.createdAt)}`
    : d.status === 'pending'
      ? `Retrying${d.nextAttemptAt ? ` ${fmtWhen(d.nextAttemptAt)}` : ''}: ${d.lastError}`
      : `Failed: ${d.lastError}`;

const fmtWhen = (iso: string): string => {
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (s <= 0) return 'now';
  if (s < 90) return `in ${s}s`;
  if (s < 5400) return `in ${Math.round(s / 60)}m`;
  return `in ${Math.round(s / 3600)}h`;
};

export function WebhooksPanel({
  teams,
  admin,
}: {
  /** Teams the person may add webhooks for. */
  teams: { id: string; name: string }[];
  admin: boolean;
}) {
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [allowed, setAllowed] = useState<string[] | null>(null);
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<Webhook | 'new' | null>(null);
  const [deleting, setDeleting] = useState<Webhook | null>(null);
  const [log, setLog] = useState<Webhook | null>(null);
  const [testing, setTesting] = useState('');
  const reload = (): void => setTick((t) => t + 1);

  useEffect(() => {
    let alive = true;
    api<{ webhooks: Webhook[]; allowedHosts: string[] }>('GET', '/api/webhooks')
      .then((r) => {
        if (!alive) return;
        setHooks(r.webhooks);
        setAllowed(r.allowedHosts);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tick]);

  const teamName = (id: string): string =>
    id ? (teams.find((t) => t.id === id)?.name ?? 'Deleted team') : 'Every team';

  const test = async (h: Webhook): Promise<void> => {
    setTesting(h.id);
    try {
      const { delivery } = await api<{ delivery: Delivery }>('POST', `/api/webhooks/${h.id}/test`);
      if (delivery.status === 'ok') toast(`Test message sent to ${h.name}`);
      else toast(`Test failed: ${delivery.lastError}`, 'bad');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Test failed', 'bad');
    } finally {
      setTesting('');
      reload();
    }
  };

  const toggle = async (h: Webhook): Promise<void> => {
    try {
      await api('PATCH', `/api/webhooks/${h.id}`, { enabled: !h.enabled });
      reload();
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Not saved', 'bad');
    }
  };

  if (allowed === null) return null;
  return (
    <section className="fs webhooks" data-testid="webhooks">
      <legend>Chat webhooks</legend>
      <p className="hint">
        Post task changes to a Rocket.Chat channel (Slack and Mattermost take the same format). A
        team’s webhook hears about tasks on that team or in its runs. Tasks in restricted cases are
        posted by number only.
      </p>
      {allowed.length === 0 ? (
        <p className="warn">
          Webhooks are turned off on this server. An administrator can allow chat hosts with{' '}
          <code>MIDDEN_WEBHOOK_ALLOWED_HOSTS</code>.
        </p>
      ) : (
        <p className="hint">Allowed hosts: {allowed.join(', ')}</p>
      )}
      {hooks.length > 0 && (
        <table className="tbl">
          <thead>
            <tr>
              <th>Webhook</th>
              <th>Team</th>
              <th>Sends</th>
              <th>Last delivery</th>
            </tr>
          </thead>
          <tbody>
            {hooks.map((h) => (
              <tr key={h.id} style={{ cursor: 'default' }} data-testid="webhook">
                <td className="whname">
                  <b>{h.name}</b>
                  <div className="dimmer mono">{h.url}</div>
                  <div className="whacts">
                    <button
                      className="btn sm ghost"
                      disabled={testing === h.id || !allowed.length}
                      onClick={() => void test(h)}
                    >
                      {testing === h.id ? 'Sending…' : 'Test'}
                    </button>
                    <button className="btn sm ghost" onClick={() => setLog(h)}>
                      Log
                    </button>
                    <button className="btn sm ghost" onClick={() => void toggle(h)}>
                      {h.enabled ? 'Pause' : 'Resume'}
                    </button>
                    <button className="btn sm ghost" onClick={() => setEditing(h)}>
                      Edit
                    </button>
                    <button className="btn sm ghost" onClick={() => setDeleting(h)}>
                      Delete
                    </button>
                  </div>
                </td>
                <td>{teamName(h.teamId)}</td>
                <td className="dimmer">
                  {h.events.map((e) => WEBHOOK_EVENT_LABELS[e]).join(', ')}
                </td>
                <td className={h.last?.status === 'ok' ? 'dimmer' : h.last ? 'warn' : 'dimmer'}>
                  {!h.enabled ? 'Paused' : h.last ? statusLabel(h.last) : 'Nothing sent yet'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <button
        className="btn sm"
        disabled={!allowed.length}
        onClick={() => setEditing('new')}
        data-testid="webhook-add"
      >
        + Webhook
      </button>
      {editing && (
        <WebhookDialog
          hook={editing === 'new' ? null : editing}
          teams={teams}
          admin={admin}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
      {log && <DeliveryLog hook={log} onClose={() => setLog(null)} />}
      {deleting && (
        <ConfirmModal
          title="Delete webhook"
          message={`Delete ${deleting.name}? Messages stop at once, and its delivery log goes with it.`}
          okLabel="Delete webhook"
          danger
          onOk={() => {
            const h = deleting;
            setDeleting(null);
            api('DELETE', `/api/webhooks/${h.id}`)
              .then(() => {
                toast('Webhook deleted');
                reload();
              })
              .catch((err: unknown) =>
                toast(err instanceof ApiError ? err.message : 'Not deleted', 'bad'),
              );
          }}
          onClose={() => setDeleting(null)}
        />
      )}
    </section>
  );
}

function WebhookDialog({
  hook,
  teams,
  admin,
  onClose,
  onSaved,
}: {
  hook: Webhook | null;
  teams: { id: string; name: string }[];
  admin: boolean;
  onClose(): void;
  onSaved(): void;
}) {
  const [name, setName] = useState(hook?.name ?? '');
  const [teamId, setTeamId] = useState(hook?.teamId ?? teams[0]?.id ?? '');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>(hook?.events ?? DEFAULT_EVENTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const problem = !name.trim()
    ? 'Give it a name'
    : !hook && !url.trim()
      ? 'Paste the webhook URL from the chat server'
      : !events.length
        ? 'Choose at least one thing to send'
        : '';

  const save = async (): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      if (hook)
        await api('PATCH', `/api/webhooks/${hook.id}`, {
          name: name.trim(),
          events,
          ...(url.trim() ? { url: url.trim() } : {}),
        });
      else
        await api('POST', '/api/webhooks', { name: name.trim(), teamId, url: url.trim(), events });
      toast(hook ? 'Webhook saved' : 'Webhook added');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Not saved');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={hook ? `Edit ${hook.name}` : 'New webhook'}
      narrow
      onClose={onClose}
      foot={
        <>
          <span className={error || problem ? 'warn' : 'dimmer'}>{error || problem}</span>
          <span className="sp" />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn pri"
            disabled={!!problem || busy}
            onClick={() => void save()}
            data-testid="webhook-save"
          >
            {hook ? 'Save' : 'Add webhook'}
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="whName">Name</label>
        <input
          id="whName"
          type="text"
          value={name}
          maxLength={80}
          placeholder="#host-cell"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      {!hook && (
        <div className="field">
          <label htmlFor="whTeam">Tasks from</label>
          <select id="whTeam" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            {admin && <option value="">Every team</option>}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="whUrl">Webhook URL</label>
        <input
          id="whUrl"
          type="url"
          value={url}
          autoComplete="off"
          spellCheck={false}
          placeholder={hook ? `${hook.url} (leave empty to keep)` : 'https://chat.example/hooks/…'}
          onChange={(e) => setUrl(e.target.value)}
        />
        <span className="hint">
          In Rocket.Chat: Administration → Integrations → New incoming webhook. Treat the URL like a
          password.
        </span>
      </div>
      <div className="field">
        <span className="flabel">Send</span>
        {WEBHOOK_EVENTS.map((e) => (
          <label className="ck" key={e}>
            <input
              type="checkbox"
              checked={events.includes(e)}
              onChange={(ev) =>
                setEvents(
                  ev.target.checked
                    ? WEBHOOK_EVENTS.filter((x) => x === e || events.includes(x))
                    : events.filter((x) => x !== e),
                )
              }
            />
            {WEBHOOK_EVENT_LABELS[e]}
          </label>
        ))}
      </div>
    </Modal>
  );
}

function DeliveryLog({ hook, onClose }: { hook: Webhook; onClose(): void }) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  useEffect(() => {
    api<{ deliveries: Delivery[] }>('GET', `/api/webhooks/${hook.id}/deliveries`)
      .then((r) => setRows(r.deliveries))
      .catch(() => setRows([]));
  }, [hook.id]);
  return (
    <Modal title={`${hook.name}: recent deliveries`} onClose={onClose}>
      {rows === null ? (
        <p className="hint">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="hint">Nothing sent yet.</p>
      ) : (
        <table className="tbl" data-testid="webhook-log">
          <thead>
            <tr>
              <th>When</th>
              <th>Message</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} style={{ cursor: 'default' }}>
                <td className="dimmer">{fmtAgo(d.createdAt)}</td>
                <td>{d.payload.text ?? d.event}</td>
                <td className={d.status === 'ok' ? 'dimmer' : 'warn'}>
                  {statusLabel(d)}
                  {d.attempts > 1 && ` (${d.attempts} attempts)`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}
