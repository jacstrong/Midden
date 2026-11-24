/**
 * One task, in full: fields, people, the approver panel, checklist, dependencies, comments and
 * history with undo. Every change is a task op through the shared TaskStore, so edits show at
 * once and everyone else sees them live.
 */
import { useEffect, useState, type ReactNode } from 'react';
import {
  categoryOf,
  moveToRunOp,
  openBlockers,
  taskRef,
  uid,
  workflowOf,
  TASK_PRIORITIES,
  type Task,
  type TaskComment,
  type TaskOp,
  type TaskPriority,
  type TaskState,
} from '@midden/core';
import { api, ApiError } from '../lib/api';
import { useRoute } from '../lib/router';
import { toast } from '../store/useToasts';
import { useTasks } from './TaskStore';
import {
  describeTaskOp,
  fmtAgo,
  fmtZulu,
  fromLocalInput,
  openTask,
  RefText,
  toLocalInput,
  useNames,
  type Names,
} from './shared';
import {
  CaseSelect,
  LabelInput,
  PeoplePicker,
  RunSelect,
  StatusSelect,
  TeamSelect,
  UserChip,
} from './pickers';

interface HistoryItem {
  seq: number;
  ts: string;
  actor: { id: string; name: string };
  op: TaskOp;
  inverse: TaskOp | null;
}

export function TaskDrawer({ num, onClose }: { num: number; onClose(): void }) {
  const state = useTasks((s) => s.state);
  const role = useTasks((s) => s.directory.users.find((u) => u.id === s.me?.id)?.role);
  const names = useNames();
  const task = state && Object.values(state.tasks).find((t) => t.num === num);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (
        e.key === 'Escape' &&
        !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
      )
        onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!state) return null;
  if (!task)
    return (
      <aside className="tdrawer" aria-label={`Task ${taskRef(num)}`}>
        <div className="tdhead">
          <span className="tid">{taskRef(num)}</span>
          <span className="sp" />
          <button className="btn sm ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <p className="empty">
          This task isn’t on the board: it may be archived, in a closed run, or linked to a case you
          can’t read.
        </p>
      </aside>
    );
  return (
    <Drawer
      key={task.id}
      task={task}
      state={state}
      names={names}
      canEdit={role !== 'viewer'}
      onClose={onClose}
    />
  );
}

function Drawer({
  task: t,
  state,
  names,
  canEdit,
  onClose,
}: {
  task: Task;
  state: TaskState;
  names: Names;
  canEdit: boolean;
  onClose(): void;
}) {
  const dispatch = useTasks((s) => s.dispatch);
  const [tab, setTab] = useState<'comments' | 'history'>('comments');
  const wf = workflowOf(state, t);
  const set = (patch: Extract<TaskOp, { type: 'task.set' }>['patch']): void =>
    void dispatch({ type: 'task.set', id: t.id, patch });
  const following = t.followers.includes(names.me);
  const assigned = t.assignees.includes(names.me);
  const cat = categoryOf(state, t);

  return (
    <aside className="tdrawer" aria-label={`Task ${taskRef(t.num)}`} data-testid="task-drawer">
      <div className="tdhead">
        <span className="tid">{taskRef(t.num)}</span>
        {t.archived && <span className="tag">archived</span>}
        <span className="sp" />
        {canEdit && !assigned && cat !== 'done' && cat !== 'cancelled' && (
          <button
            className="btn sm pri"
            onClick={() =>
              void dispatch({ type: 'task.assign', ids: [t.id], mode: 'add', users: [names.me] })
            }
            data-testid="task-claim"
          >
            Claim
          </button>
        )}
        <button
          className="btn sm ghost"
          onClick={() =>
            void dispatch({ type: 'task.follow', id: t.id, userId: names.me, on: !following })
          }
          aria-pressed={following}
          data-testid="task-follow"
        >
          {following ? '★ Following' : '☆ Follow'}
        </button>
        {canEdit && (
          <button className="btn sm ghost" onClick={() => set({ archived: !t.archived })}>
            {t.archived ? 'Restore' : 'Archive'}
          </button>
        )}
        <button className="btn sm ghost" onClick={onClose} aria-label="Close task">
          ✕
        </button>
      </div>

      <div className="tdbody">
        <Commit
          className="tdtitle"
          value={t.title}
          disabled={!canEdit}
          ariaLabel="Title"
          onCommit={(title) => title.trim() && set({ title: title.trim() })}
        />

        <dl className="tdgrid">
          <Row label="Status" htmlFor="tdStatus">
            <StatusSelect
              id="tdStatus"
              value={t.statusId}
              workflow={wf}
              disabled={!canEdit}
              onChange={(statusId) => set({ statusId })}
            />
          </Row>
          <Row label="Priority" htmlFor="tdPri">
            <select
              id="tdPri"
              value={t.priority}
              disabled={!canEdit}
              onChange={(e) => set({ priority: e.target.value as TaskPriority })}
            >
              {TASK_PRIORITIES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </Row>
          <Row label="Due (UTC)" htmlFor="tdDue">
            <input
              id="tdDue"
              type="datetime-local"
              disabled={!canEdit}
              defaultValue={toLocalInput(t.dueAt)}
              key={t.dueAt}
              onBlur={(e) => {
                const dueAt = fromLocalInput(e.target.value);
                if (dueAt !== t.dueAt) set({ dueAt });
              }}
            />
          </Row>
          <Row label="Team queue" htmlFor="tdTeam">
            <TeamSelect
              id="tdTeam"
              value={t.teamId}
              disabled={!canEdit}
              onChange={(teamId) =>
                void dispatch({ type: 'task.assign', ids: [t.id], mode: 'add', users: [], teamId })
              }
            />
          </Row>
          <Row label="Assignees" htmlFor="tdWho">
            <PeoplePicker
              id="tdWho"
              names={names}
              value={t.assignees}
              disabled={!canEdit}
              onAdd={(u) =>
                void dispatch({ type: 'task.assign', ids: [t.id], mode: 'add', users: [u] })
              }
              onRemove={(u) =>
                void dispatch({ type: 'task.assign', ids: [t.id], mode: 'remove', users: [u] })
              }
            />
          </Row>
          <Row label="Run" htmlFor="tdRun">
            <RunSelect
              id="tdRun"
              state={state}
              value={t.runId}
              disabled={!canEdit}
              onChange={(r) => {
                const op = moveToRunOp(state, t, r);
                if (op) void dispatch(op);
              }}
            />
          </Row>
          <Row label="Case" htmlFor="tdCase">
            <div className="inline">
              <CaseSelect
                id="tdCase"
                value={t.caseId}
                disabled={!canEdit}
                onChange={(caseId) => set({ caseId })}
              />
              {t.caseId && names.caseName(t.caseId) !== 'Restricted case' && (
                <button
                  className="btn sm ghost"
                  onClick={() =>
                    useRoute.getState().navigate({ kind: 'case', caseId: t.caseId, view: 'graph' })
                  }
                >
                  Open
                </button>
              )}
            </div>
            {(t.hostId || t.eventId) && (
              <span className="hint">
                Linked to {t.eventId ? 'an event' : 'a host'} in this case.
              </span>
            )}
          </Row>
          <Row label="Labels" htmlFor="tdLabels">
            <LabelInput
              id="tdLabels"
              value={t.labels}
              disabled={!canEdit}
              onChange={(labels) => set({ labels })}
            />
          </Row>
          <Row label="Followers">
            <div className="chiprow">
              {t.followers.length ? (
                t.followers.map((u) => <UserChip key={u} id={u} names={names} />)
              ) : (
                <span className="dimmer">nobody</span>
              )}
            </div>
          </Row>
        </dl>

        <ApprovalPanel t={t} names={names} canEdit={canEdit} />

        <Section title="Description">
          <Description t={t} canEdit={canEdit} onCommit={(description) => set({ description })} />
        </Section>

        <Checklist t={t} canEdit={canEdit} names={names} />
        <Dependencies t={t} state={state} canEdit={canEdit} />

        <div className="tabs tdtabs" role="tablist">
          <button
            role="tab"
            className={'tab' + (tab === 'comments' ? ' on' : '')}
            aria-selected={tab === 'comments'}
            onClick={() => setTab('comments')}
          >
            Comments (
            {Object.values(state.comments).filter((c) => c.taskId === t.id && !c.deletedAt).length})
          </button>
          <button
            role="tab"
            className={'tab' + (tab === 'history' ? ' on' : '')}
            aria-selected={tab === 'history'}
            onClick={() => setTab('history')}
          >
            History
          </button>
        </div>
        {tab === 'comments' ? (
          <Comments t={t} state={state} names={names} canEdit={canEdit} />
        ) : (
          <History t={t} state={state} names={names} canEdit={canEdit} />
        )}
        <p className="hint">
          Created by {names.user(t.createdBy)} {fmtAgo(t.createdAt)} · status since{' '}
          {fmtZulu(t.statusAt)}
          {t.doneAt ? ` · done ${fmtZulu(t.doneAt)}` : ''}
        </p>
      </div>
    </aside>
  );
}

function Row({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt>
        <label htmlFor={htmlFor}>{label}</label>
      </dt>
      <dd>{children}</dd>
    </>
  );
}

function Section({
  title,
  children,
  extra,
}: {
  title: string;
  children: ReactNode;
  extra?: ReactNode;
}) {
  return (
    <section className="tdsec">
      <h4>
        {title}
        {extra}
      </h4>
      {children}
    </section>
  );
}

/** A field that edits locally and commits on blur or Enter. */
function Commit({
  value,
  onCommit,
  disabled,
  ariaLabel,
  className,
}: {
  value: string;
  onCommit(v: string): void;
  disabled?: boolean;
  ariaLabel: string;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    // someone else changed it: show theirs
    setSeen(value);
    setDraft(value);
  }
  return (
    <input
      type="text"
      className={className}
      aria-label={ariaLabel}
      value={draft}
      readOnly={disabled}
      maxLength={300}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => draft !== value && onCommit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') setDraft(value);
      }}
    />
  );
}

function Description({
  t,
  canEdit,
  onCommit,
}: {
  t: Task;
  canEdit: boolean;
  onCommit(v: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.description);
  const [seen, setSeen] = useState(t.description);
  if (!editing && seen !== t.description) {
    setSeen(t.description);
    setDraft(t.description);
  }
  if (editing)
    return (
      <div>
        <textarea
          rows={6}
          autoFocus
          value={draft}
          aria-label="Description"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
              (e.target as HTMLTextAreaElement).blur();
          }}
          onBlur={() => {
            setEditing(false);
            if (draft !== t.description) onCommit(draft);
          }}
        />
        <span className="hint">
          Plain text. T-12 links a task; @username mentions someone. Ctrl+Enter saves.
        </span>
      </div>
    );
  return (
    <div
      className={'tddesc' + (canEdit ? ' editable' : '')}
      onClick={(e) => canEdit && !(e.target as HTMLElement).closest('a') && setEditing(true)}
      tabIndex={canEdit ? 0 : undefined}
      onKeyDown={(e) => canEdit && e.key === 'Enter' && setEditing(true)}
      role={canEdit ? 'button' : undefined}
      aria-label={canEdit ? 'Edit description' : undefined}
    >
      {t.description ? (
        <RefText text={t.description} />
      ) : (
        <span className="dimmer">{canEdit ? 'Add a description…' : 'No description'}</span>
      )}
    </div>
  );
}

function ApprovalPanel({ t, names, canEdit }: { t: Task; names: Names; canEdit: boolean }) {
  const dispatch = useTasks((s) => s.dispatch);
  const [comment, setComment] = useState('');
  const a = t.approval;
  const mine = !!a && a.approverId === names.me && a.state === 'pending';
  const decide = async (decision: 'approved' | 'rejected'): Promise<void> => {
    const r = await dispatch({
      type: 'approval.decide',
      taskId: t.id,
      decision,
      comment: comment.trim(),
    });
    if (r.ok) setComment('');
  };
  if (!a && !canEdit) return null;
  return (
    <Section title="Approval">
      {!a ? (
        <div className="inline">
          <select
            aria-label="Request approval from"
            value=""
            onChange={(e) =>
              e.target.value &&
              void dispatch({ type: 'approval.set', taskId: t.id, approverId: e.target.value })
            }
          >
            <option value="">Request approval from…</option>
            {names.active.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
          <span className="hint">
            The approver signs off in person; until then the task can’t be marked done.
          </span>
        </div>
      ) : (
        <div className={'tdappr ' + a.state} data-testid="approval">
          <div className="inline">
            <UserChip id={a.approverId} names={names} />
            <b className="apstate">{a.state}</b>
            {a.decidedAt && <span className="dimmer">{fmtAgo(a.decidedAt)}</span>}
            <span className="sp" />
            {canEdit && (
              <>
                <select
                  aria-label="Change approver"
                  value=""
                  onChange={(e) =>
                    e.target.value &&
                    void dispatch({
                      type: 'approval.set',
                      taskId: t.id,
                      approverId: e.target.value,
                    })
                  }
                >
                  <option value="">Change…</option>
                  {names.active
                    .filter((u) => u.id !== a.approverId)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                </select>
                <button
                  className="btn sm ghost"
                  onClick={() =>
                    void dispatch({ type: 'approval.set', taskId: t.id, approverId: '' })
                  }
                >
                  Remove
                </button>
              </>
            )}
          </div>
          {a.comment && (
            <blockquote className="apcomment">
              <RefText text={a.comment} />
            </blockquote>
          )}
          {mine && (
            <div className="apdecide">
              <textarea
                rows={2}
                value={comment}
                maxLength={2000}
                aria-label="Approval comment"
                placeholder="Optional comment, e.g. the risk you are accepting"
                onChange={(e) => setComment(e.target.value)}
              />
              <div className="inline">
                <button
                  className="btn pri"
                  onClick={() => void decide('approved')}
                  data-testid="approve"
                >
                  Approve
                </button>
                <button
                  className="btn mag"
                  onClick={() => void decide('rejected')}
                  data-testid="reject"
                >
                  Reject
                </button>
              </div>
            </div>
          )}
          {a.state === 'pending' && !mine && (
            <span className="hint">
              Waiting for {names.user(a.approverId)}. The task can’t be marked done until it’s
              approved.
            </span>
          )}
        </div>
      )}
    </Section>
  );
}

function Checklist({ t, canEdit, names }: { t: Task; canEdit: boolean; names: Names }) {
  const dispatch = useTasks((s) => s.dispatch);
  const [draft, setDraft] = useState('');
  const done = t.checklist.filter((c) => c.done).length;
  const add = (): void => {
    const text = draft.trim();
    if (!text) return;
    void dispatch({ type: 'checklist.add', taskId: t.id, item: { id: uid('ck'), text } });
    setDraft('');
  };
  if (!t.checklist.length && !canEdit) return null;
  return (
    <Section
      title="Checklist"
      extra={
        t.checklist.length ? (
          <span className="dimmer">
            {' '}
            {done}/{t.checklist.length}
          </span>
        ) : null
      }
    >
      <ul className="tdcheck">
        {t.checklist.map((c, i) => (
          <li key={c.id} className={c.done ? 'done' : ''}>
            <input
              type="checkbox"
              checked={c.done}
              disabled={!canEdit}
              aria-label={c.text}
              onChange={(e) =>
                void dispatch({
                  type: 'checklist.set',
                  taskId: t.id,
                  itemId: c.id,
                  patch: { done: e.target.checked },
                })
              }
            />
            <span
              className="grow"
              title={c.done ? `${names.user(c.doneBy)} · ${fmtZulu(c.doneAt)}` : undefined}
            >
              <RefText text={c.text} />
            </span>
            {canEdit && (
              <span className="rowacts">
                <button
                  className="btn sm ghost"
                  disabled={i === 0}
                  aria-label="Move up"
                  onClick={() =>
                    void dispatch({
                      type: 'checklist.move',
                      taskId: t.id,
                      itemId: c.id,
                      index: i - 1,
                    })
                  }
                >
                  ↑
                </button>
                <button
                  className="btn sm ghost"
                  aria-label={`Remove ${c.text}`}
                  onClick={() =>
                    void dispatch({ type: 'checklist.remove', taskId: t.id, itemId: c.id })
                  }
                >
                  ✕
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      {canEdit && (
        <input
          type="text"
          placeholder="+ add an item, Enter to save"
          aria-label="New checklist item"
          value={draft}
          maxLength={500}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
      )}
    </Section>
  );
}

function Dependencies({ t, state, canEdit }: { t: Task; state: TaskState; canEdit: boolean }) {
  const dispatch = useTasks((s) => s.dispatch);
  const [draft, setDraft] = useState('');
  const open = new Set(openBlockers(state, t).map((b) => b.id));
  const blocking = Object.values(state.tasks).filter((x) => x.blockedBy.includes(t.id));
  const add = (): void => {
    const n = Number(draft.trim().replace(/^T-/i, ''));
    const other = Object.values(state.tasks).find((x) => x.num === n);
    if (!other) {
      toast(`No task ${draft.trim()} on this board`, 'warn');
      return;
    }
    void dispatch({ type: 'dep.add', taskId: t.id, blockedById: other.id }).then(
      (r) => r.ok && setDraft(''),
    );
  };
  if (!t.blockedBy.length && !blocking.length && !canEdit) return null;
  const link = (x: Task | undefined, id: string) =>
    x ? (
      <a
        className="tref"
        href={`#/tasks/t/${x.num}`}
        onClick={(e) => (e.preventDefault(), openTask(x.num))}
      >
        {taskRef(x.num)}
      </a>
    ) : (
      <span className="dimmer" title={id}>
        hidden task
      </span>
    );
  return (
    <Section title="Dependencies">
      {t.blockedBy.length > 0 && (
        <ul className="tddeps">
          {t.blockedBy.map((id) => {
            const x = state.tasks[id];
            return (
              <li key={id}>
                <span className={open.has(id) ? 'late' : 'ok'}>
                  {open.has(id) ? '⛔ waiting on' : '✓ done'}
                </span>{' '}
                {link(x, id)} {x?.title}
                {canEdit && (
                  <button
                    className="btn sm ghost"
                    aria-label="Remove dependency"
                    onClick={() =>
                      void dispatch({ type: 'dep.remove', taskId: t.id, blockedById: id })
                    }
                  >
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {blocking.length > 0 && (
        <p className="hint">
          Blocking{' '}
          {blocking.map((x, i) => (
            <span key={x.id}>
              {i ? ', ' : ''}
              {link(x, x.id)}
            </span>
          ))}
        </p>
      )}
      {canEdit && (
        <div className="inline">
          <input
            type="text"
            placeholder="Blocked by… T-12"
            aria-label="Add a task this one waits on"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
          />
          <button className="btn sm" disabled={!draft.trim()} onClick={add}>
            Add
          </button>
        </div>
      )}
    </Section>
  );
}

function Comments({
  t,
  state,
  names,
  canEdit,
}: {
  t: Task;
  state: TaskState;
  names: Names;
  canEdit: boolean;
}) {
  const dispatch = useTasks((s) => s.dispatch);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const list = Object.values(state.comments)
    .filter((c) => c.taskId === t.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const post = async (): Promise<void> => {
    const body = draft.trim();
    if (!body) return;
    const r = await dispatch({
      type: 'comment.add',
      comment: { id: uid('cm'), taskId: t.id, body },
    });
    if (r.ok) setDraft('');
  };
  return (
    <div className="tdcomments" data-testid="comments">
      {list.map((c) =>
        c.deletedAt ? (
          <div key={c.id} className="tcomment gone">
            <span className="dimmer">Comment deleted</span>
          </div>
        ) : (
          <CommentItem
            key={c.id}
            c={c}
            names={names}
            editing={editing === c.id}
            onEdit={(on) => setEditing(on ? c.id : null)}
          />
        ),
      )}
      {canEdit && (
        <div className="tcompose">
          <textarea
            rows={3}
            value={draft}
            maxLength={10000}
            aria-label="New comment"
            placeholder="Comment… @username to mention, T-12 to link"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void post();
            }}
          />
          <button
            className="btn pri"
            disabled={!draft.trim()}
            onClick={() => void post()}
            data-testid="comment-post"
          >
            Comment
          </button>
        </div>
      )}
    </div>
  );
}

function CommentItem({
  c,
  names,
  editing,
  onEdit,
}: {
  c: TaskComment;
  names: Names;
  editing: boolean;
  onEdit(on: boolean): void;
}) {
  const dispatch = useTasks((s) => s.dispatch);
  const [draft, setDraft] = useState(c.body);
  const mine = c.authorId === names.me;
  return (
    <div className="tcomment" data-testid="comment">
      <div className="tchead">
        <b>{names.user(c.authorId)}</b>
        <span className="dimmer" title={fmtZulu(c.createdAt)}>
          {fmtAgo(c.createdAt)}
          {c.editedAt ? ' · edited' : ''}
        </span>
        <span className="sp" />
        {mine && !editing && (
          <button className="btn sm ghost" onClick={() => (setDraft(c.body), onEdit(true))}>
            Edit
          </button>
        )}
        {(mine || names.isAdmin) && !editing && (
          <button
            className="btn sm ghost"
            onClick={() => void dispatch({ type: 'comment.remove', id: c.id })}
          >
            Delete
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            rows={3}
            value={draft}
            aria-label="Edit comment"
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="inline">
            <button
              className="btn sm pri"
              disabled={!draft.trim()}
              onClick={() =>
                void dispatch({ type: 'comment.edit', id: c.id, body: draft.trim() }).then(
                  (r) => r.ok && onEdit(false),
                )
              }
            >
              Save
            </button>
            <button className="btn sm ghost" onClick={() => onEdit(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <RefText text={c.body} />
      )}
    </div>
  );
}

function History({
  t,
  state,
  names,
  canEdit,
}: {
  t: Task;
  state: TaskState;
  names: Names;
  canEdit: boolean;
}) {
  const seq = useTasks((s) => s.seq);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      api<{ ops: HistoryItem[] }>('GET', `/api/tasks/${t.id}/history`)
        .then((r) => alive && setItems(r.ops))
        .catch(() => alive && setItems([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [t.id, seq]);
  const undo = async (s: number): Promise<void> => {
    try {
      await api('POST', '/api/tasks/revert', { seq: s });
      toast('Undone');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Could not undo', 'bad');
    }
  };
  if (!items) return <p className="dimmer">Loading…</p>;
  return (
    <ol className="thistory" data-testid="task-history">
      {[...items].reverse().map((h) => (
        <li key={h.seq}>
          <span className="dimmer" title={fmtZulu(h.ts)}>
            {fmtAgo(h.ts)}
          </span>{' '}
          <b>{h.actor.name}</b> {describeTaskOp(h.op, state, names)}
          {canEdit && h.inverse && h.op.type !== 'op.revert' && (
            <button
              className="btn sm ghost"
              onClick={() => void undo(h.seq)}
              title={`Undo #${h.seq}`}
            >
              Undo
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
