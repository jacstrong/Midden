/**
 * Standalone autosave. The .json file is still the document an analyst keeps, but nobody
 * should lose an afternoon to a crashed tab, so every change is also written to localStorage
 * and restored on the next load. The saved form is the same v2 case file the Save button
 * writes, so restore is the same codec as opening a file.
 *
 * localStorage is small (a few megabytes) and a /16 of terrain is not. On a quota error the
 * save is retried without terrain, and the status says so, so the analyst knows to save the
 * file to keep the scans.
 */
import { create } from 'zustand';
import { readCaseFile, writeCaseFile, type ParsedCaseFile } from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useTerrain } from '../store/useTerrain';
import { MemoryTerrain } from './terrain';

export const AUTOSAVE_KEY = 'midden.standalone.autosave.v1';
const DEBOUNCE_MS = 400;

interface Envelope {
  savedAt: string;
  fileName: string | null;
  /** Whether the work had been saved to a .json file at the time. */
  dirty: boolean;
  file: unknown;
}

export type AutosaveStatus =
  | { kind: 'idle' }
  | { kind: 'saved'; at: string; dropped: 'nothing' | 'terrain' }
  | { kind: 'failed'; reason: string }
  | { kind: 'unavailable'; reason: string };

interface AutosaveState {
  status: AutosaveStatus;
}
export const useAutosave = create<AutosaveState>(() => ({ status: { kind: 'idle' } }));

function storage(): Storage | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    // A private window or blocked storage can expose the object and then throw on use.
    s.getItem(AUTOSAVE_KEY);
    return s;
  } catch {
    return null;
  }
}

function isQuotaError(err: unknown): boolean {
  return (
    err instanceof DOMException &&
    (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
  );
}

/** Write the current case now. Exported so a page-hide can flush without waiting for the debounce. */
export function saveNow(): void {
  const s = storage();
  if (!s) {
    useAutosave.setState({
      status: { kind: 'unavailable', reason: 'this browser does not allow local storage here' },
    });
    return;
  }
  const cs = useCaseStore.getState();
  const terrain = useTerrain.getState().store;
  const scans = terrain instanceof MemoryTerrain ? terrain.all() : undefined;
  for (const dropped of ['nothing', 'terrain'] as const) {
    const file = writeCaseFile(cs.state, {
      generator: `MIDDEN ${__MIDDEN_VERSION__} autosave`,
      terrain: dropped === 'nothing' ? scans : undefined,
    });
    const envelope: Envelope = {
      savedAt: new Date().toISOString(),
      fileName: cs.fileName,
      dirty: cs.dirty,
      file,
    };
    try {
      s.setItem(AUTOSAVE_KEY, JSON.stringify(envelope));
      useAutosave.setState({ status: { kind: 'saved', at: envelope.savedAt, dropped } });
      return;
    } catch (err) {
      if (!isQuotaError(err)) {
        useAutosave.setState({
          status: { kind: 'failed', reason: err instanceof Error ? err.message : String(err) },
        });
        return;
      }
    }
  }
  useAutosave.setState({
    status: { kind: 'failed', reason: 'the case is too large for this browser to keep locally' },
  });
}

/** What a previous session left behind, or null. Corrupt or foreign data is ignored, never thrown. */
export function readAutosave(): {
  parsed: ParsedCaseFile;
  savedAt: string;
  fileName: string | null;
  dirty: boolean;
} | null {
  const s = storage();
  if (!s) return null;
  const raw = s.getItem(AUTOSAVE_KEY);
  if (!raw) return null;
  try {
    const env = JSON.parse(raw) as Partial<Envelope>;
    if (!env || typeof env !== 'object' || !env.file) return null;
    return {
      parsed: readCaseFile(env.file),
      savedAt: typeof env.savedAt === 'string' ? env.savedAt : '',
      fileName: typeof env.fileName === 'string' ? env.fileName : null,
      dirty: env.dirty === true,
    };
  } catch {
    return null;
  }
}

export function clearAutosave(): void {
  try {
    storage()?.removeItem(AUTOSAVE_KEY);
  } catch {
    /* nothing to clear */
  }
  useAutosave.setState({ status: { kind: 'idle' } });
}

/**
 * Restore whatever the last session left, if the current case is still empty. Returns what was
 * restored so the caller can say so.
 */
export async function restoreAutosave(): Promise<{ savedAt: string; events: number } | null> {
  const found = readAutosave();
  if (!found) return null;
  const cs = useCaseStore.getState();
  const empty = !Object.keys(cs.state.events).length && !Object.keys(cs.state.hosts).length;
  if (!empty) return null;
  const { parsed, savedAt, fileName, dirty } = found;
  await cs.replace(parsed.state, { fileName, fileHandle: null });
  useTerrain.getState().setStore(new MemoryTerrain(parsed.terrain));
  if (dirty) useCaseStore.setState({ dirty: true });
  return { savedAt, events: parsed.report.events };
}

/**
 * Start watching the case for changes. Debounced, flushed on page hide (a closing tab fires
 * that; a crash usually does not, which is why the debounce is short).
 */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  const schedule = (): void => {
    pending = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      pending = false;
      saveNow();
    }, DEBOUNCE_MS);
  };
  const flush = (): void => {
    if (!pending) return;
    if (timer) clearTimeout(timer);
    timer = null;
    pending = false;
    saveNow();
  };
  const unsubCase = useCaseStore.subscribe((s, prev) => {
    if (s.state !== prev.state || s.fileName !== prev.fileName || s.dirty !== prev.dirty)
      schedule();
  });
  const unsubTerrain = useTerrain.subscribe((s, prev) => {
    if (s.version !== prev.version || s.store !== prev.store) schedule();
  });
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') flush();
  };
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    unsubCase();
    unsubTerrain();
    window.removeEventListener('pagehide', flush);
    document.removeEventListener('visibilitychange', onVisibility);
    if (timer) clearTimeout(timer);
  };
}
