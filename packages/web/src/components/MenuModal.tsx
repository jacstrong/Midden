import { Modal } from './Modal';
import { useUiStore } from '../store/useUiStore';
import { useCaseStore } from '../store/useCaseStore';
import {
  exportCsv,
  exportIocs,
  exportJson,
  exportMd,
  loadDemo,
  newCase,
  mergeDemo,
  openCaseFile,
} from '../lib/caseActions';
import { useSession } from '../store/useSession';
import { useRoute } from '../lib/router';

function B({
  label,
  onClick,
  mag,
}: {
  label: string;
  onClick: () => void;
  mag?: boolean | undefined;
}) {
  return (
    <button
      className={'btn' + (mag ? ' mag' : '')}
      style={{ width: '100%', marginBottom: 6 }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function MenuModal() {
  const { closeModal, openModal } = useUiStore();
  const fileBased = useCaseStore((s) => s.capabilities.fileBased);
  const access = useCaseStore((s) => s.access);
  const logout = useSession((s) => s.logout);
  const navigate = useRoute((s) => s.navigate);
  const run = (fn: () => void): void => {
    closeModal();
    fn();
  };
  return (
    <Modal
      title="Case actions"
      onClose={closeModal}
      foot={
        <>
          <span className="sp" />
          <button className="btn pri" onClick={closeModal}>
            Done
          </button>
        </>
      }
    >
      <div className="grid2">
        <div>
          <div className="sbtitle">This investigation</div>
          {access.edit && (
            <B label="Edit case details" onClick={() => openModal({ kind: 'case' })} />
          )}
          {fileBased ? (
            <>
              <B label="Load example case" onClick={() => run(loadDemo)} />
              <B label="Start a new empty case" onClick={() => run(newCase)} mag />
            </>
          ) : (
            <>
              {access.edit && (
                <B
                  label="Merge a case file into this case"
                  onClick={() => run(() => void openCaseFile(null))}
                />
              )}
              {access.edit && <B label="Merge the example case" onClick={() => run(mergeDemo)} />}
              <B label="All cases" onClick={() => run(() => navigate({ kind: 'cases' }))} />
              <B label="Sign out" onClick={() => run(() => void logout())} mag />
            </>
          )}
        </div>
        <div>
          <div className="sbtitle">Export</div>
          <B label="Case file (.json)" onClick={() => run(() => void exportJson())} />
          <B label="Report (.md)" onClick={() => run(exportMd)} />
          <B label="Timeline (.csv)" onClick={() => run(exportCsv)} />
          <B label="Indicator list (.csv)" onClick={() => run(exportIocs)} />
        </div>
      </div>
      <div className="sbtitle" style={{ marginTop: 18 }}>
        How this works
      </div>
      <p style={{ color: 'var(--dim)', lineHeight: 1.8, margin: 0 }}>
        {fileBased ? (
          <>
            Everything is held in this page and in the case file you download — no server, no
            storage, no network calls. Save the .json whenever you want to keep your work, and open
            it again to pick the investigation back up.
          </>
        ) : (
          <>
            Every change is saved to the server as it happens and shared live with everyone else in
            this case. Export a .json to take a copy with you.
          </>
        )}
        <br />
        <br />
        <b style={{ color: 'var(--ink)' }}>Branch graph</b> — one lane per host, ordered by when the
        attacker first touched it. Node colour is the ATT&CK tactic, the ring around it is the host.
        Set “Came from” on an event to draw a magenta branch showing the pivot between systems.
        <br />
        <br />
        <b style={{ color: 'var(--ink)' }}>Timestamps</b> — every event stores the source system’s
        timezone alongside UTC, so you can switch between UTC, your local time, and the time each
        source actually logged.
        <br />
        <br />
        <b style={{ color: 'var(--ink)' }}>Shortcuts</b> — <kbd>N</kbd> new event · <kbd>H</kbd> new
        host · <kbd>/</kbd> search · <kbd>Ctrl</kbd>+<kbd>S</kbd> save case file · <kbd>Esc</kbd>{' '}
        close
      </p>
    </Modal>
  );
}
