/** Small pieces shared by the board, the task editor and the task dialogs. */
import { useState } from 'react';
import {
  byId,
  fmtParts,
  TASK_PRIORITY,
  TASK_STATUS,
  type CaseState,
  type TaskPriority,
  type TaskStatus,
  type TzMode,
} from '@midden/core';
import { colorFor, initials, trunc } from '../lib/format';
import { usePeople, usePersonName } from '../store/usePeople';
import { useCaseStore } from '../store/useCaseStore';

export const STATUS_BY_ID = byId(TASK_STATUS);
export const PRIORITY_BY_ID = byId(TASK_PRIORITY);

export function PriorityBadge({ p, always = false }: { p: TaskPriority; always?: boolean }) {
  if (p === 'normal' && !always) return null;
  const x = PRIORITY_BY_ID[p];
  return (
    <span className="badge" style={{ color: x.color }} data-testid="task-priority">
      {x.label}
    </span>
  );
}

export function StatusBadge({ s }: { s: TaskStatus }) {
  const x = STATUS_BY_ID[s];
  return (
    <span className="badge" style={{ color: x.color }}>
      {x.label}
    </span>
  );
}

export function Avatars({ ids, max = 4 }: { ids: readonly string[]; max?: number }) {
  const name = usePersonName();
  if (!ids.length) return null;
  return (
    <span className="avatars">
      {ids.slice(0, max).map((id) => (
        <span
          key={id}
          className="avatar"
          style={{ background: colorFor(id) }}
          title={name(id)}
          aria-label={name(id)}
        >
          {initials(name(id)) || '?'}
        </span>
      ))}
      {ids.length > max && <span className="avatar more">+{ids.length - max}</span>}
    </span>
  );
}

/** Due dates read in the case's chosen clock; "source" has no meaning for a deadline, so it reads as UTC. */
export function fmtDue(iso: string, tz: TzMode): string {
  const ep = Date.parse(iso);
  if (!Number.isFinite(ep)) return '';
  const off = tz === 'local' ? -new Date(ep).getTimezoneOffset() : 0;
  const p = fmtParts(ep, off);
  return `${p.date} ${p.time.slice(0, 5)}${tz === 'local' ? '' : 'Z'}`;
}

/** ISO instant to the value of a datetime-local input (browser time) and back. */
export function isoToLocalInput(iso: string): string {
  const ep = Date.parse(iso);
  if (!Number.isFinite(ep)) return '';
  const d = new Date(ep - new Date(ep).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
export function localInputToIso(v: string): string {
  if (!v) return '';
  const ep = new Date(v).getTime();
  return Number.isFinite(ep) ? new Date(ep).toISOString() : '';
}

interface Option {
  id: string;
  label: string;
}

/**
 * Chips for what is chosen and a select to add more. `free` allows typed values, for standalone
 * assignees, which are names rather than accounts.
 */
export function ChipPicker({
  id,
  value,
  options,
  onChange,
  placeholder,
  free = false,
  disabled = false,
  testId,
}: {
  id: string;
  value: readonly string[];
  options: readonly Option[];
  onChange: (next: string[]) => void;
  placeholder: string;
  free?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const [typed, setTyped] = useState('');
  const label = new Map(options.map((o) => [o.id, o.label]));
  const remaining = options.filter((o) => !value.includes(o.id));
  const addTyped = (): void => {
    const v = typed.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setTyped('');
  };
  return (
    <div className="chippick" data-testid={testId}>
      {value.map((v) => (
        <span key={v} className="pchip">
          {trunc(label.get(v) ?? v, 48)}
          {!disabled && (
            <button
              type="button"
              aria-label={`Remove ${label.get(v) ?? v}`}
              onClick={() => onChange(value.filter((x) => x !== v))}
            >
              ×
            </button>
          )}
        </span>
      ))}
      {!disabled &&
        (free ? (
          <>
            <input
              type="text"
              id={id}
              value={typed}
              list={`${id}-list`}
              placeholder={placeholder}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={addTyped}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addTyped();
                }
              }}
            />
            <datalist id={`${id}-list`}>
              {remaining.map((o) => (
                <option key={o.id} value={o.id} />
              ))}
            </datalist>
          </>
        ) : (
          <select
            id={id}
            value=""
            onChange={(e) => e.target.value && onChange([...value, e.target.value])}
            disabled={!remaining.length}
          >
            <option value="">{remaining.length ? placeholder : 'Nothing more to add'}</option>
            {remaining.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
    </div>
  );
}

/** People who can take a task: accounts when hosted, names already in use when standalone. */
export function usePeopleOptions(): { options: Option[]; free: boolean } {
  const people = usePeople((s) => s.people);
  const multiUser = useCaseStore((s) => s.capabilities.multiUser);
  const tasks = useCaseStore((s) => s.state.tasks);
  if (multiUser)
    return { options: people.map((p) => ({ id: p.id, label: p.displayName })), free: false };
  const names = new Set<string>();
  for (const t of Object.values(tasks)) for (const a of t.assignees) names.add(a);
  return { options: [...names].sort().map((n) => ({ id: n, label: n })), free: true };
}

export const hostOptions = (state: CaseState): Option[] =>
  Object.values(state.hosts)
    .map((h) => ({ id: h.id, label: h.ip ? `${h.name} (${trunc(h.ip, 24)})` : h.name }))
    .sort((a, b) => a.label.localeCompare(b.label));

export const eventOptions = (state: CaseState): Option[] =>
  Object.values(state.events)
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .map((e) => ({
      id: e.id,
      label: `${e.ts.slice(0, 16).replace('T', ' ')} ${trunc(e.activity || e.indicator || e.id, 60)}`,
    }));
