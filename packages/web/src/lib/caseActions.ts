/** Case-level actions shared by the top bar, the menu, and keyboard shortcuts. */
import {
  buildIocCsv,
  buildMarkdown,
  buildTimelineCsv,
  CaseFileError,
  demoCaseState,
  emptyState,
  fileStamp,
  filterEvents,
  mergeOps,
  readCaseFile,
  slug,
  writeCaseFile,
  type ParsedCaseFile,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { toast } from '../store/useToasts';
import { downloadText, pickFile, writeBack } from './download';
import { useTerrain } from '../store/useTerrain';
import { MemoryTerrain } from './terrain';

const caseSlug = (): string => {
  const c = useCaseStore.getState().state.case;
  return slug(c.number || c.name);
};

export async function exportJson(): Promise<void> {
  const cs = useCaseStore.getState();
  const terrain = useTerrain.getState().store;
  const file = writeCaseFile(cs.state, {
    generator: `MIDDEN ${__MIDDEN_VERSION__}`,
    // Standalone carries its parsed scans so the file is the whole investigation.
    terrain: terrain instanceof MemoryTerrain ? terrain.all() : undefined,
  });
  const text = JSON.stringify(file, null, 2);
  if (await writeBack(cs.fileHandle, text)) {
    cs.markSaved();
    toast(`Saved to ${cs.fileName ?? 'file'}`);
    return;
  }
  downloadText(`${caseSlug()}_${fileStamp()}.json`, text);
  cs.markSaved();
  toast('Case file downloaded');
}

export async function openCaseFile(fallbackInput: HTMLInputElement | null): Promise<void> {
  const picked = await pickFile(
    { 'application/json': ['.json'] },
    'Midden case file',
    fallbackInput,
  );
  if (!picked) return;
  let parsed: ParsedCaseFile;
  try {
    parsed = readCaseFile(JSON.parse(await picked.file.text()));
  } catch (err) {
    toast(err instanceof CaseFileError ? err.message : 'That file is not valid JSON', 'bad');
    return;
  }
  const cs = useCaseStore.getState();
  const empty = !Object.keys(cs.state.events).length && !Object.keys(cs.state.hosts).length;
  if (!cs.capabilities.fileBased) {
    await applyImport(parsed, 'merge', picked.file.name, null);
    return;
  }
  if (empty) {
    await applyImport(parsed, 'replace', picked.file.name, picked.handle);
    return;
  }
  useUiStore
    .getState()
    .openModal({ kind: 'import', parsed, fileName: picked.file.name, fileHandle: picked.handle });
}

export async function applyImport(
  parsed: ParsedCaseFile,
  mode: 'merge' | 'replace',
  fileName: string,
  handle: FileSystemFileHandle | null,
): Promise<void> {
  const cs = useCaseStore.getState();
  const ui = useUiStore.getState();
  const terrain = useTerrain.getState();
  if (mode === 'replace') {
    await cs.replace(parsed.state, { fileName, fileHandle: handle });
    if (cs.capabilities.fileBased) terrain.setStore(new MemoryTerrain(parsed.terrain));
  } else {
    await cs.dispatch(mergeOps(cs.state, parsed.state));
    const store = terrain.store;
    if (store instanceof MemoryTerrain) {
      for (const [id, hosts] of Object.entries(parsed.terrain))
        if (!store.has(id)) store.put(id, hosts);
      terrain.bump();
    }
  }
  ui.select(null);
  ui.setExpandedAll(null);
  const n = parsed.report.events;
  const extra = parsed.report.dropped.length
    ? ` (${parsed.report.dropped.length} entries skipped)`
    : '';
  toast(
    `${mode === 'merge' ? 'Merged' : 'Opened'} ${n} events from ${fileName}${extra}`,
    parsed.report.dropped.length ? 'warn' : 'info',
  );
}

export function loadDemo(): void {
  const cs = useCaseStore.getState();
  // A hosted case belongs to the server and to everyone else in it, so it can be added to but
  // never swapped out wholesale. The empty-state button reaches this in both modes.
  if (!cs.capabilities.fileBased) return mergeDemo();
  const ui = useUiStore.getState();
  const run = (): void => {
    void cs.replace(demoCaseState(), { fileName: null, fileHandle: null }).then(() => {
      ui.select(null);
      ui.setExpandedAll(null);
      toast('Example case loaded');
    });
  };
  if (Object.keys(cs.state.events).length)
    ui.confirm(
      'Load example case',
      'This replaces the current investigation. Any unsaved work is lost.',
      'Load example',
      run,
      true,
    );
  else run();
}

/** Hosted mode: add the example data into the current case without replacing anything. */
export function mergeDemo(): void {
  const cs = useCaseStore.getState();
  const ui = useUiStore.getState();
  ui.confirm(
    'Merge the example case',
    'Adds the example hosts and events to this case. Existing data is kept.',
    'Merge example',
    () => {
      void cs
        .dispatch(mergeOps(cs.state, demoCaseState()))
        .then((r) => r.ok && toast('Example case merged'));
    },
  );
}

export function newCase(): void {
  const cs = useCaseStore.getState();
  const ui = useUiStore.getState();
  ui.confirm(
    'Start a new case',
    'This clears all hosts and events. Save your case file first if you need it.',
    'Clear everything',
    () => {
      void cs.replace(emptyState(), { fileName: null, fileHandle: null }).then(() => {
        useTerrain.getState().setStore(new MemoryTerrain());
        ui.select(null);
        ui.setExpandedAll(null);
        toast('New case started');
      });
    },
    true,
  );
}

export function exportCsv(): void {
  const cs = useCaseStore.getState();
  const ui = useUiStore.getState();
  downloadText(
    `${caseSlug()}_timeline_${fileStamp()}.csv`,
    buildTimelineCsv(cs.state, filterEvents(cs.state, ui.filters)),
    'text/csv;charset=utf-8',
  );
  toast('Timeline exported as CSV');
}

export function exportIocs(): void {
  downloadText(
    `${caseSlug()}_indicators_${fileStamp()}.csv`,
    buildIocCsv(useCaseStore.getState().state),
    'text/csv;charset=utf-8',
  );
  toast('Indicator list exported');
}

export function exportMd(): void {
  const cs = useCaseStore.getState();
  downloadText(
    `${caseSlug()}_report_${fileStamp()}.md`,
    buildMarkdown(cs.state, useUiStore.getState().tz),
    'text/markdown;charset=utf-8',
  );
  toast('Report downloaded as Markdown');
}

export function deleteEvent(id: string): void {
  const cs = useCaseStore.getState();
  const ui = useUiStore.getState();
  const e = cs.state.events[id];
  if (!e) return;
  const what = (e.activity || e.indicator || 'this event').slice(0, 60);
  ui.confirm(
    'Delete event',
    `Remove "${what}" from the timeline?`,
    'Delete',
    () => {
      void cs.dispatch({ type: 'event.remove', id });
      if (ui.sel === id) ui.select(id);
      toast('Event deleted', 'warn');
    },
    true,
  );
}

export function deleteHost(id: string): void {
  const cs = useCaseStore.getState();
  const ui = useUiStore.getState();
  const h = cs.state.hosts[id];
  if (!h) return;
  const n = Object.values(cs.state.events).filter(
    (e) => e.hostId === id || e.srcHostId === id,
  ).length;
  const msg =
    `Remove ${h.name}?` +
    (n
      ? ` ${n} event(s) reference this host and will show as "(deleted host)" until reassigned.`
      : '');
  ui.confirm(
    'Delete host',
    msg,
    'Delete',
    () => {
      const links = Object.values(cs.state.links).filter((l) => l.hostId === id);
      void cs.dispatch({
        type: 'batch',
        ops: [
          { type: 'host.remove', id },
          ...links.map((l) => ({ type: 'link.remove' as const, hostId: l.hostId, ip: l.ip })),
        ],
      });
      toast('Host deleted', 'warn');
    },
    true,
  );
}
