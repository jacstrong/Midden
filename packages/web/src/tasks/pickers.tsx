/** Small form controls for task fields: people, teams, runs, cases, labels and status. */
import { useState } from 'react';
import { initials, userColor } from '../lib/format';
import type { TaskState, Workflow } from '@midden/core';
import { useTasks } from './TaskStore';
import type { Names } from './shared';

export function Avatar({ id, names }: { id: string; names: Names }) {
  return (
    <i className="avatar sm" style={{ background: userColor(id) }} title={names.user(id)}>
      {initials(names.user(id))}
    </i>
  );
}

export function UserChip({
  id,
  names,
  onRemove,
}: {
  id: string;
  names: Names;
  onRemove?: () => void;
}) {
  return (
    <span className="uchip" title={names.username(id)}>
      <Avatar id={id} names={names} />
      {names.user(id)}
      {onRemove && (
        <button className="x" onClick={onRemove} aria-label={`Remove ${names.user(id)}`}>
          ✕
        </button>
      )}
    </span>
  );
}

/** Chips for the chosen people and a select to add one more. */
export function PeoplePicker({
  value,
  onAdd,
  onRemove,
  names,
  id,
  disabled,
  label = '+ add…',
}: {
  value: string[];
  onAdd(id: string): void;
  onRemove(id: string): void;
  names: Names;
  id?: string;
  disabled?: boolean;
  label?: string;
}) {
  const left = names.assignable.filter((u) => !value.includes(u.id));
  return (
    <div className="chiprow" style={{ alignItems: 'center' }}>
      {value.map((u) => (
        <UserChip
          key={u}
          id={u}
          names={names}
          {...(disabled ? {} : { onRemove: () => onRemove(u) })}
        />
      ))}
      {!disabled && (
        <select
          id={id}
          className="addsel"
          value=""
          aria-label="Add a person"
          onChange={(e) => e.target.value && onAdd(e.target.value)}
        >
          <option value="">{label}</option>
          {left.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName} ({u.username})
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function TeamSelect({
  value,
  onChange,
  id,
  disabled,
}: {
  value: string;
  onChange(v: string): void;
  id?: string;
  disabled?: boolean;
}) {
  const teams = useTasks((s) => s.directory.teams);
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">No team</option>
      {teams.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
      {value && !teams.some((t) => t.id === value) && <option value={value}>Deleted team</option>}
    </select>
  );
}

export function RunSelect({
  value,
  onChange,
  state,
  id,
  disabled,
}: {
  value: string;
  onChange(v: string): void;
  state: TaskState;
  id?: string;
  disabled?: boolean;
}) {
  const runs = Object.values(state.runs).filter((r) => !r.closed || r.id === value);
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">No run</option>
      {runs.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
          {r.closed ? ' (closed)' : ''}
        </option>
      ))}
    </select>
  );
}

export function CaseSelect({
  value,
  onChange,
  id,
  disabled,
}: {
  value: string;
  onChange(v: string): void;
  id?: string;
  disabled?: boolean;
}) {
  const cases = useTasks((s) => s.directory.cases);
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">No case</option>
      {cases.map((c) => (
        <option key={c.id} value={c.id}>
          {c.number ? `${c.number} · ` : ''}
          {c.name}
          {c.restricted ? ' 🔒' : ''}
        </option>
      ))}
    </select>
  );
}

export function StatusSelect({
  value,
  onChange,
  workflow,
  id,
  disabled,
}: {
  value: string;
  onChange(v: string): void;
  workflow: Workflow | undefined;
  id?: string;
  disabled?: boolean;
}) {
  return (
    <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {(workflow?.statuses ?? []).map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}

/** Comma- or Enter-separated labels, shown as chips. */
export function LabelInput({
  value,
  onChange,
  id,
  disabled,
}: {
  value: string[];
  onChange(v: string[]): void;
  id?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const commit = (): void => {
    const add = draft
      .split(',')
      .map((l) => l.trim())
      .filter((l) => l && !value.includes(l));
    if (add.length) onChange([...value, ...add]);
    setDraft('');
  };
  return (
    <div className="chiprow" style={{ alignItems: 'center' }}>
      {value.map((l) => (
        <span key={l} className="tag lbl">
          {l}
          {!disabled && (
            <button
              className="x"
              aria-label={`Remove label ${l}`}
              onClick={() => onChange(value.filter((x) => x !== l))}
            >
              ✕
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          id={id}
          type="text"
          className="addsel"
          placeholder="+ label"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            }
          }}
        />
      )}
    </div>
  );
}
