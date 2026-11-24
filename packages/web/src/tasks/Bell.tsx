/**
 * The notification bell in the top bar: the unread count, and a short list of the newest
 * notifications. Opening one marks it read and goes to its task (or to the inbox for a bulk
 * change, which lists every task).
 */
import { useEffect, useRef, useState } from 'react';
import { statusOf, type NotificationView } from '@midden/core';
import { useRoute } from '../lib/router';
import { notificationAlso, notificationText, useInbox } from './inbox';
import { fmtAgo } from './shared';
import { useTasks } from './TaskStore';

const SHOWN = 8;

export function NotificationItem({
  n,
  onOpen,
}: {
  n: NotificationView;
  onOpen(n: NotificationView): void;
}) {
  const also = notificationAlso(n);
  const statusName = useTasks((s) => {
    const t = n.tasks.length === 1 && s.state ? s.state.tasks[n.tasks[0]!.id] : undefined;
    return t && s.state ? statusOf(s.state, t)?.name : undefined;
  });
  return (
    <button
      type="button"
      className={`nitem${n.read ? '' : ' unread'}`}
      onClick={() => onOpen(n)}
      data-testid="notification"
    >
      <span className="ndot" aria-hidden />
      <span className="nbody">
        <span className="ntext">{notificationText(n, statusName)}</span>
        {n.comments.length > 0 && <span className="nquote">“{n.comments.at(-1)!.excerpt}”</span>}
        {n.tasks.length > 1 && (
          <span className="nmore">
            {n.tasks
              .slice(0, 5)
              .map((t) => `T-${t.num}`)
              .join(', ')}
            {n.tasks.length > 5 ? ` and ${n.tasks.length - 5} more` : ''}
          </span>
        )}
        <span className="nmeta">
          {fmtAgo(n.updatedAt)}
          {also && ` · ${also}`}
          {n.count > 1 && ` · ${n.count} changes`}
        </span>
      </span>
    </button>
  );
}

/** Mark read and go to the task; a notification about several tasks opens the inbox. */
export function useOpenNotification(): (n: NotificationView) => void {
  const navigate = useRoute((s) => s.navigate);
  const markRead = useInbox((s) => s.markRead);
  return (n) => {
    void markRead([n.id]).catch(() => {});
    if (n.tasks.length === 1) navigate({ kind: 'tasks', viewId: 'mine', taskNum: n.tasks[0]!.num });
    else navigate({ kind: 'inbox', tab: 'inbox' });
  };
}

export function Bell() {
  const unread = useInbox((s) => s.unread);
  const items = useInbox((s) => s.items);
  const loaded = useInbox((s) => s.loaded);
  const load = useInbox((s) => s.load);
  const markAll = useInbox((s) => s.markAll);
  const navigate = useRoute((s) => s.navigate);
  const open = useOpenNotification();
  const [shown, setShown] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  useEffect(() => {
    if (!shown) return;
    const away = (e: MouseEvent): void => {
      if (box.current && !box.current.contains(e.target as Node)) setShown(false);
    };
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setShown(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [shown]);

  return (
    <div className="bellwrap" ref={box}>
      <button
        className="btn ghost bell"
        aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={shown}
        title="Notifications"
        onClick={() => setShown(!shown)}
        data-testid="bell"
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
          <path
            d="M8 1.5a4 4 0 0 0-4 4v2.7L2.6 11h10.8L12 8.2V5.5a4 4 0 0 0-4-4zM6.3 12.5a1.8 1.8 0 0 0 3.4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className="bellbadge" data-testid="bell-count">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {shown && (
        <div className="bellpop" role="dialog" aria-label="Notifications">
          <header>
            <b>Notifications</b>
            <span className="sp" />
            <button className="btn sm ghost" disabled={!unread} onClick={() => void markAll()}>
              Mark all read
            </button>
          </header>
          <div className="nlist">
            {items.length === 0 ? (
              <p className="hint">
                Nothing yet. You’ll hear here when someone assigns or mentions you.
              </p>
            ) : (
              items.slice(0, SHOWN).map((n) => (
                <NotificationItem
                  key={n.id}
                  n={n}
                  onOpen={(x) => {
                    setShown(false);
                    open(x);
                  }}
                />
              ))
            )}
          </div>
          <footer>
            <button
              className="btn sm ghost"
              onClick={() => {
                setShown(false);
                navigate({ kind: 'inbox', tab: 'inbox' });
              }}
            >
              All notifications
            </button>
            <span className="sp" />
            <button
              className="btn sm ghost"
              onClick={() => {
                setShown(false);
                navigate({ kind: 'inbox', tab: 'prefs' });
              }}
            >
              Preferences
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
