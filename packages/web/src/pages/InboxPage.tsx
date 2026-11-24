/**
 * Every notification, and the preferences that decide which ones arrive. Being assigned,
 * @mentioned or asked to approve always notifies; the grid covers the rest.
 */
import { useEffect, useState } from 'react';
import {
  GRID_KINDS,
  NOTIFY_KIND_LABELS,
  NOTIFY_RELATIONS,
  NOTIFY_RELATION_LABELS,
  type NotifyPrefs,
  type NotifyPrefsPatch,
} from '@midden/core';
import { HostedChrome } from '../components/HostedChrome';
import { api, ApiError } from '../lib/api';
import { useRoute } from '../lib/router';
import { toast } from '../store/useToasts';
import { NotificationItem, useOpenNotification } from '../tasks/Bell';
import { useInbox } from '../tasks/inbox';

export function InboxPage({ tab }: { tab: 'inbox' | 'prefs' }) {
  const navigate = useRoute((s) => s.navigate);
  return (
    <HostedChrome title="Notifications">
      <div className="view on inboxpage" style={{ padding: 14, maxWidth: 900 }}>
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === 'inbox'}
            className={`tab${tab === 'inbox' ? ' on' : ''}`}
            onClick={() => navigate({ kind: 'inbox', tab: 'inbox' })}
          >
            Inbox
          </button>
          <button
            role="tab"
            aria-selected={tab === 'prefs'}
            className={`tab${tab === 'prefs' ? ' on' : ''}`}
            onClick={() => navigate({ kind: 'inbox', tab: 'prefs' })}
            data-testid="tab-prefs"
          >
            Preferences
          </button>
        </div>
        {tab === 'inbox' ? <Inbox /> : <Prefs />}
      </div>
    </HostedChrome>
  );
}

function Inbox() {
  const items = useInbox((s) => s.items);
  const unread = useInbox((s) => s.unread);
  const more = useInbox((s) => s.more);
  const load = useInbox((s) => s.load);
  const loadMore = useInbox((s) => s.loadMore);
  const markAll = useInbox((s) => s.markAll);
  const open = useOpenNotification();
  const [onlyUnread, setOnlyUnread] = useState(false);
  useEffect(() => {
    void load();
  }, [load]);
  const shown = onlyUnread ? items.filter((n) => !n.read) : items;
  return (
    <>
      <div className="toolbar">
        <label className="ck">
          <input
            type="checkbox"
            checked={onlyUnread}
            onChange={(e) => setOnlyUnread(e.target.checked)}
          />
          Unread only
        </label>
        <span className="dimmer">{unread} unread</span>
        <span className="sp" />
        <button className="btn sm" disabled={!unread} onClick={() => void markAll()}>
          Mark all read
        </button>
      </div>
      <div className="nlist page" data-testid="inbox">
        {shown.length === 0 ? (
          <p className="hint">{onlyUnread ? 'All caught up.' : 'No notifications yet.'}</p>
        ) : (
          shown.map((n) => <NotificationItem key={n.id} n={n} onOpen={open} />)
        )}
      </div>
      {more && (
        <button className="btn sm ghost" onClick={() => void loadMore()}>
          Older notifications
        </button>
      )}
    </>
  );
}

function Prefs() {
  const [prefs, setPrefs] = useState<NotifyPrefs | null>(null);
  const [defaults, setDefaults] = useState<NotifyPrefs | null>(null);
  useEffect(() => {
    api<{ prefs: NotifyPrefs; defaults: NotifyPrefs }>('GET', '/api/notifications/prefs')
      .then((r) => {
        setPrefs(r.prefs);
        setDefaults(r.defaults);
      })
      .catch(() => toast('Could not load your preferences', 'bad'));
  }, []);
  if (!prefs || !defaults) return <p className="hint">Loading…</p>;

  const save = (patch: NotifyPrefsPatch, optimistic: NotifyPrefs): void => {
    const before = prefs;
    setPrefs(optimistic);
    api<{ prefs: NotifyPrefs }>('PATCH', '/api/notifications/prefs', patch)
      .then((r) => setPrefs(r.prefs))
      .catch((err: unknown) => {
        setPrefs(before);
        toast(err instanceof ApiError ? err.message : 'Not saved', 'bad');
      });
  };

  return (
    <div className="prefs">
      <p className="hint">
        You’re always told when you’re assigned a task, @mentioned, or asked to approve one. You’re
        never told about your own changes, and quick changes to one task arrive as one notification.
      </p>
      <table className="tbl prefgrid" data-testid="pref-grid">
        <thead>
          <tr>
            <th>Tell me about…</th>
            {NOTIFY_RELATIONS.map((r) => (
              <th key={r}>{NOTIFY_RELATION_LABELS[r]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {GRID_KINDS.map((k) => (
            <tr key={k} style={{ cursor: 'default' }}>
              <td>{NOTIFY_KIND_LABELS[k]}</td>
              {NOTIFY_RELATIONS.map((r) => (
                <td key={r}>
                  <input
                    type="checkbox"
                    aria-label={`${NOTIFY_KIND_LABELS[k]} on tasks ${NOTIFY_RELATION_LABELS[r].toLowerCase()}`}
                    checked={prefs.grid[k][r]}
                    onChange={(e) =>
                      save(
                        { grid: { [k]: { [r]: e.target.checked } } },
                        {
                          ...prefs,
                          grid: { ...prefs.grid, [k]: { ...prefs.grid[k], [r]: e.target.checked } },
                        },
                      )
                    }
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="field">
        <span className="flabel">Team queues</span>
        <label className="ck">
          <input
            type="checkbox"
            checked={prefs.queue}
            onChange={(e) =>
              save({ queue: e.target.checked }, { ...prefs, queue: e.target.checked })
            }
          />
          Tell me when a task lands in the queue of a team I’m on
        </label>
      </div>
      <div className="field">
        <span className="flabel">Follow a task automatically when I…</span>
        {(
          [
            ['created', 'create it'],
            ['assigned', 'am assigned it'],
            ['commented', 'comment on it'],
            ['approver', 'am its approver'],
          ] as const
        ).map(([key, label]) => (
          <label className="ck" key={key}>
            <input
              type="checkbox"
              checked={prefs.autoFollow[key]}
              onChange={(e) =>
                save(
                  { autoFollow: { [key]: e.target.checked } },
                  { ...prefs, autoFollow: { ...prefs.autoFollow, [key]: e.target.checked } },
                )
              }
            />
            {label}
          </label>
        ))}
        <span className="hint">You can unfollow any task from its drawer.</span>
      </div>
      <button
        className="btn sm ghost"
        onClick={() => save(defaults, defaults)}
        disabled={JSON.stringify(prefs) === JSON.stringify(defaults)}
      >
        Back to the defaults
      </button>
    </div>
  );
}
