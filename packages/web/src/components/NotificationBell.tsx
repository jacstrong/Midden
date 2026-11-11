import { useEffect, useRef, useState } from 'react';
import type { TaskNotification } from '@midden/core';
import { useNotifications } from '../store/useNotifications';
import { useTaskBoard } from '../store/useTaskBoard';
import { toast } from '../store/useToasts';
import { useRoute } from '../lib/router';
import { trunc } from '../lib/format';

const POLL_MS = 30_000;

const when = (iso: string): string => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return iso.slice(0, 10);
};

/** Hosted only. Shows unread task notices and takes you to the task. */
export function NotificationBell() {
  const { items, unread, load, received, markRead } = useNotifications();
  const navigate = useRoute((s) => s.navigate);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    const onPush = (e: Event): void => {
      const n = (e as CustomEvent<TaskNotification>).detail;
      received(n);
      toast(`${n.actor.name} ${trunc(n.text, 120)}`);
    };
    window.addEventListener('midden:notify', onPush);
    return () => {
      clearInterval(t);
      window.removeEventListener('midden:notify', onPush);
    };
  }, [load, received]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const go = (n: TaskNotification): void => {
    setOpen(false);
    if (!n.readAt) void markRead([n.id]);
    if (n.taskId) navigate({ kind: 'case', caseId: n.caseId, view: 'tasks', taskId: n.taskId });
    else {
      useTaskBoard.getState().setScope('mine');
      navigate({ kind: 'case', caseId: n.caseId, view: 'tasks' });
    }
  };

  return (
    <div className="bellwrap" ref={panel}>
      <button
        className="btn ghost bell"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={unread ? `${unread} unread notifications` : 'Notifications'}
        title="Task notifications"
        data-testid="bell"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
        {unread > 0 && (
          <span className="bellcount" data-testid="bell-count">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div
          className="bellpanel"
          role="dialog"
          aria-label="Notifications"
          data-testid="bell-panel"
        >
          <div className="bellhead">
            <b>Notifications</b>
            <span className="sp" />
            {unread > 0 && (
              <button className="btn ghost sm" onClick={() => void markRead('all')}>
                Mark all read
              </button>
            )}
          </div>
          {!items.length && (
            <div className="bellempty">
              Nothing yet. You hear about tasks you are assigned to or follow.
            </div>
          )}
          {items.map((n) => (
            <button
              key={n.id}
              className={'bellitem' + (n.readAt ? '' : ' unread')}
              onClick={() => go(n)}
              data-testid="bell-item"
            >
              <span>
                <b>{n.actor.name}</b> {n.text}
              </span>
              <small>
                {trunc(n.caseName, 40)} · {when(n.createdAt)}
              </small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
