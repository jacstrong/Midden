import { useEffect, useMemo, useState } from 'react';
import {
  blankTask,
  bottomRank,
  commentsFor,
  definedKeys,
  statusPatch,
  TASK_PRIORITY,
  TASK_STATUS,
  TECHNIQUE_NAME,
  uid,
  type ChecklistItem,
  type Patch,
  type Task,
  type TaskFields,
} from '@midden/core';
import { Modal } from '../components/Modal';
import { Field } from '../components/fields';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore, type ModalState } from '../store/useUiStore';
import { usePeople, useMyFollows, usePersonName } from '../store/usePeople';
import { toast } from '../store/useToasts';
import { colorFor, initials } from '../lib/format';
import {
  ChipPicker,
  eventOptions,
  hostOptions,
  isoToLocalInput,
  localInputToIso,
  usePeopleOptions,
} from './taskUi';
import { currentActor, deleteTasks, duplicateTasks } from './taskActions';

export interface TaskEditorProps {
  id: string | null;
  draft?: Partial<Task> | undefined;
  returnTo?: ModalState | undefined;
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function diffTask(original: Task, next: TaskFields): Patch<TaskFields> {
  const patch: Patch<TaskFields> = {};
  for (const k of Object.keys(next) as (keyof TaskFields)[])
    if (!sameJson(original[k], next[k])) (patch as Record<string, unknown>)[k] = next[k];
  return patch;
}

const TECHNIQUES = Object.keys(TECHNIQUE_NAME).sort();

export function TaskEditor({ id, draft, returnTo }: TaskEditorProps) {
  const state = useCaseStore((s) => s.state);
  const dispatch = useCaseStore((s) => s.dispatch);
  const canEdit = useCaseStore((s) => s.access.edit);
  const manage = useCaseStore((s) => s.access.manage);
  const multiUser = useCaseStore((s) => s.capabilities.multiUser);
  const touches = useCaseStore((s) => (id ? s.remoteTouches[id] : undefined));
  const clearTouches = useCaseStore((s) => s.clearTouches);
  const { closeModal, openModal } = useUiStore();
  const isNew = !id;
  const original = useMemo<Task>(
    () => (id ? state.tasks[id] : undefined) ?? blankTask(currentActor(), undefined, draft ?? {}),
    [id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const [f, setF] = useState({
    ...original,
    tags: original.tags.join(', '),
    due: isoToLocalInput(original.due),
  });
  const [baseSeq] = useState(() => useCaseStore.getState().seq);
  const people = usePeopleOptions();
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]): void =>
    setF((x) => ({ ...x, [k]: v }));

  const close = (): void => {
    clearTouches(original.id);
    if (returnTo) openModal(returnTo);
    else closeModal();
  };
  const mark = (field: string): { className?: string; title?: string } =>
    touches?.[field]
      ? {
          className: 'changed',
          title: `Changed by ${touches[field]!.by.name} while you were editing`,
        }
      : {};

  const save = async (): Promise<void> => {
    const fields: TaskFields = {
      ...original,
      title: f.title.trim() || 'Untitled task',
      description: f.description,
      status: f.status,
      priority: f.priority,
      assignees: f.assignees,
      hostIds: f.hostIds,
      eventIds: f.eventIds,
      technique: f.technique.trim().toUpperCase(),
      tags: [
        ...new Set(
          f.tags
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        ),
      ],
      due: localInputToIso(f.due),
      checklist: f.checklist.filter((c) => c.text.trim()),
      outcome: f.outcome,
      rank: original.rank,
      completedAt: original.completedAt,
    };
    delete (fields as Partial<Task>).id;
    const now = new Date().toISOString();
    if (isNew) {
      const task: Task = {
        ...fields,
        id: original.id,
        rank: bottomRank(state, fields.status),
        completedAt: fields.status === 'done' ? now : '',
      };
      const r = await dispatch({ type: 'task.add', task }, { baseSeq });
      if (!r.ok) return;
      toast('Task added');
    } else {
      const live = useCaseStore.getState().state.tasks[original.id] ?? original;
      const patch = diffTask(original, fields);
      if (patch.status) {
        Object.assign(patch, statusPatch(live, patch.status, now));
        patch.rank = bottomRank(useCaseStore.getState().state, patch.status);
      }
      if (definedKeys(patch).length) {
        const r = await dispatch({ type: 'task.set', id: original.id, patch }, { baseSeq });
        if (!r.ok) return;
        toast('Task updated');
      }
    }
    close();
  };

  return (
    <Modal
      title={isNew ? 'Add task' : 'Edit task'}
      onClose={close}
      head={
        !isNew && (
          <>
            {multiUser && <FollowButton taskId={original.id} />}
            {manage && canEdit && (
              <button
                className="btn sm"
                onClick={() => {
                  close();
                  void duplicateTasks([original.id]);
                }}
              >
                Duplicate
              </button>
            )}
            {canEdit && (
              <button className="btn sm mag" onClick={() => deleteTasks([original.id], close)}>
                Delete
              </button>
            )}
          </>
        )
      }
      foot={
        <>
          {!isNew && (
            <span className="dimmer" style={{ fontSize: 10 }}>
              Created by {original.createdByName || 'someone'}{' '}
              {original.createdAt ? `on ${original.createdAt.slice(0, 10)}` : ''}
              {original.completedAt
                ? ` · done ${original.completedAt.slice(0, 16).replace('T', ' ')}Z`
                : ''}
            </span>
          )}
          <span className="sp" />
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn pri"
            onClick={() => void save()}
            disabled={!canEdit}
            data-testid="task-save"
          >
            {isNew ? 'Add task' : 'Save changes'}
          </button>
        </>
      }
    >
      {touches && Object.keys(touches).length > 0 && (
        <div className="changed-note" data-testid="remote-changed">
          {[...new Set(Object.values(touches).map((t) => t.by.name))].join(', ')} changed{' '}
          {Object.keys(touches).join(', ')} while this was open.
        </div>
      )}
      <div className="grid3">
        <Field label="Title" htmlFor="tTitle" span={3}>
          <input
            type="text"
            id="tTitle"
            value={f.title}
            placeholder="Sweep the domain controllers for DCSync"
            onChange={(e) => set('title', e.target.value)}
            readOnly={!canEdit}
            {...mark('title')}
          />
        </Field>
        <Field label="Status" htmlFor="tStatus">
          <select
            id="tStatus"
            value={f.status}
            onChange={(e) => set('status', e.target.value as Task['status'])}
            disabled={!canEdit}
            {...mark('status')}
          >
            {TASK_STATUS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority" htmlFor="tPriority">
          <select
            id="tPriority"
            value={f.priority}
            onChange={(e) => set('priority', e.target.value as Task['priority'])}
            disabled={!canEdit}
            {...mark('priority')}
          >
            {TASK_PRIORITY.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Due" htmlFor="tDue" hint="In this browser's time">
          <input
            type="datetime-local"
            id="tDue"
            value={f.due}
            onChange={(e) => set('due', e.target.value)}
            readOnly={!canEdit}
            {...mark('due')}
          />
        </Field>
        <Field
          label="Assigned to"
          htmlFor="tAssign"
          span={3}
          hint={multiUser ? 'Everyone assigned is notified of changes.' : undefined}
        >
          <ChipPicker
            id="tAssign"
            value={f.assignees}
            options={people.options}
            free={people.free}
            onChange={(v) => set('assignees', v)}
            placeholder={people.free ? 'Type a name, then Enter' : 'Add a person…'}
            disabled={!canEdit}
            testId="task-assignees"
          />
        </Field>
        <Field label="Hosts" htmlFor="tHosts" span={3}>
          <ChipPicker
            id="tHosts"
            value={f.hostIds}
            options={hostOptions(state)}
            onChange={(v) => set('hostIds', v)}
            placeholder="Link a host…"
            disabled={!canEdit}
            testId="task-hosts"
          />
        </Field>
        <Field label="Events" htmlFor="tEvents" span={3}>
          <ChipPicker
            id="tEvents"
            value={f.eventIds}
            options={eventOptions(state)}
            onChange={(v) => set('eventIds', v)}
            placeholder="Link an event…"
            disabled={!canEdit}
          />
        </Field>
        <Field label="ATT&CK technique" htmlFor="tTech" hint="What the task hunts for, if anything">
          <input
            type="text"
            id="tTech"
            value={f.technique}
            list="tTechList"
            placeholder="T1003.006"
            onChange={(e) => set('technique', e.target.value)}
            readOnly={!canEdit}
          />
          <datalist id="tTechList">
            {TECHNIQUES.map((t) => (
              <option key={t} value={t}>
                {TECHNIQUE_NAME[t]}
              </option>
            ))}
          </datalist>
        </Field>
        <Field label="Tags" htmlFor="tTags" span={2}>
          <input
            type="text"
            id="tTags"
            value={f.tags}
            placeholder="collection, shift-2"
            onChange={(e) => set('tags', e.target.value)}
            readOnly={!canEdit}
          />
        </Field>
        <Field label="Description" htmlFor="tDesc" span={3}>
          <textarea
            id="tDesc"
            value={f.description}
            placeholder="What to look at, where, and what counts as done"
            onChange={(e) => set('description', e.target.value)}
            readOnly={!canEdit}
            {...mark('description')}
          />
        </Field>
        <div className="field span3">
          <label>Checklist</label>
          <Checklist
            items={f.checklist}
            onChange={(v) => set('checklist', v)}
            disabled={!canEdit}
          />
        </div>
        <Field
          label="Outcome"
          htmlFor="tOutcome"
          span={3}
          hint="What the work found. Shown on the card once it is done."
        >
          <textarea
            id="tOutcome"
            value={f.outcome}
            placeholder="Nothing on DC01–03. Second implant found on FS02, see event."
            onChange={(e) => set('outcome', e.target.value)}
            readOnly={!canEdit}
            style={{ minHeight: 54 }}
          />
        </Field>
      </div>
      {!isNew && <Comments taskId={original.id} />}
    </Modal>
  );
}

function Checklist({
  items,
  onChange,
  disabled,
}: {
  items: ChecklistItem[];
  onChange: (v: ChecklistItem[]) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState('');
  const add = (): void => {
    const t = text.trim();
    if (!t) return;
    onChange([...items, { id: uid('ck'), text: t, done: false }]);
    setText('');
  };
  const done = items.filter((c) => c.done).length;
  return (
    <div className="checklist" data-testid="task-checklist">
      {items.length > 0 && (
        <div className="ckbar" aria-hidden>
          <i style={{ width: `${(100 * done) / items.length}%` }} />
        </div>
      )}
      {items.map((c, i) => (
        <div key={c.id} className="ckrow">
          <input
            type="checkbox"
            checked={c.done}
            disabled={disabled}
            aria-label={`Done: ${c.text}`}
            onChange={(e) =>
              onChange(items.map((x) => (x.id === c.id ? { ...x, done: e.target.checked } : x)))
            }
          />
          <input
            type="text"
            value={c.text}
            readOnly={disabled}
            aria-label={`Checklist item ${i + 1}`}
            className={c.done ? 'struck' : ''}
            onChange={(e) =>
              onChange(items.map((x) => (x.id === c.id ? { ...x, text: e.target.value } : x)))
            }
          />
          {!disabled && (
            <button
              type="button"
              className="btn ghost sm"
              aria-label={`Remove ${c.text}`}
              onClick={() => onChange(items.filter((x) => x.id !== c.id))}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {!disabled && (
        <div className="ckrow">
          <span style={{ width: 13 }} />
          <input
            type="text"
            value={text}
            placeholder="Add a step, then Enter"
            aria-label="New checklist item"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        </div>
      )}
    </div>
  );
}

function FollowButton({ taskId }: { taskId: string }) {
  const following = useMyFollows().has(taskId);
  const setFollowing = usePeople((s) => s.setFollowing);
  const loadFollows = usePeople((s) => s.loadFollows);
  const follows = usePeople((s) => s.follows);
  const name = usePersonName();
  useEffect(() => {
    void loadFollows();
  }, [loadFollows]);
  const who = follows.filter((f) => f.taskId === taskId).map((f) => name(f.userId));
  return (
    <button
      className={'btn sm' + (following ? ' pri' : '')}
      onClick={() => void setFollowing(taskId, !following)}
      title={who.length ? `Followed by ${who.join(', ')}` : 'Nobody follows this yet'}
      aria-pressed={following}
      data-testid="task-follow"
    >
      {following ? 'Following' : 'Follow'}
      {who.length > 0 && ` · ${who.length}`}
    </button>
  );
}

function Comments({ taskId }: { taskId: string }) {
  const state = useCaseStore((s) => s.state);
  const dispatch = useCaseStore((s) => s.dispatch);
  const canEdit = useCaseStore((s) => s.access.edit);
  const manage = useCaseStore((s) => s.access.manage);
  const me = useCaseStore((s) => s.me);
  const confirm = useUiStore((s) => s.confirm);
  const [text, setText] = useState('');
  const comments = commentsFor(state, taskId);
  const post = async (): Promise<void> => {
    const t = text.trim();
    if (!t) return;
    const actor = currentActor();
    const r = await dispatch({
      type: 'comment.add',
      comment: {
        id: uid('cm'),
        taskId,
        authorId: actor.id,
        authorName: actor.name,
        ts: new Date().toISOString(),
        text: t,
      },
    });
    if (r.ok) setText('');
  };
  return (
    <fieldset className="fs comments" data-testid="task-comments">
      <legend>Comments {comments.length > 0 && `(${comments.length})`}</legend>
      {comments.map((c) => {
        const mine = !me || c.authorId === me.id;
        return (
          <div key={c.id} className="comment">
            <span className="avatar" style={{ background: colorFor(c.authorId || c.authorName) }}>
              {initials(c.authorName) || '?'}
            </span>
            <div>
              <div className="cmeta">
                <b>{c.authorName || 'Someone'}</b> · {c.ts.slice(0, 16).replace('T', ' ')}Z
                {canEdit && (mine || manage) && (
                  <button
                    className="btn ghost sm"
                    aria-label="Delete comment"
                    onClick={() =>
                      confirm(
                        'Delete comment',
                        'Remove this comment? It can be reverted from the history.',
                        'Delete',
                        () => void dispatch({ type: 'comment.remove', id: c.id }),
                        true,
                      )
                    }
                  >
                    ×
                  </button>
                )}
              </div>
              <div className="notetext">{c.text}</div>
            </div>
          </div>
        );
      })}
      {canEdit && (
        <div className="cpost">
          <textarea
            value={text}
            placeholder="Progress, a finding, a question for the lead… (Ctrl+Enter to post)"
            aria-label="New comment"
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void post();
              }
            }}
            data-testid="task-comment-input"
          />
          <button
            className="btn"
            onClick={() => void post()}
            disabled={!text.trim()}
            data-testid="task-comment-post"
          >
            Comment
          </button>
        </div>
      )}
    </fieldset>
  );
}
