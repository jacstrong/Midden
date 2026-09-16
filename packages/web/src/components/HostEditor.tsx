import { useMemo, useState } from 'react';
import {
  CRITICALITY,
  definedKeys,
  HOST_STATUS,
  uid,
  type Host,
  type HostFields,
  type Patch,
} from '@midden/core';
import { Modal } from './Modal';
import { Field } from './fields';
import { Attachments } from './Attachments';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore, type ModalState } from '../store/useUiStore';
import { toast } from '../store/useToasts';
import { deleteHost } from '../lib/caseActions';

export interface HostEditorProps {
  id: string | null;
  after?: ((id: string) => void) | undefined;
  returnTo?: ModalState | undefined;
}

function blankHost(): Host {
  return {
    id: uid('h'),
    name: '',
    ip: '',
    os: '',
    role: '',
    zone: '',
    crit: 'moderate',
    status: 'suspect',
    owner: '',
    tags: [],
    notes: '',
  };
}

export function diffHost(original: Host, next: HostFields): Patch<HostFields> {
  const patch: Patch<HostFields> = {};
  for (const k of Object.keys(next) as (keyof HostFields)[]) {
    const a = original[k];
    const b = next[k];
    const same =
      Array.isArray(a) && Array.isArray(b)
        ? a.length === b.length && a.every((x, i) => x === b[i])
        : a === b;
    if (!same) (patch as Record<string, unknown>)[k] = b;
  }
  return patch;
}

export function HostEditor({ id, after, returnTo }: HostEditorProps) {
  const state = useCaseStore((s) => s.state);
  const dispatch = useCaseStore((s) => s.dispatch);
  const touches = useCaseStore((s) => (id ? s.remoteTouches[id] : undefined));
  const clearTouches = useCaseStore((s) => s.clearTouches);
  const canEdit = useCaseStore((s) => s.access.edit);
  const { closeModal, openModal } = useUiStore();
  const isNew = !id;
  const original = useMemo<Host>(() => (id ? state.hosts[id] : undefined) ?? blankHost(), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState({ ...original, tags: original.tags.join(', ') });
  const [baseSeq] = useState(() => useCaseStore.getState().seq);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]): void =>
    setF((x) => ({ ...x, [k]: v }));

  const cancel = (): void => {
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
    const fields: HostFields = {
      name: f.name.trim() || 'UNNAMED-' + original.id.slice(-4),
      ip: f.ip.trim(),
      os: f.os.trim(),
      role: f.role.trim(),
      zone: f.zone.trim(),
      owner: f.owner.trim(),
      status: f.status,
      crit: f.crit,
      tags: f.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      notes: f.notes,
    };
    if (isNew) {
      const r = await dispatch(
        { type: 'host.add', host: { ...fields, id: original.id } },
        { baseSeq },
      );
      if (!r.ok) return;
      toast('Host added');
    } else {
      const patch = diffHost(original, fields);
      if (definedKeys(patch).length) {
        const r = await dispatch({ type: 'host.set', id: original.id, patch }, { baseSeq });
        if (!r.ok) return;
        toast('Host updated');
      }
    }
    clearTouches(original.id);
    closeModal();
    after?.(original.id);
  };

  return (
    <Modal
      title={isNew ? 'Add host' : 'Edit host'}
      onClose={cancel}
      head={
        !isNew &&
        canEdit && (
          <button
            className="btn sm mag"
            onClick={() => {
              closeModal();
              deleteHost(original.id);
            }}
          >
            Delete
          </button>
        )
      }
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={cancel}>
            Cancel
          </button>
          <button
            className="btn pri"
            onClick={() => void save()}
            data-testid="host-save"
            disabled={!canEdit}
          >
            {isNew ? 'Add host' : 'Save changes'}
          </button>
        </>
      }
    >
      {!isNew && <Attachments targetKind="host" targetId={original.id} />}
      {touches && Object.keys(touches).length > 0 && (
        <div className="changed-note" data-testid="remote-changed">
          {[...new Set(Object.values(touches).map((t) => t.by.name))].join(', ')} changed{' '}
          {Object.keys(touches).join(', ')} while this was open.
        </div>
      )}
      <div className="grid3">
        <Field label="Hostname" htmlFor="hName">
          <input
            type="text"
            id="hName"
            value={f.name}
            placeholder="WKS-FIN-014"
            onChange={(e) => set('name', e.target.value)}
            {...mark('name')}
          />
        </Field>
        <Field label="IP address(es)" htmlFor="hIp">
          <input
            type="text"
            id="hIp"
            value={f.ip}
            placeholder="10.20.4.31"
            onChange={(e) => set('ip', e.target.value)}
          />
        </Field>
        <Field label="Operating system" htmlFor="hOs">
          <input
            type="text"
            id="hOs"
            value={f.os}
            placeholder="Windows 11 23H2"
            onChange={(e) => set('os', e.target.value)}
          />
        </Field>
        <Field label="Function" htmlFor="hRole">
          <input
            type="text"
            id="hRole"
            value={f.role}
            placeholder="Finance workstation"
            onChange={(e) => set('role', e.target.value)}
          />
        </Field>
        <Field label="Network zone" htmlFor="hZone">
          <input
            type="text"
            id="hZone"
            value={f.zone}
            placeholder="Corp / VLAN 20"
            onChange={(e) => set('zone', e.target.value)}
          />
        </Field>
        <Field label="Owner / custodian" htmlFor="hOwner">
          <input
            type="text"
            id="hOwner"
            value={f.owner}
            placeholder="J. Reyes, Finance"
            onChange={(e) => set('owner', e.target.value)}
          />
        </Field>
        <Field label="Status" htmlFor="hStatus">
          <select
            id="hStatus"
            value={f.status}
            onChange={(e) => set('status', e.target.value as Host['status'])}
            {...mark('status')}
          >
            {HOST_STATUS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Business criticality" htmlFor="hCrit">
          <select
            id="hCrit"
            value={f.crit}
            onChange={(e) => set('crit', e.target.value as Host['crit'])}
          >
            {CRITICALITY.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags" htmlFor="hTags">
          <input
            type="text"
            id="hTags"
            value={f.tags}
            placeholder="pci, isolated"
            onChange={(e) => set('tags', e.target.value)}
          />
        </Field>
        <Field label="Notes" htmlFor="hNotes" span={3}>
          <textarea
            id="hNotes"
            value={f.notes}
            placeholder="Containment actions, imaging status, open questions…"
            onChange={(e) => set('notes', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
