import { useState } from 'react';
import { definedKeys, type CaseMeta, type Patch } from '@midden/core';
import { Modal } from './Modal';
import { Field } from './fields';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { toast } from '../store/useToasts';

export function CaseEditor() {
  const original = useCaseStore((s) => s.state.case);
  const dispatch = useCaseStore((s) => s.dispatch);
  const closeModal = useUiStore((s) => s.closeModal);
  const [f, setF] = useState({ ...original });
  const [baseSeq] = useState(() => useCaseStore.getState().seq);
  const set = <K extends keyof CaseMeta>(k: K, v: string): void => setF((x) => ({ ...x, [k]: v }));

  const save = async (): Promise<void> => {
    const patch: Patch<CaseMeta> = {};
    for (const k of ['name', 'number', 'analyst', 'classification', 'summary'] as const)
      if (f[k] !== original[k]) patch[k] = f[k];
    if (definedKeys(patch).length) {
      const r = await dispatch({ type: 'case.set', patch }, { baseSeq });
      if (!r.ok) return;
      toast('Case details saved');
    }
    closeModal();
  };

  return (
    <Modal
      title="Case details"
      onClose={closeModal}
      foot={
        <>
          <span className="sp" />
          <button className="btn ghost" onClick={closeModal}>
            Cancel
          </button>
          <button className="btn pri" onClick={() => void save()}>
            Save details
          </button>
        </>
      }
    >
      <div className="grid2">
        <Field label="Investigation name" htmlFor="cName">
          <input
            type="text"
            id="cName"
            value={f.name}
            placeholder="Operation Glasshouse"
            onChange={(e) => set('name', e.target.value)}
          />
        </Field>
        <Field label="Case number" htmlFor="cNum">
          <input
            type="text"
            id="cNum"
            value={f.number}
            placeholder="IR-2026-0142"
            onChange={(e) => set('number', e.target.value)}
          />
        </Field>
        <Field label="Lead analyst" htmlFor="cAnalyst">
          <input
            type="text"
            id="cAnalyst"
            value={f.analyst}
            onChange={(e) => set('analyst', e.target.value)}
          />
        </Field>
        <Field label="Handling / classification" htmlFor="cClass">
          <input
            type="text"
            id="cClass"
            value={f.classification}
            placeholder="TLP:AMBER+STRICT"
            onChange={(e) => set('classification', e.target.value)}
          />
        </Field>
        <Field label="Executive summary" htmlFor="cSum" span={2}>
          <textarea
            id="cSum"
            style={{ minHeight: 130 }}
            value={f.summary}
            placeholder="What happened, scope, current status…"
            onChange={(e) => set('summary', e.target.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
