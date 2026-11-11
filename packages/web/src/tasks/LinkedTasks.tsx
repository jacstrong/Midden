import { tasksForEvent, tasksForHost, type Task } from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore, type ModalState } from '../store/useUiStore';
import { Avatars, StatusBadge } from './taskUi';

/** The tasks linked to a host or event, shown in its editor, with a way to start a new one. */
export function LinkedTasks({
  targetKind,
  targetId,
  hostId,
}: {
  targetKind: 'host' | 'event';
  targetId: string;
  /** For an event: its host, so a new task is linked to both. */
  hostId?: string | undefined;
}) {
  const state = useCaseStore((s) => s.state);
  const canEdit = useCaseStore((s) => s.access.edit);
  const modal = useUiStore((s) => s.modal);
  const openModal = useUiStore((s) => s.openModal);
  const tasks =
    targetKind === 'host' ? tasksForHost(state, targetId) : tasksForEvent(state, targetId);
  const returnTo: ModalState | undefined = modal.kind === 'none' ? undefined : modal;
  const draft: Partial<Task> =
    targetKind === 'host'
      ? { hostIds: [targetId] }
      : { eventIds: [targetId], hostIds: hostId ? [hostId] : [] };
  if (!tasks.length && !canEdit) return null;
  return (
    <fieldset className="fs" data-testid="linked-tasks">
      <legend>Tasks</legend>
      {tasks.length === 0 && <div className="hint">No work is planned against this yet.</div>}
      {tasks.map((t) => (
        <button
          key={t.id}
          type="button"
          className="linkedtask"
          onClick={() => openModal({ kind: 'task', id: t.id, returnTo })}
        >
          <StatusBadge s={t.status} />
          <span className="lt">{t.title || 'Untitled task'}</span>
          <Avatars ids={t.assignees} max={3} />
        </button>
      ))}
      {canEdit && (
        <button
          type="button"
          className="btn sm"
          style={{ marginTop: 6 }}
          onClick={() => openModal({ kind: 'task', id: null, draft, returnTo })}
          data-testid="linked-task-add"
        >
          + Task for this {targetKind}
        </button>
      )}
    </fieldset>
  );
}
