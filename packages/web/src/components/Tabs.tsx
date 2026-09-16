import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';
import { useFilteredEvents, useIocList } from '../lib/selectors';
import { goToView, useRoute, type CaseView } from '../lib/router';

const TABS: Array<[CaseView, string]> = [
  ['graph', 'Branch graph'],
  ['timeline', 'Timeline'],
  ['hosts', 'Hosts'],
  ['pivot', 'Indicators'],
  ['matrix', 'ATT&CK'],
  ['scans', 'Scans'],
  ['map', 'Network map'],
  ['builder', 'Scan builder'],
  ['report', 'Report'],
  ['history', 'History'],
];

export function Tabs() {
  const view = useUiStore((s) => s.view);
  const route = useRoute((s) => s.route);
  const history = useCaseStore((s) => s.capabilities.history);
  const filtered = useFilteredEvents();
  const hosts = useCaseStore((s) => s.state.hosts);
  const iocs = useIocList(filtered);
  const seq = useCaseStore((s) => s.seq);
  const current: CaseView = route.kind === 'case' && route.view === 'history' ? 'history' : view;
  const scans = useCaseStore((s) => s.state.scans);
  const counts: Partial<Record<CaseView, number>> = {
    scans: Object.keys(scans).length,
    timeline: filtered.length,
    hosts: Object.keys(hosts).length,
    pivot: iocs.length,
    history: seq,
  };
  return (
    <nav className="tabs" role="tablist">
      {TABS.filter(([id]) => id !== 'history' || history).map(([id, label]) => (
        <button
          key={id}
          className={'tab' + (current === id ? ' on' : '')}
          role="tab"
          aria-selected={current === id}
          onClick={() => goToView(id)}
          data-testid={`tab-${id}`}
        >
          {label}
          {counts[id] !== undefined && <span className="n">{counts[id]}</span>}
        </button>
      ))}
    </nav>
  );
}
