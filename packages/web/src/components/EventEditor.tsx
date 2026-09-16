import { useMemo, useState } from 'react';
import {
  browserOffset,
  CONFIDENCE,
  DATA_SOURCES,
  definedKeys,
  distinctIocTypes,
  distinctSources,
  distinctUsers,
  fmtParts,
  IOC_TYPES,
  isoInput,
  parseTimestamp,
  PRIVS,
  SEVERITY,
  TACTICS,
  TACTIC_BY_ID,
  TECHNIQUE_NAME,
  toEpoch,
  TZ_OPTIONS,
  uid,
  type Event,
  type EventFields,
  type Patch,
} from '@midden/core';
import { Modal } from './Modal';
import { Datalist, Field, Fieldset } from './fields';
import { Attachments } from './Attachments';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { toast } from '../store/useToasts';
import { deleteEvent } from '../lib/caseActions';
import { useSortedEvents } from '../lib/selectors';

export interface EventEditorProps {
  id: string | null;
  draft?: Partial<Event> | undefined;
}

interface Form {
  tsText: string;
  offChoice: string;
  hostId: string;
  srcHostId: string;
  user: string;
  priv: string;
  activity: string;
  cmd: string;
  itype: string;
  indicator: string;
  tactic: string;
  technique: string;
  conf: Event['conf'];
  sev: Event['sev'];
  tags: string;
  source: string;
  link: string;
  evidence: string;
  notes: string;
  key: boolean;
}

function blankEvent(prevHostId: string): Event {
  return {
    id: uid('ev'),
    ts: new Date().toISOString(),
    off: 0,
    hostId: prevHostId,
    srcHostId: '',
    user: '',
    priv: '',
    indicator: '',
    itype: '',
    activity: '',
    cmd: '',
    tactic: '',
    technique: '',
    source: '',
    link: '',
    conf: 'medium',
    sev: 'medium',
    key: false,
    tags: [],
    evidence: '',
    notes: '',
  };
}

function toForm(e: Event): Form {
  return {
    tsText: isoInput(e),
    offChoice: String(e.off),
    hostId: e.hostId,
    srcHostId: e.srcHostId,
    user: e.user,
    priv: e.priv,
    activity: e.activity,
    cmd: e.cmd,
    itype: e.itype,
    indicator: e.indicator,
    tactic: e.tactic,
    technique: e.technique,
    conf: e.conf,
    sev: e.sev,
    tags: e.tags.join(', '),
    source: e.source,
    link: e.link,
    evidence: e.evidence,
    notes: e.notes,
    key: e.key,
  };
}

/** Form → event fields. `ts` is null when the timestamp text is unparseable. */
export function fromForm(f: Form): { fields: EventFields; tsOk: boolean } {
  const off = f.offChoice === 'local' ? browserOffset() : +f.offChoice || 0;
  const ts = parseTimestamp(f.tsText, f.offChoice === 'local' ? 'local' : off);
  return {
    tsOk: ts !== null,
    fields: {
      ts: ts ?? '',
      off,
      hostId: f.hostId,
      srcHostId: f.srcHostId,
      user: f.user.trim(),
      priv: f.priv.trim(),
      activity: f.activity.trim(),
      cmd: f.cmd,
      itype: f.itype.trim(),
      indicator: f.indicator.trim(),
      tactic: f.tactic,
      technique: f.technique,
      conf: f.conf,
      sev: f.sev,
      tags: f.tags
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      source: f.source.trim(),
      link: f.link.trim(),
      evidence: f.evidence.trim(),
      notes: f.notes,
      key: f.key,
    },
  };
}

function withoutId(e: Event): Partial<Event> {
  const { id: _id, ...rest } = e;
  return rest;
}

/** Only the keys whose values differ from the original: the minimal patch. */
export function diffFields(original: Event, next: EventFields): Patch<EventFields> {
  const patch: Patch<EventFields> = {};
  for (const k of Object.keys(next) as (keyof EventFields)[]) {
    const a = original[k];
    const b = next[k];
    // timestamps compare by instant so "…52Z" and "…52.000Z" are not a change
    const same =
      k === 'ts'
        ? toEpoch(a as string) === toEpoch(b as string)
        : Array.isArray(a) && Array.isArray(b)
          ? a.length === b.length && a.every((x, i) => x === b[i])
          : a === b;
    if (!same) (patch as Record<string, unknown>)[k] = b;
  }
  return patch;
}

export function EventEditor({ id, draft }: EventEditorProps) {
  const state = useCaseStore((s) => s.state);
  const dispatch = useCaseStore((s) => s.dispatch);
  const touches = useCaseStore((s) => (id ? s.remoteTouches[id] : undefined));
  const clearTouches = useCaseStore((s) => s.clearTouches);
  const canEdit = useCaseStore((s) => s.access.edit);
  const { closeModal, openModal, select } = useUiStore();
  const sorted = useSortedEvents();
  const isNew = !id;
  const original = useMemo<Event>(() => {
    const base = id ? state.events[id] : undefined;
    const prev = sorted[sorted.length - 1];
    const seed = base ?? blankEvent(prev?.hostId ?? Object.keys(state.hosts)[0] ?? '');
    return draft ? { ...seed, ...draft, id: seed.id } : seed;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  const [form, setForm] = useState<Form>(() => toForm(original));
  const [baseSeq] = useState(() => useCaseStore.getState().seq);
  const [tsErr, setTsErr] = useState('');
  const set = <K extends keyof Form>(k: K, v: Form[K]): void => setForm((f) => ({ ...f, [k]: v }));

  const techniques = TACTIC_BY_ID[form.tactic]?.tech ?? [];
  const techMissing = form.technique && !techniques.some((p) => p[0] === form.technique);
  const users = distinctUsers(sorted);
  const types = [...new Set([...IOC_TYPES, ...distinctIocTypes(sorted)])].sort();
  const sources = [...new Set([...DATA_SOURCES, ...distinctSources(sorted)])].sort();

  const currentFields = (): Event => ({ ...original, ...fromForm(form).fields });

  const save = async (): Promise<void> => {
    const { fields, tsOk } = fromForm(form);
    if (!tsOk) {
      setTsErr('Timestamp not recognised — try 2026-07-14 13:02:41');
      return;
    }
    if (isNew) {
      const r = await dispatch(
        { type: 'event.add', event: { ...fields, id: original.id } },
        { baseSeq },
      );
      if (!r.ok) return;
      toast('Event added');
    } else {
      const patch = diffFields(original, fields);
      if (definedKeys(patch).length) {
        const r = await dispatch({ type: 'event.set', id: original.id, patch }, { baseSeq });
        if (!r.ok) return;
        toast('Event updated');
      }
    }
    closeModal();
    clearTouches(original.id);
    if (useUiStore.getState().sel !== original.id) select(original.id);
  };
  const close = (): void => {
    clearTouches(original.id);
    closeModal();
  };
  const mark = (field: string): { className?: string; title?: string } =>
    touches?.[field]
      ? {
          className: 'changed',
          title: `Changed by ${touches[field]!.by.name} while you were editing`,
        }
      : {};

  const addHost = (): void => {
    const current = currentFields();
    openModal({
      kind: 'host',
      id: null,
      after: (newId) => openModal({ kind: 'event', id, draft: { ...current, hostId: newId } }),
      returnTo: { kind: 'event', id, draft: current },
    });
  };

  const setNow = (): void => {
    const o = form.offChoice === 'local' ? browserOffset() : +form.offChoice || 0;
    const p = fmtParts(Date.now(), o);
    set('tsText', p.date + ' ' + p.time);
  };

  const hostOptions = (blank: string) => (
    <>
      <option value="">{blank}</option>
      {Object.values(state.hosts).map((h) => (
        <option key={h.id} value={h.id}>
          {h.name}
          {h.ip ? ` (${h.ip})` : ''}
        </option>
      ))}
    </>
  );

  return (
    <Modal
      title={isNew ? 'Add event' : 'Edit event'}
      onClose={close}
      head={
        !isNew &&
        canEdit && (
          <>
            <button
              className="btn sm ghost"
              onClick={() =>
                openModal({
                  kind: 'event',
                  id: null,
                  draft: withoutId(currentFields()),
                })
              }
            >
              Duplicate
            </button>
            <button
              className="btn sm mag"
              onClick={() => {
                closeModal();
                deleteEvent(original.id);
              }}
            >
              Delete
            </button>
          </>
        )
      }
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn pri"
            onClick={() => void save()}
            data-testid="event-save"
            disabled={!canEdit}
          >
            {isNew ? 'Add event' : 'Save changes'}
          </button>
        </>
      }
    >
      <Datalist id="dlUsers" values={users} />
      <Datalist id="dlPriv" values={PRIVS} />
      <Datalist id="dlIoc" values={types} />
      <Datalist id="dlSrc" values={sources} />

      <Fieldset legend="When" cols={3}>
        <Field
          label="Timestamp"
          htmlFor="eTs"
          span={2}
          hint={<>ISO, YYYY-MM-DD HH:MM:SS, US format, or epoch seconds/ms</>}
          error={tsErr}
        >
          <div className="inline">
            <input
              type="text"
              id="eTs"
              value={form.tsText}
              placeholder="2026-07-14 13:02:41"
              onChange={(e) => set('tsText', e.target.value)}
            />
            <button className="btn sm" type="button" onClick={setNow}>
              Now
            </button>
          </div>
        </Field>
        <Field label="Source timezone" htmlFor="eOff" hint="How the source system logged it">
          <select
            id="eOff"
            value={form.offChoice}
            onChange={(e) => set('offChoice', e.target.value)}
          >
            {TZ_OPTIONS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
      </Fieldset>

      <Fieldset legend="Where & who" cols={3}>
        <Field
          label="Host / target"
          htmlFor="eHost"
          hint={
            <a
              href="#"
              className="src"
              onClick={(ev) => {
                ev.preventDefault();
                addHost();
              }}
            >
              + add a new host
            </a>
          }
        >
          <select id="eHost" value={form.hostId} onChange={(e) => set('hostId', e.target.value)}>
            {hostOptions('— unassigned —')}
          </select>
        </Field>
        <Field label="Came from (pivot source)" htmlFor="eSrc" hint="Draws a branch in the graph">
          <select
            id="eSrc"
            value={form.srcHostId}
            onChange={(e) => set('srcHostId', e.target.value)}
          >
            {hostOptions('— not a pivot —')}
          </select>
        </Field>
        <Field label="Account" htmlFor="eUser">
          <input
            type="text"
            id="eUser"
            value={form.user}
            list="dlUsers"
            placeholder="CORP\j.reyes"
            onChange={(e) => set('user', e.target.value)}
            {...mark('user')}
          />
        </Field>
        <Field label="Privilege" htmlFor="ePriv">
          <input
            type="text"
            id="ePriv"
            value={form.priv}
            list="dlPriv"
            placeholder="domain admin"
            onChange={(e) => set('priv', e.target.value)}
          />
        </Field>
        <Field label="Activity" htmlFor="eAct" span={2}>
          <input
            type="text"
            id="eAct"
            value={form.activity}
            placeholder="LSASS memory dumped via comsvcs.dll"
            onChange={(e) => set('activity', e.target.value)}
            {...mark('activity')}
          />
        </Field>
        <Field label="Command line / raw detail" htmlFor="eCmd" span={3}>
          <textarea
            id="eCmd"
            value={form.cmd}
            placeholder="rundll32.exe C:\Windows\System32\comsvcs.dll, MiniDump 712 C:\ProgramData\lsass.dmp full"
            onChange={(e) => set('cmd', e.target.value)}
          />
        </Field>
      </Fieldset>

      <Fieldset legend="Indicator" cols={3}>
        <Field label="Type" htmlFor="eIType">
          <input
            type="text"
            id="eIType"
            value={form.itype}
            list="dlIoc"
            placeholder="sha256"
            onChange={(e) => set('itype', e.target.value)}
          />
        </Field>
        <Field label="Value" htmlFor="eInd" span={2}>
          <input
            type="text"
            id="eInd"
            value={form.indicator}
            placeholder="185.243.115.44"
            onChange={(e) => set('indicator', e.target.value)}
          />
        </Field>
      </Fieldset>

      <Fieldset legend="Classification" cols={3}>
        <Field label="Tactic" htmlFor="eTac">
          <select
            id="eTac"
            value={form.tactic}
            onChange={(e) => {
              set('tactic', e.target.value);
              set('technique', '');
            }}
          >
            <option value="">— none —</option>
            {TACTICS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} · {t.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Technique" htmlFor="eTech" span={2}>
          <select
            id="eTech"
            value={form.technique}
            onChange={(e) => set('technique', e.target.value)}
          >
            <option value="">— none —</option>
            {techniques.map((p) => (
              <option key={p[0]} value={p[0]}>
                {p[0]} · {p[1]}
              </option>
            ))}
            {techMissing && (
              <option value={form.technique}>
                {form.technique}
                {TECHNIQUE_NAME[form.technique] ? ' · ' + TECHNIQUE_NAME[form.technique] : ''}
              </option>
            )}
          </select>
        </Field>
        <Field label="Confidence" htmlFor="eConf">
          <select
            id="eConf"
            value={form.conf}
            onChange={(e) => set('conf', e.target.value as Event['conf'])}
          >
            {CONFIDENCE.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Severity" htmlFor="eSev">
          <select
            id="eSev"
            value={form.sev}
            onChange={(e) => set('sev', e.target.value as Event['sev'])}
          >
            {SEVERITY.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tags" htmlFor="eTags">
          <input
            type="text"
            id="eTags"
            value={form.tags}
            placeholder="ransomware, patient-zero"
            onChange={(e) => set('tags', e.target.value)}
          />
        </Field>
      </Fieldset>

      <Fieldset legend="Evidence" cols={3}>
        <Field label="Data source" htmlFor="eSource">
          <input
            type="text"
            id="eSource"
            value={form.source}
            list="dlSrc"
            placeholder="Splunk"
            onChange={(e) => set('source', e.target.value)}
          />
        </Field>
        <Field label="Link to source record" htmlFor="eLink" span={2}>
          <input
            type="url"
            id="eLink"
            value={form.link}
            placeholder="https://splunk.corp/app/search/…"
            onChange={(e) => set('link', e.target.value)}
          />
        </Field>
        <Field label="Evidence reference" htmlFor="eEvid" span={3}>
          <input
            type="text"
            id="eEvid"
            value={form.evidence}
            placeholder="EVID-014 · triage collection WKS-FIN-014 2026-07-15"
            onChange={(e) => set('evidence', e.target.value)}
          />
        </Field>
        <Field label="Analyst notes" htmlFor="eNotes" span={3}>
          <textarea
            id="eNotes"
            value={form.notes}
            placeholder="Why this matters, what is still unverified, follow-up needed…"
            onChange={(e) => set('notes', e.target.value)}
            {...mark('notes')}
          />
        </Field>
        <div className="field span3">
          <label className="ck">
            <input
              type="checkbox"
              id="eKey"
              checked={form.key}
              onChange={(e) => set('key', e.target.checked)}
            />{' '}
            Flag as a key event in the attack narrative
          </label>
        </div>
      </Fieldset>
      {!isNew && <Attachments targetKind="event" targetId={original.id} />}
      {touches && Object.keys(touches).length > 0 && (
        <div className="changed-note" data-testid="remote-changed">
          {[...new Set(Object.values(touches).map((t) => t.by.name))].join(', ')} changed{' '}
          {Object.keys(touches).join(', ')} while this was open. Saving keeps your values for the
          fields you edited.
        </div>
      )}
      {!isNew && (
        <div className="hint">
          Raw timestamp <code>{original.ts}</code> · epoch {toEpoch(original.ts)}
        </div>
      )}
    </Modal>
  );
}
