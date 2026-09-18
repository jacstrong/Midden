import { useEffect, useState } from 'react';
import { useCaseStore } from '../store/useCaseStore';
import { useAutosave } from '../lib/autosave';

type Tone = 'local' | 'ok' | 'bad';

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return new Date(iso).toLocaleTimeString();
}

/**
 * The pulsing light beside the wordmark. Purple: standalone, working from this browser.
 * Green: live connection to the server. Red: the server cannot be reached, so edits are
 * blocked until it can. Hover for the words.
 */
export function StatusLight() {
  const connection = useCaseStore((s) => s.connection);
  const dirty = useCaseStore((s) => s.dirty);
  const fileName = useCaseStore((s) => s.fileName);
  const autosave = useAutosave((s) => s.status);
  // Only so "saved 40s ago" keeps counting while the tab is open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  let tone: Tone;
  let title: string;
  let detail: string;
  // Keyed on the build, not the adapter: a hosted case briefly sits on the local adapter while
  // it loads, and that moment is "connecting", not "standalone".
  if (__MIDDEN_MODE__ === 'standalone') {
    tone = 'local';
    title = 'Standalone';
    const file = fileName
      ? `Case file: ${fileName}${dirty ? ' (changes not yet saved to it)' : ''}`
      : 'No case file yet';
    switch (autosave.kind) {
      case 'saved':
        detail =
          `Your work is kept in this browser (saved ${ago(autosave.at, now)}` +
          (autosave.dropped === 'terrain' ? ', without scan data' : '') +
          `) and comes back if the tab closes or crashes. ${file}. Save a .json to keep a copy elsewhere.`;
        break;
      case 'failed':
        detail = `Could not keep your work in this browser: ${autosave.reason}. Save a .json file to be safe. ${file}.`;
        break;
      case 'unavailable':
        detail = `This browser will not keep your work between loads: ${autosave.reason}. Save a .json file to be safe. ${file}.`;
        break;
      default:
        detail = `Working from this browser with no server. Changes are kept here as you make them. ${file}.`;
    }
  } else if (connection === 'online') {
    tone = 'ok';
    title = 'Connected';
    detail =
      'Live connection to the server. Changes save as you make them and reach everyone in this case.';
  } else if (connection === 'connecting') {
    tone = 'bad';
    title = 'Connecting';
    detail = 'Reaching the server… Editing is held until the connection is up.';
  } else {
    tone = 'bad';
    title = 'Not connected';
    detail =
      'The server cannot be reached. Editing is blocked until the connection returns; you will catch up automatically when it does.';
  }
  const failing =
    __MIDDEN_MODE__ === 'standalone' &&
    (autosave.kind === 'failed' || autosave.kind === 'unavailable');
  return (
    <span
      className={`light ${tone}${failing ? ' warn' : ''}`}
      data-testid="status-light"
      data-tone={tone}
      role="status"
      aria-label={`${title}: ${detail}`}
    >
      <i className="dot" />
      <span className="tip" role="tooltip">
        <span className="tiptitle">{title}</span>
        {detail}
      </span>
    </span>
  );
}
