import { useMemo } from 'react';
import {
  caseTotals,
  filterEvents,
  iocList,
  sortedEvents,
  type CaseState,
  type Event,
} from '@midden/core';
import { useCaseStore } from '../store/useCaseStore';
import { useUiStore } from '../store/useUiStore';

export function useCaseState(): CaseState {
  return useCaseStore((s) => s.state);
}

export function useSortedEvents(): Event[] {
  const events = useCaseStore((s) => s.state.events);
  return useMemo(() => sortedEvents({ events } as CaseState), [events]);
}

export function useFilteredEvents(): Event[] {
  const state = useCaseState();
  const filters = useUiStore((s) => s.filters);
  const sorted = useSortedEvents();
  return useMemo(() => filterEvents(state, filters, sorted), [state, filters, sorted]);
}

export function useTotals() {
  const state = useCaseState();
  const sorted = useSortedEvents();
  return useMemo(() => caseTotals(state, sorted), [state, sorted]);
}

export function useIocList(events: Event[]) {
  return useMemo(() => iocList(events), [events]);
}

export function useSelectedEvent(): Event | null {
  const sel = useUiStore((s) => s.sel);
  const events = useCaseStore((s) => s.state.events);
  return sel ? (events[sel] ?? null) : null;
}
