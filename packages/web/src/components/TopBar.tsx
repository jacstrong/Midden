import { useRef, useState } from 'react';
import { StatusLight } from './StatusLight';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { exportJson, openCaseFile } from '../lib/caseActions';
import { PresenceStrip } from './PresenceStrip';
import { useRoute } from '../lib/router';

function CommitInput({
  id,
  value,
  placeholder,
  onCommit,
  ariaLabel,
  readOnly,
}: {
  id: string;
  value: string;
  placeholder: string;
  onCommit: (v: string) => void;
  ariaLabel: string;
  readOnly?: boolean | undefined;
}) {
  const [v, setV] = useState(value);
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setV(value);
  }
  const commit = (): void => {
    if (v !== value) onCommit(v);
  };
  return (
    <input
      type="text"
      id={id}
      value={v}
      placeholder={placeholder}
      aria-label={ariaLabel}
      readOnly={readOnly}
      onChange={(e) => setV(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

export function TopBar() {
  const c = useCaseStore((s) => s.state.case);
  const dirty = useCaseStore((s) => s.dirty);
  const fileBased = useCaseStore((s) => s.capabilities.fileBased);
  const dispatch = useCaseStore((s) => s.dispatch);
  const access = useCaseStore((s) => s.access);
  const multiUser = useCaseStore((s) => s.capabilities.multiUser);
  const { openModal, setSidebarOpen, sidebarOpen } = useUiStore();
  const navigate = useRoute((s) => s.navigate);
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <header className="topbar">
      <button
        className="btn ghost sbtoggle"
        title="Filters"
        onClick={() => setSidebarOpen(!sidebarOpen)}
      >
        ☰
      </button>
      <div
        className="brand"
        style={multiUser ? { cursor: 'pointer' } : undefined}
        onClick={() => multiUser && navigate({ kind: 'cases' })}
        title={multiUser ? 'All cases' : undefined}
      >
        <StatusLight />
        <b>MIDDEN</b>
        <span>{multiUser ? '← Cases' : 'Attack Reconstruction'}</span>
      </div>
      <div className="caseband">
        <CommitInput
          id="caseName"
          value={c.name}
          placeholder="Untitled investigation"
          ariaLabel="Case name"
          readOnly={!access.edit}
          onCommit={(name) => void dispatch({ type: 'case.set', patch: { name } })}
        />
        <CommitInput
          id="caseNumber"
          value={c.number}
          placeholder="CASE-0000"
          ariaLabel="Case number"
          readOnly={!access.edit}
          onCommit={(number) => void dispatch({ type: 'case.set', patch: { number } })}
        />
        {fileBased && (
          <span className={'dirty' + (dirty ? ' on' : '')} data-testid="dirty">
            ● unsaved
          </span>
        )}
        {multiUser && <PresenceStrip />}
      </div>
      <div className="topact">
        {access.edit && (
          <>
            <button
              className="btn"
              title="Add event (N)"
              onClick={() => openModal({ kind: 'event', id: null })}
              data-testid="btn-new-event"
            >
              + Event
            </button>
            <button
              className="btn"
              title="Add host (H)"
              onClick={() => openModal({ kind: 'host', id: null })}
              data-testid="btn-new-host"
            >
              + Host
            </button>
          </>
        )}
        {fileBased && (
          <>
            <button
              className="btn"
              title="Open a saved case file"
              onClick={() => void openCaseFile(fileInput.current)}
              data-testid="btn-open"
            >
              Open
            </button>
            <button
              className="btn pri"
              title="Download case file (Ctrl+S)"
              onClick={() => void exportJson()}
              data-testid="btn-save"
            >
              Save .json
            </button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              style={{ display: 'none' }}
              data-testid="file-input"
            />
          </>
        )}
        <button
          className="btn ghost"
          title="More"
          onClick={() => openModal({ kind: 'menu' })}
          data-testid="btn-menu"
        >
          ⋯
        </button>
      </div>
    </header>
  );
}
