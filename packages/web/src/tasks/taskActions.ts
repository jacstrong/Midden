/** Task actions shared by the board, the editor and the dialogs. */
import {
  duplicateTasksOp,
  fileStamp,
  normalizeState,
  planTaskImport,
  removeTasksOp,
  slug,
  taskTemplateCsv,
  uid,
  writeTaskTemplate,
  type CaseState,
  type TaskActor,
  type TemplateNames,
  type TemplateTask,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { usePeople, type Person } from '../store/usePeople';
import { useUiStore } from '../store/useUiStore';
import { useTaskBoard } from '../store/useTaskBoard';
import { toast } from '../store/useToasts';
import { downloadText } from '../lib/download';
import { api } from '../lib/api';

/** Who to record as a task's creator. Standalone has no accounts, so it uses the case analyst. */
export function currentActor(): TaskActor {
  const cs = useCaseStore.getState();
  return cs.me ?? { id: '', name: cs.state.case.analyst || 'Analyst' };
}

/** Templates name people by username when hosted, and by the typed name when standalone. */
export function templateNames(): TemplateNames {
  const byId = new Map(usePeople.getState().people.map((p) => [p.id, p.username]));
  return { user: (id) => byId.get(id) ?? id };
}

/** Match a template's person by username or display name; standalone keeps the name itself. */
export function userResolver(
  people: readonly Person[],
  multiUser: boolean,
): (ref: string) => string | null {
  if (!multiUser) return (ref) => ref.trim() || null;
  const byKey = new Map<string, string>();
  for (const p of people) {
    byKey.set(p.username.toLowerCase(), p.id);
    if (!byKey.has(p.displayName.toLowerCase())) byKey.set(p.displayName.toLowerCase(), p.id);
  }
  return (ref) => byKey.get(ref.trim().toLowerCase()) ?? null;
}

export function exportTasks(ids: readonly string[], format: 'json' | 'csv'): void {
  const cs = useCaseStore.getState();
  const file = writeTaskTemplate(cs.state, ids, templateNames(), {
    generator: `MIDDEN ${__MIDDEN_VERSION__}`,
  });
  const base = `${slug(cs.state.case.number || cs.state.case.name) || 'case'}_tasks_${fileStamp()}`;
  if (format === 'csv')
    downloadText(`${base}.csv`, taskTemplateCsv(file.tasks), 'text/csv;charset=utf-8');
  else downloadText(`${base}.json`, JSON.stringify(file, null, 2));
  toast(`Exported ${file.tasks.length} task${file.tasks.length === 1 ? '' : 's'}`);
}

export function deleteTasks(ids: readonly string[], after?: () => void): void {
  const n = ids.length;
  useUiStore.getState().confirm(
    n === 1 ? 'Delete task' : `Delete ${n} tasks`,
    `${n === 1 ? 'This task and its comments' : `These ${n} tasks and their comments`} will be removed. The history keeps a record, and the deletion can be reverted.`,
    'Delete',
    () => {
      const cs = useCaseStore.getState();
      void cs.dispatch(removeTasksOp(cs.state, ids)).then((r) => {
        if (!r.ok) return;
        useTaskBoard.getState().clearSelection();
        toast(n === 1 ? 'Task deleted' : `${n} tasks deleted`);
        after?.();
      });
    },
    true,
  );
}

export async function duplicateTasks(ids: readonly string[]): Promise<string[]> {
  const cs = useCaseStore.getState();
  const { op, ids: created } = duplicateTasksOp(cs.state, ids, currentActor());
  const r = await cs.dispatch(op);
  if (!r.ok) return [];
  toast(created.length === 1 ? 'Task duplicated' : `${created.length} tasks duplicated`);
  useTaskBoard.getState().selectOnly(created);
  return created;
}

export interface CopyResult {
  created: number;
  unresolvedUsers: string[];
  unresolvedHosts: string[];
}

/** Copy tasks into another case, matching people by username and hosts by name or address there. */
export async function copyTasksToCase(
  ids: readonly string[],
  targetCaseId: string,
): Promise<CopyResult> {
  const cs = useCaseStore.getState();
  const tasks: TemplateTask[] = writeTaskTemplate(cs.state, ids, templateNames()).tasks;
  const [{ state }, { people }] = await Promise.all([
    api<{ state: CaseState }>('GET', `/api/cases/${targetCaseId}/state`),
    api<{ people: Person[] }>('GET', `/api/cases/${targetCaseId}/people`),
  ]);
  const plan = planTaskImport(normalizeState(state), tasks, {
    actor: currentActor(),
    resolveUser: userResolver(people, true),
  });
  await api('POST', `/api/cases/${targetCaseId}/ops`, { op: plan.op, clientOpId: uid('op') });
  return {
    created: plan.ids.length,
    unresolvedUsers: plan.unresolvedUsers,
    unresolvedHosts: plan.unresolvedHosts,
  };
}
